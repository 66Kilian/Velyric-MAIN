import type { Locations } from '@velyric/db';
import { isValidTimeZone } from '@velyric/domain';
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
import { newId, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso } from './common.js';

const MAX_LOCATIONS = 200;
const HHMM = '^([01]\\d|2[0-3]):[0-5]\\d$';

export const Address = Type.Object(
  {
    line1: Type.String({ minLength: 1, maxLength: 200 }),
    line2: Type.Optional(Type.String({ maxLength: 200 })),
    city: Type.String({ minLength: 1, maxLength: 100 }),
    postal_code: Type.String({ minLength: 2, maxLength: 16 }),
    region: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const BusinessHours = Type.Array(
  Type.Object(
    {
      iso_weekday: Type.Integer({ minimum: 1, maximum: 7 }),
      opens: Type.String({ pattern: HHMM }),
      closes: Type.String({ pattern: HHMM }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 21 },
);

const Holidays = Type.Array(
  Type.Object(
    {
      date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      name: Type.String({ minLength: 1, maxLength: 100 }),
      closed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  { maxItems: 100 },
);

const CreateBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 160 }),
    timezone: Type.String({ minLength: 3, maxLength: 64 }),
    country: Type.String({ pattern: '^[A-Z]{2}$' }),
    address: Type.Optional(Address),
    business_hours: Type.Optional(BusinessHours),
    holiday_calendar: Type.Optional(Holidays),
  },
  { additionalProperties: false },
);

const UpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    timezone: Type.Optional(Type.String({ minLength: 3, maxLength: 64 })),
    address: Type.Optional(Address),
    business_hours: Type.Optional(BusinessHours),
    holiday_calendar: Type.Optional(Holidays),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
  },
  { additionalProperties: false, minProperties: 1 },
);

export function presentLocation(row: Selectable<Locations>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    country: row.country,
    address: row.address,
    business_hours: row.business_hours,
    holiday_calendar: row.holiday_calendar,
    is_primary: row.is_primary,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function validateHours(
  hours:
    | readonly { readonly iso_weekday: number; readonly opens: string; readonly closes: string }[]
    | undefined,
): void {
  if (hours === undefined) {
    return;
  }
  const byDay = new Map<number, { opens: string; closes: string }[]>();
  for (const [index, entry] of hours.entries()) {
    if (entry.opens >= entry.closes) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: `/body/business_hours/${String(index)}`, rule: 'opens_before_closes' }],
      });
    }
    const day = byDay.get(entry.iso_weekday) ?? [];
    if (day.some((other) => entry.opens < other.closes && other.opens < entry.closes)) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: `/body/business_hours/${String(index)}`, rule: 'no_overlap' }],
      });
    }
    day.push({ opens: entry.opens, closes: entry.closes });
    byDay.set(entry.iso_weekday, day);
  }
}

function assertTimeZone(value: string | undefined): void {
  if (value !== undefined && !isValidTimeZone(value)) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/body/timezone', rule: 'iana_time_zone' }],
    });
  }
}

