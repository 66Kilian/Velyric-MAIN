import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeBookingTool, type ToolRequest } from '../src/tools/booking.js';
import { seedBookableLocation, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

function request(tenantId: string, toolName: string, args: unknown): ToolRequest {
  return {
    tenantId,
    callId: null,
    toolName,
    arguments: args,
    idempotencyKey: `test:${randomUUID()}`,
    traceId: TRACE,
    now: new Date('2030-01-07T00:00:00Z'),
  };
}

async function run(toolRequest: ToolRequest): Promise<Record<string, unknown>> {
  const outcome = await executeBookingTool(toolRequest, { db: database().db, calendar: null });
  return outcome.result;
}

async function slotIds(tenantId: string, serviceId: string): Promise<string[]> {
  const available = await run(
    request(tenantId, 'check_availability', {
      service_id: serviceId,
      date_from: '2030-01-08',
      max_results: 4,
    }),
  );
  return (available['slots'] as { slot_id: string }[]).map((slot) => slot.slot_id);
}

async function events(
  tenantId: string,
): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
  const result = await database().admin.query<{
    event_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_type, payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type LIKE 'booking.%' ORDER BY created_at, id`,
    [tenantId],
  );
  return result.rows;
}

describe('guest details and booking events', () => {
  it('stores the guest contact on the booking and announces the booking once', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const [first] = await slotIds(seeded.tenantId, seeded.serviceId);
    const toolRequest = request(seeded.tenantId, 'create_booking', {
      slot_id: first,
      customer_name: 'Kiss Anna',
      customer_email: 'Anna.Kiss@Example.test',
      customer_phone: '+36301234567',
    });
    const booked = await run(toolRequest);
    await run(toolRequest);

    const guest = await database().admin.query<{
      display_name: string;
      identities: string[];
    }>(
      `SELECT p.display_name,
              array_agg(i.identity_type || ':' || i.normalized_value ORDER BY i.identity_type) AS identities
         FROM app.bookings b
         JOIN app.caller_profiles p ON p.id = b.person_id
         JOIN app.person_identities i ON i.person_id = p.id
        WHERE b.id = $1
        GROUP BY p.display_name`,
      [booked['booking_id']],
    );
    expect(guest.rows[0]).toEqual({
      display_name: 'Kiss Anna',
      identities: ['EMAIL:anna.kiss@example.test', 'PHONE:+36301234567'],
    });
    const created = await events(seeded.tenantId);
    expect(created.map((event) => event.event_type)).toEqual(['booking.created']);
    expect(created[0]?.payload).toMatchObject({ booking_id: booked['booking_id'], party_size: 1 });

    const again = await run(
      request(seeded.tenantId, 'create_booking', {
        slot_id: (await slotIds(seeded.tenantId, seeded.serviceId))[0],
        customer_name: 'Kiss Anna',
        customer_email: 'anna.kiss@example.test',
      }),
    );
    const people = await database().admin.query<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM app.bookings WHERE id = ANY($1::uuid[])`,
      [[booked['booking_id'], again['booking_id']]],
    );
    expect(people.rows).toHaveLength(1);
  });

  it('moves a booking to a new slot as one change and announces cancellations', async () => {
    const seeded = await seedBookableLocation(database().admin);
    const [first, , third] = await slotIds(seeded.tenantId, seeded.serviceId);
    const booked = await run(
      request(seeded.tenantId, 'create_booking', {
        slot_id: first,
        customer_name: 'Nagy Péter',
        customer_email: 'peter@example.test',
      }),
    );
    const moveRequest = request(seeded.tenantId, 'reschedule_booking', {
      reference: booked['reference'],
      slot_id: third,
    });
    const moved = await run(moveRequest);
    expect(moved).toMatchObject({
      status: 'CONFIRMED',
      local_start: '2030-01-08 08:30',
      party_size: 1,
      previous_booking_id: booked['booking_id'],
      previous_local_start: '2030-01-08 08:00',
    });
    expect(await run(moveRequest)).toMatchObject({
      booking_id: moved['booking_id'],
      replayed: true,
    });

    const rows = await database().admin.query<{
      id: string;
      status: string;
      cancellation_reason: string | null;
      rescheduled_from_booking_id: string | null;
      person_id: string;
    }>(
      `SELECT id, status, cancellation_reason, rescheduled_from_booking_id, person_id FROM app.bookings WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[booked['booking_id'], moved['booking_id']]],
    );
    expect(rows.rows.map((row) => [row.status, row.cancellation_reason])).toEqual([
      ['CANCELED', 'RESCHEDULED'],
      ['CONFIRMED', null],
    ]);
    expect(rows.rows[1]?.rescheduled_from_booking_id).toBe(booked['booking_id']);
    expect(rows.rows[1]?.person_id).toBe(rows.rows[0]?.person_id);

    await run(request(seeded.tenantId, 'cancel_booking', { booking_id: moved['booking_id'] }));
    expect((await events(seeded.tenantId)).map((event) => event.event_type)).toEqual([
      'booking.created',
      'booking.changed',
      'booking.canceled',
    ]);
    const changed = (await events(seeded.tenantId))[1];
    expect(changed?.payload).toMatchObject({
      booking_id: moved['booking_id'],
      previous_booking_id: booked['booking_id'],
      changed_by: 'VOICE_AGENT',
    });
  });
});
