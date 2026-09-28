import { randomUUID } from 'node:crypto';
import { resolveGuestProfile, type DB } from '@velyric/db';
import { findAvailableSlots, type AvailableSlot, type Occupation } from '@velyric/domain';
import { sql, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { ToolExecutionError, databaseErrorCode } from './errors.js';

export type Trx = Transaction<DB>;

export interface GuestContact {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export async function appendBookingEvent(
  trx: Trx,
  tenantId: string,
  eventType: 'booking.created' | 'booking.changed' | 'booking.canceled',
  payload: Readonly<Record<string, unknown>>,
  traceId: string,
): Promise<void> {
  await sql`
    insert into app.outbox_events (tenant_id, event_id, event_type, schema_version, subject, payload, trace_id, occurred_at)
    values (${tenantId}, ${uuidv7()}, ${eventType}, 1, ${`domain.v1.${tenantId}.${eventType}`}, ${JSON.stringify(payload)}::jsonb, ${traceId}, now())`.execute(
    trx,
  );
}

export interface ServiceRecord {
  readonly id: string;
  readonly locationId: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly requiredResourceTypes: readonly string[];
  readonly cancellationWindowMinutes: number;
  readonly minPartySize: number;
  readonly maxPartySize: number;
}

export interface ResourceRecord {
  readonly id: string;
  readonly name: string;
  readonly resourceType: string;
  readonly parallelSlots: number;
  readonly calendarIntegrationId: string | null;
  readonly externalCalendarRef: string | null;
}

export interface ServiceContext {
  readonly tenantId: string;
  readonly service: ServiceRecord;
  readonly timezone: string;
  readonly resources: readonly ResourceRecord[];
}

export interface TimeWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface BookingRecord {
  readonly id: string;
  readonly status: string;
  readonly serviceId: string | null;
  readonly locationId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly partySize: number;
  readonly externalEventRef: string | null;
  readonly externalSyncStatus: string;
  readonly replayed: boolean;
  readonly assignedResourceIds: readonly string[];
}

export interface CreateBookingInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly partySize: number;
  readonly customerNote: string | null;
  readonly callId: string | null;
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly externalSync: boolean;
  readonly externalBusy: readonly Occupation[];
  readonly guest?: GuestContact | null;
  readonly personId?: string | null;
  readonly rescheduledFromBookingId?: string | null;
  readonly traceId?: string;
}

const BOOKING_COLUMNS = [
  'id',
  'status',
  'service_id',
  'location_id',
  'starts_at',
  'ends_at',
  'timezone',
  'party_size',
  'external_event_ref',
  'external_sync_status',
] as const;

interface BookingRow {
  readonly id: string;
  readonly status: string;
  readonly service_id: string | null;
  readonly location_id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly timezone: string;
  readonly party_size: number;
  readonly external_event_ref: string | null;
  readonly external_sync_status: string;
}

function toBooking(
  row: BookingRow,
  replayed: boolean,
  assignedResourceIds: readonly string[] = [],
): BookingRecord {
  return {
    id: row.id,
    status: row.status,
    serviceId: row.service_id,
    locationId: row.location_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    partySize: row.party_size,
    externalEventRef: row.external_event_ref,
    externalSyncStatus: row.external_sync_status,
    replayed,
    assignedResourceIds,
  };
}

export function bookingReference(bookingId: string): string {
  return bookingId.replaceAll('-', '').slice(-8).toUpperCase();
}

export async function loadServiceContext(
  trx: Trx,
  tenantId: string,
  serviceId: string,
): Promise<ServiceContext> {
  const service = await trx
    .selectFrom('services')
    .innerJoin('locations', 'locations.id', 'services.location_id')
    .select([
      'services.id',
      'services.location_id',
      'services.name',
      'services.duration_minutes',
      'services.buffer_before_minutes',
      'services.buffer_after_minutes',
      'services.required_resource_types',
      'services.cancellation_window_minutes',
      'services.min_party_size',
      'services.max_party_size',
      'services.active',
      'locations.timezone',
      'locations.status as location_status',
    ])
    .where('services.id', '=', serviceId)
    .executeTakeFirst();
  if (service === undefined || !service.active) {
    throw new ToolExecutionError('NOT_FOUND', 'service not found', {
      details: { entity: 'service' },
    });
  }
  const resources = await trx
    .selectFrom('resources')
    .select([
      'id',
      'name',
      'resource_type',
      'parallel_slots',
      'calendar_integration_id',
      'external_calendar_ref',
    ])
    .where('location_id', '=', service.location_id)
    .where('active', '=', true)
    .where('resource_type', 'in', service.required_resource_types)
    .orderBy('name')
    .execute();
  return {
    tenantId,
    timezone: service.timezone,
    service: {
      id: service.id,
      locationId: service.location_id,
      name: service.name,
      durationMinutes: service.duration_minutes,
      bufferBeforeMinutes: service.buffer_before_minutes,
      bufferAfterMinutes: service.buffer_after_minutes,
      requiredResourceTypes: service.required_resource_types,
      cancellationWindowMinutes: service.cancellation_window_minutes,
      minPartySize: service.min_party_size,
      maxPartySize: service.max_party_size,
    },
    resources: resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      resourceType: resource.resource_type,
      parallelSlots: resource.parallel_slots,
      calendarIntegrationId: resource.calendar_integration_id,
      externalCalendarRef: resource.external_calendar_ref,
    })),
  };
}

