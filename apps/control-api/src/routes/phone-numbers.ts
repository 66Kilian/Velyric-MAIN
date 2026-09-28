import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import { newId, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso, Uuid } from './common.js';

const UpdateBody = Type.Object(
  {
    location_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
    max_concurrent_calls: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

const BindingBody = Type.Object(
  { agent_id: Type.Union([Uuid, Type.Null()]) },
  { additionalProperties: false },
);

interface NumberRow {
  readonly id: string;
  readonly e164: string;
  readonly country: string;
  readonly number_type: string;
  readonly status: string;
  readonly provider: string;
  readonly location_id: string | null;
  readonly max_concurrent_calls: number | null;
  readonly retention_until: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
}

function present(row: NumberRow): Record<string, unknown> {
  return {
    id: row.id,
    e164: row.e164,
    country: row.country,
    number_type: row.number_type,
    status: row.status,
    provider: row.provider,
    location_id: row.location_id,
    max_concurrent_calls: row.max_concurrent_calls,
    retention_until: iso(row.retention_until),
    agent: row.agent_id === null ? null : { id: row.agent_id, name: row.agent_name },
    version: row.version,
    created_at: iso(row.created_at),
  };
}

function numbers(trx: Trx) {
  return trx
    .selectFrom('phone_numbers')
    .leftJoin('agent_phone_bindings', (join) =>
      join
        .onRef('agent_phone_bindings.phone_number_id', '=', 'phone_numbers.id')
        .on('agent_phone_bindings.active', '=', true)
        .on('agent_phone_bindings.priority', '=', 0),
    )
    .leftJoin('agents', 'agents.id', 'agent_phone_bindings.agent_id')
    .select([
      'phone_numbers.id',
      'phone_numbers.e164',
      'phone_numbers.country',
      'phone_numbers.number_type',
      'phone_numbers.status',
      'phone_numbers.provider',
      'phone_numbers.location_id',
      'phone_numbers.max_concurrent_calls',
      'phone_numbers.retention_until',
      'phone_numbers.version',
      'phone_numbers.created_at',
      'agent_phone_bindings.agent_id',
      'agents.name as agent_name',
    ]);
}

async function lockNumber(trx: Trx, actor: TenantActor, id: string) {
  const row = await trx
    .selectFrom('phone_numbers')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (
    row === undefined ||
    row.status === 'RELEASED' ||
    (actor.locationScope.length > 0 &&
      (row.location_id === null || !actor.locationScope.includes(row.location_id)))
  ) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export const registerPhoneNumberRoutes: RouteModule = (app, services) => {
  app.get('/v1/phone-numbers', async (request) => {
    const actor = requireTenantActor(request.principal, 'phone_numbers:read');
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = numbers(trx)
        .where('phone_numbers.status', '<>', 'RELEASED')
        .orderBy('phone_numbers.created_at');
      if (actor.locationScope.length > 0) {
        query = query.where('phone_numbers.location_id', 'in', actor.locationScope);
      }
      return query.limit(200).execute();
    });
    return { data: rows.map(present) };
  });

  app.patch(
    '/v1/phone-numbers/:id',
    { schema: { params: IdParams, body: UpdateBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'phone_numbers:manage');
      const expected = requireIfMatch(request);
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'phone_numbers.update',
        async (trx) => {
          const current = await lockNumber(trx, actor, request.params.id);
          if (current.version !== expected) {
            throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
          }
          if (body.location_id !== undefined && body.location_id !== null) {
            const location = await trx
              .selectFrom('locations')
              .select(['id', 'status'])
              .where('id', '=', body.location_id)
              .executeTakeFirst();
            if (
              location === undefined ||
              location.status !== 'ACTIVE' ||
              (actor.locationScope.length > 0 && !actor.locationScope.includes(location.id))
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/location_id', rule: 'active_location' }],
              });
            }
          }
          if (body.max_concurrent_calls !== undefined && body.max_concurrent_calls !== null) {
            const entitlement = await trx
              .selectFrom('entitlement_snapshots')
              .select(['concurrency_limit'])
              .orderBy('version', 'desc')
              .limit(1)
              .executeTakeFirst();
            if (
              entitlement !== undefined &&
              body.max_concurrent_calls > entitlement.concurrency_limit
            ) {
              throw new ApiError('PLAN_LIMIT_EXCEEDED', {
                limit: 'concurrency',
                max: entitlement.concurrency_limit,
              });
            }
          }
          await trx
            .updateTable('phone_numbers')
            .set((eb) => ({
              ...(body.location_id === undefined ? {} : { location_id: body.location_id }),
              ...(body.max_concurrent_calls === undefined
                ? {}
                : { max_concurrent_calls: body.max_concurrent_calls }),
              version: eb('version', '+', 1),
              updated_at: services.now(),
            }))
            .where('id', '=', current.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'phone_number.updated',
            objectType: 'phone_number',
            objectId: current.id,
            diff: body,
            metadata: { fields: Object.keys(body) },
          });
          const row = await numbers(trx)
            .where('phone_numbers.id', '=', current.id)
            .executeTakeFirstOrThrow();
          return { status: 200, body: present(row), headers: { etag: weakEtag(row.version) } };
        },
      );
    },
  );

  app.put(
    '/v1/phone-numbers/:id/agent',
    { schema: { params: IdParams, body: BindingBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'phone_numbers:manage');
      const agentId = request.body.agent_id;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'phone_numbers.bind_agent',
        async (trx) => {
          const current = await lockNumber(trx, actor, request.params.id);
          if (agentId !== null) {
            const agent = await trx
              .selectFrom('agents')
              .select(['id', 'status', 'production_version_id', 'location_id'])
              .where('id', '=', agentId)
              .executeTakeFirst();
            if (agent === undefined) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/agent_id', rule: 'exists' }],
              });
            }
            if (agent.production_version_id === null || agent.status === 'ARCHIVED') {
              throw new ApiError('INVALID_STATE_TRANSITION', {
                reason: 'agent_has_no_production_version',
              });
            }
            if (
              agent.location_id !== null &&
              current.location_id !== null &&
              agent.location_id !== current.location_id
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/agent_id', rule: 'same_location' }],
              });
            }
          }
          await trx
            .updateTable('agent_phone_bindings')
            .set({ active: false, updated_at: services.now() })
            .where('phone_number_id', '=', current.id)
            .where('active', '=', true)
            .execute();
          if (agentId !== null) {
            await trx
              .insertInto('agent_phone_bindings')
              .values({
                id: newId(),
                tenant_id: actor.tenantId,
                agent_id: agentId,
                phone_number_id: current.id,
                priority: 0,
                active: true,
              })
              .onConflict((conflict) =>
                conflict
                  .columns(['agent_id', 'phone_number_id'])
                  .doUpdateSet({ active: true, priority: 0, updated_at: services.now() }),
              )
              .execute();
          }
          await trx
            .updateTable('phone_numbers')
            .set((eb) => ({ version: eb('version', '+', 1), updated_at: services.now() }))
            .where('id', '=', current.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: agentId === null ? 'phone_number.agent_unbound' : 'phone_number.agent_bound',
            objectType: 'phone_number',
            objectId: current.id,
            metadata: { agent_id: agentId },
          });
          const row = await numbers(trx)
            .where('phone_numbers.id', '=', current.id)
            .executeTakeFirstOrThrow();
          return { status: 200, body: present(row), headers: { etag: weakEtag(row.version) } };
        },
      );
    },
  );
};
