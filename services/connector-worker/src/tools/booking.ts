import { withTenantTransaction, type DB } from '@velyric/db';
import {
  addDays,
  localDaysBetween,
  toLocalParts,
  zonedToUtc,
  type Occupation,
} from '@velyric/domain';
import type { Kysely } from 'kysely';
import Type, { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
  bookingReference,
  cancelBooking,
  computeSlots,
  createBooking,
  findBooking,
  loadServiceContext,
  recordExternalSync,
  rescheduleBooking,
  type BookingRecord,
  type ServiceContext,
  type TimeWindow,
} from '../booking-engine.js';
import { ToolExecutionError } from '../errors.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const Uuid = Type.String({ pattern: UUID_PATTERN });
const LocalDate = Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' });
const Reference = Type.String({ pattern: '^[0-9A-Fa-f]{8}$' });
const Email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]{1,64}@[^\\s@]{1,255}\\.[^\\s@]{2,63}$',
});
const E164 = Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' });

export const CheckAvailabilityArguments = Type.Object(
  {
    service_id: Uuid,
    date_from: LocalDate,
    date_to: Type.Optional(LocalDate),
    time_of_day: Type.Optional(
      Type.Union([Type.Literal('MORNING'), Type.Literal('AFTERNOON'), Type.Literal('EVENING')]),
    ),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

export const CreateBookingArguments = Type.Object(
  {
    slot_id: Type.String({ minLength: 10, maxLength: 200 }),
    customer_name: Type.String({ minLength: 1, maxLength: 120 }),
    party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    note: Type.Optional(Type.String({ maxLength: 500 })),
    customer_email: Type.Optional(Email),
    customer_phone: Type.Optional(E164),
  },
  { additionalProperties: false },
);

export const RescheduleBookingArguments = Type.Object(
  {
    booking_id: Type.Optional(Uuid),
    reference: Type.Optional(Reference),
    slot_id: Type.String({ minLength: 10, maxLength: 200 }),
    party_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

export const CancelBookingArguments = Type.Object(
  {
    booking_id: Type.Optional(Uuid),
    reference: Type.Optional(Reference),
    reason: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);

export const FindBookingArguments = Type.Object(
  { booking_id: Type.Optional(Uuid), reference: Type.Optional(Reference) },
  { additionalProperties: false },
);

export const ListServicesArguments = Type.Object(
  {
    location_id: Type.Optional(Uuid),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

const MAX_LISTED_SERVICES = 50;

export const BOOKING_TOOL_NAMES: readonly string[] = [
  'list_services',
  'check_availability',
  'lookup_availability',
  'create_booking',
  'cancel_booking',
  'reschedule_booking',
  'find_booking',
];

const TIME_OF_DAY_HOURS = { MORNING: [6, 12], AFTERNOON: [12, 17], EVENING: [17, 22] } as const;
const MAX_WINDOW_DAYS = 14;
const MIN_LEAD_MINUTES = 30;

export interface CalendarEventSummary {
  readonly title: string;
  readonly note: string | null;
}

export interface CalendarSync {
  busy(context: ServiceContext, window: TimeWindow, traceId: string): Promise<Occupation[]>;
  createEvent(
    context: ServiceContext,
    booking: BookingRecord,
    summary: CalendarEventSummary,
    traceId: string,
  ): Promise<string | null>;
  cancelEvent(tenantId: string, externalEventRef: string, traceId: string): Promise<void>;
}

export interface ToolRequest {
  readonly tenantId: string;
  readonly callId: string | null;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly now: Date;
}

export interface ToolResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly httpStatus: number | null;
}

export interface BookingToolDependencies {
  readonly db: Kysely<DB>;
  readonly calendar: CalendarSync | null;
}

function parseArguments<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new ToolExecutionError(
      'VALIDATION_FAILED',
      'tool arguments do not match the tool contract',
      { details: { reason: 'schema_mismatch' } },
    );
  }
  return value;
}

export function encodeSlotId(serviceId: string, startsAt: Date): string {
  return Buffer.from(`${serviceId}|${startsAt.toISOString()}`, 'utf8').toString('base64url');
}

export function decodeSlotId(slotId: string): {
  readonly serviceId: string;
  readonly startsAt: Date;
} {
  const [serviceId, startsAt, extra] = Buffer.from(slotId, 'base64url').toString('utf8').split('|');
  const parsed = startsAt === undefined ? Number.NaN : Date.parse(startsAt);
  if (
    serviceId === undefined ||
    extra !== undefined ||
    !new RegExp(UUID_PATTERN).test(serviceId) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== startsAt
  ) {
    throw new ToolExecutionError(
      'VALIDATION_FAILED',
      'slot_id is not a slot offered by check_availability',
      { details: { reason: 'invalid_slot_id' } },
    );
  }
  return { serviceId, startsAt: new Date(parsed) };
}

function parseLocalDate(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}

export function localDateWindow(
  timezone: string,
  dateFrom: string,
  dateTo: string | undefined,
): TimeWindow {
  const from = parseLocalDate(dateFrom);
  const to = parseLocalDate(dateTo ?? dateFrom);
  const days = localDaysBetween(from, to);
  if (days < 0 || days >= MAX_WINDOW_DAYS) {
    throw new ToolExecutionError(
      'VALIDATION_FAILED',
      `the date range must cover 1 to ${String(MAX_WINDOW_DAYS)} days`,
      { details: { reason: 'invalid_date_range' } },
    );
  }
  return {
    from: zonedToUtc({ ...from, hour: 0, minute: 0, second: 0 }, timezone),
    to: zonedToUtc({ ...addDays(to, 1), hour: 0, minute: 0, second: 0 }, timezone),
  };
}

export function formatLocal(instant: Date, timezone: string): string {
  const parts = toLocalParts(instant, timezone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function bookingSummary(booking: BookingRecord): Record<string, unknown> {
  return {
    booking_id: booking.id,
    reference: bookingReference(booking.id),
    status: booking.status,
    starts_at: booking.startsAt.toISOString(),
    ends_at: booking.endsAt.toISOString(),
    local_start: formatLocal(booking.startsAt, booking.timezone),
    timezone: booking.timezone,
    party_size: booking.partySize,
    calendar_sync: booking.externalSyncStatus,
    replayed: booking.replayed,
  };
}

function bookingLookup(args: {
  readonly booking_id?: string;
  readonly reference?: string;
}): { readonly bookingId: string } | { readonly reference: string } {
  if (args.booking_id !== undefined) {
    return { bookingId: args.booking_id };
  }
  if (args.reference !== undefined) {
    return { reference: args.reference };
  }
  throw new ToolExecutionError('VALIDATION_FAILED', 'either booking_id or reference is required', {
    details: { reason: 'missing_booking_identifier' },
  });
}

export async function executeBookingTool(
  request: ToolRequest,
  deps: BookingToolDependencies,
): Promise<ToolResult> {
  const context = {
    tenantId: request.tenantId,
    actorType: 'SERVICE' as const,
    actorId: 'connector-worker',
    traceId: request.traceId,
  };
  switch (request.toolName) {
    case 'check_availability':
    case 'lookup_availability': {
      const args = parseArguments(CheckAvailabilityArguments, request.arguments);
      const service = await withTenantTransaction(deps.db, context, (trx) =>
        loadServiceContext(trx, request.tenantId, args.service_id),
      );
      const window = localDateWindow(service.timezone, args.date_from, args.date_to);
      const externalBusy =
        deps.calendar === null ? [] : await deps.calendar.busy(service, window, request.traceId);
      const slots = await withTenantTransaction(deps.db, context, (trx) =>
        computeSlots(trx, service, window, {
          now: request.now,
          minLeadMinutes: MIN_LEAD_MINUTES,
          maxResults: 200,
          externalBusy,
        }),
      );
      const hours = args.time_of_day === undefined ? null : TIME_OF_DAY_HOURS[args.time_of_day];
      const filtered = slots
        .filter((slot) => {
          if (hours === null) {
            return true;
          }
          const hour = toLocalParts(slot.startsAt, service.timezone).hour;
          return hour >= hours[0] && hour < hours[1];
        })
        .slice(0, args.max_results ?? 5);
      return {
        httpStatus: null,
        result: {
          service_name: service.service.name,
          timezone: service.timezone,
          slots: filtered.map((slot) => ({
            slot_id: encodeSlotId(service.service.id, slot.startsAt),
            starts_at: slot.startsAt.toISOString(),
            ends_at: slot.endsAt.toISOString(),
            local_start: formatLocal(slot.startsAt, service.timezone),
          })),
        },
      };
    }
    case 'create_booking': {
      const args = parseArguments(CreateBookingArguments, request.arguments);
      const slot = decodeSlotId(args.slot_id);
      const service = await withTenantTransaction(deps.db, context, (trx) =>
        loadServiceContext(trx, request.tenantId, slot.serviceId),
      );
      const padding =
        (service.service.bufferBeforeMinutes + service.service.bufferAfterMinutes) * 60_000;
      const window = {
        from: new Date(slot.startsAt.getTime() - padding),
        to: new Date(slot.startsAt.getTime() + service.service.durationMinutes * 60_000 + padding),
      };
      const externalBusy =
        deps.calendar === null ? [] : await deps.calendar.busy(service, window, request.traceId);
      const noteLines = [
        `Name: ${args.customer_name}`,
        ...(args.note === undefined ? [] : [args.note]),
      ];
      let booking = await withTenantTransaction(deps.db, context, (trx) =>
        createBooking(trx, {
          tenantId: request.tenantId,
          serviceId: slot.serviceId,
          startsAt: slot.startsAt,
          partySize: args.party_size ?? 1,
          customerNote: noteLines.join('\n'),
          callId: request.callId,
          idempotencyKey: request.idempotencyKey,
          now: request.now,
          externalSync: deps.calendar !== null,
          externalBusy,
          guest: {
            name: args.customer_name,
            email: args.customer_email ?? null,
            phone: args.customer_phone ?? null,
          },
          traceId: request.traceId,
        }),
      );
      if (deps.calendar !== null && !booking.replayed && booking.externalSyncStatus === 'PENDING') {
        let outcome: {
          externalEventRef: string | null;
          status: 'SYNCED' | 'FAILED' | 'NOT_REQUIRED';
        };
        try {
          const reference = await deps.calendar.createEvent(
            service,
            booking,
            { title: `${service.service.name} – ${args.customer_name}`, note: args.note ?? null },
            request.traceId,
          );
          outcome =
            reference === null
              ? { externalEventRef: null, status: 'NOT_REQUIRED' }
              : { externalEventRef: reference, status: 'SYNCED' };
        } catch {
          outcome = { externalEventRef: null, status: 'FAILED' };
        }
        await withTenantTransaction(deps.db, context, (trx) =>
          recordExternalSync(trx, booking.id, outcome),
        );
        booking = {
          ...booking,
          externalEventRef: outcome.externalEventRef,
          externalSyncStatus: outcome.status,
        };
      }
      return { httpStatus: null, result: bookingSummary(booking) };
    }
    case 'cancel_booking': {
      const args = parseArguments(CancelBookingArguments, request.arguments);
      const lookup = bookingLookup(args);
      let booking = await withTenantTransaction(deps.db, context, async (trx) => {
        const found = await findBooking(trx, lookup);
        if (found === null) {
          throw new ToolExecutionError('NOT_FOUND', 'booking not found', {
            details: { entity: 'booking' },
          });
        }
        return cancelBooking(trx, {
          tenantId: request.tenantId,
          bookingId: found.id,
          reason: args.reason ?? null,
          now: request.now,
          traceId: request.traceId,
        });
      });
      const externalEventRef = booking.externalEventRef;
      if (
        deps.calendar !== null &&
        externalEventRef !== null &&
        booking.externalSyncStatus === 'PENDING'
      ) {
        let status: 'SYNCED' | 'FAILED';
        try {
          await deps.calendar.cancelEvent(request.tenantId, externalEventRef, request.traceId);
          status = 'SYNCED';
        } catch {
          status = 'FAILED';
        }
        await withTenantTransaction(deps.db, context, (trx) =>
          recordExternalSync(trx, booking.id, { externalEventRef, status }),
        );
        booking = { ...booking, externalSyncStatus: status };
      }
      return { httpStatus: null, result: bookingSummary(booking) };
    }
    case 'reschedule_booking': {
      const args = parseArguments(RescheduleBookingArguments, request.arguments);
      const lookup = bookingLookup(args);
      const slot = decodeSlotId(args.slot_id);
      const service = await withTenantTransaction(deps.db, context, (trx) =>
        loadServiceContext(trx, request.tenantId, slot.serviceId),
      );
      const padding =
        (service.service.bufferBeforeMinutes + service.service.bufferAfterMinutes) * 60_000;
      const window = {
        from: new Date(slot.startsAt.getTime() - padding),
        to: new Date(slot.startsAt.getTime() + service.service.durationMinutes * 60_000 + padding),
      };
      const externalBusy =
        deps.calendar === null ? [] : await deps.calendar.busy(service, window, request.traceId);
      const moved = await withTenantTransaction(deps.db, context, async (trx) => {
        const found = await findBooking(trx, lookup);
        if (found === null) {
          throw new ToolExecutionError('NOT_FOUND', 'booking not found', {
            details: { entity: 'booking' },
          });
        }
        return rescheduleBooking(trx, {
          tenantId: request.tenantId,
          bookingId: found.id,
          serviceId: slot.serviceId,
          startsAt: slot.startsAt,
          partySize: args.party_size ?? null,
          callId: request.callId,
          idempotencyKey: request.idempotencyKey,
          now: request.now,
          externalSync: deps.calendar !== null,
          externalBusy,
          traceId: request.traceId,
        });
      });
      let booking = moved.booking;
      if (deps.calendar !== null && !booking.replayed) {
        const previousRef = moved.previous.externalEventRef;
        if (previousRef !== null) {
          let status: 'SYNCED' | 'FAILED';
          try {
            await deps.calendar.cancelEvent(request.tenantId, previousRef, request.traceId);
            status = 'SYNCED';
          } catch {
            status = 'FAILED';
          }
          await withTenantTransaction(deps.db, context, (trx) =>
            recordExternalSync(trx, moved.previous.id, { externalEventRef: previousRef, status }),
          );
        }
        if (booking.externalSyncStatus === 'PENDING') {
          let outcome: {
            externalEventRef: string | null;
            status: 'SYNCED' | 'FAILED' | 'NOT_REQUIRED';
          };
          try {
            const reference = await deps.calendar.createEvent(
              service,
              booking,
              { title: service.service.name, note: null },
              request.traceId,
            );
            outcome =
              reference === null
                ? { externalEventRef: null, status: 'NOT_REQUIRED' }
                : { externalEventRef: reference, status: 'SYNCED' };
          } catch {
            outcome = { externalEventRef: null, status: 'FAILED' };
          }
          await withTenantTransaction(deps.db, context, (trx) =>
            recordExternalSync(trx, booking.id, outcome),
          );
          booking = {
            ...booking,
            externalEventRef: outcome.externalEventRef,
            externalSyncStatus: outcome.status,
          };
        }
      }
      return {
        httpStatus: null,
        result: {
          ...bookingSummary(booking),
          previous_booking_id: moved.previous.id,
          previous_local_start: formatLocal(moved.previous.startsAt, moved.previous.timezone),
        },
      };
    }
    case 'find_booking': {
      const args = parseArguments(FindBookingArguments, request.arguments);
      const lookup = bookingLookup(args);
      const booking = await withTenantTransaction(deps.db, context, (trx) =>
        findBooking(trx, lookup),
      );
      if (booking === null) {
        throw new ToolExecutionError('NOT_FOUND', 'booking not found', {
          details: { entity: 'booking' },
        });
      }
      return { httpStatus: null, result: bookingSummary(booking) };
    }
    case 'list_services': {
      const args = parseArguments(ListServicesArguments, request.arguments);
      const rows = await withTenantTransaction(deps.db, context, (trx) => {
        let query = trx
          .selectFrom('services')
          .innerJoin('locations', 'locations.id', 'services.location_id')
          .select([
            'services.id',
            'services.name',
            'services.duration_minutes',
            'services.location_id',
            'locations.name as location_name',
            'locations.timezone',
          ])
          .where('services.active', '=', true)
          .where('locations.status', '=', 'ACTIVE')
          .orderBy('locations.name')
          .orderBy('services.name')
          .limit(MAX_LISTED_SERVICES + 1);
        if (args.location_id !== undefined) {
          query = query.where('services.location_id', '=', args.location_id);
        }
        if (args.query !== undefined) {
          query = query.where(
            'services.name',
            'ilike',
            `%${args.query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`,
          );
        }
        return query.execute();
      });
      return {
        httpStatus: null,
        result: {
          services: rows.slice(0, MAX_LISTED_SERVICES).map((row) => ({
            service_id: row.id,
            name: row.name,
            duration_minutes: row.duration_minutes,
            location_id: row.location_id,
            location_name: row.location_name,
            timezone: row.timezone,
          })),
          truncated: rows.length > MAX_LISTED_SERVICES,
        },
      };
    }
    default:
      throw new ToolExecutionError(
        'TOOL_NOT_ALLOWED',
        'this connector does not implement the requested tool',
        { details: { tool_name: request.toolName } },
      );
  }
}
