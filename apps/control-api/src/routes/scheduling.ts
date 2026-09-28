import { ResourceType } from '@velyric/contracts';
import type {
  AvailabilityExceptions,
  AvailabilityRules,
  Bookings,
  Resources,
  Services,
} from '@velyric/db';
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
import {
  appendOutbox,
  buildPage,
  newId,
  readCursor,
  writeAudit,
  type Trx,
} from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso, limitFromQuery, Uuid } from './common.js';

const LIMIT = Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' }));
const CURSOR = Type.Optional(Type.String({ minLength: 1, maxLength: 1024 }));
const Instant = Type.String({ minLength: 20, maxLength: 40 });
const LocalTime = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
const ResourceTypeSchema = Type.Enum(Object.values(ResourceType));
const Currency = Type.Union([Type.Literal('HUF'), Type.Literal('EUR'), Type.Literal('USD')]);
const Minor = Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 });

const LocationListQuery = Type.Object(
  { location_id: Type.Optional(Uuid), limit: LIMIT, cursor: CURSOR },
  { additionalProperties: false },
);

const CreateServiceBody = Type.Object(
  {
    location_id: Uuid,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    duration_minutes: Type.Integer({ minimum: 5, maximum: 1_440 }),
    buffer_before_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 240 })),
    buffer_after_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 240 })),
    required_resource_types: Type.Array(ResourceTypeSchema, {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
    }),
    min_party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    max_party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cancellation_window_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_160 })),
    price_minor: Type.Optional(Minor),
    currency: Type.Optional(Currency),
    deposit_required: Type.Optional(Type.Boolean()),
    deposit_minor: Type.Optional(Minor),
  },
  { additionalProperties: false },
);

const UpdateServiceBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    duration_minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1_440 })),
    buffer_before_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 240 })),
    buffer_after_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 240 })),
    required_resource_types: Type.Optional(
      Type.Array(ResourceTypeSchema, { minItems: 1, maxItems: 4, uniqueItems: true }),
    ),
    min_party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    max_party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cancellation_window_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_160 })),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

const CreateResourceBody = Type.Object(
  {
    location_id: Uuid,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    resource_type: ResourceTypeSchema,
    parallel_slots: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    seat_capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    calendar_integration_id: Type.Optional(Uuid),
    external_calendar_ref: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
  },
  { additionalProperties: false },
);

const UpdateResourceBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    parallel_slots: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    seat_capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    calendar_integration_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
    external_calendar_ref: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 320 }), Type.Null()]),
    ),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

const ReplaceRulesBody = Type.Object(
  {
    timezone: Type.String({ minLength: 3, maxLength: 64 }),
    rules: Type.Array(
      Type.Object(
        {
          iso_weekday: Type.Integer({ minimum: 1, maximum: 7 }),
          start_local: LocalTime,
          end_local: LocalTime,
          valid_from: Type.Optional(Instant),
          valid_to: Type.Optional(Instant),
        },
        { additionalProperties: false },
      ),
      { maxItems: 42 },
    ),
  },
  { additionalProperties: false },
);

const ExceptionListQuery = Type.Object(
  { location_id: Uuid, from: Instant, to: Instant, limit: LIMIT, cursor: CURSOR },
  { additionalProperties: false },
);

const CreateExceptionBody = Type.Object(
  {
    location_id: Uuid,
    resource_id: Type.Optional(Uuid),
    exception_kind: Type.Union([Type.Literal('CLOSED'), Type.Literal('EXTRA_OPENING')]),
    starts_at: Instant,
    ends_at: Instant,
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);

const BookingListQuery = Type.Object(
  {
    location_id: Type.Optional(Uuid),
    from: Type.Optional(Instant),
    to: Type.Optional(Instant),
    status: Type.Optional(
      Type.Union([
        Type.Literal('PENDING_DEPOSIT'),
        Type.Literal('CONFIRMED'),
        Type.Literal('CANCELED'),
        Type.Literal('NO_SHOW'),
        Type.Literal('COMPLETED'),
      ]),
    ),
    limit: LIMIT,
    cursor: CURSOR,
  },
  { additionalProperties: false },
);

const CancelBookingBody = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);

function parseInstant(value: string, path: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'rfc3339' }] });
  }
  return parsed;
}

function invalid(path: string, rule: string): ApiError {
  return new ApiError('VALIDATION_FAILED', { issues: [{ path, rule }] });
}

