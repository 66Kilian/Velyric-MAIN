import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadControlApiConfig, type SecretResolver } from '../src/config.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const JWKS = JSON.stringify({
  keys: [
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      kid: 'voice-runtime-1',
    },
  ],
});

const SIGNING_PEM = generateKeyPairSync('ed25519')
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const noSecrets: SecretResolver = {
  resolve: () => Promise.reject(new Error('unexpected ARN resolution')),
};

function localEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    VELYRIC_ENV: 'local',
    VELYRIC_DATABASE_URL_SECRET: 'postgres://velyric_app:secret@127.0.0.1:55432/velyric',
    VELYRIC_REDIS_URL_SECRET: 'redis://127.0.0.1:56379',
    VELYRIC_NATS_URL: 'nats://127.0.0.1:54222',
    VELYRIC_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    VELYRIC_PUBLIC_API_ORIGIN: 'http://localhost:4000',
    CONTROL_API_CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    CONTROL_API_CURSOR_KEY_SECRET: KEY,
    CONTROL_API_API_KEY_PEPPER_SECRET: KEY,
    CONTROL_API_STATE_KEY_SECRET: KEY,
    VELYRIC_SESSION_SIGNING_KEY_SECRET: 's'.repeat(48),
    VELYRIC_PROVIDER_SIMULATOR_URL: 'http://127.0.0.1:4010',
    VELYRIC_SERVICE_JWKS_SECRET: JWKS,
    VELYRIC_TERMS_VERSION: '2026-09-01',
    VELYRIC_SERVICE_SIGNING_KEY_SECRET: SIGNING_PEM,
    CONTROL_API_SERVICE_KEY_ID: 'control-api-2026-09',
    ...overrides,
  };
}

async function issuesOf(promise: Promise<unknown>): Promise<readonly string[]> {
  try {
    await promise;
    return [];
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues;
    }
    throw error;
  }
}

