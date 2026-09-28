import { ProviderMode, VelyricEnvironment } from '@velyric/contracts';
import { SecretValue } from '@velyric/security';

export const CONFIGURED_PROVIDERS = [
  'STRIPE',
  'TELNYX',
  'OPENAI',
  'TWILIO',
  'GOOGLE',
  'MICROSOFT',
] as const;
export type ConfiguredProvider = (typeof CONFIGURED_PROVIDERS)[number];

export interface SecretResolver {
  resolve(arn: string): Promise<string>;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`CONFIG_INVALID:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface ControlApiConfig {
  readonly environment: VelyricEnvironment;
  readonly host: string;
  readonly publicPort: number;
  readonly internalPort: number;
  readonly databaseUrl: SecretValue;
  readonly databaseAssumeRole: boolean;
  readonly redisUrl: SecretValue;
  readonly natsUrl: string;
  readonly publicWebOrigin: string;
  readonly publicApiOrigin: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly awsRegion: string;
  readonly cursorKey: Buffer;
  readonly apiKeyPepper: Buffer;
  readonly stateKey: Buffer;
  readonly providerModes: Readonly<Record<ConfiguredProvider, ProviderMode>>;
  readonly providerSimulatorUrl: string | null;
  readonly sessionSecret: SecretValue;
  readonly turnstileSecretKey: string | null;
  readonly stripe: {
    readonly secretKey: SecretValue;
    readonly webhookSecrets: readonly SecretValue[];
  };
  readonly telnyx: { readonly apiKey: SecretValue; readonly webhookPublicKey: string };
  readonly openai: { readonly webhookSecrets: readonly SecretValue[] };
  readonly twilio: { readonly authToken: SecretValue };
  readonly serviceJwks: string;
  readonly termsVersion: string;
  readonly serviceSigningKeyPem: SecretValue;
  readonly serviceKeyId: string;
  readonly oauthClients: Readonly<
    Record<
      'GOOGLE' | 'MICROSOFT',
      { readonly clientId: string; readonly clientSecret: SecretValue }
    >
  >;
  readonly localVaultDir: string | null;
  readonly s3: { readonly bucketPrefix: string; readonly endpoint: string | null };
  readonly requireVectorSearch: boolean;
  readonly webTestCallEnabled: boolean;
}

const ALLOWED_MODES: Readonly<Record<VelyricEnvironment, readonly ProviderMode[]>> = {
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

type Env = Readonly<Record<string, string | undefined>>;

class Reader {
  readonly issues: string[] = [];
  readonly #env: Env;

  constructor(env: Env) {
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

  port(name: string, fallback: number): number {
    const raw = this.optional(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      this.issues.push(`${name} must be a TCP port`);
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T | undefined): T {
    const raw = this.optional(name);
    if (raw === undefined) {
      if (fallback === undefined) {
        this.issues.push(`${name} is required`);
        return allowed[0] as T;
      }
      return fallback;
    }
    if (!(allowed as readonly string[]).includes(raw)) {
      this.issues.push(`${name} must be one of ${allowed.join(', ')}`);
      return fallback ?? (allowed[0] as T);
    }
    return raw as T;
  }

  url(name: string, protocols: readonly string[], fallback?: string): string {
    const raw = this.optional(name) ?? fallback;
    if (raw === undefined) {
      this.issues.push(`${name} is required`);
      return '';
    }
    try {
      const parsed = new URL(raw);
      if (!protocols.includes(parsed.protocol)) {
        this.issues.push(`${name} must use ${protocols.join(' or ')}`);
      }
      return raw;
    } catch {
      this.issues.push(`${name} must be a valid URL`);
      return '';
    }
  }
}

async function readSecret(
  reader: Reader,
  environment: VelyricEnvironment,
  resolver: SecretResolver,
  name: string,
  simulatorDefault: string | null,
): Promise<string> {
  const plain = reader.optional(`${name}_SECRET`);
  const arn = reader.optional(`${name}_SECRET_ARN`);
  if (plain !== undefined && arn !== undefined) {
    reader.issues.push(`only one of ${name}_SECRET and ${name}_SECRET_ARN may be set`);
    return '';
  }
  if (plain !== undefined) {
    if (environment === 'staging' || environment === 'production') {
      reader.issues.push(`${name}_SECRET is not allowed in ${environment}; use ${name}_SECRET_ARN`);
      return '';
    }
    return plain;
  }
  if (arn !== undefined) {
    if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)) {
      reader.issues.push(`${name}_SECRET_ARN must be a Secrets Manager ARN`);
      return '';
    }
    try {
      return await resolver.resolve(arn);
    } catch (error) {
      reader.issues.push(
        `${name}_SECRET_ARN could not be resolved: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return '';
    }
  }
  if (simulatorDefault !== null) {
    return simulatorDefault;
  }
  reader.issues.push(
    `${name}_SECRET${environment === 'local' || environment === 'ci' ? '' : '_ARN'} is required`,
  );
  return '';
}

