import { createHmac } from 'node:crypto';
import type { VelyricEnvironment } from '@velyric/contracts';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  safeRequest,
  type EgressPolicy,
  type HostResolver,
} from '@velyric/security';
import { ToolExecutionError, readTenantSecret } from '../errors.js';
import type { TenantSecretReader } from '@velyric/tenant-secrets';
import type { ToolResult } from './booking.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CustomApiDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly pathTemplate: string | null;
  readonly httpMethod: string | null;
  readonly allowedHosts: readonly string[];
  readonly authType: string;
  readonly authSecretRef: string | null;
  readonly responseMaxBytes: number;
  readonly maxRetries: number;
  readonly idempotencySupported: boolean;
  readonly timeoutMs: number;
}

export interface CustomApiRequest {
  readonly toolRunId: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

export interface BuiltCustomApiRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly body: string | undefined;
}

export interface CustomApiExecutorOptions {
  readonly secrets: TenantSecretReader;
  readonly environment: VelyricEnvironment;
  readonly allowHttp: boolean;
  readonly resolver?: HostResolver;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,63})\}/g;

function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return null;
}

export function buildCustomApiRequest(
  definition: CustomApiDefinition,
  args: unknown,
): BuiltCustomApiRequest {
  if (
    definition.baseUrl === null ||
    definition.pathTemplate === null ||
    definition.httpMethod === null
  ) {
    throw new ToolExecutionError('TOOL_NOT_ALLOWED', 'custom API tool is not fully configured');
  }
  const method = definition.httpMethod.toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) {
    throw new ToolExecutionError(
      'TOOL_NOT_ALLOWED',
      'custom API tool uses an unsupported HTTP method',
    );
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolExecutionError(
      'VALIDATION_FAILED',
      'custom API tool arguments must be an object',
    );
  }
  const remaining = new Map<string, unknown>(Object.entries(args));
  const path = definition.pathTemplate.replace(PLACEHOLDER, (_, name: string) => {
    const value = scalar(remaining.get(name));
    if (value === null || value === '') {
      throw new ToolExecutionError('VALIDATION_FAILED', `path parameter ${name} is required`, {
        details: { parameter: name },
      });
    }
    remaining.delete(name);
    return encodeURIComponent(value);
  });
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) {
    throw new ToolExecutionError(
      'TOOL_NOT_ALLOWED',
      'custom API path template resolves to an unsafe path',
    );
  }
  const url = new URL(definition.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  if (method === 'GET' || method === 'DELETE') {
    for (const [name, value] of remaining) {
      const text = scalar(value);
      if (text === null) {
        throw new ToolExecutionError(
          'VALIDATION_FAILED',
          `query parameter ${name} must be a scalar`,
          { details: { parameter: name } },
        );
      }
      url.searchParams.append(name, text);
    }
    return { url: url.toString(), method, body: undefined };
  }
  return { url: url.toString(), method, body: JSON.stringify(Object.fromEntries(remaining)) };
}

export function signCustomApiRequest(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
}

