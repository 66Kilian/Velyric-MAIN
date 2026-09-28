import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ToolExecutionError } from '../src/errors.js';
import { executeBookingTool, type ToolRequest } from '../src/tools/booking.js';
import { seedBookableLocation, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

function request(
  tenantId: string,
  toolName: string,
  args: unknown,
  overrides: Partial<ToolRequest> = {},
): ToolRequest {
  return {
    tenantId,
    callId: null,
    toolName,
    arguments: args,
    idempotencyKey: `test:${randomUUID()}`,
    traceId: TRACE,
    now: new Date('2030-01-07T00:00:00Z'),
    ...overrides,
  };
}

async function run(toolRequest: ToolRequest): Promise<Record<string, unknown>> {
  const outcome = await executeBookingTool(toolRequest, { db: database().db, calendar: null });
  return outcome.result;
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the tool execution to fail');
}

function slots(result: Record<string, unknown>): { slot_id: string; local_start: string }[] {
  return result['slots'] as { slot_id: string; local_start: string }[];
}

describe('built-in booking tools', () => {
  it('lists active services with ids so callers can pick one before checking availability', async () => {
    const seeded = await seedBookableLocation(database().admin);
    await database().admin.query(
      `INSERT INTO app.services (tenant_id, location_id, name, duration_minutes, active, required_resource_types) VALUES ($1, $2, 'Régi 100%_szolgáltatás', 20, false, ARRAY['DOCTOR'])`,
      [seeded.tenantId, seeded.locationId],
    );
    const listed = await run(request(seeded.tenantId, 'list_services', {}));
    expect(listed).toEqual({
      services: [
        {
          service_id: seeded.serviceId,
          name: 'Konzultáció',
          duration_minutes: 30,
          location_id: seeded.locationId,
          location_name: 'Központ',
          timezone: 'Europe/Budapest',
        },
      ],
      truncated: false,
    });
    expect(await run(request(seeded.tenantId, 'list_services', { query: 'konz' }))).toMatchObject({
      services: [{ service_id: seeded.serviceId }],
    });
    expect(await run(request(seeded.tenantId, 'list_services', { query: '%' }))).toEqual({
      services: [],
      truncated: false,
    });
    expect(
      await failureCode(
        run(request(seeded.tenantId, 'list_services', { location_id: 'not-a-uuid' })),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('offers availability, books idempotently and never double books a slot', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const available = await run(
      request(seeded.tenantId, 'check_availability', {
        service_id: seeded.serviceId,
        date_from: '2030-01-08',
        max_results: 3,
      }),
    );
    expect(available['timezone']).toBe('Europe/Budapest');
    expect(slots(available).map((slot) => slot.local_start)).toEqual([
      '2030-01-08 08:00',
      '2030-01-08 08:15',
      '2030-01-08 08:30',
    ]);
    const first = slots(available)[0];
    if (first === undefined) {
      throw new Error('expected a slot');
    }
    const key = `call:${randomUUID()}`;
    const booked = await run(
      request(
        seeded.tenantId,
        'create_booking',
        { slot_id: first.slot_id, customer_name: 'Kiss Anna' },
        { idempotencyKey: key },
      ),
    );
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      local_start: '2030-01-08 08:00',
      calendar_sync: 'NOT_REQUIRED',
      replayed: false,
    });
    expect(booked['reference']).toMatch(/^[0-9A-F]{8}$/);
    const replay = await run(
      request(
        seeded.tenantId,
        'create_booking',
        { slot_id: first.slot_id, customer_name: 'Kiss Anna' },
        { idempotencyKey: key },
      ),
    );
    expect(replay).toMatchObject({ booking_id: booked['booking_id'], replayed: true });
    expect(
      await failureCode(
        run(
          request(seeded.tenantId, 'create_booking', {
            slot_id: first.slot_id,
            customer_name: 'Nagy Béla',
          }),
        ),
      ),
    ).toBe('BOOKING_SLOT_UNAVAILABLE');
    const after = await run(
      request(seeded.tenantId, 'check_availability', {
        service_id: seeded.serviceId,
        date_from: '2030-01-08',
        max_results: 1,
      }),
    );
    expect(slots(after).map((slot) => slot.local_start)).toEqual(['2030-01-08 08:45']);
  });

  it('lets exactly one of many concurrent requests take the same slot', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const available = await run(
      request(seeded.tenantId, 'check_availability', {
        service_id: seeded.serviceId,
        date_from: '2030-01-09',
        max_results: 1,
      }),
    );
    const slot = slots(available)[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        run(
          request(seeded.tenantId, 'create_booking', {
            slot_id: slot.slot_id,
            customer_name: `Caller ${String(index)}`,
          }),
        ),
      ),
    );
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(
      rejected.map((attempt) =>
        attempt.reason instanceof ToolExecutionError ? attempt.reason.code : String(attempt.reason),
      ),
    ).toEqual(Array.from({ length: 5 }, () => 'BOOKING_SLOT_UNAVAILABLE'));
    const count = await database().admin.query<{ count: string }>(
      `SELECT count(*) FROM app.resource_allocations WHERE resource_id = $1 AND is_active`,
      [seeded.resourceId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('finds bookings by reference, cancels them within the window and releases the slot', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const now = new Date('2030-01-10T06:30:00Z');
    const available = await run(
      request(
        seeded.tenantId,
        'check_availability',
        { service_id: seeded.serviceId, date_from: '2030-01-10', max_results: 1 },
        { now },
      ),
    );
    const slot = slots(available)[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    expect(slot.local_start).toBe('2030-01-10 08:00');
    const booked = await run(
      request(
        seeded.tenantId,
        'create_booking',
        { slot_id: slot.slot_id, customer_name: 'Tóth Éva' },
        { now },
      ),
    );
    const reference = String(booked['reference']);
    expect(await run(request(seeded.tenantId, 'find_booking', { reference }))).toMatchObject({
      booking_id: booked['booking_id'],
      status: 'CONFIRMED',
    });
    expect(
      await failureCode(run(request(seeded.tenantId, 'cancel_booking', { reference }, { now }))),
    ).toBe('INVALID_STATE_TRANSITION');
    const earlier = new Date('2030-01-09T12:00:00Z');
    const canceled = await run(
      request(
        seeded.tenantId,
        'cancel_booking',
        { reference, reason: 'caller request' },
        { now: earlier },
      ),
    );
    expect(canceled).toMatchObject({ status: 'CANCELED', replayed: false });
    expect(
      await run(
        request(
          seeded.tenantId,
          'cancel_booking',
          { booking_id: booked['booking_id'] },
          { now: earlier },
        ),
      ),
    ).toMatchObject({ status: 'CANCELED', replayed: true });
    const reopened = await run(
      request(
        seeded.tenantId,
        'check_availability',
        { service_id: seeded.serviceId, date_from: '2030-01-10', max_results: 1 },
        { now },
      ),
    );
    expect(slots(reopened).map((entry) => entry.local_start)).toEqual(['2030-01-10 08:00']);
  });

  it('validates arguments, rejects forged slot ids and hides other tenants', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const other = await seedBookableLocation(database().admin);
    expect(
      await failureCode(
        run(
          request(seeded.tenantId, 'check_availability', {
            service_id: seeded.serviceId,
            date_from: '2030-01-10',
            date_to: '2030-01-08',
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failureCode(
        run(
          request(seeded.tenantId, 'check_availability', {
            service_id: seeded.serviceId,
            date_from: '2030-01-10',
            unexpected: true,
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failureCode(
        run(
          request(seeded.tenantId, 'create_booking', {
            slot_id: 'bm90LWEtc2xvdC1pZA',
            customer_name: 'X',
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failureCode(
        run(
          request(seeded.tenantId, 'check_availability', {
            service_id: other.serviceId,
            date_from: '2030-01-10',
          }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await failureCode(run(request(seeded.tenantId, 'find_booking', {})))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await failureCode(run(request(seeded.tenantId, 'delete_everything', {})))).toBe(
      'TOOL_NOT_ALLOWED',
    );
  });
});
