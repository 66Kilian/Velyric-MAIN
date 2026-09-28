import type { VelyricEnvironment } from '@velyric/contracts';

export interface SecretResolver {
  resolve(arn: string): Promise<string>;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid connector-worker configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type ProviderMode = 'simulator' | 'sandbox' | 'live';

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface CalendarProviderConfig {
  readonly mode: ProviderMode;
  readonly apiBaseUrl: string;
  readonly tokenUrl: string;
  readonly client: OAuthClient | null;
  readonly simulatorUpstreamHost: string | null;
}

export const SIMULATOR_HOSTNAME = 'provider-simulator.velyric.internal';

export interface ConnectorWorkerConfig {
  readonly environment: VelyricEnvironment;
  readonly awsRegion: string;
  readonly logLevel: string;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly databaseAssumeRole: boolean;
  readonly natsUrl: string;
  readonly natsCreds: string | null;
  readonly redisUrl: string;
  readonly serviceJwks: string;
  readonly egressAllowHttp: boolean;
  readonly localVaultDir: string | null;
  readonly google: CalendarProviderConfig;
  readonly microsoft: CalendarProviderConfig;
}

const ENVIRONMENTS: readonly VelyricEnvironment[] = ['local', 'ci', 'staging', 'production'];
const MODES_BY_ENVIRONMENT: Readonly<Record<VelyricEnvironment, readonly ProviderMode[]>> = {
  local: ['simulator', 'sandbox'],
  ci: ['simulator'],
  staging: ['sandbox'],
  production: ['live'],
};
const DEFAULT_MODE: Readonly<Record<VelyricEnvironment, ProviderMode>> = {
  local: 'simulator',
  ci: 'simulator',
  staging: 'sandbox',
  production: 'live',
};

class Reader {
  readonly issues: string[] = [];
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.#env = env;
  }

  optional(name: string): string | undefined {
    const value = this.#env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  required(name: string): string {
    const value = this.optional(name);
    if (value === undefined) {
      this.issues.push(`${name} is required`);
      return '';
    }
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.optional(name);
    if (value === undefined) {
      return fallback;
    }
    if (value !== 'true' && value !== 'false') {
      this.issues.push(`${name} must be true or false`);
      return fallback;
    }
    return value === 'true';
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const value = this.optional(name);
    if (value === undefined) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.issues.push(`${name} must be an integer between ${String(min)} and ${String(max)}`);
      return fallback;
    }
    return parsed;
  }
}

