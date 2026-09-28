import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, type DB } from '@velyric/db';
import {
  importServiceSigner,
  signServiceToken,
  type ServiceScope,
  type ServiceSigner,
} from '@velyric/security';
import { LocalVaultTenantSecrets } from '@velyric/tenant-secrets';
import { exportJWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import {
  buildInternalApp,
  buildPublicApp,
  type AppInstance,
  type AppServices,
} from '../../src/app.js';
import {
  PublicAuthenticator,
  ServiceAuthenticator,
  VelyricSessionVerifier,
  type SessionVerifier,
  type VerifiedSession,
} from '../../src/auth.js';
import { oauthEndpoints } from '../../src/integrations/oauth.js';
import { registerAgentRoutes } from '../../src/routes/agents.js';
import { createIntegrationRoutes } from '../../src/routes/integrations.js';
import { createMessagingRoutes } from '../../src/routes/messaging.js';
import { createTenantSmtpRoutes } from '../../src/routes/tenant-smtp.js';
import { createAuthRoutes } from '../../src/routes/auth.js';
import { createSocialAuthRoutes } from '../../src/routes/social-auth.js';
import { createBillingRoutes } from '../../src/routes/billing.js';
import { createCallRoutes } from '../../src/routes/calls.js';
import { createProvisioningRoutes } from '../../src/routes/provisioning.js';
import { createCustomToolRoutes } from '../../src/routes/custom-tools.js';
import { registerAuditLogRoutes } from '../../src/routes/audit-logs.js';
import { createApiKeyRoutes } from '../../src/routes/api-keys.js';
import { registerLocationRoutes } from '../../src/routes/locations.js';
import { registerAdminRoutes } from '../../src/routes/admin.js';
import { createAdminTicketRoutes } from '../../src/routes/admin-tickets.js';
import { registerAdminTenantRoutes } from '../../src/routes/admin-tenants.js';
import { createSupportTicketRoutes } from '../../src/routes/support-tickets.js';
import { registerAnalyticsRoutes } from '../../src/routes/analytics.js';
import { registerPhoneNumberRoutes } from '../../src/routes/phone-numbers.js';
import { createMemberRoutes } from '../../src/routes/members.js';
import { createInternalRuntimeRoutes } from '../../src/routes/internal-runtime.js';
import { createInternalKnowledgeRoutes } from '../../src/routes/internal-knowledge.js';
import {
  registerInternalSimulationRoutes,
  registerSimulationRoutes,
} from '../../src/routes/simulations.js';
import { registerContactRoutes } from '../../src/routes/contacts.js';
import { registerWaitlistRoutes } from '../../src/routes/waitlist.js';
import { registerPrivacyRoutes } from '../../src/routes/privacy.js';
import { createOutboundWebhookRoutes } from '../../src/routes/outbound-webhooks.js';
import { createKnowledgeRoutes } from '../../src/routes/knowledge.js';
import { createVoiceTestRoutes } from '../../src/routes/voice-test.js';
import { FakeRealtimeSessions } from './fake-realtime.js';
import { InMemoryKnowledgeObjectStore } from './fake-objects.js';
import { createStripeWebhookRoutes } from '../../src/routes/stripe-webhook.js';
import { registerSchedulingRoutes } from '../../src/routes/scheduling.js';
import { registerWorkspaceRoutes } from '../../src/routes/workspaces.js';
import { AjvJsonSchemaValidator } from '../../src/runtime/tool-dispatch.js';
import { FakeCalendarLister } from './fake-calendar-list.js';
import { FakeOAuthTokenClient } from './fake-oauth.js';
import { FakeTurnstileVerifier } from './fake-turnstile.js';
import { FakeCommandBus, FakeProvisioningControl, FakeToolDispatcher } from './fake-runtime.js';
import { FakeStripeGateway } from './fake-stripe.js';
import './provided.js';

export const TEST_ORIGIN = 'http://app.velyric.test';
export const TERMS_VERSION = '2026-09-01';
export const STRIPE_WEBHOOK_SECRET = 'whsec_velyric_test_signing_secret';
export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-bytes-long';
export const TEST_API_ORIGIN = 'http://api.velyric.test';
export const OAUTH_SIMULATOR = 'http://oauth.simulator.test';

export class StaticSessionVerifier implements SessionVerifier {
  readonly #sessions = new Map<string, VerifiedSession>();
  readonly #fallback: SessionVerifier | undefined;

  constructor(fallback?: SessionVerifier) {
    this.#fallback = fallback;
  }

  async verify(sealedSession: string): Promise<VerifiedSession | null> {
    const staticSession = this.#sessions.get(sealedSession);
    if (staticSession !== undefined) {
      return staticSession;
    }
    return (await this.#fallback?.verify(sealedSession)) ?? null;
  }

  issue(email: string): TestUser {
    const cookie = randomBytes(24).toString('base64url');
    const session: VerifiedSession = {
      authSubject: `user_${randomUUID().replaceAll('-', '')}`,
      email,
      sessionId: `session_${randomUUID()}`,
    };
    this.#sessions.set(cookie, session);
    return { cookie, csrf: randomBytes(32).toString('base64url'), session };
  }
}

export interface TestUser {
  readonly cookie: string;
  readonly csrf: string;
  readonly session: VerifiedSession;
}

export interface Harness {
  readonly app: AppInstance;
  readonly internal: AppInstance;
  readonly admin: pg.Pool;
  readonly db: Kysely<DB>;
  readonly sessions: StaticSessionVerifier;
  readonly apiKeyPepper: Buffer;
  readonly stripe: FakeStripeGateway;
  readonly dispatcher: FakeToolDispatcher;
  readonly commandBus: FakeCommandBus;
  readonly provisioning: FakeProvisioningControl;
  readonly objects: InMemoryKnowledgeObjectStore;
  readonly vectorSearch: boolean;
  readonly oauth: FakeOAuthTokenClient;
  readonly turnstile: FakeTurnstileVerifier;
  readonly calendarLister: FakeCalendarLister;
  readonly realtime: FakeRealtimeSessions;
  readonly vaultDir: string;
  readonly stateKey: Buffer;
  serviceToken(scopes: readonly ServiceScope[], tenantId?: string): Promise<string>;
}

export const TEST_HOSTS: Readonly<Record<string, string>> = {
  'api.partner.test': '93.184.216.34',
  'crm.partner.test': '151.101.1.69',
  'intranet.partner.test': '10.20.30.40',
  'metadata.partner.test': '169.254.169.254',
  'smtp.partner.test': '127.0.0.1',
};

export const testHostResolver = (
  hostname: string,
): Promise<readonly { address: string; family: 4 | 6 }[]> => {
  const address = TEST_HOSTS[hostname];
  return address === undefined
    ? Promise.reject(new Error('ENOTFOUND'))
    : Promise.resolve([{ address, family: 4 }]);
};

export function browserHeaders(
  user: TestUser,
  workspace?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: `vly_session=${user.cookie}; vly_csrf=${user.csrf}`,
    'x-csrf-token': user.csrf,
    origin: TEST_ORIGIN,
    ...(workspace === undefined ? {} : { 'x-velyric-workspace': workspace }),
    ...extra,
  };
}

export function useApiHarness(): () => Harness {
  let harness: Harness | undefined;
  let databaseName = '';
  let adminUrl = '';

  beforeAll(async () => {
    const info = inject('controlApiDb');
    const base = `postgres://${encodeURIComponent(info.user)}:${encodeURIComponent(info.password)}@${info.host}:${String(info.port)}`;
    adminUrl = `${base}/postgres`;
    databaseName = `api_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(databaseName)} TEMPLATE ${client.escapeIdentifier(info.template)}`,
      );
    } finally {
      await client.end();
    }
    const connectionString = `${base}/${databaseName}`;
    const db = createDatabase<DB>({
      connectionString,
      applicationName: 'control-api-test',
      assumeRole: 'velyric_app',
      maxConnections: 10,
    });
    const sessions = new StaticSessionVerifier(new VelyricSessionVerifier(db, TEST_SESSION_SECRET));
    const apiKeyPepper = randomBytes(32);
    const stripe = new FakeStripeGateway();
    const realtime = new FakeRealtimeSessions();
    const dispatcher = new FakeToolDispatcher();
    const commandBus = new FakeCommandBus();
    const provisioning = new FakeProvisioningControl();
    const objects = new InMemoryKnowledgeObjectStore();
    const vectorProbe = await sql<{
      present: boolean;
    }>`select to_regclass('app.knowledge_chunk_embeddings') is not null as present`.execute(db);
    const vectorSearch = vectorProbe.rows[0]?.present === true;
    const oauth = new FakeOAuthTokenClient();
    const turnstile = new FakeTurnstileVerifier();
    const calendarLister = new FakeCalendarLister();
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'velyric-control-api-vault-'));
    const stateKey = randomBytes(32);
    const services: AppServices = {
      environment: 'ci',
      db,
      cursorKey: randomBytes(32),
      stateKey,
      now: () => new Date(),
    };
    const app = await buildPublicApp({
      services,
      authenticator: new PublicAuthenticator(db, sessions, apiKeyPepper),
      corsAllowedOrigins: [TEST_ORIGIN],
      modules: [
        createAuthRoutes({ sessionSecret: TEST_SESSION_SECRET, cookieDomain: null, turnstile }),
        createSocialAuthRoutes({
          tokenClient: oauth,
          google: {
            endpoints: oauthEndpoints('google', 'simulator', OAUTH_SIMULATOR),
            clientId: 'google-test-client',
          },
          publicApiOrigin: TEST_API_ORIGIN,
          webOrigin: TEST_ORIGIN,
          sessionSecret: TEST_SESSION_SECRET,
          cookieDomain: null,
        }),
        registerWorkspaceRoutes,
        registerAdminRoutes,
        registerAdminTenantRoutes,
        createAdminTicketRoutes({ webOrigin: TEST_ORIGIN }),
        createSupportTicketRoutes({ webOrigin: TEST_ORIGIN }),
        registerAgentRoutes,
        registerSchedulingRoutes,
        registerAuditLogRoutes,
        registerLocationRoutes,
        registerAnalyticsRoutes,
        registerPhoneNumberRoutes,
        registerSimulationRoutes,
        registerContactRoutes,
        registerWaitlistRoutes,
        registerPrivacyRoutes,
        createOutboundWebhookRoutes({
          secrets: new LocalVaultTenantSecrets(vaultDir),
          resolver: testHostResolver,
        }),
        createMemberRoutes({ webOrigin: TEST_ORIGIN }),
        createApiKeyRoutes({ apiKeyPepper, webOrigin: TEST_ORIGIN }),
        createKnowledgeRoutes({ objects, resolver: testHostResolver }),
        createVoiceTestRoutes({
          secrets: new LocalVaultTenantSecrets(vaultDir),
          sessions: realtime,
          objects,
          dispatcher,
          schemaValidator: new AjvJsonSchemaValidator(),
          openAiMode: 'live',
        }),
        createIntegrationRoutes({
          tokenClient: oauth,
          secrets: new LocalVaultTenantSecrets(vaultDir),
          providers: {
            google: {
              endpoints: oauthEndpoints('google', 'simulator', OAUTH_SIMULATOR),
              clientId: 'google-test-client',
              apiBaseUrl: `${OAUTH_SIMULATOR}/google/api`,
            },
            microsoft: {
              endpoints: oauthEndpoints('microsoft', 'simulator', OAUTH_SIMULATOR),
              clientId: 'microsoft-test-client',
              apiBaseUrl: `${OAUTH_SIMULATOR}/microsoft/api`,
            },
          },
          calendarLister,
          publicApiOrigin: TEST_API_ORIGIN,
          webOrigin: TEST_ORIGIN,
        }),
        createCustomToolRoutes({
          secrets: new LocalVaultTenantSecrets(vaultDir),
          resolver: testHostResolver,
        }),
        createTenantSmtpRoutes({
          secrets: new LocalVaultTenantSecrets(vaultDir),
          resolver: testHostResolver,
          tokenClient: oauth,
        }),
        createMessagingRoutes(),
        createCallRoutes({ commandBus }),
        createProvisioningRoutes({ control: provisioning }),
        createBillingRoutes({ stripe, webOrigin: TEST_ORIGIN, currentTermsVersion: TERMS_VERSION }),
        createStripeWebhookRoutes({ stripe, webhookSecrets: () => [STRIPE_WEBHOOK_SECRET] }),
      ],
    });
    await app.ready();

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer: ServiceSigner = await importServiceSigner(
      'voice-runtime',
      'voice-runtime-test',
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    const jwks = {
      keys: [
        { ...(await exportJWK(publicKey)), kid: 'voice-runtime-test', alg: 'EdDSA', use: 'sig' },
      ],
    };
    const seen = new Set<string>();
    const internal = buildInternalApp({
      services,
      authenticator: new ServiceAuthenticator({
        audience: 'control-api',
        jwks,
        replayGuard: (issuer, jti) => {
          const key = `${issuer}:${jti}`;
          if (seen.has(key)) {
            return Promise.resolve(false);
          }
          seen.add(key);
          return Promise.resolve(true);
        },
      }),
      modules: [
        createInternalRuntimeRoutes({ dispatcher, schemaValidator: new AjvJsonSchemaValidator() }),
        createInternalKnowledgeRoutes({ objects, vectorSearch }),
        registerInternalSimulationRoutes,
      ],
      jwks: JSON.stringify(jwks),
      readiness: () => Promise.resolve(true),
    });
    await internal.ready();

    harness = {
      app,
      internal,
      admin: new pg.Pool({ connectionString, max: 4, options: '-c search_path=app,public' }),
      db,
      sessions,
      apiKeyPepper,
      stripe,
      dispatcher,
      commandBus,
      provisioning,
      objects,
      vectorSearch,
      oauth,
      turnstile,
      calendarLister,
      realtime,
      vaultDir,
      stateKey,
      serviceToken: (scopes, tenantId) =>
        signServiceToken(signer, {
          audience: 'control-api',
          scopes,
          ...(tenantId === undefined ? {} : { tenantId }),
        }),
    };
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.app.close();
      await harness.internal.close();
      await harness.db.destroy();
      await harness.admin.end();
      await rm(harness.vaultDir, { recursive: true, force: true });
    }
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(
        `DROP DATABASE IF EXISTS ${client.escapeIdentifier(databaseName)} WITH (FORCE)`,
      );
    } finally {
      await client.end();
    }
  });

  return () => {
    if (harness === undefined) {
      throw new Error('API harness is not initialised');
    }
    return harness;
  };
}
