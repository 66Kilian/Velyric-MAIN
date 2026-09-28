'use client';

import { parseError, toSearch, WORKSPACE_HEADER } from './api-types';

export interface ClientRequestOptions {
  readonly workspace?: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly body?: unknown;
  readonly ifMatch?: string | number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match === undefined ? null : decodeURIComponent(match.slice(name.length + 1));
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: ClientRequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.workspace !== undefined) {
    headers[WORKSPACE_HEADER] = options.workspace;
  }
  if (method !== 'GET') {
    headers['idempotency-key'] = options.idempotencyKey ?? newIdempotencyKey();
    const csrf = readCookie('__Host-vly_csrf') ?? readCookie('vly_csrf');
    if (csrf !== null) {
      headers['x-csrf-token'] = csrf;
    }
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.ifMatch !== undefined) {
    headers['if-match'] =
      typeof options.ifMatch === 'number' ? `W/"${String(options.ifMatch)}"` : options.ifMatch;
  }
  const response = await fetch(`/v1${path}${toSearch(options.query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options: ClientRequestOptions = {}) => request<T>('GET', path, options),
  post: <T>(path: string, options: ClientRequestOptions = {}) => request<T>('POST', path, options),
  put: <T>(path: string, options: ClientRequestOptions = {}) => request<T>('PUT', path, options),
  patch: <T>(path: string, options: ClientRequestOptions = {}) =>
    request<T>('PATCH', path, options),
  delete: <T>(path: string, options: ClientRequestOptions = {}) =>
    request<T>('DELETE', path, options),
};