export class CustomApiExecutor {
  readonly #options: CustomApiExecutorOptions;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: CustomApiExecutorOptions) {
    this.#options = options;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? Date.now;
  }

  #policy(definition: CustomApiDefinition, url: URL): EgressPolicy {
    const allowHttp =
      this.#options.allowHttp &&
      (this.#options.environment === 'local' || this.#options.environment === 'ci');
    const hosts = definition.allowedHosts.length > 0 ? definition.allowedHosts : [];
    if (hosts.length === 0) {
      throw new ToolExecutionError('TOOL_NOT_ALLOWED', 'custom API tool has no allowed hosts');
    }
    return {
      ...DEFAULT_EGRESS_POLICY,
      allowedHosts: hosts,
      allowHttp,
      allowedPorts: url.port === '' ? [url.protocol === 'http:' ? 80 : 443] : [Number(url.port)],
      totalTimeoutMs: Math.max(500, definition.timeoutMs),
      maxResponseBytes: Math.max(1_024, definition.responseMaxBytes),
      trustedPrivateCidrs: allowHttp ? ['127.0.0.0/8', '::1/128'] : [],
    };
  }

  async #authHeaders(
    definition: CustomApiDefinition,
    body: string | undefined,
  ): Promise<Record<string, string>> {
    if (definition.authType === 'NONE') {
      return {};
    }
    if (definition.authSecretRef === null) {
      throw new ToolExecutionError(
        'INTEGRATION_UNAVAILABLE',
        'custom API credential is not configured',
      );
    }
    const secret = await readTenantSecret(this.#options.secrets, definition.authSecretRef);
    switch (definition.authType) {
      case 'BEARER':
        return { authorization: `Bearer ${secret}` };
      case 'OAUTH2': {
        let token: unknown;
        try {
          token = (JSON.parse(secret) as Record<string, unknown>)['access_token'];
        } catch (error) {
          throw new ToolExecutionError(
            'SECRET_INVALID',
            'custom API OAuth credential is not valid JSON',
            { cause: error },
          );
        }
        if (typeof token !== 'string' || token === '') {
          throw new ToolExecutionError(
            'SECRET_INVALID',
            'custom API OAuth credential has no access token',
          );
        }
        return { authorization: `Bearer ${token}` };
      }
      case 'HMAC': {
        const timestamp = Math.floor(this.#now() / 1000);
        return {
          'x-velyric-timestamp': String(timestamp),
          'x-velyric-signature': `v1=${signCustomApiRequest(secret, timestamp, body ?? '')}`,
        };
      }
      default:
        throw new ToolExecutionError(
          'TOOL_NOT_ALLOWED',
          'custom API tool uses an unsupported authentication type',
        );
    }
  }

  async execute(definition: CustomApiDefinition, request: CustomApiRequest): Promise<ToolResult> {
    const built = buildCustomApiRequest(definition, request.arguments);
    const url = new URL(built.url);
    const policy = this.#policy(definition, url);
    const idempotent = built.method === 'GET' || definition.idempotencySupported;
    const attempts = idempotent ? Math.min(Math.max(definition.maxRetries, 0), 3) + 1 : 1;
    const deadline = this.#now() + definition.timeoutMs;
    let lastError: ToolExecutionError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-velyric-tool-run-id': request.toolRunId,
        traceparent: `00-${request.traceId}-${request.toolRunId.replaceAll('-', '').slice(0, 16)}-01`,
        ...(await this.#authHeaders(definition, built.body)),
      };
      if (built.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      if (definition.idempotencySupported && built.method !== 'GET') {
        headers['idempotency-key'] = request.idempotencyKey;
      }
      try {
        const response = await safeRequest(
          {
            url: built.url,
            method: built.method,
            headers,
            ...(built.body === undefined ? {} : { body: built.body }),
          },
          {
            policy,
            environment: this.#options.environment,
            ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
          },
        );
        if (response.status >= 200 && response.status < 300) {
          const raw = new TextDecoder().decode(response.body);
          let parsed: unknown = null;
          if (raw !== '') {
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              throw new ToolExecutionError('PROVIDER_ERROR', 'custom API returned malformed JSON', {
                httpStatus: response.status,
                cause: error,
              });
            }
          }
          const result =
            typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { data: parsed };
          return { result, httpStatus: response.status };
        }
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new ToolExecutionError(
          retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
          `custom API responded with HTTP ${String(response.status)}`,
          {
            retryable,
            httpStatus: response.status,
          },
        );
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        if (error instanceof EgressBlockedError) {
          if (error.reason !== 'TIMEOUT') {
            throw new ToolExecutionError(
              'EGRESS_BLOCKED',
              'custom API request was blocked by the egress policy',
              { details: { reason: error.reason }, cause: error },
            );
          }
          lastError = new ToolExecutionError('UPSTREAM_TIMEOUT', 'custom API request timed out', {
            retryable: true,
            cause: error,
          });
        } else {
          lastError = new ToolExecutionError('PROVIDER_UNAVAILABLE', 'custom API is unreachable', {
            retryable: true,
            cause: error,
          });
        }
      }
      const backoff = 200 * 2 ** (attempt - 1);
      if (!lastError.retryable || attempt === attempts || this.#now() + backoff >= deadline) {
        break;
      }
      await this.#sleep(backoff);
    }
    throw lastError ?? new ToolExecutionError('PROVIDER_ERROR', 'custom API request failed');
  }
}