function inScope(actor: TenantActor, locationId: string): boolean {
  return actor.locationScope.length === 0 || actor.locationScope.includes(locationId);
}

async function assertLocation(trx: Trx, actor: TenantActor, locationId: string): Promise<void> {
  if (!inScope(actor, locationId)) {
    throw new ApiError('NOT_FOUND');
  }
  const location = await trx
    .selectFrom('locations')
    .select(['id'])
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (location === undefined) {
    throw invalid('/body/location_id', 'exists');
  }
}

async function assertCalendarLink(
  trx: Trx,
  integrationId: string | null | undefined,
  calendarRef: string | null | undefined,
): Promise<void> {
  if ((integrationId ?? null) === null && (calendarRef ?? null) === null) {
    return;
  }
  if ((integrationId ?? null) === null || (calendarRef ?? null) === null) {
    throw invalid('/body/external_calendar_ref', 'calendar_integration_pair');
  }
  const integration = await trx
    .selectFrom('integrations')
    .select(['integration_type'])
    .where('id', '=', integrationId ?? '')
    .executeTakeFirst();
  if (
    integration === undefined ||
    (integration.integration_type !== 'GOOGLE_CALENDAR' &&
      integration.integration_type !== 'MICROSOFT_365')
  ) {
    throw invalid('/body/calendar_integration_id', 'calendar_integration');
  }
}