export async function computeSlots(
  trx: Trx,
  context: ServiceContext,
  window: TimeWindow,
  options: {
    readonly now: Date;
    readonly stepMinutes?: number;
    readonly minLeadMinutes?: number;
    readonly maxResults?: number;
    readonly externalBusy?: readonly Occupation[];
  },
): Promise<AvailableSlot[]> {
  const resourceIds = context.resources.map((resource) => resource.id);
  if (resourceIds.length === 0) {
    return [];
  }
  const padding =
    (context.service.bufferBeforeMinutes + context.service.bufferAfterMinutes) * 60_000;
  const paddedFrom = new Date(window.from.getTime() - padding);
  const paddedTo = new Date(window.to.getTime() + padding);
  const rules = await trx
    .selectFrom('availability_rules')
    .select([
      'resource_id',
      'iso_weekday',
      'start_local',
      'end_local',
      'timezone',
      'valid_from',
      'valid_to',
    ])
    .where('resource_id', 'in', resourceIds)
    .execute();
  const exceptions = await trx
    .selectFrom('availability_exceptions')
    .select(['resource_id', 'exception_kind', 'starts_at', 'ends_at'])
    .where('location_id', '=', context.service.locationId)
    .where('starts_at', '<', paddedTo)
    .where('ends_at', '>', paddedFrom)
    .where((eb) => eb.or([eb('resource_id', 'is', null), eb('resource_id', 'in', resourceIds)]))
    .execute();
  const allocations = await trx
    .selectFrom('resource_allocations')
    .select([
      'resource_id',
      'slot_index',
      sql<Date>`lower(during)`.as('starts_at'),
      sql<Date>`upper(during)`.as('ends_at'),
    ])
    .where('resource_id', 'in', resourceIds)
    .where('is_active', '=', true)
    .where(sql<boolean>`during && tstzrange(${paddedFrom}, ${paddedTo}, '[)')`)
    .where((eb) => eb.or([eb('hold_id', 'is', null), eb('hold_expires_at', '>', options.now)]))
    .execute();
  return findAvailableSlots({
    service: context.service,
    resources: context.resources,
    rules: rules.map((rule) => ({
      resourceId: rule.resource_id,
      isoWeekday: rule.iso_weekday,
      startLocal: rule.start_local,
      endLocal: rule.end_local,
      timezone: rule.timezone,
      validFrom: rule.valid_from,
      validTo: rule.valid_to,
    })),
    exceptions: exceptions.map((exception) => ({
      resourceId: exception.resource_id,
      kind: exception.exception_kind === 'EXTRA_OPENING' ? 'EXTRA_OPENING' : 'CLOSED',
      startsAt: exception.starts_at,
      endsAt: exception.ends_at,
    })),
    occupations: [
      ...allocations.map((allocation) => ({
        resourceId: allocation.resource_id,
        slotIndex: allocation.slot_index,
        startsAt: allocation.starts_at,
        endsAt: allocation.ends_at,
      })),
      ...(options.externalBusy ?? []),
    ],
    query: {
      from: window.from,
      to: window.to,
      now: options.now,
      ...(options.stepMinutes === undefined ? {} : { stepMinutes: options.stepMinutes }),
      ...(options.minLeadMinutes === undefined ? {} : { minLeadMinutes: options.minLeadMinutes }),
      ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
    },
  });
}

