import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import { natsSubjects, type ToolKind } from '@velyric/contracts';

export interface JsonSchemaValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface JsonSchemaValidator {
  validate(cacheKey: string, schema: unknown, value: unknown): JsonSchemaValidation;
}

interface AjvValidateFunction {
  (data: unknown): boolean;
  errors?: readonly { readonly instancePath: string; readonly keyword: string }[] | null;
}

interface AjvInstance {
  compile(schema: object): AjvValidateFunction;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (
  options: Readonly<Record<string, unknown>>,
) => AjvInstance;
const addFormats = require('ajv-formats') as (ajv: AjvInstance) => AjvInstance;

const SCHEMA_CACHE_LIMIT = 500;

export class AjvJsonSchemaValidator implements JsonSchemaValidator {
  readonly #ajv: AjvInstance;
  readonly #cache = new Map<string, AjvValidateFunction>();

  constructor() {
    this.#ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      validateFormats: true,
    });
    addFormats(this.#ajv);
  }

  validate(cacheKey: string, schema: unknown, value: unknown): JsonSchemaValidation {
    let validateFn = this.#cache.get(cacheKey);
    if (validateFn === undefined) {
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        return { valid: false, issues: ['/:schema_invalid'] };
      }
      try {
        validateFn = this.#ajv.compile(schema);
      } catch {
        return { valid: false, issues: ['/:schema_uncompilable'] };
      }
      if (this.#cache.size >= SCHEMA_CACHE_LIMIT) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) {
          this.#cache.delete(oldest);
        }
      }
      this.#cache.set(cacheKey, validateFn);
    }
    if (validateFn(value)) {
      return { valid: true, issues: [] };
    }
    return {
      valid: false,
      issues: (validateFn.errors ?? [])
        .slice(0, 20)
        .map((error) => `${error.instancePath === '' ? '/' : error.instancePath}:${error.keyword}`),
    };
  }
}

export interface ToolDispatchRequest {
  readonly tenantId: string;
  readonly callId: string | null;
  readonly toolRunId: string;
  readonly toolDefinitionId: string;
  readonly toolName: string;
  readonly kind: ToolKind;
  readonly connectorKey: string | null;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly traceId: string;
}

export type ToolDispatchResult =
  | {
      readonly status: 'SUCCEEDED';
      readonly result: unknown;
      readonly httpStatus: number | null;
      readonly latencyMs: number;
    }
  | {
      readonly status: 'FAILED' | 'TIMED_OUT';
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly httpStatus: number | null;
      readonly latencyMs: number;
    };

export interface ToolDispatcher {
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
}

function parseConnectorReply(value: unknown, latencyMs: number): ToolDispatchResult {
  if (typeof value !== 'object' || value === null) {
    return {
      status: 'FAILED',
      errorCode: 'PROVIDER_ERROR',
      retryable: false,
      httpStatus: null,
      latencyMs,
    };
  }
  const record = value as Record<string, unknown>;
  const httpStatus = typeof record['http_status'] === 'number' ? record['http_status'] : null;
  if (record['status'] === 'SUCCEEDED') {
    return { status: 'SUCCEEDED', result: record['result'] ?? null, httpStatus, latencyMs };
  }
  return {
    status: record['status'] === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
    errorCode: typeof record['error_code'] === 'string' ? record['error_code'] : 'PROVIDER_ERROR',
    retryable: record['retryable'] === true,
    httpStatus,
    latencyMs,
  };
}

export class NatsToolDispatcher implements ToolDispatcher {
  readonly #nats: NatsConnection;
  readonly #token: (tenantId: string) => Promise<string>;

  constructor(nats: NatsConnection, token: (tenantId: string) => Promise<string>) {
    this.#nats = nats;
    this.#token = token;
  }

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    const started = performance.now();
    const messageHeaders = headers();
    messageHeaders.set('authorization', `Bearer ${await this.#token(request.tenantId)}`);
    messageHeaders.set('traceparent', `00-${request.traceId}-${randomBytes(8).toString('hex')}-01`);
    messageHeaders.set('idempotency-key', request.idempotencyKey);
    const payload = JSON.stringify({
      tool_run_id: request.toolRunId,
      tool_definition_id: request.toolDefinitionId,
      tool_name: request.toolName,
      kind: request.kind,
      connector_key: request.connectorKey,
      call_id: request.callId,
      arguments: request.arguments,
      idempotency_key: request.idempotencyKey,
      timeout_ms: request.timeoutMs,
    });
    try {
      const reply = await this.#nats.request(
        natsSubjects.connectorExecute(request.tenantId),
        payload,
        {
          timeout: request.timeoutMs + 1_000,
          headers: messageHeaders,
        },
      );
      return parseConnectorReply(reply.json(), Math.round(performance.now() - started));
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const description = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      if (/timeout/i.test(description)) {
        return {
          status: 'TIMED_OUT',
          errorCode: 'UPSTREAM_TIMEOUT',
          retryable: true,
          httpStatus: null,
          latencyMs,
        };
      }
      if (/no responders|503/i.test(description)) {
        return {
          status: 'FAILED',
          errorCode: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          httpStatus: null,
          latencyMs,
        };
      }
      throw error;
    }
  }
}
