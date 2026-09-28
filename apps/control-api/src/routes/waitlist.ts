import { sql } from 'kysely';
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
import { canonicalProfileId } from '../contacts/identity.js';
import { ApiError } from '../errors.js';
import { buildPage, readCursor, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso, limitFromQuery, Uuid } from './common.js';

const STATUSES = [
  'ACTIVE',
  'OFFERED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'FULFILLED',
  'CANCELED',
] as const;
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ACTIVE: ['CANCELED', 'FULFILLED', 'EXPIRED'],
  OFFERED: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  ACCEPTED: ['FULFILLED', 'CANCELED'],
  DECLINED: ['ACTIVE', 'CANCELED'],
};
const MAX_WINDOW_DAYS = 180;
const Instant = Type.String({ minLength: 20, maxLength: 40 });

const ListQuery = Type.Object(
  {
    status: Type.Optional(Type.Enum(STATUSES)),
    location_id: Type.Optional(Uuid),
    service_id: Type.Optional(Uuid),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

const CreateBody = Type.Object(
  {
    person_id: Uuid,
    location_id: Uuid,
    service_id: Type.Optional(Uuid),
    resource_type: Type.Optional(
      Type.Enum([
        'EMPLOYEE',
        'DOCTOR',
        'ROOM',
        'TABLE',
        'BAY',
        'VEHICLE',
        'EQUIPMENT',
        'SERVICE_POINT',
      ]),
    ),
    desired_from: Instant,
    desired_to: Instant,
    party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    priority_rule: Type.Optional(
      Type.Enum(['FIFO', 'WINDOW_FIT', 'PARTY_SIZE_FIT', 'LOYALTY_PROGRAM']),
    ),
    contact_channel: Type.Enum(['EMAIL', 'SMS', 'IN_APP', 'WEBHOOK']),
    contact_consent: Type.Literal(true),
    max_contact_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    expires_at: Instant,
  },
  { additionalProperties: false },
);

const UpdateBody = Type.Object(
  {
    status: Type.Optional(Type.Enum(['ACTIVE', 'CANCELED', 'FULFILLED', 'EXPIRED'])),
    priority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    max_contact_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

interface EntryRow {
  readonly id: string;
  readonly location_id: string;
  readonly person_id: string;
  readonly service_id: string | null;
  readonly resource_type: string | null;
  readonly desired_from: Date;
  readonly desired_to: Date;
  readonly party_size: number;
  readonly priority: number;
  readonly priority_rule: string;
  readonly contact_channel: string;
  readonly status: string;
  readonly contact_attempts: number;
  readonly max_contact_attempts: number;
  readonly last_contacted_at: Date | null;
  readonly expires_at: Date;
  readonly version: number;
  readonly created_at: Date;
  readonly display_name: string | null;
}

function parseInstant(value: string, path: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'rfc3339' }] });
  }
  return parsed;
}

function present(row: EntryRow): Record<string, unknown> {
  return {
    id: row.id,
    location_id: row.location_id,
    person: { id: row.person_id, display_name: row.display_name },
    service_id: row.service_id,
    resource_type: row.resource_type,
    desired_from: iso(row.desired_from),
    desired_to: iso(row.desired_to),
    party_size: row.party_size,
    priority: row.priority,
    priority_rule: row.priority_rule,
    contact_channel: row.contact_channel,
    status: row.status,
    contact_attempts: row.contact_attempts,
    max_contact_attempts: row.max_contact_attempts,
    last_contacted_at: iso(row.last_contacted_at),
    expires_at: iso(row.expires_at),
    version: row.version,
    created_at: iso(row.created_at),
  };
}

function entries(trx: Trx) {
  return trx
    .selectFrom('waitlist_entries as w')
    .innerJoin('caller_profiles as p', 'p.id', 'w.person_id')
    .select([
      'w.id',
      'w.location_id',
      'w.person_id',
      'w.service_id',
      'w.resource_type',
      sql<Date>`lower(w.desired_window)`.as('desired_from'),
      sql<Date>`upper(w.desired_window)`.as('desired_to'),
      'w.party_size',
      'w.priority',
      'w.priority_rule',
      'w.contact_channel',
      'w.status',
      'w.contact_attempts',
      'w.max_contact_attempts',
      'w.last_contacted_at',
      'w.expires_at',
      'w.version',
      'w.created_at',
      'p.display_name',
    ]);
}

function assertScope(actor: TenantActor, locationId: string): void {
  if (actor.locationScope.length > 0 && !actor.locationScope.includes(locationId)) {
    throw new ApiError('NOT_FOUND');
  }
}

