import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let other: SeededTenant;

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  other = await seedRuntimeTenant(harness());
});

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

function headers(
  extra: Record<string, string> = {},
  seeded: SeededTenant = tenant,
): Record<string, string> {
  return browserHeaders(seeded.owner, seeded.tenantId, extra);
}

function writeHeaders(
  extra: Record<string, string> = {},
  seeded: SeededTenant = tenant,
): Record<string, string> {
  return headers({ 'idempotency-key': `sched-${randomUUID()}`, ...extra }, seeded);
}

async function createService(
  seeded: SeededTenant = tenant,
  overrides: Record<string, unknown> = {},
) {
  return harness().app.inject({
    method: 'POST',
    url: '/v1/services',
    headers: writeHeaders({}, seeded),
    payload: {
      location_id: seeded.locationId,
      name: `Konzultáció ${randomUUID().slice(0, 6)}`,
      duration_minutes: 30,
      buffer_after_minutes: 10,
      required_resource_types: ['DOCTOR'],
      cancellation_window_minutes: 60,
      ...overrides,
    },
  });
}

async function createResource(
  seeded: SeededTenant = tenant,
  overrides: Record<string, unknown> = {},
) {
  return harness().app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: writeHeaders({}, seeded),
    payload: {
      location_id: seeded.locationId,
      name: `Dr. ${randomUUID().slice(0, 6)}`,
      resource_type: 'DOCTOR',
      ...overrides,
    },
  });
}

