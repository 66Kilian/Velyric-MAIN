import { randomBytes } from 'node:crypto';
import { NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX } from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import {
  ServiceTokenError,
  verifyServiceToken,
  type ServiceTokenVerifier,
} from '@velyric/security';
import type { Kysely } from 'kysely';
import Type from 'typebox';
import { Value } from 'typebox/value';
import { ToolExecutionError } from './errors.js';
import { executeBookingTool, type CalendarSync, type ToolResult } from './tools/booking.js';
import type { CustomApiExecutor } from './tools/custom-api.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const Uuid = Type.String({ pattern: UUID_PATTERN });
const UUID_REGEX = new RegExp(UUID_PATTERN);

export const ExecuteRequestSchema = Type.Object(
  {
    tool_run_id: Uuid,
    tool_definition_id: Uuid,
    tool_name: Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' }),
    kind: Type.Union([
      Type.Literal('BUILT_IN'),
      Type.Literal('CONNECTOR'),
      Type.Literal('CUSTOM_API'),
    ]),
    connector_key: Type.Union([Type.String({ pattern: '^[a-z][a-z0-9_]{1,63}$' }), Type.Null()]),
    call_id: Type.Union([Uuid, Type.Null()]),
    arguments: Type.Unknown(),
    idempotency_key: Type.String({ pattern: '^[A-Za-z0-9_.:-]{16,200}$' }),
    timeout_ms: Type.Integer({ minimum: 100, maximum: 60_000 }),
  },
  { additionalProperties: false },
);

export interface ExecuteReply {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  readonly result: unknown;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly http_status: number | null;
}

export interface IncomingExecuteMessage {
  readonly subject: string;
  readonly authorization: string | null;
  readonly traceparent: string | null;
  readonly payload: Uint8Array;
}

export interface ExecutorLogger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface ExecutorDependencies {
  readonly db: Kysely<DB>;
  readonly verifier: ServiceTokenVerifier;
  readonly calendars: Readonly<Record<string, CalendarSync>>;
  readonly customApi: CustomApiExecutor;
  readonly now: () => Date;
  readonly logger: ExecutorLogger;
}

function failure(
  errorCode: string,
  retryable = false,
  httpStatus: number | null = null,
): ExecuteReply {
  return {
    status: 'FAILED',
    result: null,
    error_code: errorCode,
    retryable,
    http_status: httpStatus,
  };
}

