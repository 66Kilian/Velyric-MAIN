import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export interface StoreSecretInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly secretRefId: string;
  readonly version: number;
  readonly value: string;
}

export interface TenantSecretWriter {
  store(input: StoreSecretInput): Promise<string>;
  scheduleDeletion(secretRef: string): Promise<void>;
}

export interface TenantSecretReader {
  read(secretRef: string): Promise<string>;
}

export type TenantSecretErrorCode =
  'SECRET_REFERENCE_INVALID' | 'SECRET_UNAVAILABLE' | 'SECRET_ALREADY_EXISTS';

export class TenantSecretError extends Error {
  readonly code: TenantSecretErrorCode;
  readonly retryable: boolean;

  constructor(
    code: TenantSecretErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TenantSecretError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const SEGMENT = /^[A-Za-z0-9_+=.@-]+$/;
const SCHEMES = ['aws-sm://', 'local-vault://'] as const;
export type SecretScheme = (typeof SCHEMES)[number];

export function tenantSecretName(input: Omit<StoreSecretInput, 'value'>): string {
  const segments = [
    input.tenantId,
    input.kind.toLowerCase(),
    input.secretRefId,
    `v${String(input.version)}`,
  ];
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    !segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  ) {
    throw new TenantSecretError(
      'SECRET_REFERENCE_INVALID',
      'tenant secret name segments are invalid',
    );
  }
  return `tenants/${segments.join('/')}`;
}

export function parseSecretReference(secretRef: string): {
  readonly scheme: SecretScheme;
  readonly name: string;
} {
  const scheme = SCHEMES.find((candidate) => secretRef.startsWith(candidate));
  if (scheme === undefined) {
    throw new TenantSecretError(
      'SECRET_REFERENCE_INVALID',
      'secret reference uses an unsupported scheme',
    );
  }
  const name = secretRef.slice(scheme.length);
  const segments = name.split('/');
  if (
    segments[0] !== 'tenants' ||
    segments.length < 3 ||
    segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')
  ) {
    throw new TenantSecretError('SECRET_REFERENCE_INVALID', 'secret reference is malformed');
  }
  return { scheme, name };
}

function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? (error as { name: string }).name
    : '';
}

export class AwsTenantSecrets implements TenantSecretWriter, TenantSecretReader {
  readonly #client: SecretsManagerClient;
  readonly #cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(
    client: SecretsManagerClient,
    options: { readonly cacheTtlMs?: number; readonly now?: () => number } = {},
  ) {
    this.#client = client;
    this.#ttlMs = options.cacheTtlMs ?? 300_000;
    this.#now = options.now ?? Date.now;
  }

  #name(secretRef: string): string {
    const parsed = parseSecretReference(secretRef);
    if (parsed.scheme !== 'aws-sm://') {
      throw new TenantSecretError(
        'SECRET_REFERENCE_INVALID',
        'secret reference is not an AWS Secrets Manager reference',
      );
    }
    return parsed.name;
  }

  async store(input: StoreSecretInput): Promise<string> {
    const name = tenantSecretName(input);
    try {
      await this.#client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: input.value,
          ClientRequestToken: input.secretRefId,
          Tags: [
            { Key: 'velyric:tenant_id', Value: input.tenantId },
            { Key: 'velyric:secret_kind', Value: input.kind },
          ],
        }),
      );
    } catch (error) {
      if (errorName(error) === 'ResourceExistsException') {
        throw new TenantSecretError(
          'SECRET_ALREADY_EXISTS',
          'a secret with this reference already exists',
          { cause: error },
        );
      }
      throw new TenantSecretError('SECRET_UNAVAILABLE', 'secret could not be stored', {
        retryable: true,
        cause: error,
      });
    }
    return `aws-sm://${name}`;
  }

  async read(secretRef: string): Promise<string> {
    const name = this.#name(secretRef);
    const cached = this.#cache.get(name);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return cached.value;
    }
    let value: string | undefined;
    try {
      value = (await this.#client.send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
    } catch (error) {
      throw new TenantSecretError('SECRET_UNAVAILABLE', 'tenant secret could not be read', {
        retryable: errorName(error) !== 'ResourceNotFoundException',
        cause: error,
      });
    }
    if (value === undefined || value === '') {
      throw new TenantSecretError('SECRET_UNAVAILABLE', 'tenant secret has no string value');
    }
    this.#cache.set(name, { value, expiresAt: this.#now() + this.#ttlMs });
    return value;
  }

  async scheduleDeletion(secretRef: string): Promise<void> {
    const name = this.#name(secretRef);
    this.#cache.delete(name);
    try {
      await this.#client.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 }));
    } catch (error) {
      if (errorName(error) !== 'ResourceNotFoundException') {
        throw new TenantSecretError(
          'SECRET_UNAVAILABLE',
          'secret deletion could not be scheduled',
          { retryable: true, cause: error },
        );
      }
    }
  }
}