describe('services and resources', () => {
  it('creates, lists, reads and updates services with optimistic concurrency', async () => {
    const created = await createService();
    expect(created.statusCode, created.body).toBe(201);
    const service = created.json<{
      id: string;
      version: number;
      required_resource_types: string[];
      cancellation_window_minutes: number;
    }>();
    expect(service).toMatchObject({
      required_resource_types: ['DOCTOR'],
      cancellation_window_minutes: 60,
      version: 1,
    });
    expect(created.headers['etag']).toBe('W/"1"');

    const list = await harness().app.inject({
      method: 'GET',
      url: `/v1/services?location_id=${tenant.locationId}`,
      headers: headers(),
    });
    expect(list.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toContain(service.id);

    const stale = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/services/${service.id}`,
      headers: headers({ 'if-match': 'W/"7"' }),
      payload: { duration_minutes: 45 },
    });
    expect(stale.json<Envelope>()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { current_version: 1 },
    });
    const updated = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/services/${service.id}`,
      headers: headers({ 'if-match': 'W/"1"' }),
      payload: { duration_minutes: 45, active: false },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ duration_minutes: 45, active: false, version: 2 });

    const invalidParty = await createService(tenant, { min_party_size: 4, max_party_size: 2 });
    expect(invalidParty.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const priceWithoutCurrency = await createService(tenant, { price_minor: 1_000_000 });
    expect(priceWithoutCurrency.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const foreignLocation = await createService(tenant, { location_id: other.locationId });
    expect(foreignLocation.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps tenants isolated and replays idempotent creates', async () => {
    const key = `sched-${randomUUID()}`;
    const payload = {
      location_id: tenant.locationId,
      name: 'Rendelő 3',
      resource_type: 'ROOM',
      parallel_slots: 2,
    };
    const first = await harness().app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: headers({ 'idempotency-key': key }),
      payload,
    });
    const replay = await harness().app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: headers({ 'idempotency-key': key }),
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const resourceId = first.json<{ id: string }>().id;
    const foreign = await harness().app.inject({
      method: 'GET',
      url: `/v1/resources/${resourceId}/availability-rules`,
      headers: headers({}, other),
    });
    expect(foreign.statusCode).toBe(404);
    const otherList = await harness().app.inject({
      method: 'GET',
      url: '/v1/resources',
      headers: headers({}, other),
    });
    expect(otherList.json<{ data: { id: string }[] }>().data.map((row) => row.id)).not.toContain(
      resourceId,
    );
    const halfLinked = await createResource(tenant, { external_calendar_ref: 'dr@example.com' });
    expect(halfLinked.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('availability and bookings', () => {
  it('replaces weekly rules atomically and validates them', async () => {
    const resource = (await createResource()).json<{ id: string; version: number }>();
    const url = `/v1/resources/${resource.id}/availability-rules`;
    const replaced = await harness().app.inject({
      method: 'PUT',
      url,
      headers: writeHeaders({ 'if-match': `W/"${String(resource.version)}"` }),
      payload: {
        timezone: 'Europe/Budapest',
        rules: [
          { iso_weekday: 1, start_local: '08:00', end_local: '12:00' },
          { iso_weekday: 3, start_local: '13:00', end_local: '17:30' },
        ],
      },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.headers['etag']).toBe('W/"2"');
    const read = await harness().app.inject({ method: 'GET', url, headers: headers() });
    expect(read.json()).toEqual({
      resource_id: resource.id,
      rules: [
        expect.objectContaining({
          iso_weekday: 1,
          start_local: '08:00',
          end_local: '12:00',
          timezone: 'Europe/Budapest',
        }),
        expect.objectContaining({ iso_weekday: 3, start_local: '13:00', end_local: '17:30' }),
      ],
    });
    const inverted = await harness().app.inject({
      method: 'PUT',
      url,
      headers: writeHeaders({ 'if-match': 'W/"2"' }),
      payload: {
        timezone: 'Europe/Budapest',
        rules: [{ iso_weekday: 2, start_local: '12:00', end_local: '08:00' }],
      },
    });
    expect(inverted.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const badZone = await harness().app.inject({
      method: 'PUT',
      url,
      headers: writeHeaders({ 'if-match': 'W/"2"' }),
      payload: { timezone: 'Mars/Olympus', rules: [] },
    });
    expect(badZone.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const cleared = await harness().app.inject({
      method: 'PUT',
      url,
      headers: writeHeaders({ 'if-match': 'W/"2"' }),
      payload: { timezone: 'Europe/Budapest', rules: [] },
    });
    expect(cleared.json()).toEqual({ resource_id: resource.id, rules: [] });
  });

  it('records closures and lists them inside a window', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/availability-exceptions',
      headers: writeHeaders(),
      payload: {
        location_id: tenant.locationId,
        exception_kind: 'CLOSED',
        starts_at: '2030-12-24T00:00:00+01:00',
        ends_at: '2030-12-27T00:00:00+01:00',
        reason: 'Ünnepek',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const list = await harness().app.inject({
      method: 'GET',
      url: `/v1/availability-exceptions?location_id=${tenant.locationId}&from=2030-12-01T00:00:00Z&to=2031-01-01T00:00:00Z`,
      headers: headers(),
    });
    expect(list.json<{ data: { starts_at: string; reason: string }[] }>().data).toEqual([
      expect.objectContaining({ starts_at: '2030-12-23T23:00:00.000Z', reason: 'Ünnepek' }),
    ]);
    const inverted = await harness().app.inject({
      method: 'POST',
      url: '/v1/availability-exceptions',
      headers: writeHeaders(),
      payload: {
        location_id: tenant.locationId,
        exception_kind: 'CLOSED',
        starts_at: '2030-12-27T00:00:00Z',
        ends_at: '2030-12-24T00:00:00Z',
      },
    });
    expect(inverted.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const exceptionId = created.json<{ id: string }>().id;
    expect(
      (
        await harness().app.inject({
          method: 'DELETE',
          url: `/v1/availability-exceptions/${exceptionId}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(204);
  });

  it('lists bookings and cancels them from the dashboard, releasing the allocation and emitting an event', async () => {
    const service = (await createService()).json<{ id: string }>();
    const resource = (await createResource()).json<{ id: string }>();
    const bookingId = randomUUID();
    await harness().admin.query(
      `INSERT INTO app.bookings (id, tenant_id, location_id, service_id, starts_at, ends_at, timezone, source, status, idempotency_key)
       VALUES ($1, $2, $3, $4, '2030-03-04T08:00:00Z', '2030-03-04T08:30:00Z', 'Europe/Budapest', 'VOICE_AGENT', 'CONFIRMED', $5)`,
      [bookingId, tenant.tenantId, tenant.locationId, service.id, `voice:${randomUUID()}`],
    );
    await harness().admin.query(
      `INSERT INTO app.resource_allocations (tenant_id, resource_id, slot_index, during, booking_id) VALUES ($1, $2, 0, tstzrange('2030-03-04T08:00:00Z', '2030-03-04T08:40:00Z', '[)'), $3)`,
      [tenant.tenantId, resource.id, bookingId],
    );
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/bookings?from=2030-03-01T00:00:00Z&to=2030-03-31T00:00:00Z&status=CONFIRMED',
      headers: headers(),
    });
    expect(list.json<{ data: { id: string; reference: string }[] }>().data).toEqual([
      expect.objectContaining({
        id: bookingId,
        reference: bookingId.replaceAll('-', '').slice(-8).toUpperCase(),
      }),
    ]);

    const canceled = await harness().app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: writeHeaders(),
      payload: { reason: 'A páciens lemondta' },
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json()).toMatchObject({
      status: 'CANCELED',
      cancellation_reason: 'A páciens lemondta',
      version: 2,
    });
    const again = await harness().app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: writeHeaders(),
      payload: { reason: 'dupla' },
    });
    expect(again.json()).toMatchObject({
      status: 'CANCELED',
      cancellation_reason: 'A páciens lemondta',
    });
    const allocation = await harness().admin.query<{ is_active: boolean }>(
      `SELECT is_active FROM app.resource_allocations WHERE booking_id = $1`,
      [bookingId],
    );
    expect(allocation.rows).toEqual([{ is_active: false }]);
    const events = await harness().admin.query<{
      event_type: string;
      payload: { booking_id: string };
    }>(
      `SELECT event_type, payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'booking.canceled'`,
      [tenant.tenantId],
    );
    expect(events.rows.map((row) => row.payload.booking_id)).toContain(bookingId);
    const foreign = await harness().app.inject({
      method: 'GET',
      url: `/v1/bookings/${bookingId}`,
      headers: headers({}, other),
    });
    expect(foreign.statusCode).toBe(404);
  });
});
