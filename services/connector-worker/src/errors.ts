import { TenantSecretError, type TenantSecretReader } from '@velyric/tenant-secrets';

export class ToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      httpStatus?: number | null;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolExecutionError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.details = options.details ?? {};
  }
}

export function databaseErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

export async function readTenantSecret(
  reader: TenantSecretReader,
  secretRef: string,
): Promise<string> {
  try {
    return await reader.read(secretRef);
  } catch (error) {
    if (error instanceof TenantSecretError) {
      throw new ToolExecutionError(error.code, error.message, {
        retryable: error.retryable,
        cause: error,
      });
    }
    throw new ToolExecutionError('SECRET_UNAVAILABLE', 'tenant secret could not be read', {
      retryable: true,
      cause: error,
    });
  }
}
