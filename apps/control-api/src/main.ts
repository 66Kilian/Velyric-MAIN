import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { jetstream } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { createDatabase, type DB } from '@velyric/db';
import {
  importServiceSigner,
  signServiceToken,
  systemResolver,
  type ReplayGuard,
} from '@velyric/security';
import { AwsTenantSecrets, LocalVaultTenantSecrets } from '@velyric/tenant-secrets';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { buildInternalApp, buildPublicApp, type AppServices } from './app.js';
import { PublicAuthenticator, ServiceAuthenticator, VelyricSessionVerifier } from './auth.js';
import { StripeSdkGateway } from './billing/stripe-gateway.js';
import { ConfigError, loadControlApiConfig, type SecretResolver } from './config.js';
import { HttpCalendarLister } from './integrations/calendar-list.js';
import { calendarApiBaseUrl, HttpOAuthTokenClient, oauthEndpoints } from './integrations/oauth.js';
import { JetStreamOutboxPublisher, OutboxRelay } from './outbox/relay.js';
import { RedisRateLimiter } from './rate-limit.js';
import { registerAgentRoutes } from './routes/agents.js';
import { createIntegrationRoutes } from './routes/integrations.js';
import { createVoiceTestRoutes, OpenAiRealtimeSessions } from './routes/voice-test.js';
import { createSocialAuthRoutes } from './routes/social-auth.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createTenantSmtpRoutes } from './routes/tenant-smtp.js';
import { createAuthRoutes } from './routes/auth.js';
import { createTurnstileVerifier } from './turnstile.js';
import { createBillingRoutes } from './routes/billing.js';
import { createProvisioningRoutes } from './routes/provisioning.js';
import { createCustomToolRoutes } from './routes/custom-tools.js';
import { registerAuditLogRoutes } from './routes/audit-logs.js';
import { createApiKeyRoutes } from './routes/api-keys.js';
import { registerLocationRoutes } from './routes/locations.js';
import { registerAdminRoutes } from './routes/admin.js';
import { createAdminTicketRoutes } from './routes/admin-tickets.js';
import { registerAdminTenantRoutes } from './routes/admin-tenants.js';
import { createSupportTicketRoutes } from './routes/support-tickets.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerPhoneNumberRoutes } from './routes/phone-numbers.js';
import { createMemberRoutes } from './routes/members.js';
import { createCallRoutes } from './routes/calls.js';
import { createInternalRuntimeRoutes } from './routes/internal-runtime.js';
import { createInternalKnowledgeRoutes } from './routes/internal-knowledge.js';
import {
  registerInternalSimulationRoutes,
  registerSimulationRoutes,
} from './routes/simulations.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerWaitlistRoutes } from './routes/waitlist.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { createOutboundWebhookRoutes } from './routes/outbound-webhooks.js';
import { createKnowledgeRoutes } from './routes/knowledge.js';
import { S3KnowledgeObjectStore } from './knowledge/object-store.js';
import { createStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { registerSchedulingRoutes } from './routes/scheduling.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { NatsProvisioningControl } from './runtime/provisioning-control.js';
import { NatsRuntimeCommandBus } from './runtime/command-bus.js';
import { AjvJsonSchemaValidator, NatsToolDispatcher } from './runtime/tool-dispatch.js';

function sessionCookieDomain(publicWebOrigin: string, publicApiOrigin: string): string | null {
  const webHost = new URL(publicWebOrigin).hostname;
  const apiHost = new URL(publicApiOrigin).hostname;
  if (webHost === apiHost || isIP(webHost) !== 0) {
    return null;
  }
  if (webHost === 'localhost') {
    return webHost;
  }
  const labels = webHost.split('.');
  return labels.length < 2 ? null : `.${labels.slice(-2).join('.')}`;
}

class AwsSecretResolver implements SecretResolver {
  readonly #client: SecretsManagerClient;

  constructor(region: string) {
    this.#client = new SecretsManagerClient({ region });
  }

  async resolve(arn: string): Promise<string> {
    const output = await this.#client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (output.SecretString === undefined) {
      throw new Error('SecretStringMissing');
    }
    return output.SecretString;
  }
}