export const registerWaitlistRoutes: RouteModule = (app, services) => {
  app.get('/v1/waitlist', { schema: { querystring: ListQuery } }, async (request) => {
    const actor = requireTenantActor(
      request.principal,
      'waitlist:read',
      request.query.location_id ?? undefined,
    );
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = entries(trx)
        .orderBy('w.created_at', 'desc')
        .orderBy('w.id', 'desc')
        .limit(limit + 1);
      if (request.query.status !== undefined)
        query = query.where('w.status', '=', request.query.status);
      if (request.query.location_id !== undefined)
        query = query.where('w.location_id', '=', request.query.location_id);
      if (request.query.service_id !== undefined)
        query = query.where('w.service_id', '=', request.query.service_id);
      if (actor.locationScope.length > 0)
        query = query.where('w.location_id', 'in', actor.locationScope);
      if (cursor !== null) {
        const createdAt = new Date(String(cursor.k[0]));
        query = query.where((eb) =>
          eb(eb.refTuple('w.created_at', 'w.id'), '<', eb.tuple(createdAt, cursor.id)),
        );
      }
      return query.execute();
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
      present,
    );
  });

  app.get('/v1/waitlist/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'waitlist:read');
    const { entry, offers } = await inTenant(services, actor, request, async (trx) => {
      const row = await entries(trx).where('w.id', '=', request.params.id).executeTakeFirst();
      if (row === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      assertScope(actor, row.location_id);
      const offerRows = await trx
        .selectFrom('waitlist_offers')
        .select(['id', 'hold_id', 'status', 'offered_at', 'expires_at', 'responded_at'])
        .where('entry_id', '=', row.id)
        .orderBy('offered_at', 'desc')
        .execute();
      return { entry: row, offers: offerRows };
    });
    return reply.header('etag', weakEtag(entry.version)).send({
      ...present(entry),
      offers: offers.map((offer) => ({
        ...offer,
        offered_at: iso(offer.offered_at),
        expires_at: iso(offer.expires_at),
        responded_at: iso(offer.responded_at),
      })),
    });
  });

  app.post('/v1/waitlist', { schema: { body: CreateBody } }, async (request, reply) => {
    const body = request.body;
    const actor = requireTenantActor(request.principal, 'waitlist:write', body.location_id);
    const from = parseInstant(body.desired_from, '/body/desired_from');
    const to = parseInstant(body.desired_to, '/body/desired_to');
    const expiresAt = parseInstant(body.expires_at, '/body/expires_at');
    const now = services.now();
    if (to <= from || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: '/body/desired_to', rule: `window_1_to_${String(MAX_WINDOW_DAYS)}_days` }],
      });
    }
    if (expiresAt <= now || expiresAt > new Date(to.getTime() + 86_400_000)) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: '/body/expires_at', rule: 'future_and_before_window_end' }],
      });
    }
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      { tenantId: actor.tenantId, userId: actor.userId ?? null },
      'waitlist.create',
      async (trx) => {
        const location = await trx
          .selectFrom('locations')
          .select(['id'])
          .where('id', '=', body.location_id)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (location === undefined) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [{ path: '/body/location_id', rule: 'active_location' }],
          });
        }
        const person = await trx
          .selectFrom('caller_profiles')
          .select(['id'])
          .where('id', '=', body.person_id)
          .executeTakeFirst();
        if (person === undefined) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [{ path: '/body/person_id', rule: 'exists' }],
          });
        }
        const personId = await canonicalProfileId(trx, person.id);
        if (body.service_id !== undefined) {
          const service = await trx
            .selectFrom('services')
            .select(['id'])
            .where('id', '=', body.service_id)
            .where('location_id', '=', body.location_id)
            .where('active', '=', true)
            .executeTakeFirst();
          if (service === undefined) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/service_id', rule: 'active_service_at_location' }],
            });
          }
        }
        const inserted = await trx
          .insertInto('waitlist_entries')
          .values({
            tenant_id: actor.tenantId,
            location_id: body.location_id,
            person_id: personId,
            service_id: body.service_id ?? null,
            resource_type: body.resource_type ?? null,
            desired_window: sql<string>`tstzrange(${from}, ${to}, '[)')`,
            party_size: body.party_size ?? 1,
            priority_rule: body.priority_rule ?? 'FIFO',
            contact_consent: true,
            contact_channel: body.contact_channel,
            max_contact_attempts: body.max_contact_attempts ?? 3,
            expires_at: expiresAt,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        const row = await entries(trx).where('w.id', '=', inserted.id).executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'waitlist_entry.created',
          objectType: 'waitlist_entry',
          objectId: row.id,
          metadata: { location_id: body.location_id, service_id: body.service_id ?? null },
        });
        return {
          status: 201,
          body: present(row),
          resource: { type: 'waitlist_entry', id: row.id },
          headers: { etag: weakEtag(row.version) },
        };
      },
    );
  });

  app.patch(
    '/v1/waitlist/:id',
    { schema: { params: IdParams, body: UpdateBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'waitlist:write');
      const expected = requireIfMatch(request);
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'waitlist.update',
        async (trx) => {
          const current = await trx
            .selectFrom('waitlist_entries')
            .select(['id', 'status', 'version', 'location_id', 'contact_attempts'])
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (current === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          assertScope(actor, current.location_id);
          if (current.version !== expected) {
            throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
          }
          if (
            body.status !== undefined &&
            body.status !== current.status &&
            !(TRANSITIONS[current.status] ?? []).includes(body.status)
          ) {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              from: current.status,
              to: body.status,
            });
          }
          if (
            body.max_contact_attempts !== undefined &&
            body.max_contact_attempts < current.contact_attempts
          ) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/max_contact_attempts', rule: 'at_least_contact_attempts' }],
            });
          }
          await trx
            .updateTable('waitlist_entries')
            .set({
              ...(body.status === undefined ? {} : { status: body.status }),
              ...(body.priority === undefined ? {} : { priority: body.priority }),
              ...(body.max_contact_attempts === undefined
                ? {}
                : { max_contact_attempts: body.max_contact_attempts }),
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .execute();
          const row = await entries(trx).where('w.id', '=', current.id).executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'waitlist_entry.updated',
            objectType: 'waitlist_entry',
            objectId: row.id,
            diff: body,
          });
          return {
            status: 200,
            body: present(row),
            resource: { type: 'waitlist_entry', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );
};
