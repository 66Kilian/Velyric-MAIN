import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadWorkflowWorkerConfig,
  providerBaseUrl,
  type SecretResolver,
} from '../src/config.js';

const resolver: SecretResolver = {
  resolve: (arn) =>
    Promise.resolve(
      arn.endsWith('database')
        ? 'postgres://svc@db.internal:5432/velyric'
        : arn.endsWith('smtp')
          ? 'smtps://svc@mail.internal:465'
          : `resolved:${arn.split(':').at(-1) ?? ''}`,
    ),
};

const JWKS =
  '{"keys":[{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","kid":"control-api-1"}]}';

const LOCAL = {
  VELYRIC_ENV: 'ci',
  VELYRIC_AWS_REGION: 'eu-central-1',
  VELYRIC_DATABASE_URL_SECRET: 'postgres://velyric:velyric@127.0.0.1:5432/velyric',
  VELYRIC_TEMPORAL_ADDRESS: '127.0.0.1:7233',
  VELYRIC_NATS_URL: 'nats://127.0.0.1:4222',
  VELYRIC_REDIS_URL: 'redis://127.0.0.1:6379',
  VELYRIC_SERVICE_JWKS: JWKS,
  VELYRIC_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
  VELYRIC_PROVIDER_SIMULATOR_URL: 'http://127.0.0.1:7900',
  WORKFLOW_WORKER_EMAIL_FROM: 'Velyric <noreply@velyric.test>',
  VELYRIC_SMTP_URL_SECRET: 'smtp://user:pass@127.0.0.1:1025',
};

const ARN = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:velyric/production';

const PRODUCTION = {
  VELYRIC_ENV: 'production',
  VELYRIC_AWS_REGION: 'eu-central-1',
  VELYRIC_DATABASE_URL_SECRET_ARN: `${ARN}/database`,
  VELYRIC_NATS_CREDS_SECRET_ARN: `${ARN}/nats`,
  VELYRIC_TEMPORAL_ADDRESS: 'velyric.a1b2c.tmprl.cloud:7233',
  VELYRIC_TEMPORAL_API_KEY_SECRET_ARN: `${ARN}/temporal`,
  VELYRIC_NATS_URL: 'tls://nats.internal:4222',
  VELYRIC_REDIS_URL: 'rediss://redis.internal:6379',
  VELYRIC_SERVICE_JWKS: JWKS,
  VELYRIC_PUBLIC_WEB_ORIGIN: 'https://velyric.ai',
  WORKFLOW_WORKER_OPENAI_ADMIN_KEY_SECRET_ARN: `${ARN}/openai-admin`,
  VELYRIC_TELNYX_API_KEY_SECRET_ARN: `${ARN}/telnyx`,
  WORKFLOW_WORKER_TELNYX_CONNECTION_ID: '2217001234',
  VELYRIC_BILLINGO_API_KEY_SECRET_ARN: `${ARN}/billingo`,
  WORKFLOW_WORKER_BILLINGO_BLOCK_ID: '150123',
  VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN: `${ARN}/stripe`,
  WORKFLOW_WORKER_EMAIL_FROM: 'Velyric <szamla@velyric.ai>',
  VELYRIC_SMTP_URL_SECRET_ARN: `${ARN}/smtp`,
  WORKFLOW_WORKER_OPENAI_SPEND_LIMITS_USD: '{"START":150,"PRO":400}',
};

async function issues(env: Record<string, string>): Promise<readonly string[]> {
  try {
    await loadWorkflowWorkerConfig(env, resolver);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

describe('workflow worker configuration', () => {
  it('runs every provider against the simulator in ci without real credentials', async () => {
    const config = await loadWorkflowWorkerConfig(LOCAL, resolver);
    expect(config.providerModes).toEqual({
      OPENAI: 'simulator',
      TELNYX: 'simulator',
      BILLINGO: 'simulator',
      STRIPE: 'simulator',
    });
    expect(providerBaseUrl(config, 'OPENAI')).toBe('http://127.0.0.1:7900/openai/v1');
    expect(providerBaseUrl(config, 'BILLINGO')).toBe('http://127.0.0.1:7900/billingo/v3');
    expect(config.temporal).toEqual({
      address: '127.0.0.1:7233',
      namespace: 'velyric-ci',
      apiKey: null,
      tls: false,
    });
    expect(config.streamReplicas).toBe(1);
  });

  it('resolves every production secret from Secrets Manager and uses live providers', async () => {
    const config = await loadWorkflowWorkerConfig(PRODUCTION, resolver);
    expect(config.databaseUrl).toBe('postgres://svc@db.internal:5432/velyric');
    expect(config.billingo).toEqual({
      apiKey: 'resolved:velyric/production/billingo',
      blockId: 150_123,
    });
    expect(config.temporal.tls).toBe(true);
    expect(providerBaseUrl(config, 'OPENAI')).toBeUndefined();
    expect(providerBaseUrl(config, 'BILLINGO')).toBe('https://api.billingo.hu/v3');
    expect(config.openAiMonthlySpendLimitUsd).toEqual({ START: 150, PRO: 400 });
  });

  it('fails closed when production is misconfigured', async () => {
    const found = await issues({
      ...PRODUCTION,
      VELYRIC_PROVIDER_MODE_BILLINGO: 'simulator',
      VELYRIC_STRIPE_SECRET_KEY_SECRET: 'sk_live_plaintext',
      VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN: '',
      VELYRIC_NATS_URL: 'nats://nats.internal:4222',
      VELYRIC_SMTP_URL_SECRET: 'smtp://mail.internal',
      VELYRIC_SMTP_URL_SECRET_ARN: '',
      WORKFLOW_WORKER_TELNYX_CONNECTION_ID: '',
    });
    expect(found).toEqual(
      expect.arrayContaining([
        'VELYRIC_PROVIDER_MODE_BILLINGO=simulator is not allowed in production',
        'VELYRIC_STRIPE_SECRET_KEY_SECRET is not allowed in production; use VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN',
        'VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)',
        'VELYRIC_SMTP_URL_SECRET is not allowed in production; use VELYRIC_SMTP_URL_SECRET_ARN',
        'WORKFLOW_WORKER_TELNYX_CONNECTION_ID is required',
      ]),
    );
    expect(JSON.stringify(found)).not.toContain('sk_live_plaintext');
  });

  it('requires staging to use provider sandboxes with real credentials', async () => {
    const found = await issues({
      ...PRODUCTION,
      VELYRIC_ENV: 'staging',
      VELYRIC_PROVIDER_MODE_OPENAI: 'live',
      VELYRIC_TELNYX_API_KEY_SECRET_ARN: '',
      WORKFLOW_WORKER_OPENAI_SPEND_LIMITS_USD: '{"START":-1}',
    });
    expect(found).toEqual(
      expect.arrayContaining([
        'VELYRIC_PROVIDER_MODE_OPENAI=live is not allowed in staging',
        'VELYRIC_TELNYX_API_KEY_SECRET_ARN is required',
        'WORKFLOW_WORKER_OPENAI_SPEND_LIMITS_USD must be a JSON object of plan code to positive USD amounts',
      ]),
    );
  });
});
