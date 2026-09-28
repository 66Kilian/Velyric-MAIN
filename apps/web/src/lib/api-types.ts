export interface ApiErrorBody {
  readonly code: string;
  readonly message_key?: string;
  readonly trace_id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.code ?? `HTTP_${String(status)}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'MALFORMED_REQUEST');
    this.traceId = body?.trace_id ?? null;
    this.details = body?.details ?? null;
  }
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly next_cursor: string | null; readonly limit: number };
}

export const WORKSPACE_HEADER = 'x-velyric-workspace';

export function toSearch(
  params: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined,
): string {
  if (params === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export async function parseError(response: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody | null = null;
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string'
    ) {
      body = parsed as ApiErrorBody;
    }
  } catch {
    body = null;
  }
  return new ApiRequestError(response.status, body);
}
