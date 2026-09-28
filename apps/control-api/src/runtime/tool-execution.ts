import { AgentConfigSchema, type ConversationState, type ToolKind } from '@velyric/contracts';
import { withTenantTransaction, type DB, type TenantContext } from '@velyric/db';
import { evaluateToolExecution, type ToolPolicyFacts } from '@velyric/domain';
import { sha256Hex } from '@velyric/security';
import type { Kysely } from 'kysely';
import { Value } from 'typebox/value';
import { ApiError } from '../errors.js';
import { canonicalJson, newId, type Trx } from '../persistence.js';
import type { JsonSchemaValidator, ToolDispatcher, ToolDispatchResult } from './tool-dispatch.js';

export interface ToolGatewayResponse {
  readonly tool_run_id: string;
  readonly status: string;
  readonly result: unknown;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly replayed: boolean;
}

export interface ToolExecutionRequest {
  readonly tenantId: string;
  readonly callId: string | null;
  readonly agentVersionId: string;
  readonly specialist: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly conversationState: ConversationState;
  readonly confirmation: { readonly confirmedAt: string; readonly turnSeq: number } | null;
  readonly verifiedIdentity: boolean;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

export interface ToolExecutionDependencies {
  readonly db: Kysely<DB>;
  readonly now: () => Date;
  readonly dispatcher: ToolDispatcher;
  readonly schemaValidator: JsonSchemaValidator;
  readonly onDispatchError: (details: Record<string, unknown>, message: string) => void;
}

export async function engagedKillSwitches(
  trx: Trx,
  scopes: readonly { scopeType: string; scopeRef: string }[],
): Promise<string[]> {
  const rows = await trx
    .selectFrom('kill_switches')
    .select(['switch_key'])
    .where('engaged', '=', true)
    .where((eb) =>
      eb.or([
        eb('scope_type', '=', 'GLOBAL'),
        ...scopes.map((scope) =>
          eb.and([eb('scope_type', '=', scope.scopeType), eb('scope_ref', '=', scope.scopeRef)]),
        ),
      ]),
    )
    .execute();
  return [...new Set(rows.map((row) => row.switch_key))].sort();
}

export async function executeToolRun(
  deps: ToolExecutionDependencies,
  context: TenantContext,
  input: ToolExecutionRequest,
): Promise<ToolGatewayResponse> {
  const requestHash = sha256Hex(
    canonicalJson({
      tool_name: input.toolName,
      arguments: input.arguments,
      call_id: input.callId,
    }),
  );
  const phaseOne = await withTenantTransaction(deps.db, context, async (trx) => {
    const tool = await trx
      .selectFrom('tool_definitions')
      .selectAll()
      .where('name', '=', input.toolName)
      .executeTakeFirst();
    const existing =
      tool === undefined
        ? undefined
        : await trx
            .selectFrom('tool_runs')
            .select(['id', 'status', 'request_hash', 'error_code', 'response_meta'])
            .where('tool_definition_id', '=', tool.id)
            .where('idempotency_key', '=', input.idempotencyKey)
            .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_KEY_REUSED');
      }
      if (existing.status === 'PENDING' || existing.status === 'RUNNING') {
        throw new ApiError('IDEMPOTENCY_KEY_IN_PROGRESS', undefined, {
          headers: { 'retry-after': '1' },
        });
      }
      const meta = existing.response_meta as Record<string, unknown>;
      return {
        kind: 'final' as const,
        response: {
          tool_run_id: existing.id,
          status: existing.status,
          result: meta['result'] ?? null,
          error_code: existing.error_code,
          retryable: false,
          replayed: true,
        },
      };
    }
    const version = await trx
      .selectFrom('agent_versions')
      .select(['config'])
      .where('id', '=', input.agentVersionId)
      .executeTakeFirst();
    if (version === undefined || !Value.Check(AgentConfigSchema, version.config)) {
      throw new ApiError('NOT_FOUND', { resource: 'agent_version' });
    }
    const config = version.config;
    if (tool === undefined) {
      throw new ApiError('TOOL_NOT_ALLOWED', { reason: 'unknown_tool' });
    }
    const counts =
      input.callId === null
        ? { total: 0, specialist: 0 }
        : await trx
            .selectFrom('tool_runs')
            .select((eb) => [
              eb.fn.countAll<string>().as('total'),
              eb.fn
                .countAll<string>()
                .filterWhere('specialist', '=', input.specialist)
                .as('specialist'),
            ])
            .where('call_id', '=', input.callId)
            .where('status', 'not in', ['REJECTED_BY_POLICY', 'DEDUPLICATED'])
            .executeTakeFirstOrThrow();
    const killed = await engagedKillSwitches(trx, [
      { scopeType: 'TENANT', scopeRef: input.tenantId },
      { scopeType: 'TOOL', scopeRef: tool.id },
    ]);
    const facts: ToolPolicyFacts = {
      sideEffectClass: tool.side_effect_class as ToolPolicyFacts['sideEffectClass'],
      confirmationPolicy: tool.confirmation_policy as ToolPolicyFacts['confirmationPolicy'],
      status: killed.includes('kill.tool') ? 'KILLED' : (tool.status as ToolPolicyFacts['status']),
    };
    const decision = evaluateToolExecution(config, facts, {
      specialist: input.specialist,
      toolName: input.toolName,
      conversationState: input.conversationState,
      confirmation:
        input.confirmation === null
          ? null
          : { confirmedAt: input.confirmation.confirmedAt, turnSeq: input.confirmation.turnSeq },
      verifiedIdentity: input.verifiedIdentity,
      executionsInCall: Number(counts.total),
      executionsBySpecialist: Number(counts.specialist),
    });
    const toolRunId = newId();
    const insertRun = async (
      status: string,
      errorCode: string | null,
      meta: Record<string, unknown>,
    ): Promise<void> => {
      await trx
        .insertInto('tool_runs')
        .values({
          id: toolRunId,
          tenant_id: input.tenantId,
          call_id: input.callId,
          tool_definition_id: tool.id,
          specialist: input.specialist,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          status,
          attempt: status === 'RUNNING' ? 1 : 0,
          error_code: errorCode,
          response_meta: JSON.stringify(meta),
          trace_id: input.traceId,
          started_at: status === 'RUNNING' ? deps.now() : null,
          finished_at: status === 'RUNNING' ? null : deps.now(),
        })
        .execute();
    };
    if (!decision.allowed) {
      const errorCode =
        killed.includes('kill.tool') && decision.errorCode === 'TOOL_NOT_ALLOWED'
          ? 'KILL_SWITCH_ACTIVE'
          : decision.errorCode;
      await insertRun('REJECTED_BY_POLICY', errorCode, { reason: decision.reason });
      return {
        kind: 'final' as const,
        response: {
          tool_run_id: toolRunId,
          status: 'REJECTED_BY_POLICY',
          result: null,
          error_code: errorCode,
          retryable: false,
          replayed: false,
        },
      };
    }
    const argumentsValidation = deps.schemaValidator.validate(
      `${tool.id}:${String(tool.version)}:input`,
      tool.input_schema,
      input.arguments,
    );
    if (!argumentsValidation.valid) {
      await insertRun('FAILED', 'TOOL_SCHEMA_INVALID', { issues: argumentsValidation.issues });
      return {
        kind: 'final' as const,
        response: {
          tool_run_id: toolRunId,
          status: 'FAILED',
          result: null,
          error_code: 'TOOL_SCHEMA_INVALID',
          retryable: false,
          replayed: false,
        },
      };
    }
    await insertRun('RUNNING', null, {});
    return {
      kind: 'dispatch' as const,
      toolRunId,
      tool: {
        id: tool.id,
        name: tool.name,
        kind: tool.kind as ToolKind,
        connectorKey: tool.connector_key,
        timeoutMs: tool.timeout_ms,
        outputSchema: tool.output_schema,
        version: tool.version,
      },
    };
  });

  if (phaseOne.kind === 'final') {
    return phaseOne.response;
  }

  let outcome: ToolDispatchResult;
  try {
    outcome = await deps.dispatcher.dispatch({
      tenantId: input.tenantId,
      callId: input.callId,
      toolRunId: phaseOne.toolRunId,
      toolDefinitionId: phaseOne.tool.id,
      toolName: phaseOne.tool.name,
      kind: phaseOne.tool.kind,
      connectorKey: phaseOne.tool.connectorKey,
      arguments: input.arguments,
      idempotencyKey: input.idempotencyKey,
      timeoutMs: phaseOne.tool.timeoutMs,
      traceId: input.traceId,
    });
  } catch (error) {
    deps.onDispatchError(
      { err: error, tool_run_id: phaseOne.toolRunId },
      'tool dispatch failed unexpectedly',
    );
    outcome = {
      status: 'FAILED',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
      httpStatus: null,
      latencyMs: 0,
    };
  }
  if (outcome.status === 'SUCCEEDED') {
    const outputValidation = deps.schemaValidator.validate(
      `${phaseOne.tool.id}:${String(phaseOne.tool.version)}:output`,
      phaseOne.tool.outputSchema,
      outcome.result,
    );
    if (!outputValidation.valid) {
      outcome = {
        status: 'FAILED',
        errorCode: 'TOOL_SCHEMA_INVALID',
        retryable: false,
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
      };
    }
  }
  const final = outcome;
  return withTenantTransaction(deps.db, context, async (trx) => {
    await trx
      .updateTable('tool_runs')
      .set({
        status: final.status,
        error_code: final.status === 'SUCCEEDED' ? null : final.errorCode,
        http_status: final.httpStatus,
        latency_ms: final.latencyMs,
        response_meta: JSON.stringify(
          final.status === 'SUCCEEDED' ? { result: final.result } : { retryable: final.retryable },
        ),
        finished_at: deps.now(),
      })
      .where('id', '=', phaseOne.toolRunId)
      .execute();
    return {
      tool_run_id: phaseOne.toolRunId,
      status: final.status,
      result: final.status === 'SUCCEEDED' ? final.result : null,
      error_code: final.status === 'SUCCEEDED' ? null : final.errorCode,
      retryable: final.status === 'SUCCEEDED' ? false : final.retryable,
      replayed: false,
    };
  });
}
