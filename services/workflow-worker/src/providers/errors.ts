export type ProviderName = 'billingo' | 'openai' | 'telnyx' | 'stripe' | 'smtp';

export class ProviderCallError extends Error {
  readonly provider: ProviderName;
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly httpStatus: number | null;

  constructor(
    provider: ProviderName,
    code: string,
    message: string,
    options: {
      readonly retryable: boolean;
      readonly outcomeUnknown?: boolean;
      readonly httpStatus?: number | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderCallError';
    this.provider = provider;
    this.code = code;
    this.retryable = options.retryable;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.httpStatus = options.httpStatus ?? null;
  }
}

export function classifyHttpFailure(
  provider: ProviderName,
  status: number,
  code: string,
  message: string,
  mutating: boolean,
): ProviderCallError {
  if (status === 429) {
    return new ProviderCallError(provider, code || 'rate_limited', message, {
      retryable: true,
      httpStatus: status,
    });
  }
  if (status >= 500) {
    return new ProviderCallError(provider, code || 'provider_unavailable', message, {
      retryable: true,
      outcomeUnknown: mutating,
      httpStatus: status,
    });
  }
  if (status === 409) {
    return new ProviderCallError(provider, code || 'conflict', message, {
      retryable: false,
      httpStatus: status,
    });
  }
  return new ProviderCallError(provider, code || 'request_rejected', message, {
    retryable: false,
    httpStatus: status,
  });
}

export function classifyTransportFailure(
  provider: ProviderName,
  error: unknown,
  mutating: boolean,
): ProviderCallError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const causeCode =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: { code?: unknown } }).cause?.code
      : undefined;
  const connectionRefused =
    causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN';
  return new ProviderCallError(
    provider,
    name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error',
    message,
    {
      retryable: true,
      outcomeUnknown: mutating && !connectionRefused,
      cause: error,
    },
  );
}
