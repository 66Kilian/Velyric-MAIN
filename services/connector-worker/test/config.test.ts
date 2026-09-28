import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  SIMULATOR_HOSTNAME,
  loadConnectorWorkerConfig,
  type SecretResolver,
} from '../src/config.js';

const ARN = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret';
const SECRETS: Readonly<Record<string, string>> = {
  [`${ARN}:database`]: 'postgres://app@db.internal:5432/velyric',
  [`${ARN}:nats`]: '-----BEGIN NATS USER JWT-----',
  [`${ARN}:google-oauth`]: '{"client_id":"g-id","client_secret":"g-secret"}',
  [`${ARN}:microsoft-oauth`]: '{"client_id":"m-id","client_secret":"m-secret"}',
};

const resolver: SecretResolver = {
  resolve: (arn) => {
    const value = SECRETS[arn];
    return value === undefined
      ? Promise.reject(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }))
      : Promise.resolve(value);
  },
};

const JWKS = JSON.stringify({
  keys: [
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      kid: 'control-api-1',
    },
  ],
});

const local: Readonly<Record<string, string>> = {
  VELYRIC_ENV: 'local',
  VELYRIC_AWS_REGION: 'eu-central-1',
  VELYRIC_DATABASE_URL_SECRET: 'postgres://postgres:pw@127.0.0.1:55432/velyric',
  VELYRIC_NATS_URL: 'nats://127.0.0.1:54222',
  VELYRIC_REDIS_URL: 'redis://127.0.0.1:56379',
  VELYRIC_SERVICE_JWKS: JWKS,
  VELYRIC_PROVIDER_SIMULATOR_URL: 'http://127.0.0.1:4010',
  CONNECTOR_WORKER_EGRESS_ALLOW_HTTP: 'true',
  CONNECTOR_WORKER_LOCAL_VAULT_DIR: '.vault',
};

const production: Readonly<Record<string, string>> = {
  VELYRIC_ENV: 'production',
  VELYRIC_AWS_REGION: 'eu-central-1',
  VELYRIC_DATABASE_URL_SECRET_ARN: `${ARN}:database`,
  VELYRIC_NATS_URL: 'tls://nats-1.internal:4222,tls://nats-2.internal:4222',
  VELYRIC_NATS_CREDS_SECRET_ARN: `${ARN}:nats`,
  VELYRIC_REDIS_URL: 'rediss://redis.internal:6379',
  VELYRIC_SERVICE_JWKS: JWKS,
  CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET_ARN: `${ARN}:google-oauth`,
  CONNECTOR_WORKER_MICROSOFT_OAUTH_CLIENT_SECRET_ARN: `${ARN}:microsoft-oauth`,
};

async function issuesOf(env: Readonly<Record<string, string>>): Promise<readonly string[]> {
  try {
    await loadConnectorWorkerConfig(env, resolver);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected configuration to be rejected');
}

describe('connector-worker configuration', () => {
  it('routes simulator traffic through the synthetic simulator host in local development', async () => {
    const config = await loadConnectorWorkerConfig(local, resolver);
    expect(config.google).toEqual({
      mode: 'simulator',
      apiBaseUrl: `http://${SIMULATOR_HOSTNAME}:4010/google/api`,
      tokenUrl: `http://${SIMULATOR_HOSTNAME}:4010/google/token`,
      client: null,
      simulatorUpstreamHost: '127.0.0.1',
    });
    expect(config.microsoft.apiBaseUrl).toBe(`http://${SIMULATOR_HOSTNAME}:4010/microsoft/api`);
    expect([
      config.port,
      config.host,
      config.databaseAssumeRole,
      config.egressAllowHttp,
      config.localVaultDir,
    ]).toEqual([7_300, '127.0.0.1', true, true, '.vault']);
  });

  it('resolves production secrets and uses the live provider endpoints', async () => {
    const config = await loadConnectorWorkerConfig(production, resolver);
    expect(config.google).toEqual({
      mode: 'live',
      apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      client: { clientId: 'g-id', clientSecret: 'g-secret' },
      simulatorUpstreamHost: null,
    });
    expect(config.microsoft.client).toEqual({ clientId: 'm-id', clientSecret: 'm-secret' });
    expect([config.databaseUrl, config.natsCreds, config.host, config.databaseAssumeRole]).toEqual([
      'postgres://app@db.internal:5432/velyric',
      '-----BEGIN NATS USER JWT-----',
      '0.0.0.0',
      false,
    ]);
  });

  it('reports every unsafe production setting at once', async () => {
    const issues = await issuesOf({
      ...local,
      VELYRIC_ENV: 'production',
      VELYRIC_PROVIDER_MODE_GOOGLE: 'simulator',
      VELYRIC_SERVICE_JWKS: '{"keys":[]}',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)',
        'VELYRIC_REDIS_URL must use rediss:// (redis:// is allowed only in local and ci)',
        'VELYRIC_SERVICE_JWKS must contain at least one key',
        'CONNECTOR_WORKER_EGRESS_ALLOW_HTTP is only allowed in local and ci',
        'CONNECTOR_WORKER_LOCAL_VAULT_DIR is not allowed in staging or production',
        'VELYRIC_DATABASE_URL_SECRET is not allowed in production; use VELYRIC_DATABASE_URL_SECRET_ARN',
        'VELYRIC_NATS_CREDS_SECRET_ARN is required',
        'VELYRIC_PROVIDER_MODE_GOOGLE=simulator is not allowed in production',
        'CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET_ARN is required',
        'CONNECTOR_WORKER_MICROSOFT_OAUTH_CLIENT_SECRET_ARN is required',
      ]),
    );
    expect(
      await issuesOf({
        ...production,
        CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET_ARN: `${ARN}:missing`,
      }),
    ).toEqual([
      'CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET_ARN could not be resolved: ResourceNotFoundException',
    ]);
  });
});