async function readSecret(
  reader: Reader,
  environment: VelyricEnvironment,
  resolver: SecretResolver,
  name: string,
  required: boolean,
): Promise<string | null> {
  const plain = reader.optional(`${name}_SECRET`);
  const arn = reader.optional(`${name}_SECRET_ARN`);
  if (plain !== undefined && arn !== undefined) {
    reader.issues.push(`only one of ${name}_SECRET and ${name}_SECRET_ARN may be set`);
    return null;
  }
  if (plain !== undefined) {
    if (environment === 'staging' || environment === 'production') {
      reader.issues.push(`${name}_SECRET is not allowed in ${environment}; use ${name}_SECRET_ARN`);
      return null;
    }
    return plain;
  }
  if (arn !== undefined) {
    if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)) {
      reader.issues.push(`${name}_SECRET_ARN must be a Secrets Manager ARN`);
      return null;
    }
    try {
      return await resolver.resolve(arn);
    } catch (error) {
      reader.issues.push(
        `${name}_SECRET_ARN could not be resolved: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return null;
    }
  }
  if (required) {
    reader.issues.push(
      environment === 'local' || environment === 'ci'
        ? `${name}_SECRET or ${name}_SECRET_ARN is required`
        : `${name}_SECRET_ARN is required`,
    );
  }
  return null;
}

function parseClient(reader: Reader, name: string, raw: string | null): OAuthClient | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const clientId = record['client_id'];
      const clientSecret = record['client_secret'];
      if (
        typeof clientId === 'string' &&
        clientId !== '' &&
        typeof clientSecret === 'string' &&
        clientSecret !== ''
      ) {
        return { clientId, clientSecret };
      }
    }
  } catch {
    reader.issues.push(`${name} must be JSON with client_id and client_secret`);
    return null;
  }
  reader.issues.push(`${name} must be JSON with client_id and client_secret`);
  return null;
}

async function calendarProvider(
  reader: Reader,
  environment: VelyricEnvironment,
  resolver: SecretResolver,
  provider: 'GOOGLE' | 'MICROSOFT',
  simulatorUrl: string | undefined,
): Promise<CalendarProviderConfig> {
  const raw = reader.optional(`VELYRIC_PROVIDER_MODE_${provider}`) ?? DEFAULT_MODE[environment];
  const allowed = MODES_BY_ENVIRONMENT[environment];
  const mode = (allowed as readonly string[]).includes(raw)
    ? (raw as ProviderMode)
    : DEFAULT_MODE[environment];
  if (!(allowed as readonly string[]).includes(raw)) {
    reader.issues.push(`VELYRIC_PROVIDER_MODE_${provider}=${raw} is not allowed in ${environment}`);
  }
  const secretName = `CONNECTOR_WORKER_${provider}_OAUTH_CLIENT`;
  const client = parseClient(
    reader,
    secretName,
    await readSecret(reader, environment, resolver, secretName, mode !== 'simulator'),
  );
  if (mode === 'simulator') {
    if (simulatorUrl === undefined) {
      reader.issues.push(
        `VELYRIC_PROVIDER_SIMULATOR_URL is required when VELYRIC_PROVIDER_MODE_${provider}=simulator`,
      );
    }
    let base = '';
    let upstreamHost: string | null = null;
    if (simulatorUrl !== undefined) {
      try {
        const parsed = new URL(simulatorUrl);
        upstreamHost = parsed.hostname.replace(/^\[|\]$/g, '');
        parsed.hostname = SIMULATOR_HOSTNAME;
        base = parsed.toString().replace(/\/$/, '');
      } catch {
        reader.issues.push('VELYRIC_PROVIDER_SIMULATOR_URL must be a valid URL');
      }
    }
    const segment = provider === 'GOOGLE' ? 'google' : 'microsoft';
    return {
      mode,
      apiBaseUrl: `${base}/${segment}/api`,
      tokenUrl: `${base}/${segment}/token`,
      client,
      simulatorUpstreamHost: upstreamHost,
    };
  }
  return provider === 'GOOGLE'
    ? {
        mode,
        apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        client,
        simulatorUpstreamHost: null,
      }
    : {
        mode,
        apiBaseUrl: 'https://graph.microsoft.com/v1.0',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        client,
        simulatorUpstreamHost: null,
      };
}

export async function loadConnectorWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  resolver: SecretResolver,
): Promise<ConnectorWorkerConfig> {
  const reader = new Reader(env);
  const rawEnvironment = reader.required('VELYRIC_ENV');
  const environment = (ENVIRONMENTS as readonly string[]).includes(rawEnvironment)
    ? (rawEnvironment as VelyricEnvironment)
    : 'production';
  if (rawEnvironment !== '' && !(ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    reader.issues.push('VELYRIC_ENV must be one of local, ci, staging, production');
  }
  const deployed = environment === 'staging' || environment === 'production';
  const awsRegion = reader.required('VELYRIC_AWS_REGION');
  if (awsRegion !== '' && !/^[a-z]{2}-[a-z]+-\d$/.test(awsRegion)) {
    reader.issues.push('VELYRIC_AWS_REGION must be an AWS region such as eu-central-1');
  }
  const natsUrl = reader.required('VELYRIC_NATS_URL');
  if (
    natsUrl !== '' &&
    !natsUrl
      .split(',')
      .every(
        (part) =>
          part.trim().startsWith('tls://') || (!deployed && part.trim().startsWith('nats://')),
      )
  ) {
    reader.issues.push(
      'VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)',
    );
  }
  const redisUrl = reader.required('VELYRIC_REDIS_URL');
  if (
    redisUrl !== '' &&
    !(redisUrl.startsWith('rediss://') || (!deployed && redisUrl.startsWith('redis://')))
  ) {
    reader.issues.push(
      'VELYRIC_REDIS_URL must use rediss:// (redis:// is allowed only in local and ci)',
    );
  }
  const serviceJwks = reader.required('VELYRIC_SERVICE_JWKS');
  if (serviceJwks !== '') {
    try {
      const parsed = JSON.parse(serviceJwks) as { keys?: unknown };
      if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
        reader.issues.push('VELYRIC_SERVICE_JWKS must contain at least one key');
      }
    } catch {
      reader.issues.push('VELYRIC_SERVICE_JWKS must be a JSON Web Key Set');
    }
  }
  const egressAllowHttp = reader.boolean('CONNECTOR_WORKER_EGRESS_ALLOW_HTTP', false);
  if (egressAllowHttp && environment !== 'local' && environment !== 'ci') {
    reader.issues.push('CONNECTOR_WORKER_EGRESS_ALLOW_HTTP is only allowed in local and ci');
  }
  const localVaultDir = reader.optional('CONNECTOR_WORKER_LOCAL_VAULT_DIR') ?? null;
  if (localVaultDir !== null && deployed) {
    reader.issues.push('CONNECTOR_WORKER_LOCAL_VAULT_DIR is not allowed in staging or production');
  }
  const simulatorUrl = reader.optional('VELYRIC_PROVIDER_SIMULATOR_URL');
  const databaseUrl =
    (await readSecret(reader, environment, resolver, 'VELYRIC_DATABASE_URL', true)) ?? '';
  if (databaseUrl !== '' && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    reader.issues.push('VELYRIC_DATABASE_URL must be a postgres URL');
  }
  const natsCreds = await readSecret(reader, environment, resolver, 'VELYRIC_NATS_CREDS', deployed);
  const google = await calendarProvider(reader, environment, resolver, 'GOOGLE', simulatorUrl);
  const microsoft = await calendarProvider(
    reader,
    environment,
    resolver,
    'MICROSOFT',
    simulatorUrl,
  );
  const config: ConnectorWorkerConfig = {
    environment,
    awsRegion,
    logLevel: reader.optional('VELYRIC_LOG_LEVEL') ?? 'info',
    host: reader.optional('CONNECTOR_WORKER_HOST') ?? (deployed ? '0.0.0.0' : '127.0.0.1'),
    port: reader.integer('CONNECTOR_WORKER_PORT', 7_300, 1, 65_535),
    databaseUrl,
    databaseAssumeRole: reader.boolean(
      'CONNECTOR_WORKER_DATABASE_ASSUME_ROLE',
      environment === 'local',
    ),
    natsUrl,
    natsCreds,
    redisUrl,
    serviceJwks,
    egressAllowHttp,
    localVaultDir,
    google,
    microsoft,
  };
  if (reader.issues.length > 0) {
    throw new ConfigError(reader.issues);
  }
  return config;
}
