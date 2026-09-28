import { PlanCode, type VelyricEnvironment } from '@velyric/contracts';

export interface SecretResolver {
  resolve(arn: string): Promise<string>;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid workflow-worker configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type ProviderMode = 'simulator' | 'sandbox' | 'live';
type Provider = 'OPENAI' | 'TELNYX' | 'BILLINGO' | 'STRIPE';

export interface WorkflowWorkerConfig {
  readonly environment: VelyricEnvironment;
  readonly awsRegion: string;
  readonly logLevel: string;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly databaseAssumeRole: boolean;
  readonly temporal: {
    readonly address: string;
    readonly namespace: string;
    readonly apiKey: string | null;
    readonly tls: boolean;
  };
  readonly natsUrl: string;
  readonly natsCreds: string | null;
  readonly redisUrl: string;
  readonly serviceJwks: string;
  readonly webOrigin: string;
  readonly providerModes: Readonly<Record<Provider, ProviderMode>>;
  readonly simulatorUrl: string | null;
  readonly openAiAdminKey: string;
  readonly telnyx: { readonly apiKey: string; readonly connectionId: string };
  readonly billingo: { readonly apiKey: string; readonly blockId: number };
  readonly stripeSecretKey: string;
  readonly email: {
    readonly from: string;
    readonly smtpUrl: string;
  };
  readonly googleOauth: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tokenUrl: string;
  } | null;
  readonly localVaultDir: string | null;
  readonly openAiMonthlySpendLimitUsd: Readonly<Record<string, number>>;
  readonly streamReplicas: number;
}

function parseGoogleOauth(
  reader: Reader,
  raw: string | null,
  simulatorUrl: string | null,
): { readonly clientId: string; readonly clientSecret: string; readonly tokenUrl: string } | null {
  if (raw === null) {
    return null;
  }
  const tokenUrl =
    simulatorUrl === null
      ? 'https://oauth2.googleapis.com/token'
      : `${simulatorUrl.replace(/\/$/, '')}/google/token`;
  let record: Record<string, unknown> | null;
  try {
    const parsed: unknown = JSON.parse(raw);
    record =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    record = null;
  }
  const clientId = record?.['client_id'];
  const clientSecret = record?.['client_secret'];
  if (
    typeof clientId !== 'string' ||
    clientId === '' ||
    typeof clientSecret !== 'string' ||
    clientSecret === ''
  ) {
    reader.issues.push(
      'WORKFLOW_WORKER_GOOGLE_OAUTH_CLIENT must be JSON with client_id and client_secret',
    );
    return null;
  }
  return { clientId, clientSecret, tokenUrl };
}

const ENVIRONMENTS: readonly VelyricEnvironment[] = ['local', 'ci', 'staging', 'production'];
const PROVIDERS: readonly Provider[] = ['OPENAI', 'TELNYX', 'BILLINGO', 'STRIPE'];
const ALLOWED: Readonly<Record<VelyricEnvironment, readonly ProviderMode[]>> = {
  local: ['simulator', 'sandbox'],
  ci: ['simulator'],
  staging: ['sandbox'],
  production: ['live'],
};
const DEFAULT: Readonly<Record<VelyricEnvironment, ProviderMode>> = {
  local: 'simulator',
  ci: 'simulator',
  staging: 'sandbox',
  production: 'live',
};
const SIMULATOR_SECRETS: Readonly<Record<string, string>> = {
  WORKFLOW_WORKER_OPENAI_ADMIN_KEY: 'sk-admin-simulator',
  VELYRIC_TELNYX_API_KEY: 'KEY_simulator',
  VELYRIC_BILLINGO_API_KEY: 'billingo-simulator',
  VELYRIC_STRIPE_SECRET_KEY: 'sk_test_simulator',
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

  integer(name: string, fallback: number | undefined, min: number, max: number): number {
    const raw = this.optional(name);
    if (raw === undefined) {
      if (fallback === undefined) {
        this.issues.push(`${name} is required`);
        return min;
      }
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.issues.push(`${name} must be an integer between ${String(min)} and ${String(max)}`);
      return fallback ?? min;
    }
    return parsed;
  }

  boolean(name: string, fallback: boolean): boolean {
    const raw = this.optional(name);
    if (raw === undefined) {
      return fallback;
    }
    if (raw !== 'true' && raw !== 'false') {
      this.issues.push(`${name} must be true or false`);
      return fallback;
    }
    return raw === 'true';
  }
}