export class LocalVaultTenantSecrets implements TenantSecretWriter, TenantSecretReader {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  #file(secretRef: string): string {
    const parsed = parseSecretReference(secretRef);
    if (parsed.scheme !== 'local-vault://') {
      throw new TenantSecretError(
        'SECRET_REFERENCE_INVALID',
        'secret reference is not a local vault reference',
      );
    }
    const file = path.resolve(this.#directory, `${parsed.name}.secret`);
    if (!file.startsWith(`${this.#directory}${path.sep}`)) {
      throw new TenantSecretError(
        'SECRET_REFERENCE_INVALID',
        'secret reference escapes the local vault',
      );
    }
    return file;
  }

  async store(input: StoreSecretInput): Promise<string> {
    const secretRef = `local-vault://${tenantSecretName(input)}`;
    const file = this.#file(secretRef);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, input.value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new TenantSecretError(
          'SECRET_ALREADY_EXISTS',
          'a secret with this reference already exists',
          { cause: error },
        );
      }
      throw error;
    }
    return secretRef;
  }

  async read(secretRef: string): Promise<string> {
    try {
      return (await readFile(this.#file(secretRef), 'utf8')).trim();
    } catch (error) {
      if (error instanceof TenantSecretError) {
        throw error;
      }
      throw new TenantSecretError('SECRET_UNAVAILABLE', 'local vault secret is missing', {
        cause: error,
      });
    }
  }

  async scheduleDeletion(secretRef: string): Promise<void> {
    await rm(this.#file(secretRef), { force: true });
  }
}

export class RoutingTenantSecrets implements TenantSecretWriter, TenantSecretReader {
  readonly #aws: AwsTenantSecrets | null;
  readonly #local: LocalVaultTenantSecrets | null;
  readonly #writeTarget: 'aws' | 'local';

  constructor(options: {
    readonly aws: AwsTenantSecrets | null;
    readonly local: LocalVaultTenantSecrets | null;
  }) {
    if (options.aws === null && options.local === null) {
      throw new RangeError('at least one tenant secret backend is required');
    }
    this.#aws = options.aws;
    this.#local = options.local;
    this.#writeTarget = options.local !== null ? 'local' : 'aws';
  }

  #backend(secretRef: string): TenantSecretWriter & TenantSecretReader {
    const { scheme } = parseSecretReference(secretRef);
    const backend = scheme === 'aws-sm://' ? this.#aws : this.#local;
    if (backend === null) {
      throw new TenantSecretError(
        'SECRET_REFERENCE_INVALID',
        'secret reference scheme is not available in this environment',
      );
    }
    return backend;
  }

  store(input: StoreSecretInput): Promise<string> {
    const backend = this.#writeTarget === 'local' ? this.#local : this.#aws;
    if (backend === null) {
      return Promise.reject(
        new TenantSecretError('SECRET_UNAVAILABLE', 'no writable tenant secret backend'),
      );
    }
    return backend.store(input);
  }

  async read(secretRef: string): Promise<string> {
    return this.#backend(secretRef).read(secretRef);
  }

  async scheduleDeletion(secretRef: string): Promise<void> {
    await this.#backend(secretRef).scheduleDeletion(secretRef);
  }
}