export function presentService(row: Selectable<Services>): Record<string, unknown> {
  return {
    id: row.id,
    location_id: row.location_id,
    name: row.name,
    duration_minutes: row.duration_minutes,
    buffer_before_minutes: row.buffer_before_minutes,
    buffer_after_minutes: row.buffer_after_minutes,
    required_resource_types: row.required_resource_types,
    min_party_size: row.min_party_size,
    max_party_size: row.max_party_size,
    cancellation_window_minutes: row.cancellation_window_minutes,
    price_minor: row.price_minor === null ? null : Number(row.price_minor),
    currency: row.currency,
    deposit_required: row.deposit_required,
    deposit_minor: row.deposit_minor === null ? null : Number(row.deposit_minor),
    active: row.active,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function presentResource(row: Selectable<Resources>): Record<string, unknown> {
  return {
    id: row.id,
    location_id: row.location_id,
    name: row.name,
    resource_type: row.resource_type,
    parallel_slots: row.parallel_slots,
    seat_capacity: row.seat_capacity,
    calendar_integration_id: row.calendar_integration_id,
    external_calendar_ref: row.external_calendar_ref,
    active: row.active,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function presentRule(
  row: Pick<
    Selectable<AvailabilityRules>,
    'id' | 'iso_weekday' | 'start_local' | 'end_local' | 'timezone' | 'valid_from' | 'valid_to'
  >,
): Record<string, unknown> {
  return {
    id: row.id,
    iso_weekday: row.iso_weekday,
    start_local: row.start_local.slice(0, 5),
    end_local: row.end_local.slice(0, 5),
    timezone: row.timezone,
    valid_from: iso(row.valid_from),
    valid_to: iso(row.valid_to),
  };
}

function presentException(row: Selectable<AvailabilityExceptions>): Record<string, unknown> {
  return {
    id: row.id,
    location_id: row.location_id,
    resource_id: row.resource_id,
    exception_kind: row.exception_kind,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    reason: row.reason,
    created_at: iso(row.created_at),
  };
}

export function presentBooking(row: Selectable<Bookings>): Record<string, unknown> {
  return {
    id: row.id,
    reference: row.id.replaceAll('-', '').slice(-8).toUpperCase(),
    location_id: row.location_id,
    service_id: row.service_id,
    call_id: row.call_id,
    status: row.status,
    source: row.source,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    timezone: row.timezone,
    party_size: row.party_size,
    customer_note: row.customer_note,
    deposit_status: row.deposit_status,
    external_sync_status: row.external_sync_status,
    canceled_at: iso(row.canceled_at),
    cancellation_reason: row.cancellation_reason,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export const registerSchedulingRoutes: RouteModule = (app, services) => {
  app.get('/v1/services', { schema: { querystring: LocationListQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'bookings:read');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('services')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (request.query.location_id !== undefined) {
        query = query.where('location_id', '=', request.query.location_id);
      }
      if (actor.locationScope.length > 0) {
        query = query.where('location_id', 'in', actor.locationScope);
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
      presentService,
    );
  });

  app.post('/v1/services', { schema: { body: CreateServiceBody } }, async (request, reply) => {
    const body = request.body;
    const actor = requireTenantActor(request.principal, 'locations:manage', body.location_id);
    if ((body.max_party_size ?? 1) < (body.min_party_size ?? 1)) {
      throw invalid('/body/max_party_size', 'gte_min_party_size');
    }
    if ((body.price_minor === undefined) !== (body.currency === undefined)) {
      throw invalid('/body/currency', 'price_currency_pair');
    }
    if (
      body.deposit_required === true &&
      (body.deposit_minor === undefined || body.currency === undefined)
    ) {
      throw invalid('/body/deposit_minor', 'deposit_requires_amount_and_currency');
    }
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      { tenantId: actor.tenantId, userId: null },
      'services.create',
      async (trx) => {
        await assertLocation(trx, actor, body.location_id);
        const id = newId();
        const row = await trx
          .insertInto('services')
          .values({
            id,
            tenant_id: actor.tenantId,
            location_id: body.location_id,
            name: body.name,
            duration_minutes: body.duration_minutes,
            buffer_before_minutes: body.buffer_before_minutes ?? 0,
            buffer_after_minutes: body.buffer_after_minutes ?? 0,
            required_resource_types: [...body.required_resource_types],
            min_party_size: body.min_party_size ?? 1,
            max_party_size: body.max_party_size ?? Math.max(1, body.min_party_size ?? 1),
            cancellation_window_minutes: body.cancellation_window_minutes ?? 0,
            price_minor: body.price_minor ?? null,
            currency: body.currency ?? null,
            deposit_required: body.deposit_required ?? false,
            deposit_minor: body.deposit_minor ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'service.created',
          objectType: 'service',
          objectId: id,
          diff: body,
        });
        return {
          status: 201,
          body: presentService(row),
          resource: { type: 'service', id },
          headers: { etag: weakEtag(row.version) },
        };
      },
    );
  });

  app.get('/v1/services/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'bookings:read');
    const row = await inTenant(services, actor, request, (trx) =>
      trx.selectFrom('services').selectAll().where('id', '=', request.params.id).executeTakeFirst(),
    );
    if (row === undefined || !inScope(actor, row.location_id)) {
      throw new ApiError('NOT_FOUND');
    }
    return reply.header('etag', weakEtag(row.version)).send(presentService(row));
  });

  app.patch(
    '/v1/services/:id',
    { schema: { params: IdParams, body: UpdateServiceBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage');
      const expectedVersion = requireIfMatch(request);
      const body = request.body;
      const updated = await inTenant(services, actor, request, async (trx) => {
        const current = await trx
          .selectFrom('services')
          .selectAll()
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined || !inScope(actor, current.location_id)) {
          throw new ApiError('NOT_FOUND');
        }
        if (current.version !== expectedVersion) {
          throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
        }
        if (
          (body.max_party_size ?? current.max_party_size) <
          (body.min_party_size ?? current.min_party_size)
        ) {
          throw invalid('/body/max_party_size', 'gte_min_party_size');
        }
        const row = await trx
          .updateTable('services')
          .set((eb) => ({
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.duration_minutes === undefined
              ? {}
              : { duration_minutes: body.duration_minutes }),
            ...(body.buffer_before_minutes === undefined
              ? {}
              : { buffer_before_minutes: body.buffer_before_minutes }),
            ...(body.buffer_after_minutes === undefined
              ? {}
              : { buffer_after_minutes: body.buffer_after_minutes }),
            ...(body.required_resource_types === undefined
              ? {}
              : { required_resource_types: [...body.required_resource_types] }),
            ...(body.min_party_size === undefined ? {} : { min_party_size: body.min_party_size }),
            ...(body.max_party_size === undefined ? {} : { max_party_size: body.max_party_size }),
            ...(body.cancellation_window_minutes === undefined
              ? {}
              : { cancellation_window_minutes: body.cancellation_window_minutes }),
            ...(body.active === undefined ? {} : { active: body.active }),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'service.updated',
          objectType: 'service',
          objectId: current.id,
          diff: body,
        });
        return row;
      });
      return reply.header('etag', weakEtag(updated.version)).send(presentService(updated));
    },
  );

  app.get('/v1/resources', { schema: { querystring: LocationListQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'bookings:read');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('resources')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (request.query.location_id !== undefined) {
        query = query.where('location_id', '=', request.query.location_id);
      }
      if (actor.locationScope.length > 0) {
        query = query.where('location_id', 'in', actor.locationScope);
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
      presentResource,
    );
  });

  app.post('/v1/resources', { schema: { body: CreateResourceBody } }, async (request, reply) => {
    const body = request.body;
    const actor = requireTenantActor(request.principal, 'locations:manage', body.location_id);
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      { tenantId: actor.tenantId, userId: null },
      'resources.create',
      async (trx) => {
        await assertLocation(trx, actor, body.location_id);
        await assertCalendarLink(trx, body.calendar_integration_id, body.external_calendar_ref);
        const id = newId();
        const row = await trx
          .insertInto('resources')
          .values({
            id,
            tenant_id: actor.tenantId,
            location_id: body.location_id,
            name: body.name,
            resource_type: body.resource_type,
            parallel_slots: body.parallel_slots ?? 1,
            seat_capacity: body.seat_capacity ?? 1,
            calendar_integration_id: body.calendar_integration_id ?? null,
            external_calendar_ref: body.external_calendar_ref ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'resource.created',
          objectType: 'resource',
          objectId: id,
          diff: body,
        });
        return {
          status: 201,
          body: presentResource(row),
          resource: { type: 'resource', id },
          headers: { etag: weakEtag(row.version) },
        };
      },
    );
  });

  app.patch(
    '/v1/resources/:id',
    { schema: { params: IdParams, body: UpdateResourceBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage');
      const expectedVersion = requireIfMatch(request);
      const body = request.body;
      const updated = await inTenant(services, actor, request, async (trx) => {
        const current = await trx
          .selectFrom('resources')
          .selectAll()
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined || !inScope(actor, current.location_id)) {
          throw new ApiError('NOT_FOUND');
        }
        if (current.version !== expectedVersion) {
          throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
        }
        const integrationId =
          body.calendar_integration_id === undefined
            ? current.calendar_integration_id
            : body.calendar_integration_id;
        const calendarRef =
          body.external_calendar_ref === undefined
            ? current.external_calendar_ref
            : body.external_calendar_ref;
        await assertCalendarLink(trx, integrationId, calendarRef);
        const row = await trx
          .updateTable('resources')
          .set((eb) => ({
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.parallel_slots === undefined ? {} : { parallel_slots: body.parallel_slots }),
            ...(body.seat_capacity === undefined ? {} : { seat_capacity: body.seat_capacity }),
            ...(body.active === undefined ? {} : { active: body.active }),
            calendar_integration_id: integrationId,
            external_calendar_ref: calendarRef,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'resource.updated',
          objectType: 'resource',
          objectId: current.id,
          diff: body,
        });
        return row;
      });
      return reply.header('etag', weakEtag(updated.version)).send(presentResource(updated));
    },
  );

  app.get(
    '/v1/resources/:id/availability-rules',
    { schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'bookings:read');
      const result = await inTenant(services, actor, request, async (trx) => {
        const resource = await trx
          .selectFrom('resources')
          .select(['id', 'location_id', 'version'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (resource === undefined || !inScope(actor, resource.location_id)) {
          throw new ApiError('NOT_FOUND');
        }
        const rules = await trx
          .selectFrom('availability_rules')
          .select([
            'id',
            'iso_weekday',
            'start_local',
            'end_local',
            'timezone',
            'valid_from',
            'valid_to',
          ])
          .where('resource_id', '=', resource.id)
          .orderBy('iso_weekday')
          .orderBy('start_local')
          .execute();
        return { resource, rules };
      });
      return reply
        .header('etag', weakEtag(result.resource.version))
        .send({ resource_id: result.resource.id, rules: result.rules.map(presentRule) });
    },
  );

  app.put(
    '/v1/resources/:id/availability-rules',
    { schema: { params: IdParams, body: ReplaceRulesBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage');
      const expectedVersion = requireIfMatch(request);
      const body = request.body;
      if (!isValidTimeZone(body.timezone)) {
        throw invalid('/body/timezone', 'iana_time_zone');
      }
      const parsed = body.rules.map((rule, index) => {
        if (rule.end_local <= rule.start_local) {
          throw invalid(`/body/rules/${String(index)}/end_local`, 'after_start_local');
        }
        const validFrom =
          rule.valid_from === undefined
            ? null
            : parseInstant(rule.valid_from, `/body/rules/${String(index)}/valid_from`);
        const validTo =
          rule.valid_to === undefined
            ? null
            : parseInstant(rule.valid_to, `/body/rules/${String(index)}/valid_to`);
        if (validFrom !== null && validTo !== null && validTo < validFrom) {
          throw invalid(`/body/rules/${String(index)}/valid_to`, 'after_valid_from');
        }
        return { ...rule, validFrom, validTo };
      });
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'resources.availability_rules.replace',
        async (trx) => {
          const resource = await trx
            .selectFrom('resources')
            .select(['id', 'location_id', 'version'])
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (resource === undefined || !inScope(actor, resource.location_id)) {
            throw new ApiError('NOT_FOUND');
          }
          if (resource.version !== expectedVersion) {
            throw new ApiError('VERSION_CONFLICT', { current_version: resource.version });
          }
          await trx
            .deleteFrom('availability_rules')
            .where('resource_id', '=', resource.id)
            .execute();
          if (parsed.length > 0) {
            await trx
              .insertInto('availability_rules')
              .values(
                parsed.map((rule) => ({
                  id: newId(),
                  tenant_id: actor.tenantId,
                  resource_id: resource.id,
                  iso_weekday: rule.iso_weekday,
                  start_local: rule.start_local,
                  end_local: rule.end_local,
                  timezone: body.timezone,
                  valid_from: rule.validFrom,
                  valid_to: rule.validTo,
                })),
              )
              .execute();
          }
          const bumped = await trx
            .updateTable('resources')
            .set((eb) => ({ version: eb('version', '+', 1) }))
            .where('id', '=', resource.id)
            .returning(['version'])
            .executeTakeFirstOrThrow();
          const rules = await trx
            .selectFrom('availability_rules')
            .select([
              'id',
              'iso_weekday',
              'start_local',
              'end_local',
              'timezone',
              'valid_from',
              'valid_to',
            ])
            .where('resource_id', '=', resource.id)
            .orderBy('iso_weekday')
            .orderBy('start_local')
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'resource.availability_rules_replaced',
            objectType: 'resource',
            objectId: resource.id,
            diff: body,
          });
          return {
            status: 200,
            body: { resource_id: resource.id, rules: rules.map(presentRule) },
            resource: { type: 'resource', id: resource.id },
            headers: { etag: weakEtag(bumped.version) },
          };
        },
      );
    },
  );

  app.get(
    '/v1/availability-exceptions',
    { schema: { querystring: ExceptionListQuery } },
    async (request) => {
      const actor = requireTenantActor(
        request.principal,
        'bookings:read',
        request.query.location_id,
      );
      const from = parseInstant(request.query.from, '/query/from');
      const to = parseInstant(request.query.to, '/query/to');
      if (to <= from || to.getTime() - from.getTime() > 400 * 86_400_000) {
        throw invalid('/query/to', 'window');
      }
      const limit = limitFromQuery(request.query.limit);
      const cursor = readCursor(request.query.cursor, services.cursorKey);
      const rows = await inTenant(services, actor, request, (trx) => {
        let query = trx
          .selectFrom('availability_exceptions')
          .selectAll()
          .where('location_id', '=', request.query.location_id)
          .where('starts_at', '<', to)
          .where('ends_at', '>', from)
          .orderBy('starts_at')
          .orderBy('id')
          .limit(limit + 1);
        if (cursor !== null) {
          query = query.where((eb) =>
            eb(
              eb.refTuple('starts_at', 'id'),
              '>',
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
        (row) => ({ v: 1, k: [row.starts_at.toISOString()], id: row.id }),
        presentException,
      );
    },
  );

  app.post(
    '/v1/availability-exceptions',
    { schema: { body: CreateExceptionBody } },
    async (request, reply) => {
      const body = request.body;
      const actor = requireTenantActor(request.principal, 'locations:manage', body.location_id);
      const startsAt = parseInstant(body.starts_at, '/body/starts_at');
      const endsAt = parseInstant(body.ends_at, '/body/ends_at');
      if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 366 * 86_400_000) {
        throw invalid('/body/ends_at', 'window');
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'availability_exceptions.create',
        async (trx) => {
          await assertLocation(trx, actor, body.location_id);
          if (body.resource_id !== undefined) {
            const resource = await trx
              .selectFrom('resources')
              .select(['location_id'])
              .where('id', '=', body.resource_id)
              .executeTakeFirst();
            if (resource === undefined || resource.location_id !== body.location_id) {
              throw invalid('/body/resource_id', 'resource_in_location');
            }
          }
          const id = newId();
          const row = await trx
            .insertInto('availability_exceptions')
            .values({
              id,
              tenant_id: actor.tenantId,
              location_id: body.location_id,
              resource_id: body.resource_id ?? null,
              exception_kind: body.exception_kind,
              starts_at: startsAt,
              ends_at: endsAt,
              reason: body.reason ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'availability_exception.created',
            objectType: 'availability_exception',
            objectId: id,
            diff: body,
          });
          return {
            status: 201,
            body: presentException(row),
            resource: { type: 'availability_exception', id },
          };
        },
      );
    },
  );

  app.delete(
    '/v1/availability-exceptions/:id',
    { schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'locations:manage');
      await inTenant(services, actor, request, async (trx) => {
        const row = await trx
          .selectFrom('availability_exceptions')
          .select(['id', 'location_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (row === undefined || !inScope(actor, row.location_id)) {
          throw new ApiError('NOT_FOUND');
        }
        await trx.deleteFrom('availability_exceptions').where('id', '=', row.id).execute();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'availability_exception.deleted',
          objectType: 'availability_exception',
          objectId: row.id,
          diff: {},
        });
      });
      return reply.code(204).send();
    },
  );

  app.get('/v1/bookings', { schema: { querystring: BookingListQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'bookings:read');
    const from =
      request.query.from === undefined ? null : parseInstant(request.query.from, '/query/from');
    const to = request.query.to === undefined ? null : parseInstant(request.query.to, '/query/to');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('bookings')
        .selectAll()
        .orderBy('starts_at')
        .orderBy('id')
        .limit(limit + 1);
      if (request.query.location_id !== undefined) {
        query = query.where('location_id', '=', request.query.location_id);
      }
      if (actor.locationScope.length > 0) {
        query = query.where('location_id', 'in', actor.locationScope);
      }
      if (request.query.status !== undefined) {
        query = query.where('status', '=', request.query.status);
      }
      if (from !== null) {
        query = query.where('starts_at', '>=', from);
      }
      if (to !== null) {
        query = query.where('starts_at', '<', to);
      }
      if (cursor !== null) {
        query = query.where((eb) =>
          eb(
            eb.refTuple('starts_at', 'id'),
            '>',
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
      (row) => ({ v: 1, k: [row.starts_at.toISOString()], id: row.id }),
      presentBooking,
    );
  });

  app.get('/v1/bookings/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'bookings:read');
    const row = await inTenant(services, actor, request, (trx) =>
      trx.selectFrom('bookings').selectAll().where('id', '=', request.params.id).executeTakeFirst(),
    );
    if (row === undefined || !inScope(actor, row.location_id)) {
      throw new ApiError('NOT_FOUND');
    }
    return reply.header('etag', weakEtag(row.version)).send(presentBooking(row));
  });

  app.post(
    '/v1/bookings/:id/cancel',
    { schema: { params: IdParams, body: CancelBookingBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'bookings:write');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'bookings.cancel',
        async (trx) => {
          const current = await trx
            .selectFrom('bookings')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (current === undefined || !inScope(actor, current.location_id)) {
            throw new ApiError('NOT_FOUND');
          }
          if (current.status === 'CANCELED') {
            return {
              status: 200,
              body: presentBooking(current),
              resource: { type: 'booking', id: current.id },
              headers: { etag: weakEtag(current.version) },
            };
          }
          if (current.status !== 'CONFIRMED' && current.status !== 'PENDING_DEPOSIT') {
            throw new ApiError('INVALID_STATE_TRANSITION', { status: current.status });
          }
          const now = services.now();
          const row = await trx
            .updateTable('bookings')
            .set((eb) => ({
              status: 'CANCELED',
              canceled_at: now,
              cancellation_reason: request.body.reason,
              external_sync_status:
                current.external_event_ref === null ? current.external_sync_status : 'PENDING',
              version: eb('version', '+', 1),
            }))
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('resource_allocations')
            .set({ is_active: false, released_at: now })
            .where('booking_id', '=', current.id)
            .where('is_active', '=', true)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'booking.canceled',
            objectType: 'booking',
            objectId: current.id,
            diff: { reason: request.body.reason },
          });
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'booking.canceled',
            subject: domainSubject(actor.tenantId, 'booking.canceled'),
            payload: {
              booking_id: current.id,
              location_id: current.location_id,
              service_id: current.service_id,
              starts_at: current.starts_at.toISOString(),
              canceled_by: 'DASHBOARD',
              external_sync_required: current.external_event_ref !== null,
            },
            traceId: request.traceId,
          });
          return {
            status: 200,
            body: presentBooking(row),
            resource: { type: 'booking', id: current.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );
};