describe('loadControlApiConfig', () => {
  it('loads a local configuration with simulator providers and never prints secrets', async () => {
    const config = await loadControlApiConfig(localEnv(), noSecrets);
    expect(config.environment).toBe('local');
    expect(config.providerModes).toEqual({
      STRIPE: 'simulator',
      TELNYX: 'simulator',
      OPENAI: 'simulator',
      TWILIO: 'simulator',
      GOOGLE: 'simulator',
      MICROSOFT: 'simulator',
    });
    expect(config.oauthClients.GOOGLE.clientId).toBe('simulator-google');
    expect(config.publicPort).toBe(4000);
    expect(config.cursorKey).toHaveLength(32);
    expect(JSON.stringify(config)).not.toContain('secret@127.0.0.1');
    expect(config.databaseUrl.reveal()).toContain('55432');
  });

  it('aggregates every missing or invalid variable into one fail-fast error', async () => {
    const issues = await issuesOf(
      loadControlApiConfig(
        localEnv({
          VELYRIC_DATABASE_URL_SECRET: undefined,
          CONTROL_API_CURSOR_KEY_SECRET: Buffer.alloc(8).toString('base64'),
          CONTROL_API_CORS_ALLOWED_ORIGINS: '*',
          CONTROL_API_PUBLIC_PORT: '70000',
        }),
        noSecrets,
      ),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'VELYRIC_DATABASE_URL_SECRET is required',
        'CONTROL_API_CURSOR_KEY must be base64 encoding at least 32 bytes',
        'CONTROL_API_CORS_ALLOWED_ORIGINS contains an invalid origin *',
        'CONTROL_API_PUBLIC_PORT must be a TCP port',
      ]),
    );
  });

  it('rejects provider modes that do not belong to the environment', async () => {
    const ciLive = await issuesOf(
      loadControlApiConfig(
        localEnv({ VELYRIC_ENV: 'ci', VELYRIC_PROVIDER_MODE_STRIPE: 'live' }),
        noSecrets,
      ),
    );
    expect(ciLive).toContain(
      'VELYRIC_PROVIDER_MODE_STRIPE=live is not allowed when VELYRIC_ENV=ci',
    );
    const productionSimulator = await issuesOf(
      loadControlApiConfig(
        localEnv({ VELYRIC_ENV: 'production', VELYRIC_PROVIDER_MODE_TELNYX: 'simulator' }),
        noSecrets,
      ),
    );
    expect(productionSimulator).toContain(
      'VELYRIC_PROVIDER_MODE_TELNYX=simulator is not allowed when VELYRIC_ENV=production',
    );
  });

  it('requires Secrets Manager ARNs, TLS and https origins in production', async () => {
    const plain = await issuesOf(
      loadControlApiConfig(localEnv({ VELYRIC_ENV: 'production' }), noSecrets),
    );
    expect(plain).toEqual(
      expect.arrayContaining([
        'VELYRIC_DATABASE_URL_SECRET is not allowed in production; use VELYRIC_DATABASE_URL_SECRET_ARN',
      ]),
    );

    const arn = (name: string): string =>
      `arn:aws:secretsmanager:eu-central-1:123456789012:secret:velyric/production/${name}`;
    const values: Record<string, string> = {
      [arn('database')]: 'postgres://velyric_app:x@db.internal:5432/velyric',
      [arn('redis')]: 'rediss://cache.internal:6379',
      [arn('key')]: KEY,
      [arn('session')]: 's'.repeat(48),
      [arn('stripe')]: 'sk_live_stripe',
      [arn('stripe-webhook')]: 'whsec_a,whsec_b',
      [arn('telnyx')]: 'KEY_live',
      [arn('openai-webhook')]: `whsec_${Buffer.alloc(32, 9).toString('base64')}`,
      [arn('twilio')]: 'twilio-token',
      [arn('jwks')]: JWKS,
      [arn('signing')]: SIGNING_PEM,
      [arn('google-oauth')]: '{"client_id":"google-live","client_secret":"google-secret"}',
      [arn('microsoft-oauth')]: '{"client_id":"microsoft-live","client_secret":"microsoft-secret"}',
    };
    const resolver: SecretResolver = {
      resolve: (id) =>
        values[id] === undefined
          ? Promise.reject(new Error('ResourceNotFound'))
          : Promise.resolve(values[id]),
    };
    const production = {
      VELYRIC_ENV: 'production',
      VELYRIC_DATABASE_URL_SECRET_ARN: arn('database'),
      VELYRIC_REDIS_URL_SECRET_ARN: arn('redis'),
      VELYRIC_NATS_URL: 'tls://nats.internal:4222',
      VELYRIC_PUBLIC_WEB_ORIGIN: 'https://velyric.com',
      VELYRIC_PUBLIC_API_ORIGIN: 'https://api.velyric.com',
      CONTROL_API_CORS_ALLOWED_ORIGINS: 'https://velyric.com,https://app.velyric.com',
      CONTROL_API_CURSOR_KEY_SECRET_ARN: arn('key'),
      CONTROL_API_API_KEY_PEPPER_SECRET_ARN: arn('key'),
      CONTROL_API_STATE_KEY_SECRET_ARN: arn('key'),
      VELYRIC_SESSION_SIGNING_KEY_SECRET_ARN: arn('session'),
      VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN: arn('stripe'),
      VELYRIC_STRIPE_WEBHOOK_SIGNING_SECRET_ARN: arn('stripe-webhook'),
      VELYRIC_TELNYX_API_KEY_SECRET_ARN: arn('telnyx'),
      VELYRIC_TELNYX_WEBHOOK_PUBLIC_KEY: Buffer.alloc(32, 5).toString('base64'),
      VELYRIC_OPENAI_WEBHOOK_SECRET_ARN: arn('openai-webhook'),
      VELYRIC_TWILIO_AUTH_TOKEN_SECRET_ARN: arn('twilio'),
      VELYRIC_SERVICE_JWKS_SECRET_ARN: arn('jwks'),
      VELYRIC_TERMS_VERSION: '2026-09-01',
      VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN: arn('signing'),
      CONTROL_API_SERVICE_KEY_ID: 'control-api-2026-09',
      CONTROL_API_GOOGLE_OAUTH_CLIENT_SECRET_ARN: arn('google-oauth'),
      CONTROL_API_MICROSOFT_OAUTH_CLIENT_SECRET_ARN: arn('microsoft-oauth'),
      VELYRIC_S3_BUCKET_PREFIX: 'velyric-production-eu-central-1',
    };
    const config = await loadControlApiConfig(production, resolver);
    expect(config.s3).toEqual({ bucketPrefix: 'velyric-production-eu-central-1', endpoint: null });
    expect(config.requireVectorSearch).toBe(true);
    expect(
      await issuesOf(
        loadControlApiConfig(
          {
            ...production,
            CONTROL_API_REQUIRE_VECTOR_SEARCH: 'false',
            VELYRIC_S3_ENDPOINT: 'http://minio:9000',
          },
          resolver,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'VELYRIC_S3_ENDPOINT is only allowed in local and ci',
        'CONTROL_API_REQUIRE_VECTOR_SEARCH cannot be disabled in staging or production',
      ]),
    );
    expect(config.oauthClients.MICROSOFT.clientId).toBe('microsoft-live');
    expect(config.oauthClients.GOOGLE.clientSecret.reveal()).toBe('google-secret');
    expect(config.providerModes.STRIPE).toBe('live');
    expect(config.stripe.webhookSecrets.map((secret) => secret.reveal())).toEqual([
      'whsec_a',
      'whsec_b',
    ]);
    expect(config.databaseAssumeRole).toBe(false);

    const insecure = await issuesOf(
      loadControlApiConfig(
        {
          ...production,
          CONTROL_API_CORS_ALLOWED_ORIGINS: 'http://velyric.com',
          VELYRIC_REDIS_URL_SECRET_ARN: arn('missing'),
        },
        resolver,
      ),
    );
    expect(insecure).toEqual(
      expect.arrayContaining([
        'CONTROL_API_CORS_ALLOWED_ORIGINS contains an invalid origin http://velyric.com',
        'VELYRIC_REDIS_URL_SECRET_ARN could not be resolved: Error',
      ]),
    );
  });
});