/**
 * Same SECRET/SECRET_ARN convention as readSecret, but absence is not an
 * error: it means the feature stays off until the secret is configured.
 */
async function readOptionalSecret(
  reader: Reader,
  environment: VelyricEnvironment,
  resolver: SecretResolver,
  name: string,
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
  if (arn === undefined) {
    return null;
  }
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

function binaryKey(reader: Reader, name: string, value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (value !== '' && decoded.length < 32) {
    reader.issues.push(`${name} must be base64 encoding at least 32 bytes`);
  }
  return decoded;
}

function secretList(value: string): SecretValue[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => new SecretValue(item));
}

function secretOrPlaceholder(value: string): SecretValue {
  return new SecretValue(value === '' ? 'unset' : value);
}

export async function loadControlApiConfig(
  env: Env,
  resolver: SecretResolver,
): Promise<ControlApiConfig> {
  const reader = new Reader(env);
  const environment = reader.oneOf('VELYRIC_ENV', Object.values(VelyricEnvironment), undefined);
  const providerModes = {} as Record<ConfiguredProvider, ProviderMode>;
  for (const provider of CONFIGURED_PROVIDERS) {
    const mode = reader.oneOf(
      `VELYRIC_PROVIDER_MODE_${provider}`,
      Object.values(ProviderMode),
      DEFAULT_MODE[environment],
    );
    if (!ALLOWED_MODES[environment].includes(mode)) {
      reader.issues.push(
        `VELYRIC_PROVIDER_MODE_${provider}=${mode} is not allowed when VELYRIC_ENV=${environment}`,
      );
    }
    providerModes[provider] = mode;
  }
  const usesSimulator = Object.values(providerModes).includes('simulator');
  const providerSimulatorUrl = usesSimulator
    ? reader.url('VELYRIC_PROVIDER_SIMULATOR_URL', ['http:', 'https:'])
    : null;
  const simulated = (provider: ConfiguredProvider, value: string): string | null =>
    providerModes[provider] === 'simulator' ? value : null;
  const secret = (name: string, simulatorDefault: string | null = null): Promise<string> =>
    readSecret(reader, environment, resolver, name, simulatorDefault);

  const productionLike = environment === 'staging' || environment === 'production';
  const corsRaw = reader.required('CONTROL_API_CORS_ALLOWED_ORIGINS');
  const corsAllowedOrigins = corsRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of corsAllowedOrigins) {
    if (
      origin === '*' ||
      !/^https?:\/\/[^/]+$/.test(origin) ||
      (productionLike && !origin.startsWith('https://'))
    ) {
      reader.issues.push(`CONTROL_API_CORS_ALLOWED_ORIGINS contains an invalid origin ${origin}`);
    }
  }

  const [
    databaseUrl,
    redisUrl,
    cursorKey,
    apiKeyPepper,
    stateKey,
    sessionSecret,
    stripeSecretKey,
    stripeWebhookSecrets,
    telnyxApiKey,
    openaiWebhookSecrets,
    twilioAuthToken,
    serviceJwks,
    serviceSigningKey,
    googleOauthClient,
    microsoftOauthClient,
    turnstileSecretKey,
  ] = await Promise.all([
    secret('VELYRIC_DATABASE_URL'),
    secret('VELYRIC_REDIS_URL'),
    secret('CONTROL_API_CURSOR_KEY'),
    secret('CONTROL_API_API_KEY_PEPPER'),
    secret('CONTROL_API_STATE_KEY'),
    secret('VELYRIC_SESSION_SIGNING_KEY'),
    secret('VELYRIC_STRIPE_SECRET_KEY', simulated('STRIPE', 'sk_test_simulator')),
    secret('VELYRIC_STRIPE_WEBHOOK_SIGNING', simulated('STRIPE', 'whsec_simulator')),
    secret('VELYRIC_TELNYX_API_KEY', simulated('TELNYX', 'KEY_simulator')),
    secret('VELYRIC_OPENAI_WEBHOOK', simulated('OPENAI', 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')),
    secret('VELYRIC_TWILIO_AUTH_TOKEN', simulated('TWILIO', 'simulator-auth-token')),
    secret('VELYRIC_SERVICE_JWKS'),
    secret('VELYRIC_SERVICE_SIGNING_KEY'),
    secret(
      'CONTROL_API_GOOGLE_OAUTH_CLIENT',
      simulated(
        'GOOGLE',
        '{"client_id":"simulator-google","client_secret":"simulator-google-secret"}',
      ),
    ),
    secret(
      'CONTROL_API_MICROSOFT_OAUTH_CLIENT',
      simulated(
        'MICROSOFT',
        '{"client_id":"simulator-microsoft","client_secret":"simulator-microsoft-secret"}',
      ),
    ),
    readOptionalSecret(reader, environment, resolver, 'VELYRIC_TURNSTILE'),
  ]);

  if (databaseUrl !== '' && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    reader.issues.push('VELYRIC_DATABASE_URL must be a postgres URL');
  }
  if (redisUrl !== '' && !/^rediss?:\/\//.test(redisUrl)) {
    reader.issues.push('VELYRIC_REDIS_URL must be a redis URL');
  }
  if (productionLike && redisUrl.startsWith('redis://')) {
    reader.issues.push('VELYRIC_REDIS_URL must use TLS (rediss://) outside local and ci');
  }
  if (sessionSecret !== '' && sessionSecret.length < 32) {
    reader.issues.push('VELYRIC_SESSION_SIGNING_KEY must be at least 32 characters');
  }
  if (serviceJwks !== '') {
    try {
      const parsed = JSON.parse(serviceJwks) as { keys?: unknown };
      if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
        reader.issues.push('VELYRIC_SERVICE_JWKS must be a JWKS with at least one key');
      }
    } catch {
      reader.issues.push('VELYRIC_SERVICE_JWKS must be JSON');
    }
  }

  const telnyxWebhookPublicKey =
    reader.optional('VELYRIC_TELNYX_WEBHOOK_PUBLIC_KEY') ??
    (providerModes.TELNYX === 'simulator'
      ? Buffer.alloc(32, 1).toString('base64')
      : reader.required('VELYRIC_TELNYX_WEBHOOK_PUBLIC_KEY'));

  if (serviceSigningKey !== '' && !serviceSigningKey.includes('BEGIN PRIVATE KEY')) {
    reader.issues.push('VELYRIC_SERVICE_SIGNING_KEY must be a PKCS#8 PEM private key');
  }
  const oauthClient = (
    name: string,
    raw: string,
  ): { readonly clientId: string; readonly clientSecret: SecretValue } => {
    if (raw === '') {
      return { clientId: '', clientSecret: secretOrPlaceholder('') };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clientId = parsed['client_id'];
      const clientSecret = parsed['client_secret'];
      if (
        typeof clientId === 'string' &&
        clientId !== '' &&
        typeof clientSecret === 'string' &&
        clientSecret !== ''
      ) {
        return { clientId, clientSecret: new SecretValue(clientSecret) };
      }
    } catch {
      reader.issues.push(`${name} must be JSON with client_id and client_secret`);
      return { clientId: '', clientSecret: secretOrPlaceholder('') };
    }
    reader.issues.push(`${name} must be JSON with client_id and client_secret`);
    return { clientId: '', clientSecret: secretOrPlaceholder('') };
  };
  const localVaultDir = reader.optional('CONTROL_API_LOCAL_VAULT_DIR') ?? null;
  if (localVaultDir !== null && productionLike) {
    reader.issues.push('CONTROL_API_LOCAL_VAULT_DIR is only allowed in local and ci');
  }
  const s3BucketPrefix =
    reader.optional('VELYRIC_S3_BUCKET_PREFIX') ??
    (productionLike ? reader.required('VELYRIC_S3_BUCKET_PREFIX') : 'velyric-local');
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(s3BucketPrefix)) {
    reader.issues.push('VELYRIC_S3_BUCKET_PREFIX must be 3-41 lowercase letters, digits or dashes');
  }
  const s3Endpoint = reader.optional('VELYRIC_S3_ENDPOINT') ?? null;
  if (s3Endpoint !== null && productionLike) {
    reader.issues.push('VELYRIC_S3_ENDPOINT is only allowed in local and ci');
  }
  if (s3Endpoint !== null && !/^https?:\/\/[^/]+\/?$/.test(s3Endpoint)) {
    reader.issues.push('VELYRIC_S3_ENDPOINT must be an http(s) origin');
  }
  const vectorRaw = reader.optional('CONTROL_API_REQUIRE_VECTOR_SEARCH');
  if (vectorRaw !== undefined && vectorRaw !== 'true' && vectorRaw !== 'false') {
    reader.issues.push('CONTROL_API_REQUIRE_VECTOR_SEARCH must be true or false');
  }
  if (vectorRaw === 'false' && productionLike) {
    reader.issues.push(
      'CONTROL_API_REQUIRE_VECTOR_SEARCH cannot be disabled in staging or production',
    );
  }
  const serviceKeyId = reader.required('CONTROL_API_SERVICE_KEY_ID');
  const termsVersion = reader.required('VELYRIC_TERMS_VERSION');
  if (termsVersion !== '' && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(termsVersion)) {
    reader.issues.push('VELYRIC_TERMS_VERSION must be a YYYY-MM-DD date');
  }

  const config: ControlApiConfig = {
    environment,
    host: reader.optional('CONTROL_API_HOST') ?? '0.0.0.0',
    publicPort: reader.port('CONTROL_API_PUBLIC_PORT', 4000),
    internalPort: reader.port('CONTROL_API_INTERNAL_PORT', 4001),
    databaseUrl: secretOrPlaceholder(databaseUrl),
    databaseAssumeRole:
      (reader.optional('CONTROL_API_DATABASE_ASSUME_ROLE') ??
        (environment === 'local' ? 'true' : 'false')) === 'true',
    redisUrl: secretOrPlaceholder(redisUrl),
    natsUrl: reader.url('VELYRIC_NATS_URL', ['nats:', 'tls:']),
    publicWebOrigin: reader.url(
      'VELYRIC_PUBLIC_WEB_ORIGIN',
      productionLike ? ['https:'] : ['http:', 'https:'],
    ),
    publicApiOrigin: reader.url(
      'VELYRIC_PUBLIC_API_ORIGIN',
      productionLike ? ['https:'] : ['http:', 'https:'],
    ),
    corsAllowedOrigins,
    logLevel: reader.oneOf(
      'VELYRIC_LOG_LEVEL',
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      'info',
    ),
    awsRegion: reader.optional('VELYRIC_AWS_REGION') ?? 'eu-central-1',
    cursorKey: binaryKey(reader, 'CONTROL_API_CURSOR_KEY', cursorKey),
    apiKeyPepper: binaryKey(reader, 'CONTROL_API_API_KEY_PEPPER', apiKeyPepper),
    stateKey: binaryKey(reader, 'CONTROL_API_STATE_KEY', stateKey),
    providerModes,
    providerSimulatorUrl,
    sessionSecret: secretOrPlaceholder(sessionSecret),
    turnstileSecretKey,
    stripe: {
      secretKey: secretOrPlaceholder(stripeSecretKey),
      webhookSecrets: secretList(stripeWebhookSecrets),
    },
    telnyx: { apiKey: secretOrPlaceholder(telnyxApiKey), webhookPublicKey: telnyxWebhookPublicKey },
    openai: { webhookSecrets: secretList(openaiWebhookSecrets) },
    twilio: { authToken: secretOrPlaceholder(twilioAuthToken) },
    serviceJwks,
    termsVersion,
    serviceSigningKeyPem: secretOrPlaceholder(serviceSigningKey),
    serviceKeyId,
    oauthClients: {
      GOOGLE: oauthClient('CONTROL_API_GOOGLE_OAUTH_CLIENT', googleOauthClient),
      MICROSOFT: oauthClient('CONTROL_API_MICROSOFT_OAUTH_CLIENT', microsoftOauthClient),
    },
    localVaultDir,
    s3: { bucketPrefix: s3BucketPrefix, endpoint: s3Endpoint },
    requireVectorSearch: vectorRaw === undefined ? productionLike : vectorRaw === 'true',
    webTestCallEnabled: env['VELYRIC_WEB_TEST_CALL_ENABLED'] === 'true',
  };

  if (reader.issues.length > 0) {
    throw new ConfigError(reader.issues);
  }
  return config;
}
