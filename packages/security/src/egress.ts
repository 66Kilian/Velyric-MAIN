import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { VelyricEnvironment } from '@velyric/contracts';
import { Agent, request } from 'undici';
import {
  addressInCidrs,
  classifyAddress,
  stripIpv6Brackets,
  type AddressClassification,
} from './ip.js';

export const EGRESS_BLOCK_REASONS = [
  'INVALID_URL',
  'SCHEME_NOT_ALLOWED',
  'CREDENTIALS_IN_URL',
  'PORT_NOT_ALLOWED',
  'HOST_NOT_ALLOWLISTED',
  'ADDRESS_NOT_PUBLIC',
  'DNS_RESOLUTION_FAILED',
  'REDIRECT_NOT_ALLOWED',
  'TOO_MANY_REDIRECTS',
  'RESPONSE_TOO_LARGE',
  'CONTENT_TYPE_NOT_ALLOWED',
  'TIMEOUT',
  'POLICY_INVALID',
] as const;

export type EgressBlockReason = (typeof EGRESS_BLOCK_REASONS)[number];

export class EgressBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  readonly reason: EgressBlockReason;
  readonly detail: Readonly<Record<string, string | number>>;

  constructor(
    reason: EgressBlockReason,
    message: string,
    detail: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'EgressBlockedError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface EgressPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowHttp: boolean;
  readonly allowedPorts: readonly number[];
  readonly maxRedirects: number;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly trustedPrivateCidrs: readonly string[];
}

export const DEFAULT_EGRESS_POLICY: Omit<EgressPolicy, 'allowedHosts'> = Object.freeze({
  allowHttp: false,
  allowedPorts: [443],
  maxRedirects: 0,
  connectTimeoutMs: 3_000,
  totalTimeoutMs: 10_000,
  maxResponseBytes: 262_144,
  allowedContentTypes: ['application/json'],
  trustedPrivateCidrs: [],
});

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

const HOST_LABEL = /^[a-z0-9-]{1,63}$/;
const TOP_LEVEL_LABEL = /^[a-z][a-z0-9-]{0,62}$/;

function isHostLabel(label: string): boolean {
  return HOST_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-');
}

function isHostPattern(value: string): boolean {
  const host = value.startsWith('*.') ? value.slice(2) : value;
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  const labels = host.split('.');
  const topLevel = labels.pop();
  return (
    labels.length > 0 &&
    topLevel !== undefined &&
    TOP_LEVEL_LABEL.test(topLevel) &&
    labels.every(isHostLabel)
  );
}

export function normalizeAllowlistEntry(entry: string): string {
  const value = entry.trim().toLowerCase();
  if (isIP(stripIpv6Brackets(value)) !== 0) {
    const address = stripIpv6Brackets(value);
    if (classifyAddress(address) !== 'public') {
      throw new EgressBlockedError(
        'POLICY_INVALID',
        `allowlist entry ${entry} is not a public address`,
      );
    }
    return address;
  }
  if (!isHostPattern(value)) {
    throw new EgressBlockedError(
      'POLICY_INVALID',
      `allowlist entry ${entry} is not a valid hostname pattern`,
    );
  }
  return value;
}