export async function findBookingByIdempotencyKey(
  trx: Trx,
  idempotencyKey: string,
): Promise<BookingRecord | null> {
  const row = await trx
    .selectFrom('bookings')
    .select(BOOKING_COLUMNS)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : toBooking(row, true);
}

export async function createBooking(trx: Trx, input: CreateBookingInput): Promise<BookingRecord> {
  const replay = await findBookingByIdempotencyKey(trx, input.idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const context = await loadServiceContext(trx, input.tenantId, input.serviceId);
  if (
    input.partySize < context.service.minPartySize ||
    input.partySize > context.service.maxPartySize
  ) {
    throw new ToolExecutionError('VALIDATION_FAILED', 'party size is outside the service limits', {
      details: {
        min_party_size: context.service.minPartySize,
        max_party_size: context.service.maxPartySize,
      },
    });
  }
  for (const resource of context.resources) {
    await sql`SELECT app.release_expired_allocations(${resource.id}::uuid)`.execute(trx);
  }
  const endsAt = new Date(input.startsAt.getTime() + context.service.durationMinutes * 60_000);
  const [slot] = await computeSlots(
    trx,
    context,
    { from: input.startsAt, to: endsAt },
    {
      now: input.now,
      stepMinutes: 5,
      maxResults: 1,
      externalBusy: input.externalBusy,
    },
  );
  if (slot === undefined || slot.startsAt.getTime() !== input.startsAt.getTime()) {
    throw new ToolExecutionError(
      'BOOKING_SLOT_UNAVAILABLE',
      'the requested slot is no longer available',
    );
  }
  const personId =
    input.personId !== undefined
      ? input.personId
      : await resolveGuestProfile(trx, {
          tenantId: input.tenantId,
          callId: input.callId,
          locationId: context.service.locationId,
          name: input.guest?.name ?? null,
          email: input.guest?.email ?? null,
          phone: input.guest?.phone ?? null,
          language: null,
          at: input.now,
        });
  try {
    const booking = await trx
      .insertInto('bookings')
      .values({
        tenant_id: input.tenantId,
        location_id: context.service.locationId,
        service_id: context.service.id,
        call_id: input.callId,
        person_id: personId,
        rescheduled_from_booking_id: input.rescheduledFromBookingId ?? null,
        starts_at: slot.startsAt,
        ends_at: slot.endsAt,
        timezone: context.timezone,
        party_size: input.partySize,
        customer_note: input.customerNote,
        source: 'VOICE_AGENT',
        status: 'CONFIRMED',
        external_sync_status: input.externalSync ? 'PENDING' : 'NOT_REQUIRED',
        idempotency_key: input.idempotencyKey,
      })
      .returning(BOOKING_COLUMNS)
      .executeTakeFirstOrThrow();
    for (const assignment of slot.assignments) {
      await trx
        .insertInto('resource_allocations')
        .values({
          tenant_id: input.tenantId,
          resource_id: assignment.resourceId,
          slot_index: assignment.slotIndex,
          during: sql<string>`tstzrange(${slot.occupiesFrom}, ${slot.occupiesUntil}, '[)')`,
          booking_id: booking.id,
        })
        .execute();
    }
    if ((input.rescheduledFromBookingId ?? null) === null) {
      await appendBookingEvent(
        trx,
        input.tenantId,
        'booking.created',
        {
          booking_id: booking.id,
          location_id: booking.location_id,
          service_id: booking.service_id,
          starts_at: booking.starts_at.toISOString(),
          ends_at: booking.ends_at.toISOString(),
          party_size: booking.party_size,
          source: 'VOICE_AGENT',
          call_id: input.callId,
        },
        input.traceId ?? randomUUID().replaceAll('-', ''),
      );
    }
    return toBooking(
      booking,
      false,
      slot.assignments.map((assignment) => assignment.resourceId),
    );
  } catch (error) {
    if (databaseErrorCode(error) === '23P01') {
      throw new ToolExecutionError(
        'BOOKING_SLOT_UNAVAILABLE',
        'the requested slot was taken concurrently',
        { cause: error },
      );
    }
    throw error;
  }
}

export interface CancelBookingInput {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly reason: string | null;
  readonly now: Date;
  readonly traceId: string;
  readonly emitEvent?: boolean;
}

export async function cancelBooking(trx: Trx, input: CancelBookingInput): Promise<BookingRecord> {
  const booking = await trx
    .selectFrom('bookings')
    .leftJoin('services', 'services.id', 'bookings.service_id')
    .select([
      ...BOOKING_COLUMNS.map((column) => `bookings.${column}` as const),
      'services.cancellation_window_minutes',
    ])
    .where('bookings.id', '=', input.bookingId)
    .forUpdate('bookings')
    .executeTakeFirst();
  if (booking === undefined) {
    throw new ToolExecutionError('NOT_FOUND', 'booking not found', {
      details: { entity: 'booking' },
    });
  }
  if (booking.status === 'CANCELED') {
    return toBooking(booking, true);
  }
  if (booking.status !== 'CONFIRMED' && booking.status !== 'PENDING_DEPOSIT') {
    throw new ToolExecutionError('INVALID_STATE_TRANSITION', 'booking can no longer be canceled', {
      details: { status: booking.status },
    });
  }
  const windowMinutes = booking.cancellation_window_minutes ?? 0;
  if (input.now.getTime() > booking.starts_at.getTime() - windowMinutes * 60_000) {
    throw new ToolExecutionError('INVALID_STATE_TRANSITION', 'the cancellation window has passed', {
      details: { reason: 'cancellation_window_passed', cancellation_window_minutes: windowMinutes },
    });
  }
  const updated = await trx
    .updateTable('bookings')
    .set((eb) => ({
      status: 'CANCELED',
      canceled_at: input.now,
      cancellation_reason: input.reason,
      version: eb('version', '+', 1),
      external_sync_status:
        booking.external_event_ref === null ? booking.external_sync_status : 'PENDING',
    }))
    .where('id', '=', input.bookingId)
    .returning(BOOKING_COLUMNS)
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('resource_allocations')
    .set({ is_active: false, released_at: input.now })
    .where('booking_id', '=', input.bookingId)
    .where('is_active', '=', true)
    .execute();
  if (input.emitEvent !== false) {
    await appendBookingEvent(
      trx,
      input.tenantId,
      'booking.canceled',
      {
        booking_id: updated.id,
        location_id: updated.location_id,
        service_id: updated.service_id,
        starts_at: updated.starts_at.toISOString(),
        canceled_by: 'VOICE_AGENT',
        external_sync_required: updated.external_event_ref !== null,
      },
      input.traceId,
    );
  }
  return toBooking(updated, false);
}

export interface RescheduleBookingInput {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly partySize: number | null;
  readonly callId: string | null;
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly externalSync: boolean;
  readonly externalBusy: readonly Occupation[];
  readonly traceId: string;
}

export interface RescheduledBooking {
  readonly booking: BookingRecord;
  readonly previous: BookingRecord;
}

export async function rescheduleBooking(
  trx: Trx,
  input: RescheduleBookingInput,
): Promise<RescheduledBooking> {
  const replay = await trx
    .selectFrom('bookings')
    .select([...BOOKING_COLUMNS, 'rescheduled_from_booking_id'])
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (replay !== undefined && replay.rescheduled_from_booking_id !== null) {
    const previous = await trx
      .selectFrom('bookings')
      .select(BOOKING_COLUMNS)
      .where('id', '=', replay.rescheduled_from_booking_id)
      .executeTakeFirstOrThrow();
    return { booking: toBooking(replay, true), previous: toBooking(previous, true) };
  }
  const original = await trx
    .selectFrom('bookings')
    .select(['person_id', 'customer_note', 'party_size', 'status'])
    .where('id', '=', input.bookingId)
    .executeTakeFirst();
  if (original === undefined) {
    throw new ToolExecutionError('NOT_FOUND', 'booking not found', {
      details: { entity: 'booking' },
    });
  }
  const previous = await cancelBooking(trx, {
    tenantId: input.tenantId,
    bookingId: input.bookingId,
    reason: 'RESCHEDULED',
    now: input.now,
    traceId: input.traceId,
    emitEvent: false,
  });
  if (previous.replayed) {
    throw new ToolExecutionError('INVALID_STATE_TRANSITION', 'booking can no longer be changed', {
      details: { status: previous.status },
    });
  }
  const booking = await createBooking(trx, {
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    startsAt: input.startsAt,
    partySize: input.partySize ?? original.party_size,
    customerNote: original.customer_note,
    callId: input.callId,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
    externalSync: input.externalSync,
    externalBusy: input.externalBusy,
    personId: original.person_id,
    rescheduledFromBookingId: input.bookingId,
    traceId: input.traceId,
  });
  await appendBookingEvent(
    trx,
    input.tenantId,
    'booking.changed',
    {
      booking_id: booking.id,
      previous_booking_id: previous.id,
      location_id: booking.locationId,
      service_id: booking.serviceId,
      starts_at: booking.startsAt.toISOString(),
      previous_starts_at: previous.startsAt.toISOString(),
      party_size: booking.partySize,
      changed_by: 'VOICE_AGENT',
    },
    input.traceId,
  );
  return { booking, previous };
}

export async function findBooking(
  trx: Trx,
  input: { readonly bookingId?: string; readonly reference?: string },
): Promise<BookingRecord | null> {
  let query = trx
    .selectFrom('bookings')
    .select(BOOKING_COLUMNS)
    .orderBy('starts_at', 'desc')
    .limit(2);
  if (input.bookingId !== undefined) {
    query = query.where('id', '=', input.bookingId);
  } else if (input.reference !== undefined) {
    query = query.where(
      sql<string>`upper(right(replace(id::text, '-', ''), 8))`,
      '=',
      input.reference.toUpperCase(),
    );
  } else {
    return null;
  }
  const rows = await query.execute();
  if (rows.length > 1) {
    throw new ToolExecutionError('CONFLICT', 'booking reference is ambiguous', {
      details: { reason: 'ambiguous_reference' },
    });
  }
  const [row] = rows;
  return row === undefined ? null : toBooking(row, false);
}

export async function recordExternalSync(
  trx: Trx,
  bookingId: string,
  outcome: {
    readonly externalEventRef: string | null;
    readonly status: 'SYNCED' | 'FAILED' | 'NOT_REQUIRED';
  },
): Promise<void> {
  await trx
    .updateTable('bookings')
    .set((eb) => ({
      external_event_ref: outcome.externalEventRef,
      external_sync_status: outcome.status,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', bookingId)
    .execute();
}
