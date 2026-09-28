import { NotificationChannel, NotificationType, RetentionClass } from '@velyric/contracts';
import {
  NOTIFICATION_PREFERENCE_RULES,
  notificationPreferenceIssue,
  RETENTION_RULES,
  RetentionPolicyError,
  validateRetentionDays,
  type RetentionRule,
} from '@velyric/domain';
import type { DsarRequests, LegalHolds } from '@velyric/db';
import type { Selectable } from 'kysely';
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
import { appendOutbox, buildPage, readCursor, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso, limitFromQuery, Uuid } from './common.js';

const DSAR_DUE_DAYS = 30;
const REQUEST_TYPES = ['DELETE', 'EXPORT', 'RECTIFY', 'RESTRICT'] as const;
const REQUEST_STATUSES = [
  'RECEIVED',
  'VERIFYING',
  'IN_PROGRESS',
  'ON_LEGAL_HOLD',
  'COMPLETED',
  'REJECTED',
] as const;
const CHANNELS = ['PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'DASHBOARD'] as const;
const OPEN_STATUSES = ['RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'ON_LEGAL_HOLD'] as const;
const Cursor = Type.Optional(Type.String({ minLength: 1, maxLength: 1024 }));
const Limit = Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' }));

const RequestQuery = Type.Object(
  {
    status: Type.Optional(Type.Enum(REQUEST_STATUSES)),
    request_type: Type.Optional(Type.Enum(REQUEST_TYPES)),
    limit: Limit,
    cursor: Cursor,
  },
  { additionalProperties: false },
);
const CreateRequestBody = Type.Object(
  {
    person_id: Uuid,
    request_type: Type.Enum(REQUEST_TYPES),
    received_via: Type.Enum(CHANNELS),
    verification_method: Type.Optional(Type.String({ minLength: 3, maxLength: 120 })),
  },
  { additionalProperties: false },
);
const VerifyBody = Type.Object(
  { verification_method: Type.String({ minLength: 3, maxLength: 120 }) },
  { additionalProperties: false },
);
const RejectBody = Type.Object(
  { reason: Type.String({ minLength: 10, maxLength: 500 }) },
  { additionalProperties: false },
);
const CompleteBody = Type.Object(
  { resolution: Type.String({ minLength: 10, maxLength: 500 }) },
  { additionalProperties: false },
);
const HoldQuery = Type.Object(
  { active: Type.Optional(Type.Enum(['true', 'false'])), limit: Limit, cursor: Cursor },
  { additionalProperties: false },
);
const CreateHoldBody = Type.Object(
  {
    scope_type: Type.Enum(['TENANT', 'PERSON', 'CALL']),
    scope_ref: Type.Optional(Uuid),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
    legal_basis: Type.String({ minLength: 3, maxLength: 200 }),
  },
  { additionalProperties: false },
);
const ReleaseHoldBody = Type.Object(
  { reason: Type.String({ minLength: 10, maxLength: 500 }) },
  { additionalProperties: false },
);
const RetentionParams = Type.Object(
  { retention_class: Type.String({ pattern: '^[A-Z_]{3,40}$' }) },
  { additionalProperties: false },
);

function retentionClassOf(value: string): RetentionClass {
  const match = Object.values(RetentionClass).find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ApiError('NOT_FOUND', { resource: 'retention_class' });
  }
  return match;
}
const RetentionBody = Type.Object(
  { retain_days: Type.Integer({ minimum: 0, maximum: 3650 }) },
  { additionalProperties: false },
);
const PreferencesBody = Type.Object(
  {
    scope: Type.Enum(['WORKSPACE', 'USER']),
    preferences: Type.Array(
      Type.Object(
        {
          notification_type: Type.Enum(NotificationType),
          channel: Type.Enum(NotificationChannel),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

function presentRequest(
  row: Selectable<DsarRequests> & { readonly display_name?: string | null },
): Record<string, unknown> {
  return {
    id: row.id,
    person_id: row.person_id,
    ...(row.display_name === undefined ? {} : { person_display_name: row.display_name }),
    request_type: row.request_type,
    status: row.status,
    received_via: row.received_via,
    verification_method: row.verification_method,
    verified_at: iso(row.verified_at),
    legal_hold_id: row.legal_hold_id,
    export_ready: row.export_storage_key !== null,
    due_at: iso(row.due_at),
    completed_at: iso(row.completed_at),
    rejection_reason: row.rejection_reason,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function presentHold(row: Selectable<LegalHolds>): Record<string, unknown> {
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_ref: row.scope_ref,
    reason: row.reason,
    legal_basis: row.legal_basis,
    created_by: row.created_by,
    released_by: row.released_by,
    released_reason: row.released_reason,
    active: row.released_at === null,
    created_at: iso(row.created_at),
    released_at: iso(row.released_at),
  };
}

async function activeHoldFor(
  trx: Trx,
  personId: string | null,
  excludeHoldId?: string,
): Promise<string | null> {
  let query = trx
    .selectFrom('legal_holds')
    .select(['id'])
    .where('released_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('scope_type', '=', 'TENANT'),
        ...(personId === null
          ? []
          : [eb.and([eb('scope_type', '=', 'PERSON'), eb('scope_ref', '=', personId)])]),
      ]),
    )
    .orderBy('created_at')
    .limit(1);
  if (excludeHoldId !== undefined) {
    query = query.where('id', '<>', excludeHoldId);
  }
  return (await query.executeTakeFirst())?.id ?? null;
}

async function announce(
  trx: Trx,
  actor: TenantActor,
  traceId: string,
  row: Selectable<DsarRequests>,
): Promise<void> {
  await appendOutbox(trx, {
    tenantId: actor.tenantId,
    eventType: 'privacy.request_created',
    subject: domainSubject(actor.tenantId, 'privacy.request_created'),
    payload: {
      tenant_id: actor.tenantId,
      request_id: row.id,
      request_type: row.request_type,
      person_id: row.person_id,
      status: row.status,
    },
    traceId,
  });
}

async function loadRequest(trx: Trx, id: string): Promise<Selectable<DsarRequests>> {
  const row = await trx
    .selectFrom('dsar_requests')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

function checkedRetention(retentionClass: RetentionClass, retainDays: number): RetentionRule {
  try {
    return validateRetentionDays(retentionClass, retainDays);
  } catch (error) {
    if (error instanceof RetentionPolicyError) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [
          {
            path: '/body/retain_days',
            rule: error.code === 'NOT_CONFIGURABLE' ? 'not_configurable' : 'out_of_range',
          },
        ],
      });
    }
    throw error;
  }
}

function owner(actor: TenantActor): { readonly tenantId: string; readonly userId: string | null } {
  return { tenantId: actor.tenantId, userId: actor.userId ?? null };
}

export const registerPrivacyRoutes: RouteModule = (app, services) => {
  app.get('/v1/privacy-requests', { schema: { querystring: RequestQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('dsar_requests as r')
        .leftJoin('caller_profiles as p', 'p.id', 'r.person_id')
        .selectAll('r')
        .select(['p.display_name'])
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(limit + 1);
      if (request.query.status !== undefined) {
        query = query.where('r.status', '=', request.query.status);
      }
      if (request.query.request_type !== undefined) {
        query = query.where('r.request_type', '=', request.query.request_type);
      }
      if (cursor !== null) {
        query = query.where((eb) =>
          eb(
            eb.refTuple('r.created_at', 'r.id'),
            '<',
            eb.tuple(new Date(String(cursor.k[0])), cursor.id),
          ),
        );
      }
      return query.execute();
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
      presentRequest,
    );
  });

  app.post(
    '/v1/privacy-requests',
    { schema: { body: CreateRequestBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'privacy_requests.create',
        async (trx) => {
          const person = await trx
            .selectFrom('caller_profiles')
            .select(['id'])
            .where('id', '=', body.person_id)
            .where('merged_into_profile_id', 'is', null)
            .executeTakeFirst();
          if (person === undefined) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/person_id', rule: 'exists' }],
            });
          }
          const open = await trx
            .selectFrom('dsar_requests')
            .select(['id'])
            .where('person_id', '=', person.id)
            .where('request_type', '=', body.request_type)
            .where('status', 'in', OPEN_STATUSES)
            .executeTakeFirst();
          if (open !== undefined) {
            throw new ApiError('CONFLICT', { reason: 'request_already_open', request_id: open.id });
          }
          const now = services.now();
          const verified = body.verification_method !== undefined;
          const hold =
            verified && body.request_type === 'DELETE' ? await activeHoldFor(trx, person.id) : null;
          const row = await trx
            .insertInto('dsar_requests')
            .values({
              tenant_id: actor.tenantId,
              person_id: person.id,
              request_type: body.request_type,
              status: !verified ? 'VERIFYING' : hold === null ? 'IN_PROGRESS' : 'ON_LEGAL_HOLD',
              received_via: body.received_via,
              verification_method: body.verification_method ?? null,
              verified_at: verified ? now : null,
              legal_hold_id: hold,
              due_at: new Date(now.getTime() + DSAR_DUE_DAYS * 86_400_000),
              created_by: actor.actorId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          if (verified) {
            await announce(trx, actor, request.traceId, row);
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'privacy_request.created',
            objectType: 'dsar_request',
            objectId: row.id,
            metadata: { request_type: row.request_type, status: row.status },
          });
          return {
            status: 201,
            body: presentRequest(row),
            resource: { type: 'dsar_request', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/privacy-requests/:id/verify',
    { schema: { params: IdParams, body: VerifyBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'privacy_requests.verify',
        async (trx) => {
          const current = await loadRequest(trx, request.params.id);
          if (current.status !== 'RECEIVED' && current.status !== 'VERIFYING') {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              from: current.status,
              to: 'IN_PROGRESS',
            });
          }
          const hold =
            current.request_type === 'DELETE' ? await activeHoldFor(trx, current.person_id) : null;
          const row = await trx
            .updateTable('dsar_requests')
            .set({
              status: hold === null ? 'IN_PROGRESS' : 'ON_LEGAL_HOLD',
              verification_method: request.body.verification_method,
              verified_at: services.now(),
              legal_hold_id: hold,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await announce(trx, actor, request.traceId, row);
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'privacy_request.verified',
            objectType: 'dsar_request',
            objectId: row.id,
            metadata: { status: row.status },
          });
          return {
            status: 200,
            body: presentRequest(row),
            resource: { type: 'dsar_request', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/privacy-requests/:id/reject',
    { schema: { params: IdParams, body: RejectBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'privacy_requests.reject',
        async (trx) => {
          const current = await loadRequest(trx, request.params.id);
          if (current.status !== 'RECEIVED' && current.status !== 'VERIFYING') {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              from: current.status,
              to: 'REJECTED',
            });
          }
          const row = await trx
            .updateTable('dsar_requests')
            .set({
              status: 'REJECTED',
              rejection_reason: request.body.reason,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'privacy_request.rejected',
            objectType: 'dsar_request',
            objectId: row.id,
            metadata: {},
          });
          return {
            status: 200,
            body: presentRequest(row),
            resource: { type: 'dsar_request', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/privacy-requests/:id/complete',
    { schema: { params: IdParams, body: CompleteBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'privacy_requests.complete',
        async (trx) => {
          const current = await loadRequest(trx, request.params.id);
          if (current.request_type === 'DELETE') {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              reason: 'completed_by_platform_workflow',
            });
          }
          if (current.status !== 'IN_PROGRESS') {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              from: current.status,
              to: 'COMPLETED',
            });
          }
          if (current.request_type === 'EXPORT') {
            const exported = await trx
              .selectFrom('audit_logs')
              .select(['id'])
              .where('tenant_id', '=', actor.tenantId)
              .where('action', '=', 'contact.exported')
              .where('object_id', '=', current.person_id)
              .where('occurred_at', '>=', current.verified_at ?? current.created_at)
              .limit(1)
              .executeTakeFirst();
            if (exported === undefined) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'export_not_downloaded' });
            }
          }
          const now = services.now();
          const row = await trx
            .updateTable('dsar_requests')
            .set({
              status: 'COMPLETED',
              completed_at: now,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          if (current.request_type === 'RESTRICT' && current.person_id !== null) {
            await trx
              .updateTable('caller_profiles')
              .set({ memory_enabled: false, updated_at: now })
              .where('id', '=', current.person_id)
              .execute();
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'privacy_request.completed',
            objectType: 'dsar_request',
            objectId: row.id,
            metadata: { request_type: row.request_type, resolution: request.body.resolution },
          });
          return {
            status: 200,
            body: presentRequest(row),
            resource: { type: 'dsar_request', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.get('/v1/legal-holds', { schema: { querystring: HoldQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('legal_holds')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (request.query.active !== undefined) {
        query = query.where('released_at', request.query.active === 'true' ? 'is' : 'is not', null);
      }
      if (cursor !== null) {
        query = query.where((eb) =>
          eb(
            eb.refTuple('created_at', 'id'),
            '<',
            eb.tuple(new Date(String(cursor.k[0])), cursor.id),
          ),
        );
      }
      return query.execute();
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
      presentHold,
    );
  });

  app.post('/v1/legal-holds', { schema: { body: CreateHoldBody } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'privacy_requests:manage');
    const body = request.body;
    if ((body.scope_type === 'TENANT') !== (body.scope_ref === undefined)) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [
          {
            path: '/body/scope_ref',
            rule: body.scope_type === 'TENANT' ? 'must_be_absent' : 'required',
          },
        ],
      });
    }
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      owner(actor),
      'legal_holds.create',
      async (trx) => {
        if (body.scope_type === 'PERSON' || body.scope_type === 'CALL') {
          const exists =
            body.scope_type === 'PERSON'
              ? await trx
                  .selectFrom('caller_profiles')
                  .select(['id'])
                  .where('id', '=', body.scope_ref ?? '')
                  .executeTakeFirst()
              : await trx
                  .selectFrom('calls')
                  .select(['id'])
                  .where('id', '=', body.scope_ref ?? '')
                  .executeTakeFirst();
          if (exists === undefined) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/scope_ref', rule: 'exists' }],
            });
          }
        }
        const now = services.now();
        const row = await trx
          .insertInto('legal_holds')
          .values({
            tenant_id: actor.tenantId,
            scope_type: body.scope_type,
            scope_ref: body.scope_ref ?? null,
            reason: body.reason,
            legal_basis: body.legal_basis,
            created_by: actor.actorId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (body.scope_type !== 'CALL') {
          await trx
            .updateTable('dsar_requests')
            .set({ status: 'ON_LEGAL_HOLD', legal_hold_id: row.id, updated_at: now })
            .where('request_type', '=', 'DELETE')
            .where('status', '=', 'IN_PROGRESS')
            .$if(body.scope_type === 'PERSON', (query) =>
              query.where('person_id', '=', body.scope_ref ?? ''),
            )
            .execute();
        }
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'legal_hold.created',
          objectType: 'legal_hold',
          objectId: row.id,
          metadata: { scope_type: row.scope_type, scope_ref: row.scope_ref },
        });
        return {
          status: 201,
          body: presentHold(row),
          resource: { type: 'legal_hold', id: row.id },
        };
      },
    );
  });

  app.post(
    '/v1/legal-holds/:id/release',
    { schema: { params: IdParams, body: ReleaseHoldBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'retention:manage');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'legal_holds.release',
        async (trx) => {
          const current = await trx
            .selectFrom('legal_holds')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (current === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (current.released_at !== null) {
            throw new ApiError('INVALID_STATE_TRANSITION', { from: 'RELEASED', to: 'RELEASED' });
          }
          if (current.scope_type === 'DISPUTE' || current.scope_type === 'BILLING') {
            throw new ApiError('FORBIDDEN', { reason: 'platform_managed_hold' });
          }
          const now = services.now();
          const row = await trx
            .updateTable('legal_holds')
            .set({
              released_at: now,
              released_by: actor.actorId,
              released_reason: request.body.reason,
              updated_at: now,
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          const held = await trx
            .selectFrom('dsar_requests')
            .selectAll()
            .where('legal_hold_id', '=', current.id)
            .where('status', '=', 'ON_LEGAL_HOLD')
            .forUpdate()
            .execute();
          for (const entry of held) {
            const remaining = await activeHoldFor(trx, entry.person_id, current.id);
            const resumed = await trx
              .updateTable('dsar_requests')
              .set(
                remaining === null
                  ? { status: 'IN_PROGRESS', version: entry.version + 1, updated_at: now }
                  : { legal_hold_id: remaining, version: entry.version + 1, updated_at: now },
              )
              .where('id', '=', entry.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            if (remaining === null) {
              await announce(trx, actor, request.traceId, resumed);
            }
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'legal_hold.released',
            objectType: 'legal_hold',
            objectId: row.id,
            metadata: { resumed_requests: held.length },
          });
          return {
            status: 200,
            body: presentHold(row),
            resource: { type: 'legal_hold', id: row.id },
          };
        },
      );
    },
  );

  app.get('/v1/retention-policies', async (request) => {
    const actor = requireTenantActor(request.principal, 'settings:read');
    const rows = await inTenant(services, actor, request, (trx) =>
      trx.selectFrom('retention_policies').selectAll().execute(),
    );
    return {
      data: Object.values(RETENTION_RULES).map((rule) => {
        const stored = rows.find((row) => row.retention_class === rule.retentionClass);
        return {
          retention_class: rule.retentionClass,
          anchor: rule.anchor,
          tenant_configurable: rule.tenantConfigurable,
          default_days: rule.defaultDays,
          min_days: rule.minDays,
          platform_max_days: rule.platformMaxDays,
          retain_days:
            rule.tenantConfigurable && stored !== undefined ? stored.retain_days : rule.defaultDays,
          customized: rule.tenantConfigurable && stored !== undefined,
          version: stored?.version ?? null,
          updated_at: iso(stored?.updated_at ?? null),
        };
      }),
    };
  });

  app.put(
    '/v1/retention-policies/:retention_class',
    { schema: { params: RetentionParams, body: RetentionBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'retention:manage');
      const retentionClass = retentionClassOf(request.params.retention_class);
      const rule = checkedRetention(retentionClass, request.body.retain_days);
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'retention_policies.update',
        async (trx) => {
          const existing = await trx
            .selectFrom('retention_policies')
            .selectAll()
            .where('retention_class', '=', retentionClass)
            .forUpdate()
            .executeTakeFirst();
          if (existing !== undefined && existing.version !== requireIfMatch(request)) {
            throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });
          }
          const now = new Date();
          const row =
            existing === undefined
              ? await trx
                  .insertInto('retention_policies')
                  .values({
                    tenant_id: actor.tenantId,
                    retention_class: retentionClass,
                    retain_days: request.body.retain_days,
                    platform_max_days: rule.platformMaxDays,
                    updated_by_user_id: actor.userId ?? null,
                  })
                  .returningAll()
                  .executeTakeFirstOrThrow()
              : await trx
                  .updateTable('retention_policies')
                  .set({
                    retain_days: request.body.retain_days,
                    platform_max_days: rule.platformMaxDays,
                    updated_by_user_id: actor.userId ?? null,
                    version: existing.version + 1,
                    updated_at: now,
                  })
                  .where('id', '=', existing.id)
                  .returningAll()
                  .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'retention_policy.updated',
            objectType: 'retention_policy',
            objectId: row.id,
            metadata: {
              retention_class: retentionClass,
              previous_days: existing?.retain_days ?? rule.defaultDays,
              retain_days: row.retain_days,
            },
          });
          return {
            status: 200,
            body: {
              retention_class: retentionClass,
              retain_days: row.retain_days,
              default_days: rule.defaultDays,
              min_days: rule.minDays,
              platform_max_days: rule.platformMaxDays,
              customized: true,
              version: row.version,
              updated_at: iso(row.updated_at),
            },
            resource: { type: 'retention_policy', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.delete(
    '/v1/retention-policies/:retention_class',
    { schema: { params: RetentionParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'retention:manage');
      const retentionClass = retentionClassOf(request.params.retention_class);
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'retention_policies.reset',
        async (trx) => {
          const removed = await trx
            .deleteFrom('retention_policies')
            .where('retention_class', '=', retentionClass)
            .returning(['id', 'retain_days'])
            .executeTakeFirst();
          if (removed !== undefined) {
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'retention_policy.reset',
              objectType: 'retention_policy',
              objectId: removed.id,
              metadata: { retention_class: retentionClass, previous_days: removed.retain_days },
            });
          }
          const rule = RETENTION_RULES[retentionClass];
          return {
            status: 200,
            body: {
              retention_class: retentionClass,
              retain_days: rule.defaultDays,
              default_days: rule.defaultDays,
              customized: false,
              version: null,
            },
          };
        },
      );
    },
  );

  app.get('/v1/notification-preferences', async (request) => {
    const actor = requireTenantActor(request.principal, 'workspace:read');
    const rows = await inTenant(services, actor, request, (trx) =>
      trx
        .selectFrom('notification_preferences')
        .select(['user_id', 'notification_type', 'channel', 'enabled', 'updated_at'])
        .where((eb) =>
          eb.or([
            eb('user_id', 'is', null),
            ...(actor.userId === undefined ? [] : [eb('user_id', '=', actor.userId)]),
          ]),
        )
        .execute(),
    );
    const shape = (entry: (typeof rows)[number]) => ({
      notification_type: entry.notification_type,
      channel: entry.channel,
      enabled: entry.enabled,
      updated_at: iso(entry.updated_at),
    });
    return {
      rules: Object.values(NOTIFICATION_PREFERENCE_RULES).map((rule) => ({
        notification_type: rule.type,
        audience: rule.audience,
        channels: rule.channels,
        mandatory: rule.mandatory,
        default_enabled: rule.defaultEnabled,
      })),
      workspace: rows.filter((entry) => entry.user_id === null).map(shape),
      personal: rows.filter((entry) => entry.user_id !== null).map(shape),
    };
  });

  app.put(
    '/v1/notification-preferences',
    { schema: { body: PreferencesBody } },
    async (request, reply) => {
      const body = request.body;
      const actor = requireTenantActor(
        request.principal,
        body.scope === 'WORKSPACE' ? 'notifications:manage' : 'workspace:read',
      );
      const userId = body.scope === 'USER' ? actor.userId : null;
      if (userId === undefined) {
        throw new ApiError('FORBIDDEN', { reason: 'personal_preferences_require_user' });
      }
      const issues: { path: string; rule: string }[] = body.preferences.flatMap((entry, index) => {
        const issue = notificationPreferenceIssue(
          entry.notification_type,
          entry.channel,
          entry.enabled,
          body.scope,
        );
        return issue === null ? [] : [{ path: `/body/preferences/${String(index)}`, rule: issue }];
      });
      const keys = new Set(
        body.preferences.map((entry) => `${entry.notification_type}:${entry.channel}`),
      );
      if (keys.size !== body.preferences.length) {
        issues.push({ path: '/body/preferences', rule: 'unique_type_channel' });
      }
      if (issues.length > 0) {
        throw new ApiError('VALIDATION_FAILED', { issues });
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        owner(actor),
        'notification_preferences.update',
        async (trx) => {
          const now = new Date();
          for (const entry of body.preferences) {
            await trx
              .insertInto('notification_preferences')
              .values({
                tenant_id: actor.tenantId,
                user_id: userId,
                notification_type: entry.notification_type,
                channel: entry.channel,
                enabled: entry.enabled,
              })
              .onConflict((conflict) =>
                conflict
                  .columns(['tenant_id', 'user_id', 'notification_type', 'channel'])
                  .doUpdateSet({ enabled: entry.enabled, updated_at: now }),
              )
              .execute();
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'notification_preferences.updated',
            objectType: 'tenant',
            objectId: actor.tenantId,
            metadata: { scope: body.scope, changes: body.preferences.length },
          });
          return { status: 200, body: { scope: body.scope, updated: body.preferences.length } };
        },
      );
    },
  );
};
