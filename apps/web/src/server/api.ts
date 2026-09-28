import 'server-only';
import { cookies, headers } from 'next/headers';
import { ApiRequestError, parseError, toSearch, WORKSPACE_HEADER } from '../lib/api-types';
import { webConfig } from './config';

export interface ServerRequestOptions {
  readonly workspace?: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

function traceparent(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `00-${hex.slice(0, 32)}-${hex.slice(32, 48)}-01`;
}

export async function serverGet<T>(path: string, options: ServerRequestOptions = {}): Promise<T> {
  const store = await cookies();
  const incoming = await headers();
  const cookieHeader = store
    .getAll()
    .filter((cookie) => cookie.name === 'vly_session' || cookie.name.endsWith('vly_csrf'))
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join('; ');
  const requestHeaders: Record<string, string> = {
    accept: 'application/json',
    traceparent: incoming.get('traceparent') ?? traceparent(),
  };
  if (cookieHeader !== '') {
    requestHeaders['cookie'] = cookieHeader;
  }
  if (options.workspace !== undefined) {
    requestHeaders[WORKSPACE_HEADER] = options.workspace;
  }
  const language = incoming.get('accept-language');
  if (language !== null) {
    requestHeaders['accept-language'] = language;
  }
  const response = await fetch(`${webConfig().controlApiUrl}/v1${path}${toSearch(options.query)}`, {
    headers: requestHeaders,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

export async function serverGetOrNull<T>(
  path: string,
  options: ServerRequestOptions = {},
): Promise<T | null> {
  try {
    return await serverGet<T>(path, options);
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}