export function hostMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase()).replace(/\.$/, '');
  return allowlist.some((rawEntry) => {
    const entry = rawEntry.toLowerCase();
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}

export function validatePolicy(policy: EgressPolicy, environment: VelyricEnvironment): void {
  if (policy.allowedHosts.length === 0) {
    throw new EgressBlockedError(
      'POLICY_INVALID',
      'egress policy requires at least one allowed host',
    );
  }
  policy.allowedHosts.forEach(normalizeAllowlistEntry);
  if (policy.trustedPrivateCidrs.length > 0 && environment !== 'local' && environment !== 'ci') {
    throw new EgressBlockedError(
      'POLICY_INVALID',
      'trusted private CIDRs are only permitted in local and ci environments',
    );
  }
  if (policy.allowHttp && environment === 'production') {
    throw new EgressBlockedError(
      'POLICY_INVALID',
      'plain HTTP egress is not permitted in production',
    );
  }
  const positive = (value: number): boolean => Number.isInteger(value) && value > 0;
  if (
    !positive(policy.connectTimeoutMs) ||
    !positive(policy.totalTimeoutMs) ||
    !positive(policy.maxResponseBytes) ||
    !Number.isInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > 5
  ) {
    throw new EgressBlockedError('POLICY_INVALID', 'egress policy limits are invalid');
  }
}

export function validateEgressUrl(input: string | URL, policy: EgressPolicy): URL {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    throw new EgressBlockedError('INVALID_URL', 'URL could not be parsed');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new EgressBlockedError('SCHEME_NOT_ALLOWED', `scheme ${url.protocol} is not allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new EgressBlockedError('CREDENTIALS_IN_URL', 'URLs must not embed credentials');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const allowedPorts =
    policy.allowHttp && !policy.allowedPorts.includes(80)
      ? [...policy.allowedPorts, 80]
      : policy.allowedPorts;
  if (!allowedPorts.includes(port)) {
    throw new EgressBlockedError('PORT_NOT_ALLOWED', `port ${String(port)} is not allowed`, {
      port,
    });
  }
  const hostname = stripIpv6Brackets(url.hostname);
  if (!hostMatchesAllowlist(hostname, policy.allowedHosts)) {
    throw new EgressBlockedError(
      'HOST_NOT_ALLOWLISTED',
      `host ${hostname} is not in the allowlist`,
      { host: hostname },
    );
  }
  if (isIP(hostname) !== 0) {
    assertAddressAllowed(hostname, policy);
  }
  return url;
}

function assertAddressAllowed(address: string, policy: EgressPolicy): void {
  const classification: AddressClassification = classifyAddress(address);
  if (classification === 'public') {
    return;
  }
  if (addressInCidrs(address, policy.trustedPrivateCidrs)) {
    return;
  }
  throw new EgressBlockedError('ADDRESS_NOT_PUBLIC', `resolved address is ${classification}`, {
    classification,
  });
}

export async function resolveAllowedAddresses(
  hostname: string,
  policy: EgressPolicy,
  resolver: HostResolver,
): Promise<readonly ResolvedAddress[]> {
  const host = stripIpv6Brackets(hostname);
  const literal = isIP(host);
  if (literal !== 0) {
    assertAddressAllowed(host, policy);
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new EgressBlockedError('DNS_RESOLUTION_FAILED', `could not resolve ${host}`, { host });
  }
  if (addresses.length === 0) {
    throw new EgressBlockedError('DNS_RESOLUTION_FAILED', `no addresses for ${host}`, { host });
  }
  for (const entry of addresses) {
    assertAddressAllowed(entry.address, policy);
  }
  return addresses;
}

function pinnedLookup(target: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all === true) {
      (
        callback as unknown as (
          error: null,
          addresses: { address: string; family: number }[],
        ) => void
      )(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

export interface SafeRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly finalUrl: string;
  readonly remoteAddress: string;
  readonly redirects: number;
  readonly durationMs: number;
}

export interface SafeRequestOptions {
  readonly policy: EgressPolicy;
  readonly environment: VelyricEnvironment;
  readonly resolver?: HostResolver;
  readonly signal?: AbortSignal;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
  'te',
  'upgrade',
]);

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return flat;
}

async function readCapped(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > limit) {
      throw new EgressBlockedError(
        'RESPONSE_TOO_LARGE',
        `response exceeded ${String(limit)} bytes`,
        { limit },
      );
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function contentTypeAllowed(contentType: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) {
    return true;
  }
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return allowed.some((entry) => entry.toLowerCase() === mediaType);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout/i.test(error.name))
  );
}

export async function safeRequest(
  input: SafeRequest,
  options: SafeRequestOptions,
): Promise<SafeResponse> {
  const { policy } = options;
  validatePolicy(policy, options.environment);
  const resolver = options.resolver ?? systemResolver;
  const started = performance.now();
  const timeout = AbortSignal.timeout(policy.totalTimeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  let current = validateEgressUrl(input.url, policy);
  let method = input.method ?? 'GET';
  let body = input.body;

  for (let redirects = 0; ; redirects += 1) {
    const [target] = await resolveAllowedAddresses(current.hostname, policy, resolver);
    if (target === undefined) {
      throw new EgressBlockedError(
        'DNS_RESOLUTION_FAILED',
        `no usable address for ${current.hostname}`,
      );
    }
    const agent = new Agent({
      connect: { timeout: policy.connectTimeoutMs, lookup: pinnedLookup(target) },
      headersTimeout: policy.totalTimeoutMs,
      bodyTimeout: policy.totalTimeoutMs,
    });
    try {
      const response = await request(current, {
        method,
        headers,
        body: body === undefined ? null : body,
        dispatcher: agent,
        signal,
      });
      const responseHeaders = flattenHeaders(response.headers);
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        await response.body.dump();
        if (policy.maxRedirects === 0) {
          throw new EgressBlockedError(
            'REDIRECT_NOT_ALLOWED',
            'redirects are not allowed by policy',
          );
        }
        if (redirects >= policy.maxRedirects) {
          throw new EgressBlockedError(
            'TOO_MANY_REDIRECTS',
            `more than ${String(policy.maxRedirects)} redirects`,
          );
        }
        const location = responseHeaders['location'];
        if (location === undefined) {
          throw new EgressBlockedError('INVALID_URL', 'redirect without location');
        }
        current = validateEgressUrl(new URL(location, current), policy);
        if (
          response.statusCode === 303 ||
          ((response.statusCode === 301 || response.statusCode === 302) && method !== 'GET')
        ) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const declaredLength = Number(responseHeaders['content-length'] ?? Number.NaN);
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxResponseBytes) {
        await response.body.dump();
        throw new EgressBlockedError(
          'RESPONSE_TOO_LARGE',
          `response declared ${String(declaredLength)} bytes`,
          {
            limit: policy.maxResponseBytes,
          },
        );
      }
      if (
        response.statusCode < 300 &&
        !contentTypeAllowed(responseHeaders['content-type'], policy.allowedContentTypes)
      ) {
        await response.body.dump();
        throw new EgressBlockedError(
          'CONTENT_TYPE_NOT_ALLOWED',
          'response content type is not allowed',
        );
      }
      const payload = await readCapped(response.body, policy.maxResponseBytes);
      return {
        status: response.statusCode,
        headers: responseHeaders,
        body: payload,
        finalUrl: current.href,
        remoteAddress: target.address,
        redirects,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        throw error;
      }
      if (isAbortError(error) || signal.aborted) {
        throw new EgressBlockedError(
          'TIMEOUT',
          `request exceeded ${String(policy.totalTimeoutMs)} ms`,
        );
      }
      throw error;
    } finally {
      await agent.close();
    }
  }
}
