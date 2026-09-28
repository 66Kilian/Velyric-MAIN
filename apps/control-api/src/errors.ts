import {
  apiErrorHttpStatus,
  createApiErrorEnvelope,
  type ApiErrorCode,
  type ApiErrorEnvelope,
} from '@velyric/contracts';
import { DatabaseContextError } from '@velyric/db';
import { EgressBlockedError, ServiceTokenError, WebhookVerificationError } from '@velyric/security';

export interface ApiErrorOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ApiErrorCode,
    details?: Readonly<Record<string, unknown>>,
    options: ApiErrorOptions = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.headers = options.headers ?? {};
  }

  get statusCode(): number {
    return apiErrorHttpStatus(this.code);
  }

  toEnvelope(traceId: string): ApiErrorEnvelope {
    return createApiErrorEnvelope(this.code, traceId, this.details);
  }
}

function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && 'severity' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = error.constraint;
    return typeof constraint === 'string' ? constraint : undefined;
  }
  return undefined;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof EgressBlockedError) {
    return new ApiError('SSRF_BLOCKED', { reason: error.reason }, { cause: error });
  }
  if (error instanceof ServiceTokenError) {
    return new ApiError(error.code, undefined, { cause: error });
  }
  if (error instanceof WebhookVerificationError) {
    return new ApiError(error.code, undefined, { cause: error });
  }
  if (error instanceof DatabaseContextError) {
    return new ApiError('FORBIDDEN', undefined, { cause: error });
  }
  switch (pgCode(error) ?? '') {
    case '23505':
      return new ApiError(
        'CONFLICT',
        { constraint: pgConstraint(error) ?? 'unique' },
        { cause: error },
      );
    case '23P01':
      return new ApiError('BOOKING_SLOT_UNAVAILABLE', undefined, { cause: error });
    case '23503':
    case '23514':
      return new ApiError(
        'VALIDATION_FAILED',
        { constraint: pgConstraint(error) ?? 'check' },
        { cause: error },
      );
    case '42501':
      return new ApiError('FORBIDDEN', undefined, { cause: error });
    case '40001':
    case '40P01':
      return new ApiError(
        'CONFLICT',
        { retryable: true },
        { cause: error, headers: { 'retry-after': '1' } },
      );
    case '57014':
      return new ApiError('UPSTREAM_TIMEOUT', undefined, { cause: error });
    case '53300':
    case '57P03':
      return new ApiError('SERVICE_UNAVAILABLE', undefined, {
        cause: error,
        headers: { 'retry-after': '2' },
      });
    default:
      return new ApiError('INTERNAL_ERROR', undefined, { cause: error });
  }
}