function traceIdFrom(traceparent: string | null): string {
  const match =
    traceparent === null ? null : /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
  const candidate = match?.[1];
  return candidate !== undefined && candidate !== '0'.repeat(32)
    ? candidate
    : randomBytes(16).toString('hex');
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function executeMessage(
  deps: ExecutorDependencies,
  message: IncomingExecuteMessage,
): Promise<ExecuteReply> {
  const prefix = `${NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX}.`;
  const tenantId = message.subject.startsWith(prefix) ? message.subject.slice(prefix.length) : '';
  if (!UUID_REGEX.test(tenantId)) {
    return failure('VALIDATION_FAILED');
  }
  const token =
    message.authorization?.startsWith('Bearer ') === true
      ? message.authorization.slice('Bearer '.length)
      : null;
  if (!token) {
    return failure('UNAUTHENTICATED');
  }
  try {
    const verified = await verifyServiceToken(token, deps.verifier, ['connector.execute']);
    if (verified.issuer !== 'control-api' || verified.tenantId !== tenantId) {
      return failure('FORBIDDEN');
    }
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      return failure(error.code);
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(message.payload));
  } catch {
    return failure('MALFORMED_REQUEST');
  }
  if (!Value.Check(ExecuteRequestSchema, payload)) {
    return failure('VALIDATION_FAILED');
  }
  const request = payload;
  const traceId = traceIdFrom(message.traceparent);
  const context = { tenantId, actorType: 'SERVICE' as const, actorId: 'connector-worker', traceId };
  const work = (async (): Promise<ToolResult> => {
    const definition = await withTenantTransaction(deps.db, context, (trx) =>
      trx
        .selectFrom('tool_definitions')
        .leftJoin(
          'tenant_secret_refs',
          'tenant_secret_refs.id',
          'tool_definitions.auth_secret_ref_id',
        )
        .select([
          'tool_definitions.id',
          'tool_definitions.name',
          'tool_definitions.kind',
          'tool_definitions.connector_key',
          'tool_definitions.status',
          'tool_definitions.base_url',
          'tool_definitions.path_template',
          'tool_definitions.http_method',
          'tool_definitions.allowed_hosts',
          'tool_definitions.auth_type',
          'tool_definitions.response_max_bytes',
          'tool_definitions.max_retries',
          'tool_definitions.idempotency_supported',
          'tool_definitions.timeout_ms',
          'tenant_secret_refs.secret_ref',
          'tenant_secret_refs.status as secret_status',
        ])
        .where('tool_definitions.id', '=', request.tool_definition_id)
        .executeTakeFirst(),
    );
    if (
      definition === undefined ||
      definition.status !== 'ACTIVE' ||
      definition.name !== request.tool_name ||
      definition.kind !== request.kind ||
      definition.connector_key !== request.connector_key
    ) {
      throw new ToolExecutionError(
        'TOOL_NOT_ALLOWED',
        'tool definition does not match the dispatched request',
      );
    }
    const toolRequest = {
      tenantId,
      callId: request.call_id,
      toolName: request.tool_name,
      arguments: request.arguments,
      idempotencyKey: request.idempotency_key,
      traceId,
      now: deps.now(),
    };
    switch (definition.kind) {
      case 'BUILT_IN':
        return executeBookingTool(toolRequest, { db: deps.db, calendar: null });
      case 'CONNECTOR': {
        const calendar =
          definition.connector_key === null ? undefined : deps.calendars[definition.connector_key];
        if (calendar === undefined) {
          throw new ToolExecutionError(
            'TOOL_NOT_ALLOWED',
            'connector is not available in this worker',
            { details: { connector_key: definition.connector_key } },
          );
        }
        return executeBookingTool(toolRequest, { db: deps.db, calendar });
      }
      case 'CUSTOM_API':
        return deps.customApi.execute(
          {
            id: definition.id,
            name: definition.name,
            baseUrl: definition.base_url,
            pathTemplate: definition.path_template,
            httpMethod: definition.http_method,
            allowedHosts: definition.allowed_hosts,
            authType: definition.auth_type,
            authSecretRef: definition.secret_status === 'ACTIVE' ? definition.secret_ref : null,
            responseMaxBytes: definition.response_max_bytes,
            maxRetries: definition.max_retries,
            idempotencySupported: definition.idempotency_supported,
            timeoutMs: Math.min(definition.timeout_ms, request.timeout_ms),
          },
          {
            toolRunId: request.tool_run_id,
            arguments: request.arguments,
            idempotencyKey: request.idempotency_key,
            traceId,
          },
        );
      default:
        throw new ToolExecutionError('TOOL_NOT_ALLOWED', 'unsupported tool kind');
    }
  })();
  try {
    const outcome = await withTimeout(work, request.timeout_ms);
    if (outcome === 'timeout') {
      work.catch((error: unknown) => {
        deps.logger.warn(
          {
            tool_run_id: request.tool_run_id,
            err: error instanceof Error ? error.name : 'unknown',
          },
          'tool execution finished after its timeout',
        );
      });
      return {
        status: 'TIMED_OUT',
        result: null,
        error_code: 'UPSTREAM_TIMEOUT',
        retryable: true,
        http_status: null,
      };
    }
    return {
      status: 'SUCCEEDED',
      result: outcome.result,
      error_code: null,
      retryable: false,
      http_status: outcome.httpStatus,
    };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return failure(error.code, error.retryable, error.httpStatus);
    }
    deps.logger.error(
      {
        tool_run_id: request.tool_run_id,
        err: error instanceof Error ? error.message : String(error),
      },
      'tool execution failed unexpectedly',
    );
    return failure('INTERNAL_ERROR', true);
  }
}
