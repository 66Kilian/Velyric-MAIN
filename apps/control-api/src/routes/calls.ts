import { AgentConfigSchema } from '@velyric/contracts';
import type { Calls } from '@velyric/db';
import type { Selectable } from 'kysely';
import Type from 'typebox';
import { Value } from 'typebox/value';
import {
  assertKillSwitchReleased,
  idempotentWrite,
  inTenant,
  requestMeta,
  tenantContext,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import { buildPage, newId, readCursor, writeAudit } from '../persistence.js';
import { permissionsOf, requireTenantActor, type TenantActor } from '../principal.js';
import type { RuntimeCommandBus } from '../runtime/command-bus.js';
import { IdParams, iso, limitFromQuery, Uuid } from './common.js';

export interface CallRouteDependencies {
  readonly commandBus: RuntimeCommandBus;
}

const ACTIVE_STATUSES = ['INITIATED', 'QUEUED', 'IN_PROGRESS', 'TRANSFERRING'] as const;
const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_STATUSES);
const UNMASKED_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'OPERATOR']);

const ListQuery = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    status: Type.Optional(Type.String({ pattern: '^(ACTIVE|[A-Z_]{4,20})$' })),
    direction: Type.Optional(Type.Union([Type.Literal('INBOUND'), Type.Literal('OUTBOUND')])),
    channel: Type.Optional(
      Type.Union([Type.Literal('PSTN'), Type.Literal('WEB_VOICE'), Type.Literal('SIMULATION')]),
    ),
    agent_id: Type.Optional(Uuid),
    location_id: Type.Optional(Uuid),
    language: Type.Optional(Type.String({ pattern: '^[a-z]{2}$' })),
    outcome: Type.Optional(Type.String({ pattern: '^[A-Z_]{4,30}$' })),
    from: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
    to: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
  },
  { additionalProperties: false },
);

const TransferBody = Type.Object(
  {
    destination_label: Type.String({ pattern: '^[a-z0-9_-]{2,40}$' }),
    transfer_type: Type.Union([Type.Literal('COLD'), Type.Literal('WARM')]),
    reason: Type.String({ minLength: 3, maxLength: 300 }),
  },
  { additionalProperties: false },
);

const TerminateBody = Type.Object(
  { reason: Type.String({ minLength: 3, maxLength: 300 }) },
  { additionalProperties: false },
);

export function maskE164(e164: string | null): string | null {
  if (e164 === null) {
    return null;
  }
  return `${e164.slice(0, 4)}${'*'.repeat(Math.max(0, e164.length - 6))}${e164.slice(-2)}`;
}

function presentCall(row: Selectable<Calls>, actor: TenantActor): Record<string, unknown> {
  const unmasked =
    actor.actorType === 'API_KEY' || (actor.role !== null && UNMASKED_ROLES.has(actor.role));
  return {
    id: row.id,
    status: row.status,
    direction: row.direction,
    channel: row.channel,
    caller_e164: unmasked ? row.caller_e164 : maskE164(row.caller_e164),
    language: row.language,
    location_id: row.location_id,
    agent_id: row.agent_id,
    agent_version_id: row.agent_version_id,
    intent: row.intent,
    outcome: row.outcome,
    end_reason: row.end_reason,
    conversation_state: row.conversation_state,
    started_at: iso(row.started_at),
    answered_at: iso(row.answered_at),
    ended_at: iso(row.ended_at),
    duration_seconds: row.connected_seconds,
    quality_score: row.quality_score === null ? null : Number(row.quality_score),
  };
}

function parseInstant(value: string | undefined, path: string): Date | null {
  if (value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'rfc3339' }] });
  }
  return parsed;
}