async function main(): Promise<void> {
  const config = await loadControlApiConfig(
    process.env,
    new AwsSecretResolver(process.env['VELYRIC_AWS_REGION'] ?? 'eu-central-1'),
  ).catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78);
    }
    throw error;
  });

  const db = createDatabase<DB>({
    connectionString: config.databaseUrl.reveal(),
    applicationName: 'control-api',
    maxConnections: 20,
    ...(config.databaseAssumeRole ? { assumeRole: 'velyric_app' as const } : {}),
  });
  const redis = new Redis(config.redisUrl.reveal(), { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  const replayGuard: ReplayGuard = async (issuer, jti, ttlSeconds) =>
    (await redis.set(
      `vly:${config.environment}:jti:${issuer}:${jti}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    )) === 'OK';

  const signer = await importServiceSigner(
    'control-api',
    config.serviceKeyId,
    config.serviceSigningKeyPem.reveal(),
  );
  const nats = await connect({ servers: config.natsUrl, name: 'control-api' });
  const dispatcher = new NatsToolDispatcher(nats, (tenantId) =>
    signServiceToken(signer, {
      audience: 'connector-worker',
      scopes: ['connector.execute'],
      tenantId,
    }),
  );
  const commandBus = new NatsRuntimeCommandBus(nats, (tenantId) =>
    signServiceToken(signer, { audience: 'voice-runtime', scopes: ['call.control'], tenantId }),
  );
  const provisioningControl = new NatsProvisioningControl(nats, (tenantId) =>
    signServiceToken(signer, {
      audience: 'workflow-worker',
      scopes: ['provisioning.execute'],
      tenantId,
    }),
  );
  const stripe = new StripeSdkGateway(
    config.stripe.secretKey.reveal(),
    config.providerModes.STRIPE,
    config.providerSimulatorUrl,
  );

  const endpoints = {
    google: oauthEndpoints('google', config.providerModes.GOOGLE, config.providerSimulatorUrl),
    microsoft: oauthEndpoints(
      'microsoft',
      config.providerModes.MICROSOFT,
      config.providerSimulatorUrl,
    ),
  };
  const tokenClient = new HttpOAuthTokenClient(endpoints, {
    google: config.oauthClients.GOOGLE,
    microsoft: config.oauthClients.MICROSOFT,
  });
  const secretWriter =
    config.localVaultDir === null
      ? new AwsTenantSecrets(new SecretsManagerClient({ region: config.awsRegion }))
      : new LocalVaultTenantSecrets(config.localVaultDir);

  const knowledgeObjects = new S3KnowledgeObjectStore({
    region: config.awsRegion,
    bucketPrefix: config.s3.bucketPrefix,
    endpoint: config.s3.endpoint,
  });
  const vectorProbe = await sql<{
    present: boolean;
  }>`select to_regclass('app.knowledge_chunk_embeddings') is not null as present`.execute(db);
  const vectorSearch = vectorProbe.rows[0]?.present === true;
  if (config.requireVectorSearch && !vectorSearch) {
    process.stderr.write(
      'vector search is required but the vector migration track is not applied\n',
    );
    process.exit(78);
  }

  const services: AppServices = {
    environment: config.environment,
    db,
    cursorKey: config.cursorKey,
    stateKey: config.stateKey,
    now: () => new Date(),
  };

  const publicApp = await buildPublicApp({
    services,
    authenticator: new PublicAuthenticator(
      db,
      new VelyricSessionVerifier(db, config.sessionSecret.reveal()),
      config.apiKeyPepper,
    ),
    corsAllowedOrigins: config.corsAllowedOrigins,
    rateLimiter: new RedisRateLimiter(redis, `vly:${config.environment}`),
    modules: [
      createAuthRoutes({
        sessionSecret: config.sessionSecret.reveal(),
        cookieDomain: sessionCookieDomain(config.publicWebOrigin, config.publicApiOrigin),
        turnstile: createTurnstileVerifier(config.turnstileSecretKey),
      }),
      createSocialAuthRoutes({
        tokenClient,
        google: { endpoints: endpoints.google, clientId: config.oauthClients.GOOGLE.clientId },
        publicApiOrigin: config.publicApiOrigin,
        webOrigin: config.publicWebOrigin,
        sessionSecret: config.sessionSecret.reveal(),
        cookieDomain: sessionCookieDomain(config.publicWebOrigin, config.publicApiOrigin),
      }),
      registerWorkspaceRoutes,
      registerAdminRoutes,
      registerAdminTenantRoutes,
      createAdminTicketRoutes({ webOrigin: config.publicWebOrigin }),
      createSupportTicketRoutes({ webOrigin: config.publicWebOrigin }),
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
        secrets: secretWriter,
        resolver: systemResolver,
        onSecretCleanupFailure: (secretRef, error) => {
          process.stderr.write(
            `secret cleanup failed for ${secretRef}: ${error instanceof Error ? error.name : 'unknown'}\n`,
          );
        },
      }),
      createMemberRoutes({ webOrigin: config.publicWebOrigin }),
      createApiKeyRoutes({ apiKeyPepper: config.apiKeyPepper, webOrigin: config.publicWebOrigin }),
      createKnowledgeRoutes({ objects: knowledgeObjects, resolver: systemResolver }),
      ...(config.webTestCallEnabled
        ? [
            createVoiceTestRoutes({
              secrets: secretWriter,
              sessions: new OpenAiRealtimeSessions(),
              objects: knowledgeObjects,
              dispatcher,
              schemaValidator: new AjvJsonSchemaValidator(),
              openAiMode: config.providerModes.OPENAI,
            }),
          ]
        : []),
      createIntegrationRoutes({
        tokenClient,
        secrets: secretWriter,
        providers: {
          google: {
            endpoints: endpoints.google,
            clientId: config.oauthClients.GOOGLE.clientId,
            apiBaseUrl: calendarApiBaseUrl(
              'google',
              config.providerModes.GOOGLE,
              config.providerSimulatorUrl,
            ),
          },
          microsoft: {
            endpoints: endpoints.microsoft,
            clientId: config.oauthClients.MICROSOFT.clientId,
            apiBaseUrl: calendarApiBaseUrl(
              'microsoft',
              config.providerModes.MICROSOFT,
              config.providerSimulatorUrl,
            ),
          },
        },
        calendarLister: new HttpCalendarLister(
          config.environment,
          config.environment === 'local' || config.environment === 'ci',
          systemResolver,
        ),
        publicApiOrigin: config.publicApiOrigin,
        webOrigin: config.publicWebOrigin,
        onSecretCleanupFailure: (secretRef, error) => {
          process.stderr.write(
            `secret cleanup failed for ${secretRef}: ${error instanceof Error ? error.name : 'unknown'}\n`,
          );
        },
      }),
      createMessagingRoutes(),
      createTenantSmtpRoutes({
        secrets: secretWriter,
        resolver: systemResolver,
        tokenClient,
        onSecretCleanupFailure: (secretRef, error) => {
          process.stderr.write(
            `secret cleanup failed for ${secretRef}: ${error instanceof Error ? error.name : 'unknown'}\n`,
          );
        },
      }),
      createCustomToolRoutes({
        secrets: secretWriter,
        resolver: systemResolver,
        onSecretCleanupFailure: (secretRef, error) => {
          process.stderr.write(
            `secret cleanup failed for ${secretRef}: ${error instanceof Error ? error.name : 'unknown'}\n`,
          );
        },
      }),
      createCallRoutes({ commandBus }),
      createProvisioningRoutes({ control: provisioningControl }),
      createBillingRoutes({
        stripe,
        webOrigin: config.publicWebOrigin,
        currentTermsVersion: config.termsVersion,
      }),
      createStripeWebhookRoutes({
        stripe,
        webhookSecrets: () => config.stripe.webhookSecrets.map((secret) => secret.reveal()),
      }),
    ],
    logger: true,
  });

  const internalApp = buildInternalApp({
    services,
    authenticator: new ServiceAuthenticator({
      audience: 'control-api',
      jwks: JSON.parse(config.serviceJwks) as never,
      replayGuard,
    }),
    modules: [
      createInternalRuntimeRoutes({ dispatcher, schemaValidator: new AjvJsonSchemaValidator() }),
      createInternalKnowledgeRoutes({ objects: knowledgeObjects, vectorSearch }),
      registerInternalSimulationRoutes,
    ],
    jwks: config.serviceJwks,
    readiness: async () => {
      await sql`select 1`.execute(db);
      await redis.ping();
      return true;
    },
    logger: true,
  });

  const relay = new OutboxRelay({
    db,
    publisher: new JetStreamOutboxPublisher(jetstream(nats)),
    workerId: `control-api-${process.pid}-${randomUUID()}`,
    logger: {
      info: (details, message) => {
        internalApp.log.info(details, message);
      },
      warn: (details, message) => {
        internalApp.log.warn(details, message);
      },
      error: (details, message) => {
        internalApp.log.error(details, message);
      },
    },
  });
  relay.start();

  await publicApp.listen({ host: config.host, port: config.publicPort });
  await internalApp.listen({ host: config.host, port: config.internalPort });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    publicApp.log.info({ signal }, 'control-api shutting down');
    await Promise.allSettled([publicApp.close(), internalApp.close()]);
    await relay.stop();
    await nats.drain();
    await db.destroy();
    redis.disconnect();
  };
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

await main();