async function loadLocation(
  trx: Trx,
  actor: TenantActor,
  id: string,
): Promise<Selectable<Locations>> {
  const row = await trx
    .selectFrom('locations')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (
    row === undefined ||
    (actor.locationScope.length > 0 && !actor.locationScope.includes(row.id))
  ) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export const registerLocationRoutes: RouteModule = (app, services) => {
  app.get('/v1/locations', async (request) => {
    const actor = requireTenantActor(request.principal, 'locations:read');
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('locations')
        .selectAll()
        .orderBy('is_primary', 'desc')
        .orderBy('name')
        .limit(MAX_LOCATIONS);
      if (actor.locationScope.length > 0) {
        query = query.where('id', 'in', actor.locationScope);
      }
      return query.execute();
    });
    return { data: rows.map(presentLocation) };
  });

  app.get('/v1/locations/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'locations:read', request.params.id);
    const row = await inTenant(services, actor, request, (trx) =>
      trx
        .selectFrom('locations')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new ApiError('NOT_FOUND');
    }
    return reply.header('etag', weakEtag(row.version)).send(presentLocation(row));
  });

  app.post('/v1/locations', { schema: { body: CreateBody } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'locations:manage');
    if (actor.locationScope.length > 0) {
      throw new ApiError('FORBIDDEN', { reason: 'location_scope' });
    }
    const body = request.body;
    assertTimeZone(body.timezone);
    validateHours(body.business_hours);
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      { tenantId: actor.tenantId, userId: actor.userId ?? null },
      'locations.create',
      async (trx) => {
        const count = await trx
          .selectFrom('locations')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= MAX_LOCATIONS) {
          throw new ApiError('PLAN_LIMIT_EXCEEDED', { limit: 'locations', max: MAX_LOCATIONS });
        }
        const row = await trx
          .insertInto('locations')
          .values({
            id: newId(),
            tenant_id: actor.tenantId,
            name: body.name,
            timezone: body.timezone,
            country: body.country,
            address: JSON.stringify(body.address ?? {}),
            business_hours: JSON.stringify(body.business_hours ?? []),
            holiday_calendar: JSON.stringify(body.holiday_calendar ?? []),
            is_primary: Number(count.count) === 0,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'location.created',
          objectType: 'location',
          objectId: row.id,
          metadata: { name: row.name, timezone: row.timezone },
        });
        return {
          status: 201,
          body: presentLocation(row),
          headers: { etag: weakEtag(row.version), location: `/v1/locations/${row.id}` },
          resource: { type: 'location', id: row.id },
        };
      },
    );
  });

  app.patch(
    '/v1/locations/:id',
    { schema: { params: IdParams, body: UpdateBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage', request.params.id);
      const expected = requireIfMatch(request);
      const body = request.body;
      assertTimeZone(body.timezone);
      validateHours(body.business_hours);
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'locations.update',
        async (trx) => {
          const current = await loadLocation(trx, actor, request.params.id);
          if (current.version !== expected) {
            throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
          }
          if (body.status === 'INACTIVE' && current.is_primary) {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              reason: 'primary_location_must_stay_active',
            });
          }
          if (body.status === 'INACTIVE') {
            const bound = await trx
              .selectFrom('phone_numbers')
              .select(['id'])
              .where('location_id', '=', current.id)
              .where('status', '=', 'ACTIVE')
              .executeTakeFirst();
            if (bound !== undefined) {
              throw new ApiError('CONFLICT', { reason: 'location_has_active_phone_numbers' });
            }
          }
          const row = await trx
            .updateTable('locations')
            .set((eb) => ({
              ...(body.name === undefined ? {} : { name: body.name }),
              ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
              ...(body.address === undefined ? {} : { address: JSON.stringify(body.address) }),
              ...(body.business_hours === undefined
                ? {}
                : { business_hours: JSON.stringify(body.business_hours) }),
              ...(body.holiday_calendar === undefined
                ? {}
                : { holiday_calendar: JSON.stringify(body.holiday_calendar) }),
              ...(body.status === undefined ? {} : { status: body.status }),
              version: eb('version', '+', 1),
              updated_at: services.now(),
            }))
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'location.updated',
            objectType: 'location',
            objectId: row.id,
            diff: body,
            metadata: { fields: Object.keys(body) },
          });
          return {
            status: 200,
            body: presentLocation(row),
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/locations/:id/make-primary',
    { schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage');
      if (actor.locationScope.length > 0) {
        throw new ApiError('FORBIDDEN', { reason: 'location_scope' });
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'locations.make_primary',
        async (trx) => {
          const target = await loadLocation(trx, actor, request.params.id);
          if (target.status !== 'ACTIVE') {
            throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'inactive_location' });
          }
          if (!target.is_primary) {
            await trx
              .updateTable('locations')
              .set((eb) => ({
                is_primary: false,
                version: eb('version', '+', 1),
                updated_at: services.now(),
              }))
              .where('is_primary', '=', true)
              .execute();
            await trx
              .updateTable('locations')
              .set((eb) => ({
                is_primary: true,
                version: eb('version', '+', 1),
                updated_at: services.now(),
              }))
              .where('id', '=', target.id)
              .execute();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'location.made_primary',
              objectType: 'location',
              objectId: target.id,
            });
          }
          const row = await trx
            .selectFrom('locations')
            .selectAll()
            .where('id', '=', target.id)
            .executeTakeFirstOrThrow();
          return {
            status: 200,
            body: presentLocation(row),
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );
};
