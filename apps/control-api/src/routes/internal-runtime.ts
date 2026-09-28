import {
  AgentConfigSchema,
  CallIntentCategory,
  ConversationState,
  type TenantStatus,
} from '@velyric/contracts';
import { withTenantTransaction, type TenantContext } from '@velyric/db';
import { tenantAcceptsCalls } from '@velyric/domain';
import Type from 'typebox';
import { Value } from 'typebox/value';
import { headerValue, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { newId } from '../persistence.js';
import { resolvePhoneProfile } from '../contacts/identity.js';
import { requireServiceScope, type ServicePrincipal } from '../principal.js';
import type { JsonSchemaValidator, ToolDispatcher } from '../runtime/tool-dispatch.js';
import { engagedKillSwitches, executeToolRun } from '../runtime/tool-execution.js';
import { IdParams, iso, Uuid } from './common.js';

export interface InternalRuntimeDependencies {
  readonly dispatcher: ToolDispatcher;
  readonly schemaValidator: JsonSchemaValidator;
}

const E164 = Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' });
const TRACE = Type.String({ pattern: '^[0-9a-f]{32}$' });
const ConversationStateSchema = Type.Enum(ConversationState);

const RoutingQuery = Type.Object(
  { provider: Type.Union([Type.Literal('telnyx'), Type.Literal('twilio')]), e164: E164 },
  { additionalProperties: false },
);

const ToolExecutionBody = Type.Object(
  {
    tenant_id: Uuid,
    call_id: Type.Union([Uuid, Type.Null()]),
    agent_version_id: Uuid,
    specialist: Type.String({ pattern: '^[A-Z_]{3,30}$' }),
    tool_name: Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    conversation_state: ConversationStateSchema,
    confirmation: Type.Optional(
      Type.Object(
        {
          confirmed_at: Type.String({ minLength: 20, maxLength: 40 }),
          confirmation_turn_seq: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    verified_identity: Type.Boolean(),
    trace_id: Type.Optional(TRACE),
  },
  { additionalProperties: false },
);

const CALL_STATUSES = [
  'INITIATED',
  'QUEUED',
  'IN_PROGRESS',
  'TRANSFERRING',
  'TRANSFERRED',
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'ABANDONED',
] as const;
const TERMINAL_CALL_STATUSES: ReadonlySet<string> = new Set([
  'TRANSFERRED',
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'ABANDONED',
]);

const CallUpsertBody = Type.Object(
  {
    provider: Type.String({ pattern: '^[a-z_]{3,20}$' }),
    provider_call_id: Type.String({ minLength: 1, maxLength: 200 }),
    realtime_session_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    channel: Type.Union([
      Type.Literal('PSTN'),
      Type.Literal('WEB_VOICE'),
      Type.Literal('SIMULATION'),
    ]),
    direction: Type.Union([Type.Literal('INBOUND'), Type.Literal('OUTBOUND')]),
    caller_e164: Type.Optional(E164),
    phone_number_id: Type.Optional(Uuid),
    location_id: Type.Optional(Uuid),
    agent_id: Type.Optional(Uuid),
    agent_version_id: Type.Optional(Uuid),
    language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
    status: Type.Enum(CALL_STATUSES),
    conversation_state: Type.Optional(ConversationStateSchema),
    admission_decision: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,30}$' })),
    admission_reject_reason: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,40}$' })),
    intent: Type.Optional(Type.Enum(Object.values(CallIntentCategory))),
    outcome: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,30}$' })),
    end_reason: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,40}$' })),
    started_at: Type.String({ minLength: 20, maxLength: 40 }),
    answered_at: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
    ended_at: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
    connected_seconds: Type.Optional(Type.Integer({ minimum: 0 })),
    billable_seconds: Type.Optional(Type.Integer({ minimum: 0 })),
    cost_usd_micros: Type.Optional(Type.Integer({ minimum: 0 })),
    trace_id: TRACE,
    runtime_instance_id: Type.String({ minLength: 1, maxLength: 128 }),
    recording_enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

const CallEventsBody = Type.Object(
  {
    events: Type.Array(
      Type.Object(
        {
          event_id: Uuid,
          seq: Type.Integer({ minimum: 0 }),
          event_type: Type.String({ pattern: '^[a-z_]+(\\.[a-z_]+)+$' }),
          schema_version: Type.Integer({ minimum: 1 }),
          occurred_at: Type.String({ minLength: 20, maxLength: 40 }),
          payload: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
    transcript: Type.Optional(
      Type.Array(
        Type.Object(
          {
            seq: Type.Integer({ minimum: 0 }),
            speaker: Type.Union([
              Type.Literal('CALLER'),
              Type.Literal('AGENT'),
              Type.Literal('HUMAN_AGENT'),
              Type.Literal('SYSTEM'),
            ]),
            language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
            start_ms: Type.Integer({ minimum: 0 }),
            end_ms: Type.Integer({ minimum: 0 }),
            content: Type.String({ minLength: 1, maxLength: 8000 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 500 },
      ),
    ),
  },
  { additionalProperties: false },
);

function parseTimestamp(value: string, path: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/Z$|[+-]\d{2}:\d{2}$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'rfc3339' }] });
  }
  return parsed;
}

function tenantBound(service: ServicePrincipal, traceId: string): TenantContext {
  if (service.tenantId === null) {
    throw new ApiError('FORBIDDEN', { reason: 'tenant_claim_required' });
  }
  return { tenantId: service.tenantId, actorType: 'SERVICE', actorId: service.issuer, traceId };
}

export function createInternalRuntimeRoutes(deps: InternalRuntimeDependencies): RouteModule {
  return (app, services) => {
    app.get(
      '/internal/v1/runtime/agent-snapshots/:id',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const service = requireServiceScope(request.principal, 'runtime.snapshot.read');
        const context = tenantBound(service, request.traceId);
        const snapshot = await withTenantTransaction(services.db, context, async (trx) => {
          const version = await trx
            .selectFrom('agent_versions')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (version === undefined) {
            return null;
          }
          if (!Value.Check(AgentConfigSchema, version.config)) {
            throw new ApiError('INTERNAL_ERROR', { reason: 'stored_config_invalid' });
          }
          const config = version.config;
          const toolNames = [
            ...new Set(config.specialists.flatMap((specialist) => specialist.tool_allowlist)),
          ];
          const tools =
            toolNames.length === 0
              ? []
              : await trx
                  .selectFrom('tool_definitions')
                  .select([
                    'id',
                    'name',
                    'description',
                    'kind',
                    'input_schema',
                    'output_schema',
                    'side_effect_class',
                    'confirmation_policy',
                    'timeout_ms',
                    'status',
                  ])
                  .where('name', 'in', toolNames)
                  .execute();
          return { version, config, tools };
        });
        if (snapshot === null) {
          throw new ApiError('NOT_FOUND');
        }
        const etag = `"${snapshot.version.config_hash}"`;
        if (headerValue(request.headers['if-none-match']) === etag) {
          return reply.code(304).header('etag', etag).send();
        }
        return reply
          .header('etag', etag)
          .header('cache-control', 'private, max-age=86400, immutable')
          .send({
            snapshot_id: `${snapshot.version.id}:${snapshot.version.config_hash}`,
            tenant_id: context.tenantId,
            agent_id: snapshot.version.agent_id,
            agent_version_id: snapshot.version.id,
            version_number: snapshot.version.version_number,
            status: snapshot.version.status,
            config_hash: snapshot.version.config_hash,
            schema_version: snapshot.version.schema_version,
            disclosure_version: snapshot.config.disclosure.version,
            config: snapshot.config,
            tools: snapshot.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              kind: tool.kind,
              input_schema: tool.input_schema,
              output_schema: tool.output_schema,
              side_effect_class: tool.side_effect_class,
              confirmation_policy: tool.confirmation_policy,
              timeout_ms: tool.timeout_ms,
              active: tool.status === 'ACTIVE',
            })),
            generated_at: services.now().toISOString(),
          });
      },
    );

    app.get(
      '/internal/v1/runtime/routing',
      { schema: { querystring: RoutingQuery } },
      async (request) => {
        requireServiceScope(request.principal, 'runtime.admission.read');
        const directory = await services.db
          .selectFrom('phone_number_directory')
          .select(['tenant_id', 'phone_number_id', 'status'])
          .where('provider', '=', request.query.provider)
          .where('e164', '=', request.query.e164)
          .executeTakeFirst();
        if (directory === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        const tenantId = directory.tenant_id;
        return withTenantTransaction(
          services.db,
          { tenantId, actorType: 'SERVICE', actorId: 'runtime-routing', traceId: request.traceId },
          async (trx) => {
            const tenant = await trx
              .selectFrom('tenants')
              .select(['status', 'timezone', 'default_locale'])
              .executeTakeFirstOrThrow();
            const number = await trx
              .selectFrom('phone_numbers')
              .select(['id', 'location_id', 'status', 'max_concurrent_calls'])
              .where('id', '=', directory.phone_number_id)
              .executeTakeFirstOrThrow();
            const binding = await trx
              .selectFrom('agent_phone_bindings')
              .innerJoin('agents', 'agents.id', 'agent_phone_bindings.agent_id')
              .select([
                'agents.id as agent_id',
                'agents.status',
                'agents.production_version_id',
                'agents.canary_version_id',
              ])
              .where('agent_phone_bindings.phone_number_id', '=', number.id)
              .where('agent_phone_bindings.active', '=', true)
              .where('agents.status', '=', 'ACTIVE')
              .where('agents.production_version_id', 'is not', null)
              .orderBy('agent_phone_bindings.priority')
              .executeTakeFirst();
            const canary =
              binding?.canary_version_id === null || binding === undefined
                ? null
                : await trx
                    .selectFrom('agent_versions')
                    .select(['id', 'rollout_percent'])
                    .where('id', '=', binding.canary_version_id)
                    .executeTakeFirst();
            const entitlement = await trx
              .selectFrom('entitlement_snapshots')
              .selectAll()
              .orderBy('version', 'desc')
              .executeTakeFirst();
            const now = services.now();
            const budget = await trx
              .selectFrom('cost_budgets')
              .select([
                'daily_cap_usd_micros',
                'monthly_cap_usd_micros',
                'consumed_usd_micros',
                'hard_cap_reached_at',
              ])
              .where('billing_period_start', '<=', now)
              .where('billing_period_end', '>', now)
              .executeTakeFirst();
            const killSwitches = await engagedKillSwitches(trx, [
              { scopeType: 'TENANT', scopeRef: tenantId },
              { scopeType: 'PROVIDER', scopeRef: request.query.provider },
              ...(binding === undefined
                ? []
                : [{ scopeType: 'AGENT', scopeRef: binding.agent_id }]),
              ...(number.location_id === null
                ? []
                : [{ scopeType: 'LOCATION', scopeRef: number.location_id }]),
            ]);
            const limits = (entitlement?.limits ?? {}) as Record<string, unknown>;
            const blockReason = ((): string | null => {
              if (
                killSwitches.some(
                  (key) =>
                    key === 'kill.global_new_calls' ||
                    key === 'kill.tenant_traffic' ||
                    key === 'kill.provider',
                )
              ) {
                return 'KILL_SWITCH';
              }
              if (!tenantAcceptsCalls(tenant.status as TenantStatus)) {
                return 'TENANT_SUSPENDED';
              }
              if (
                entitlement === undefined ||
                entitlement.billing_period_end.getTime() <= now.getTime()
              ) {
                return 'ENTITLEMENT_INACTIVE';
              }
              if (
                budget?.hard_cap_reached_at !== null &&
                budget?.hard_cap_reached_at !== undefined
              ) {
                return 'SPEND_CAP_REACHED';
              }
              if (number.status !== 'ACTIVE') {
                return 'NUMBER_INACTIVE';
              }
              if (binding === undefined) {
                return 'NO_PRODUCTION_AGENT';
              }
              return null;
            })();
            return {
              tenant_id: tenantId,
              tenant_status: tenant.status,
              timezone: tenant.timezone,
              default_locale: tenant.default_locale,
              location_id: number.location_id,
              phone_number_id: number.id,
              agent_id: binding?.agent_id ?? null,
              production_agent_version_id: binding?.production_version_id ?? null,
              canary:
                canary === null || canary === undefined
                  ? null
                  : { agent_version_id: canary.id, rollout_percent: canary.rollout_percent },
              entitlement:
                entitlement === undefined
                  ? null
                  : {
                      entitlement_version: entitlement.version,
                      max_concurrent_calls: entitlement.concurrency_limit,
                      number_concurrency: number.max_concurrent_calls,
                      max_call_duration_seconds:
                        typeof limits['max_call_duration_seconds'] === 'number'
                          ? limits['max_call_duration_seconds']
                          : null,
                      features: entitlement.features,
                    },
              spend:
                budget === undefined
                  ? null
                  : {
                      daily_cap_usd_micros: Number(budget.daily_cap_usd_micros),
                      monthly_cap_usd_micros: Number(budget.monthly_cap_usd_micros),
                      consumed_usd_micros: Number(budget.consumed_usd_micros),
                    },
              kill_switches: killSwitches,
              admission_block_reason: blockReason,
              valid_until: new Date(now.getTime() + 60_000).toISOString(),
            };
          },
        );
      },
    );

    app.put(
      '/internal/v1/calls/:id',
      { schema: { params: IdParams, body: CallUpsertBody } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'call.control');
        const context = tenantBound(service, request.traceId);
        const body = request.body;
        const startedAt = parseTimestamp(body.started_at, '/body/started_at');
        const answeredAt =
          body.answered_at === undefined
            ? null
            : parseTimestamp(body.answered_at, '/body/answered_at');
        const endedAt =
          body.ended_at === undefined ? null : parseTimestamp(body.ended_at, '/body/ended_at');
        return withTenantTransaction(services.db, context, async (trx) => {
          const existing = await trx
            .selectFrom('calls')
            .select(['id', 'status', 'provider', 'provider_call_id', 'version'])
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          const common = {
            location_id: body.location_id ?? null,
            phone_number_id: body.phone_number_id ?? null,
            agent_id: body.agent_id ?? null,
            agent_version_id: body.agent_version_id ?? null,
            language: body.language ?? null,
            conversation_state: body.conversation_state ?? 'GREETING',
            admission_decision: body.admission_decision ?? null,
            admission_reject_reason: body.admission_reject_reason ?? null,
            intent: body.intent ?? null,
            outcome: body.outcome ?? null,
            end_reason: body.end_reason ?? null,
            answered_at: answeredAt,
            ended_at: endedAt,
            connected_seconds: body.connected_seconds ?? null,
            billable_seconds: body.billable_seconds ?? null,
            cost_usd_micros: body.cost_usd_micros ?? null,
            runtime_instance_id: body.runtime_instance_id,
            realtime_session_ref: body.realtime_session_ref ?? null,
          };
          if (existing === undefined) {
            const personId =
              body.caller_e164 === undefined || body.channel === 'SIMULATION'
                ? null
                : await resolvePhoneProfile(trx, {
                    tenantId: context.tenantId,
                    e164: body.caller_e164,
                    locationId: body.location_id ?? null,
                    at: startedAt,
                  });
            await trx
              .insertInto('calls')
              .values({
                id: request.params.id,
                tenant_id: context.tenantId,
                person_id: personId,
                provider: body.provider,
                provider_call_id: body.provider_call_id,
                channel: body.channel,
                direction: body.direction,
                caller_e164: body.caller_e164 ?? null,
                status: body.status,
                started_at: startedAt,
                trace_id: body.trace_id,
                recording_enabled: body.recording_enabled,
                ...common,
              })
              .execute();
            return { id: request.params.id, status: body.status, created: true };
          }
          if (
            existing.provider !== body.provider ||
            existing.provider_call_id !== body.provider_call_id
          ) {
            throw new ApiError('CONFLICT', { reason: 'provider_call_mismatch' });
          }
          if (TERMINAL_CALL_STATUSES.has(existing.status) && existing.status !== body.status) {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              from: existing.status,
              to: body.status,
            });
          }
          await trx
            .updateTable('calls')
            .set({ status: body.status, version: existing.version + 1, ...common })
            .where('id', '=', existing.id)
            .execute();
          return { id: existing.id, status: body.status, created: false };
        });
      },
    );

    app.post(
      '/internal/v1/calls/:id/events',
      { schema: { params: IdParams, body: CallEventsBody } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'call.control');
        const context = tenantBound(service, request.traceId);
        return withTenantTransaction(services.db, context, async (trx) => {
          const call = await trx
            .selectFrom('calls')
            .select(['id'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (call === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (request.body.events.length === 0 && (request.body.transcript ?? []).length === 0) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body', rule: 'events_or_transcript_required' }],
            });
          }
          const inserted =
            request.body.events.length === 0
              ? []
              : await trx
                  .insertInto('call_events')
                  .values(
                    request.body.events.map((event) => ({
                      id: newId(),
                      tenant_id: context.tenantId,
                      call_id: call.id,
                      seq: event.seq,
                      event_id: event.event_id,
                      event_type: event.event_type,
                      schema_version: event.schema_version,
                      payload: JSON.stringify(event.payload),
                      occurred_at: parseTimestamp(event.occurred_at, '/body/events/occurred_at'),
                    })),
                  )
                  .onConflict((conflict) => conflict.doNothing())
                  .returning(['event_id'])
                  .execute();
          let transcriptInserted = 0;
          const transcript = request.body.transcript ?? [];
          if (transcript.length > 0) {
            const segments = await trx
              .insertInto('transcript_segments')
              .values(
                transcript.map((segment) => {
                  if (segment.end_ms < segment.start_ms) {
                    throw new ApiError('VALIDATION_FAILED', {
                      issues: [{ path: '/body/transcript/end_ms', rule: 'after_start' }],
                    });
                  }
                  return {
                    id: newId(),
                    tenant_id: context.tenantId,
                    call_id: call.id,
                    seq: segment.seq,
                    speaker: segment.speaker,
                    language: segment.language ?? null,
                    start_ms: segment.start_ms,
                    end_ms: segment.end_ms,
                    content: segment.content,
                  };
                }),
              )
              .onConflict((conflict) => conflict.columns(['call_id', 'seq']).doNothing())
              .returning(['id'])
              .execute();
            transcriptInserted = segments.length;
          }
          return {
            accepted: request.body.events.length,
            inserted: inserted.length,
            transcript_inserted: transcriptInserted,
          };
        });
      },
    );

    app.post(
      '/internal/v1/tool-gateway/executions',
      { schema: { body: ToolExecutionBody } },
      async (request, reply) => {
        const service = requireServiceScope(request.principal, 'tool.execute');
        const body = request.body;
        if (service.tenantId !== body.tenant_id) {
          throw new ApiError('FORBIDDEN', { reason: 'tenant_claim_mismatch' });
        }
        const idempotencyKey = headerValue(request.headers['idempotency-key']);
        if (idempotencyKey === undefined) {
          throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
        }
        if (!/^[A-Za-z0-9_.:-]{16,200}$/.test(idempotencyKey)) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [{ path: '/headers/idempotency-key', rule: 'pattern' }],
          });
        }
        const traceId = body.trace_id ?? request.traceId;
        const response = await executeToolRun(
          {
            db: services.db,
            now: services.now,
            dispatcher: deps.dispatcher,
            schemaValidator: deps.schemaValidator,
            onDispatchError: (details, message) => {
              request.log.error(details, message);
            },
          },
          {
            tenantId: body.tenant_id,
            actorType: 'SERVICE',
            actorId: service.issuer,
            traceId,
          },
          {
            tenantId: body.tenant_id,
            callId: body.call_id,
            agentVersionId: body.agent_version_id,
            specialist: body.specialist,
            toolName: body.tool_name,
            arguments: body.arguments,
            conversationState: body.conversation_state,
            confirmation:
              body.confirmation === undefined
                ? null
                : {
                    confirmedAt: body.confirmation.confirmed_at,
                    turnSeq: body.confirmation.confirmation_turn_seq,
                  },
            verifiedIdentity: body.verified_identity,
            idempotencyKey,
            traceId,
          },
        );
        return reply.send(response);
      },
    );

    app.get(
      '/internal/v1/runtime/tenants/:id/openai-credentials',
      { schema: { params: IdParams } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'runtime.admission.read');
        const context = tenantBound(service, request.traceId);
        if (context.tenantId !== request.params.id) {
          throw new ApiError('FORBIDDEN', { reason: 'tenant_claim_mismatch' });
        }
        const refs = await withTenantTransaction(services.db, context, (trx) =>
          trx
            .selectFrom('tenant_secret_refs')
            .select(['kind', 'secret_ref', 'secret_version'])
            .where('provider', '=', 'openai')
            .where('status', '=', 'ACTIVE')
            .where('kind', 'in', ['OPENAI_SERVICE_ACCOUNT_KEY', 'OPENAI_WEBHOOK_SECRET'])
            .execute(),
        );
        const reference = (kind: string) => {
          const row = refs.find((candidate) => candidate.kind === kind);
          return row === undefined
            ? null
            : { secret_ref: row.secret_ref, secret_version: row.secret_version };
        };
        return {
          tenant_id: context.tenantId,
          api_key: reference('OPENAI_SERVICE_ACCOUNT_KEY'),
          webhook_secret: reference('OPENAI_WEBHOOK_SECRET'),
        };
      },
    );

    app.get('/internal/v1/runtime/calls/:id', { schema: { params: IdParams } }, async (request) => {
      const service = requireServiceScope(request.principal, 'call.control');
      const context = tenantBound(service, request.traceId);
      const call = await withTenantTransaction(services.db, context, (trx) =>
        trx
          .selectFrom('calls')
          .select(['id', 'status', 'started_at', 'ended_at', 'agent_version_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (call === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return {
        id: call.id,
        status: call.status,
        agent_version_id: call.agent_version_id,
        started_at: iso(call.started_at),
        ended_at: iso(call.ended_at),
      };
    });
  };
}