async function readSecret(
  reader: Reader,
  environment: VelyricEnvironment,
  resolver: SecretResolver,
  name: string,
  options: { readonly required: boolean; readonly simulatorDefault?: string },
): Promise<string | null> {
  const plain = reader.optional(`${name}_SECRET`);
  const arn = reader.optional(`${name}_SECRET_ARN`);
  const deployed = environment === 'staging' || environment === 'production';
  if (plain !== undefined && arn !== undefined) {
    reader.issues.push(`only one of ${name}_SECRET and ${name}_SECRET_ARN may be set`);
    return null;
  }
  if (plain !== undefined) {
    if (deployed) {
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
  if (options.simulatorDefault !== undefined) {
    return options.simulatorDefault;
  }
  if (options.required) {
    reader.issues.push(
      deployed
        ? `${name}_SECRET_ARN is required`
        : `${name}_SECRET or ${name}_SECRET_ARN is required`,
    );
  }
  return null;
}

export async function loadWorkflowWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  resolver: SecretResolver,
): Promise<WorkflowWorkerConfig> {
  const reader = new Reader(env);
  const rawEnvironment = reader.required('VELYRIC_ENV');
  const environment = (ENVIRONMENTS as readonly string[]).includes(rawEnvironment)
    ? (rawEnvironment as VelyricEnvironment)
    : 'production';
  if (rawEnvironment !== '' && !(ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    reader.issues.push('VELYRIC_ENV must be one of local, ci, staging, production');
  }
  const deployed = environment === 'staging' || environment === 'production';
  const providerModes = {} as Record<Provider, ProviderMode>;
  for (const provider of PROVIDERS) {
    const raw = reader.optional(`VELYRIC_PROVIDER_MODE_${provider}`) ?? DEFAULT[environment];
    if (!(ALLOWED[environment] as readonly string[]).includes(raw)) {
      reader.issues.push(
        `VELYRIC_PROVIDER_MODE_${provider}=${raw} is not allowed in ${environment}`,
      );
    }
    providerModes[provider] = (ALLOWED[environment] as readonly string[]).includes(raw)
      ? (raw as ProviderMode)
      : DEFAULT[environment];
  }
  const usesSimulator = Object.values(providerModes).includes('simulator');
  const simulatorUrl = usesSimulator ? reader.required('VELYRIC_PROVIDER_SIMULATOR_URL') : null;
  if (simulatorUrl !== null && simulatorUrl !== '' && !/^https?:\/\/[^/]+/.test(simulatorUrl)) {
    reader.issues.push('VELYRIC_PROVIDER_SIMULATOR_URL must be an http(s) URL');
  }
  const simulated = (
    provider: Provider,
    name: string,
  ): { readonly required: true; readonly simulatorDefault?: string } => {
    const fallback = SIMULATOR_SECRETS[name];
    return providerModes[provider] === 'simulator' && fallback !== undefined
      ? { required: true, simulatorDefault: fallback }
      : { required: true };
  };

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
  const webOrigin = reader.required('VELYRIC_PUBLIC_WEB_ORIGIN');
  if (
    webOrigin !== '' &&
    !(deployed ? /^https:\/\/[^/]+$/ : /^https?:\/\/[^/]+$/).test(webOrigin)
  ) {
    reader.issues.push('VELYRIC_PUBLIC_WEB_ORIGIN must be an origin (https outside local and ci)');
  }
  const temporalAddress = reader.required('VELYRIC_TEMPORAL_ADDRESS');
  const temporalNamespace =
    reader.optional('VELYRIC_TEMPORAL_NAMESPACE') ?? `velyric-${environment}`;
  const telnyxConnectionId =
    providerModes.TELNYX === 'simulator'
      ? (reader.optional('WORKFLOW_WORKER_TELNYX_CONNECTION_ID') ?? 'simulator-connection')
      : reader.required('WORKFLOW_WORKER_TELNYX_CONNECTION_ID');
  const billingoBlockId =
    providerModes.BILLINGO === 'simulator'
      ? reader.integer('WORKFLOW_WORKER_BILLINGO_BLOCK_ID', 1, 1, 2_147_483_647)
      : reader.integer('WORKFLOW_WORKER_BILLINGO_BLOCK_ID', undefined, 1, 2_147_483_647);
  const emailFrom = reader.required('WORKFLOW_WORKER_EMAIL_FROM');
  const smtpUrl =
    (await readSecret(reader, environment, resolver, 'VELYRIC_SMTP_URL', { required: true })) ?? '';
  if (smtpUrl !== '') {
    try {
      const parsed = new URL(smtpUrl);
      if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
        reader.issues.push('VELYRIC_SMTP_URL must use the smtp: or smtps: scheme');
      } else if (
        deployed &&
        parsed.protocol === 'smtp:' &&
        parsed.searchParams.get('requireTLS') !== 'true'
      ) {
        reader.issues.push(
          'VELYRIC_SMTP_URL must use smtps: or requireTLS=true in staging and production',
        );
      }
    } catch {
      reader.issues.push('VELYRIC_SMTP_URL must be a valid URL');
    }
  }
  const googleOauth = parseGoogleOauth(
    reader,
    await readSecret(reader, environment, resolver, 'WORKFLOW_WORKER_GOOGLE_OAUTH_CLIENT', {
      required: false,
    }),
    simulatorUrl === '' ? null : simulatorUrl,
  );
  const localVaultDir = reader.optional('WORKFLOW_WORKER_LOCAL_VAULT_DIR') ?? null;
  if (localVaultDir !== null && deployed) {
    reader.issues.push('WORKFLOW_WORKER_LOCAL_VAULT_DIR is only allowed in local and ci');
  }
  let spendLimits: Record<string, number> = {};
  const rawLimits = reader.optional('WORKFLOW_WORKER_OPENAI_SPEND_LIMITS_USD');
  if (rawLimits !== undefined) {
    try {
      const parsed = JSON.parse(rawLimits) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        !Object.entries(parsed).every(
          ([key, value]) =>
            (Object.values(PlanCode) as readonly string[]).includes(key) &&
            typeof value === 'number' &&
            value > 0 &&
            value <= 1_000_000,
        )
      ) {
        throw new TypeError('invalid');
      }
      spendLimits = parsed as Record<string, number>;
    } catch {
      reader.issues.push(
        'WORKFLOW_WORKER_OPENAI_SPEND_LIMITS_USD must be a JSON object of plan code to positive USD amounts',
      );
    }
  }

  const databaseUrl =
    (await readSecret(reader, environment, resolver, 'VELYRIC_DATABASE_URL', { required: true })) ??
    '';
  if (databaseUrl !== '' && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    reader.issues.push('VELYRIC_DATABASE_URL must be a postgres URL');
  }
  const natsCreds = await readSecret(reader, environment, resolver, 'VELYRIC_NATS_CREDS', {
    required: deployed,
  });
  const temporalApiKey = await readSecret(
    reader,
    environment,
    resolver,
    'VELYRIC_TEMPORAL_API_KEY',
    { required: false },
  );
  const openAiAdminKey =
    (await readSecret(
      reader,
      environment,
      resolver,
      'WORKFLOW_WORKER_OPENAI_ADMIN_KEY',
      simulated('OPENAI', 'WORKFLOW_WORKER_OPENAI_ADMIN_KEY'),
    )) ?? '';
  const telnyxApiKey =
    (await readSecret(
      reader,
      environment,
      resolver,
      'VELYRIC_TELNYX_API_KEY',
      simulated('TELNYX', 'VELYRIC_TELNYX_API_KEY'),
    )) ?? '';
  const billingoApiKey =
    (await readSecret(
      reader,
      environment,
      resolver,
      'VELYRIC_BILLINGO_API_KEY',
      simulated('BILLINGO', 'VELYRIC_BILLINGO_API_KEY'),
    )) ?? '';
  const stripeSecretKey =
    (await readSecret(
      reader,
      environment,
      resolver,
      'VELYRIC_STRIPE_SECRET_KEY',
      simulated('STRIPE', 'VELYRIC_STRIPE_SECRET_KEY'),
    )) ?? '';

  const config: WorkflowWorkerConfig = {
    environment,
    awsRegion,
    logLevel: reader.optional('VELYRIC_LOG_LEVEL') ?? 'info',
    host: reader.optional('WORKFLOW_WORKER_HOST') ?? (deployed ? '0.0.0.0' : '127.0.0.1'),
    port: reader.integer('WORKFLOW_WORKER_PORT', 7_200, 1, 65_535),
    databaseUrl,
    databaseAssumeRole: reader.boolean(
      'WORKFLOW_WORKER_DATABASE_ASSUME_ROLE',
      environment === 'local',
    ),
    temporal: {
      address: temporalAddress,
      namespace: temporalNamespace,
      apiKey: temporalApiKey,
      tls: reader.boolean('VELYRIC_TEMPORAL_TLS', deployed),
    },
    natsUrl,
    natsCreds,
    redisUrl,
    serviceJwks,
    webOrigin,
    providerModes,
    simulatorUrl: simulatorUrl === '' ? null : simulatorUrl,
    openAiAdminKey,
    telnyx: { apiKey: telnyxApiKey, connectionId: telnyxConnectionId },
    billingo: { apiKey: billingoApiKey, blockId: billingoBlockId },
    stripeSecretKey,
    email: {
      from: emailFrom,
      smtpUrl,
    },
    googleOauth,
    localVaultDir,
    openAiMonthlySpendLimitUsd: spendLimits,
    streamReplicas: reader.integer('WORKFLOW_WORKER_STREAM_REPLICAS', deployed ? 3 : 1, 1, 5),
  };
  if (reader.issues.length > 0) {
    throw new ConfigError(reader.issues);
  }
  return config;
}

export function providerBaseUrl(
  config: WorkflowWorkerConfig,
  provider: 'OPENAI' | 'TELNYX' | 'BILLINGO',
): string | undefined {
  if (config.providerModes[provider] !== 'simulator' || config.simulatorUrl === null) {
    return provider === 'BILLINGO' ? 'https://api.billingo.hu/v3' : undefined;
  }
  const base = config.simulatorUrl.replace(/\/$/, '');
  return provider === 'OPENAI'
    ? `${base}/openai/v1`
    : provider === 'TELNYX'
      ? `${base}/telnyx/v2`
      : `${base}/billingo/v3`;
}