export function createCallRoutes(deps: CallRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/calls', { schema: { querystring: ListQuery } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'calls:read');
      const query = request.query;
      const limit = limitFromQuery(query.limit);
      const cursor = readCursor(query.cursor, services.cursorKey);
      const from = parseInstant(query.from, '/query/from');
      const to = parseInstant(query.to, '/query/to');
      if (
        query.location_id !== undefined &&
        actor.locationScope.length > 0 &&
        !actor.locationScope.includes(query.location_id)
      ) {
        throw new ApiError('FORBIDDEN', { reason: 'location_scope' });
      }
      const rows = await inTenant(services, actor, request, (trx) => {
        let builder = trx
          .selectFrom('calls')
          .selectAll()
          .orderBy('started_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1);
        if (query.status === 'ACTIVE') {
          builder = builder.where('status', 'in', [...ACTIVE_STATUSES]);
        } else if (query.status !== undefined) {
          builder = builder.where('status', '=', query.status);
        }
        if (query.direction !== undefined)
          builder = builder.where('direction', '=', query.direction);
        if (query.channel !== undefined) builder = builder.where('channel', '=', query.channel);
        if (query.agent_id !== undefined) builder = builder.where('agent_id', '=', query.agent_id);
        if (query.location_id !== undefined)
          builder = builder.where('location_id', '=', query.location_id);
        if (query.language !== undefined) builder = builder.where('language', '=', query.language);
        if (query.outcome !== undefined) builder = builder.where('outcome', '=', query.outcome);
        if (from !== null) builder = builder.where('started_at', '>=', from);
        if (to !== null) builder = builder.where('started_at', '<', to);
        if (actor.locationScope.length > 0)
          builder = builder.where('location_id', 'in', actor.locationScope);
        if (cursor !== null) {
          const startedAt = new Date(String(cursor.k[0]));
          builder = builder.where((eb) =>
            eb(eb.refTuple('started_at', 'id'), '<', eb.tuple(startedAt, cursor.id)),
          );
        }
        return builder.execute();
      });
      return buildPage(
        rows,
        limit,
        services.cursorKey,
        (row) => ({ v: 1, k: [row.started_at.toISOString()], id: row.id }),
        (row) => presentCall(row, actor),
      );
    });

    app.get('/v1/calls/:id', { schema: { params: IdParams } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'calls:read');
      const canReadTranscript =
        request.principal !== null && permissionsOf(request.principal).has('calls:read_transcript');
      const detail = await inTenant(services, actor, request, async (trx) => {
        const call = await trx
          .selectFrom('calls')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (
          call === undefined ||
          (actor.locationScope.length > 0 && !actor.locationScope.includes(call.location_id ?? ''))
        ) {
          return null;
        }
        const [events, toolRuns, transfers, quality, transcript] = await Promise.all([
          trx
            .selectFrom('call_events')
            .select(['seq', 'event_type', 'occurred_at'])
            .where('call_id', '=', call.id)
            .orderBy('seq')
            .limit(1000)
            .execute(),
          trx
            .selectFrom('tool_runs')
            .innerJoin('tool_definitions', 'tool_definitions.id', 'tool_runs.tool_definition_id')
            .select([
              'tool_runs.id',
              'tool_definitions.name',
              'tool_runs.specialist',
              'tool_runs.status',
              'tool_runs.error_code',
              'tool_runs.latency_ms',
              'tool_runs.created_at',
            ])
            .where('tool_runs.call_id', '=', call.id)
            .orderBy('tool_runs.created_at')
            .execute(),
          trx
            .selectFrom('transfer_attempts')
            .select([
              'id',
              'transfer_type',
              'trigger',
              'state',
              'destination_label',
              'failure_reason',
              'started_at',
              'ended_at',
            ])
            .where('call_id', '=', call.id)
            .orderBy('started_at')
            .execute(),
          trx
            .selectFrom('quality_scores')
            .select(['rubric_version', 'overall_score', 'flags', 'created_at'])
            .where('call_id', '=', call.id)
            .orderBy('created_at', 'desc')
            .executeTakeFirst(),
          canReadTranscript
            ? trx
                .selectFrom('transcript_segments')
                .select([
                  'seq',
                  'speaker',
                  'language',
                  'start_ms',
                  'end_ms',
                  'content',
                  'redaction_state',
                ])
                .where('call_id', '=', call.id)
                .where('redaction_state', '<>', 'PURGED')
                .orderBy('seq')
                .execute()
            : Promise.resolve(null),
        ]);
        return { call, events, toolRuns, transfers, quality, transcript };
      });
      if (detail === null) {
        throw new ApiError('NOT_FOUND');
      }
      return {
        ...presentCall(detail.call, actor),
        summary: canReadTranscript ? detail.call.summary : null,
        billable_seconds: detail.call.billable_seconds,
        cost_usd_micros:
          detail.call.cost_usd_micros === null ? null : Number(detail.call.cost_usd_micros),
        trace_id: detail.call.trace_id,
        events: detail.events.map((event) => ({
          seq: Number(event.seq),
          type: event.event_type,
          occurred_at: iso(event.occurred_at),
        })),
        tool_runs: detail.toolRuns.map((run) => ({
          id: run.id,
          tool: run.name,
          specialist: run.specialist,
          status: run.status,
          error_code: run.error_code,
          latency_ms: run.latency_ms,
          created_at: iso(run.created_at),
        })),
        transfers: detail.transfers.map((transfer) => ({
          ...transfer,
          started_at: iso(transfer.started_at),
          ended_at: iso(transfer.ended_at),
        })),
        quality:
          detail.quality === undefined
            ? null
            : {
                rubric_version: detail.quality.rubric_version,
                overall_score: Number(detail.quality.overall_score),
                flags: detail.quality.flags,
              },
        transcript: detail.transcript,
      };
    });

    app.post(
      '/v1/calls/:id/transfer',
      { schema: { params: IdParams, body: TransferBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'calls:transfer');
        const body = request.body;
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: null },
          'calls.transfer',
          async (trx) => {
            const call = await trx
              .selectFrom('calls')
              .select(['id', 'status', 'agent_version_id', 'location_id'])
              .where('id', '=', request.params.id)
              .forUpdate()
              .executeTakeFirst();
            if (
              call === undefined ||
              (actor.locationScope.length > 0 &&
                !actor.locationScope.includes(call.location_id ?? ''))
            ) {
              throw new ApiError('NOT_FOUND');
            }
            if (call.status !== 'IN_PROGRESS') {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: call.status });
            }
            await assertKillSwitchReleased(trx, 'kill.call_transfer', [
              { scopeType: 'TENANT', scopeRef: actor.tenantId },
            ]);
            const version =
              call.agent_version_id === null
                ? undefined
                : await trx
                    .selectFrom('agent_versions')
                    .select(['config'])
                    .where('id', '=', call.agent_version_id)
                    .executeTakeFirst();
            if (version === undefined || !Value.Check(AgentConfigSchema, version.config)) {
              throw new ApiError('TRANSFER_DESTINATION_NOT_ALLOWED', {
                reason: 'no_agent_configuration',
              });
            }
            const destination = version.config.handoff.destinations.find(
              (candidate) => candidate.label === body.destination_label,
            );
            if (destination === undefined) {
              throw new ApiError('TRANSFER_DESTINATION_NOT_ALLOWED', {
                destination_label: body.destination_label,
              });
            }
            const transferId = newId();
            const result = await deps.commandBus.send(
              actor.tenantId,
              call.id,
              {
                type: 'TRANSFER',
                transferAttemptId: transferId,
                destinationE164: destination.e164,
                transferType: body.transfer_type,
                reason: body.reason,
                requestedBy: actor.actorId,
              },
              request.traceId,
            );
            if (!result.accepted) {
              throw result.errorCode === 'SERVICE_UNAVAILABLE'
                ? new ApiError(
                    'SERVICE_UNAVAILABLE',
                    { runtime_state: result.state },
                    { headers: { 'retry-after': '2' } },
                  )
                : new ApiError('CONFLICT', {
                    runtime_state: result.state,
                    runtime_error: result.errorCode,
                  });
            }
            await trx
              .insertInto('transfer_attempts')
              .values({
                id: transferId,
                tenant_id: actor.tenantId,
                call_id: call.id,
                transfer_type: body.transfer_type,
                trigger: 'OPERATOR',
                state: 'PREPARING',
                destination_e164: destination.e164,
                destination_label: destination.label,
                idempotency_key: `operator:${transferId}`,
              })
              .execute();
            await trx
              .updateTable('calls')
              .set({ status: 'TRANSFERRING' })
              .where('id', '=', call.id)
              .execute();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'call.transfer_requested',
              objectType: 'call',
              objectId: call.id,
              metadata: {
                transfer_attempt_id: transferId,
                destination_label: destination.label,
                transfer_type: body.transfer_type,
                reason: body.reason,
              },
            });
            return {
              status: 202,
              body: {
                transfer_attempt_id: transferId,
                state: 'PREPARING',
                runtime_state: result.state,
              },
            };
          },
        );
      },
    );

    app.post(
      '/v1/calls/:id/terminate',
      { schema: { params: IdParams, body: TerminateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'calls:terminate');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: null },
          'calls.terminate',
          async (trx) => {
            const call = await trx
              .selectFrom('calls')
              .select(['id', 'status', 'location_id'])
              .where('id', '=', request.params.id)
              .forUpdate()
              .executeTakeFirst();
            if (
              call === undefined ||
              (actor.locationScope.length > 0 &&
                !actor.locationScope.includes(call.location_id ?? ''))
            ) {
              throw new ApiError('NOT_FOUND');
            }
            if (!ACTIVE.has(call.status)) {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: call.status });
            }
            const result = await deps.commandBus.send(
              actor.tenantId,
              call.id,
              { type: 'TERMINATE', reason: request.body.reason, requestedBy: actor.actorId },
              request.traceId,
            );
            if (!result.accepted) {
              throw new ApiError(
                'SERVICE_UNAVAILABLE',
                { runtime_state: result.state },
                { headers: { 'retry-after': '2' } },
              );
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'call.terminate_requested',
              objectType: 'call',
              objectId: call.id,
              metadata: { reason: request.body.reason },
            });
            return { status: 202, body: { call_id: call.id, runtime_state: result.state } };
          },
        );
      },
    );
  };
}
