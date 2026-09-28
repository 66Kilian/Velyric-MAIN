import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGuestNotificationActivities } from '../src/activities/guest-notifications.js';
import { createNotificationActivity } from '../src/activities/notifications.js';
import { seedTenant, testDependencies, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const NOW = new Date('2030-01-07T08:00:00Z');

interface Seeded {
  readonly tenantId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly personId: string;
  readonly bookingId: string;
  readonly businessPhone: string;
}

async function seed(options: {
  readonly sms: boolean;
  readonly phoneNumber: boolean;
}): Promise<Seeded> {
  const admin = database().admin;
  const tenantId = await seedTenant(admin, { locale: 'hu' });
  const businessPhone = `+3612${String(Math.floor(100_000 + Math.random() * 899_999))}`;
  const one = async <T>(text: string, values: unknown[]): Promise<T> => {
    const result = await admin.query(text, values);
    return result.rows[0] as T;
  };
  const location = await one<{ id: string }>(
    `INSERT INTO app.locations (tenant_id, name, country, timezone, address) VALUES ($1, 'Belváros', 'HU', 'Europe/Budapest', '{"line1":"Váci utca 1.","city":"Budapest","postal_code":"1052"}') RETURNING id`,
    [tenantId],
  );
  const service = await one<{ id: string }>(
    `INSERT INTO app.services (tenant_id, location_id, name, duration_minutes, required_resource_types) VALUES ($1, $2, 'Vacsora', 90, ARRAY['TABLE']) RETURNING id`,
    [tenantId, location.id],
  );
  const person = await one<{ id: string }>(
    `INSERT INTO app.caller_profiles (tenant_id, display_name, preferred_language) VALUES ($1, 'Kovács Anna', 'hu') RETURNING id`,
    [tenantId],
  );
  for (const [type, value, state] of [
    ['EMAIL', 'anna@example.test', 'CALLER_PROVIDED'],
    ['PHONE', '+36301112233', 'OBSERVED'],
  ] as const) {
    await admin.query(
      `INSERT INTO app.person_identities (tenant_id, person_id, identity_type, normalized_value, value_hash, verification_state, source, confidence)
       VALUES ($1, $2, $3, $4, sha256(convert_to($4, 'UTF8')), $5, 'BOOKING', 0.8)`,
      [tenantId, person.id, type, value, state],
    );
  }
  const booking = await one<{ id: string }>(
    `INSERT INTO app.bookings (tenant_id, location_id, service_id, person_id, starts_at, ends_at, timezone, party_size, source, status, idempotency_key)
     VALUES ($1, $2, $3, $4, '2030-01-08T18:00:00Z', '2030-01-08T19:30:00Z', 'Europe/Budapest', 4, 'VOICE_AGENT', 'CONFIRMED', $5) RETURNING id`,
    [tenantId, location.id, service.id, person.id, `seed:${randomUUID()}`],
  );
  if (options.sms) {
    await admin.query(
      `INSERT INTO app.tenant_messaging_settings (tenant_id, sms_enabled) VALUES ($1, true)`,
      [tenantId],
    );
  }
  if (options.phoneNumber) {
    await admin.query(
      `INSERT INTO app.phone_numbers (tenant_id, location_id, provider, e164, country, number_type, status) VALUES ($1, $2, 'telnyx', $3, 'HU', 'LOCAL', 'ACTIVE')`,
      [tenantId, location.id, businessPhone],
    );
  }
  return {
    tenantId,
    locationId: location.id,
    serviceId: service.id,
    personId: person.id,
    bookingId: booking.id,
    businessPhone,
  };
}

describe('guest notifications from booking events', () => {
  it('plans an email and an SMS with the real booking details and texts the guest', async () => {
    const seeded = await seed({ sms: true, phoneNumber: true });
    const { deps, providers } = testDependencies(database(), NOW);
    const activities = createGuestNotificationActivities(deps);
    const planned = await activities.guestNotifications({
      tenantId: seeded.tenantId,
      eventType: 'booking.created',
      bookingId: seeded.bookingId,
      eventId: randomUUID(),
      traceId: TRACE,
    });
    expect(planned.map((entry) => [entry.type, entry.channel])).toEqual([
      ['CALLER_BOOKING_CONFIRMATION', 'EMAIL'],
      ['CALLER_BOOKING_CONFIRMATION', 'SMS'],
    ]);
    expect(planned[0]?.payload).toMatchObject({
      locale: 'hu',
      caller_email: 'anna@example.test',
      caller_name: 'Kovács Anna',
      service_name: 'Vacsora',
      booking_date: '2030. január 8., kedd',
      booking_time: '19:00',
      party_size: '4',
      location_name: 'Belváros',
      location_address: '1052 Budapest, Váci utca 1.',
      business_phone: seeded.businessPhone,
      booking_reference: seeded.bookingId.replaceAll('-', '').slice(-8).toUpperCase(),
    });
    expect(planned[1]?.payload['caller_phone']).toBe('+36301112233');

    const notify = createNotificationActivity(deps);
    const sms = planned[1];
    if (sms === undefined) {
      throw new Error('expected an SMS');
    }
    expect(await notify(sms)).toEqual({ status: 'SENT' });
    expect(await notify(sms)).toEqual({ status: 'ALREADY_SENT' });
    expect(providers.carrier.messages).toHaveLength(1);
    expect(providers.carrier.messages[0]).toMatchObject({
      from: seeded.businessPhone,
      to: '+36301112233',
    });
    expect(providers.carrier.messages[0]?.text).toContain('2030. január 8., kedd 19:00, 4 főre');
  });

  it('keeps SMS off unless the workspace enabled it and has its own number', async () => {
    const withoutSms = await seed({ sms: false, phoneNumber: true });
    const { deps, providers } = testDependencies(database(), NOW);
    const activities = createGuestNotificationActivities(deps);
    const planned = await activities.guestNotifications({
      tenantId: withoutSms.tenantId,
      eventType: 'booking.created',
      bookingId: withoutSms.bookingId,
      eventId: randomUUID(),
      traceId: TRACE,
    });
    expect(planned.map((entry) => entry.channel)).toEqual(['EMAIL']);

    const withoutNumber = await seed({ sms: true, phoneNumber: false });
    const notify = createNotificationActivity(deps);
    expect(
      await notify({
        tenantId: withoutNumber.tenantId,
        type: 'CALLER_BOOKING_CONFIRMATION',
        channel: 'SMS',
        dedupeKey: `sms:${randomUUID()}`,
        payload: { caller_phone: '+36301112233', locale: 'hu' },
        traceId: TRACE,
      }),
    ).toEqual({ status: 'SUPPRESSED' });
    expect(providers.carrier.messages).toHaveLength(0);

    expect(
      await activities.guestNotifications({
        tenantId: withoutSms.tenantId,
        eventType: 'booking.canceled',
        bookingId: withoutSms.bookingId,
        eventId: randomUUID(),
        traceId: TRACE,
      }),
    ).toEqual([]);
  });

  it('offers a released slot to the first matching waitlist guest exactly once', async () => {
    const seeded = await seed({ sms: false, phoneNumber: true });
    const admin = database().admin;
    const waiting = await admin.query<{ id: string }>(
      `INSERT INTO app.caller_profiles (tenant_id, display_name, preferred_language) VALUES ($1, 'Szabó Béla', 'en') RETURNING id`,
      [seeded.tenantId],
    );
    const waitingId = waiting.rows[0]?.id ?? '';
    await admin.query(
      `INSERT INTO app.person_identities (tenant_id, person_id, identity_type, normalized_value, value_hash, verification_state, source, confidence)
       VALUES ($1, $2, 'EMAIL', 'bela@example.test', sha256(convert_to('bela@example.test', 'UTF8')), 'CALLER_PROVIDED', 'WAITLIST', 0.8)`,
      [seeded.tenantId, waitingId],
    );
    const entry = await admin.query<{ id: string }>(
      `INSERT INTO app.waitlist_entries (tenant_id, location_id, service_id, person_id, desired_window, party_size, contact_channel, contact_consent, expires_at)
       VALUES ($1, $2, $3, $4, tstzrange('2030-01-08T16:00:00Z', '2030-01-08T21:00:00Z'), 2, 'EMAIL', true, '2030-01-09T00:00:00Z') RETURNING id`,
      [seeded.tenantId, seeded.locationId, seeded.serviceId, waitingId],
    );
    await admin.query(
      `INSERT INTO app.waitlist_entries (tenant_id, location_id, service_id, person_id, desired_window, party_size, contact_channel, contact_consent, expires_at)
       VALUES ($1, $2, $3, $4, tstzrange('2030-01-08T16:00:00Z', '2030-01-08T21:00:00Z'), 6, 'EMAIL', true, '2030-01-09T00:00:00Z')`,
      [seeded.tenantId, seeded.locationId, seeded.serviceId, waitingId],
    );
    await admin.query(
      `UPDATE app.bookings SET status = 'CANCELED', canceled_at = now() WHERE id = $1`,
      [seeded.bookingId],
    );

    const { deps } = testDependencies(database(), NOW);
    const activities = createGuestNotificationActivities(deps);
    const input = {
      tenantId: seeded.tenantId,
      eventType: 'booking.canceled' as const,
      bookingId: seeded.bookingId,
      eventId: randomUUID(),
      traceId: TRACE,
    };
    const offers = await activities.offerReleasedSlot(input);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      type: 'CALLER_WAITLIST_OFFER',
      channel: 'EMAIL',
      payload: {
        locale: 'en',
        caller_email: 'bela@example.test',
        caller_name: 'Szabó Béla',
        party_size: '2',
        booking_date: 'Tuesday, 8 January 2030',
        booking_time: '19:00',
      },
    });
    const again = await activities.offerReleasedSlot(input);
    expect(again.map((entry) => entry.dedupeKey)).toEqual(offers.map((entry) => entry.dedupeKey));

    const state = await admin.query<{
      status: string;
      attempts: number;
      offers: number;
      events: number;
    }>(
      `SELECT e.status, e.contact_attempts AS attempts,
              (SELECT count(*)::int FROM app.waitlist_offers o WHERE o.entry_id = e.id) AS offers,
              (SELECT count(*)::int FROM app.outbox_events x WHERE x.tenant_id = e.tenant_id AND x.event_type = 'waitlist.slot_released') AS events
         FROM app.waitlist_entries e WHERE e.id = $1`,
      [entry.rows[0]?.id],
    );
    expect(state.rows[0]).toEqual({ status: 'OFFERED', attempts: 1, offers: 1, events: 1 });
  });
});
