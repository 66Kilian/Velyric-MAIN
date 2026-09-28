import type { IncomingHttpHeaders } from 'node:http';

export type FormValue = string | FormValue[] | { [key: string]: FormValue };
export type FormObject = Record<string, FormValue>;

export interface SimRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: Buffer;
  readonly baseUrl: string;
}

export interface SimResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
}

export type Handler = (request: SimRequest) => SimResponse | Promise<SimResponse>;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

export class SimulatorHttpError extends Error {
  readonly response: SimResponse;

  constructor(response: SimResponse) {
    super(`simulated HTTP ${String(response.status)}`);
    this.name = 'SimulatorHttpError';
    this.response = response;
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): SimResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function html(status: number, body: string): SimResponse {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

export function redirect(location: string, status = 302): SimResponse {
  return { status, headers: { location, 'cache-control': 'no-store' } };
}

export function empty(status = 204): SimResponse {
  return { status };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function header(request: SimRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function bearer(request: SimRequest): string | null {
  const value = header(request, 'authorization');
  if (value === undefined || !value.startsWith('Bearer ')) {
    return null;
  }
  const token = value.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

export function jsonBody(request: SimRequest): Record<string, unknown> {
  if (request.rawBody.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody.toString('utf8'));
  } catch {
    throw new SimulatorHttpError(
      json(400, { error: { message: 'request body is not valid JSON' } }),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SimulatorHttpError(
      json(400, { error: { message: 'request body must be a JSON object' } }),
    );
  }
  return parsed as Record<string, unknown>;
}

function assign(target: FormObject, keys: readonly string[], value: string): void {
  let cursor: FormObject = target;
  keys.forEach((key, index) => {
    const last = index === keys.length - 1;
    const resolvedKey = key === '' ? String(Object.keys(cursor).length) : key;
    if (last) {
      cursor[resolvedKey] = value;
      return;
    }
    const existing = cursor[resolvedKey];
    if (typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing;
      return;
    }
    const next: FormObject = {};
    cursor[resolvedKey] = next;
    cursor = next;
  });
}

function normalizeArrays(value: FormValue): FormValue {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value);
  const normalized = Object.fromEntries(
    keys.map((key) => [key, normalizeArrays(value[key] ?? '')]),
  );
  if (keys.length > 0 && keys.every((key, index) => key === String(index))) {
    return keys.map((key) => normalized[key] ?? '');
  }
  return normalized;
}

export function parseForm(source: string | URLSearchParams): FormObject {
  const params = typeof source === 'string' ? new URLSearchParams(source) : source;
  const root: FormObject = {};
  for (const [rawKey, value] of params) {
    const base = rawKey.split('[', 1)[0] ?? rawKey;
    const nested = [...rawKey.slice(base.length).matchAll(/\[([^\]]*)\]/g)].map(
      (match) => match[1] ?? '',
    );
    assign(root, [base, ...nested], value);
  }
  const normalized = normalizeArrays(root);
  return typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : {};
}

export function formBody(request: SimRequest): FormObject {
  return parseForm(request.rawBody.toString('utf8'));
}

export function formString(form: FormObject, key: string): string | null {
  const value = form[key];
  return typeof value === 'string' ? value : null;
}

export function formObject(value: FormValue | undefined): FormObject {
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function formArray(value: FormValue | undefined): FormValue[] {
  return Array.isArray(value) ? value : [];
}

export function stringRecord(value: FormValue | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formObject(value)).flatMap(([key, entry]) =>
      typeof entry === 'string' ? [[key, entry]] : [],
    ),
  );
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.#routes.push({ method, segments: path.split('/'), handler });
  }

  match(
    method: string,
    path: string,
  ):
    | { readonly handler: Handler; readonly params: Record<string, string> }
    | 'METHOD_NOT_ALLOWED'
    | null {
    const actual = path.split('/');
    let pathMatched = false;
    for (const route of this.#routes) {
      if (route.segments.length !== actual.length) {
        continue;
      }
      const params: Record<string, string> = {};
      const matches = route.segments.every((segment, index) => {
        const value = actual[index] ?? '';
        if (segment.startsWith(':')) {
          if (value === '') {
            return false;
          }
          try {
            params[segment.slice(1)] = decodeURIComponent(value);
          } catch {
            return false;
          }
          return true;
        }
        return segment === value;
      });
      if (!matches) {
        continue;
      }
      pathMatched = true;
      if (route.method === method) {
        return { handler: route.handler, params };
      }
    }
    return pathMatched ? 'METHOD_NOT_ALLOWED' : null;
  }
}
