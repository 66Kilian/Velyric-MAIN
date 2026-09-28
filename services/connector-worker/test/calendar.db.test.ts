import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalVaultTenantSecrets } from '@velyric/tenant-secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalendarConnector, type CalendarProvider } from '../src/connectors/calendar.js';
import { ToolExecutionError } from '../src/errors.js';
import { executeBookingTool, type ToolRequest } from '../src/tools/booking.js';
import { seedBookableLocation, seedTenant, useTestDatabase } from './support/db.js';
import { loopbackResolver, startFakeProvider, type FakeProvider } from './support/http.js';

const database = useTestDatabase();
const CALENDAR = 'dr.kiss@example.com';
const HOST = 'calendar.partner.test';
let provider: FakeProvider;
let vault: string;

beforeAll(async () => {
  provider = await startFakeProvider();
  vault = await mkdtemp(path.join(tmpdir(), 'velyric-vault-'));
});

afterAll(async () => {
  await provider.close();
  await rm(vault, { recursive: true, force: true });
});

async function seedCalendarLocation(kind: CalendarProvider, refreshToken: string) {
  const admin = database().admin;
  const tenantId = await seedTenant(admin);
  const relative = `tenants/${tenantId}/oauth/${kind}`;
  await mkdir(path.join(vault, path.dirname(relative)), { recursive: true });
  await writeFile(
    path.join(vault, `${relative}.secret`),
    JSON.stringify({ refresh_token: refreshToken }),
  );
  const secret = await admin.query<{ id: string }>(
    `INSERT INTO app.tenant_secret_refs (tenant_id, kind, provider, secret_ref, secret_version, status, activated_at)
     VALUES ($1, 'OAUTH_REFRESH_TOKEN', $2, $3, 1, 'ACTIVE', now()) RETURNING id`,
    [tenantId, kind, `local-vault://${relative}`],
  );
  const integration = await admin.query<{ id: string }>(
    `INSERT INTO app.integrations (tenant_id, integration_type, provider, display_name, status, secret_ref_id, external_account_ref)
     VALUES ($1, $2, $3, 'Naptár', 'CONNECTED', $4, 'clinic@example.com') RETURNING id`,
    [tenantId, kind === 'google' ? 'GOOGLE_CALENDAR' : 'MICROSOFT_365', kind, secret.rows[0]?.id],
  );
  const integrationId = integration.rows[0]?.id ?? '';
  const seeded = await seedBookableLocation(admin, {
    tenantId,
    calendarIntegrationId: integrationId,
    calendarRef: CALENDAR,
  });
  return { ...seeded, integrationId };
}

function connector(kind: CalendarProvider): CalendarConnector {
  const base = `http://${HOST}:${String(provider.port)}/${kind}`;
  return new CalendarConnector({
    provider: kind,
    config: {
      mode: 'simulator',
      apiBaseUrl: `${base}/api`,
      tokenUrl: `${base}/token`,
      client: { clientId: 'client-id', clientSecret: 'client-secret' },
      simulatorUpstreamHost: '127.0.0.1',
    },
    db: database().db,
    secrets: new LocalVaultTenantSecrets(vault),
    environment: 'ci',
    allowHttp: true,
    resolver: loopbackResolver,
  });
}

function request(tenantId: string, toolName: string, args: unknown): ToolRequest {
  return {
    tenantId,
    callId: null,
    toolName,
    arguments: args,
    idempotencyKey: `test:${randomUUID()}`,
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    now: new Date('2030-01-07T00:00:00Z'),
  };
}

describe('Google Calendar connector', () => {
  it('merges free/busy into availability, creates and deletes events idempotently with one token refresh', async () => {
    const seeded = await seedCalendarLocation('google', 'google-refresh');
    provider.requests.length = 0;
    provider.route((incoming) => {
      if (incoming.path === '/google/token') {
        return new URLSearchParams(incoming.body).get('refresh_token') === 'google-refresh'
          ? { status: 200, body: { access_token: 'ya29.test', expires_in: 3600 } }
          : undefined;
      }
      if (incoming.path === '/google/api/freeBusy') {
        return {
          status: 200,
          body: {
            calendars: {
              [CALENDAR]: {
                busy: [{ start: '2030-01-08T07:00:00Z', end: '2030-01-08T07:30:00Z' }],
              },
            },
          },
        };
      }
      if (
        incoming.method === 'POST' &&
        incoming.path === `/google/api/calendars/${encodeURIComponent(CALENDAR)}/events`
      ) {
        return { status: 200, body: { id: (JSON.parse(incoming.body) as { id: string }).id } };
      }
      if (
        incoming.method === 'DELETE' &&
        incoming.path.startsWith(`/google/api/calendars/${encodeURIComponent(CALENDAR)}/events/`)
      ) {
        return { status: 204 };
      }
      return undefined;
    });
    const google = connector('google');
    const available = await executeBookingTool(
      request(seeded.tenantId, 'lookup_availability', {
        service_id: seeded.serviceId,
        date_from: '2030-01-08',
        max_results: 1,
      }),
      {
        db: database().db,
        calendar: google,
      },
    );
    const [slot] = available.result['slots'] as { slot_id: string; local_start: string }[];
    expect(slot?.local_start).toBe('2030-01-08 08:30');
    const booked = await executeBookingTool(
      request(seeded.tenantId, 'create_booking', {
        slot_id: slot?.slot_id,
        customer_name: 'Kiss Anna',
        note: 'Első alkalom',
      }),
      {
        db: database().db,
        calendar: google,
      },
    );
    expect(booked.result).toMatchObject({ status: 'CONFIRMED', calendar_sync: 'SYNCED' });
    const bookingId = String(booked.result['booking_id']);
    const stored = await database().admin.query<{ external_event_ref: string }>(
      `SELECT external_event_ref FROM app.bookings WHERE id = $1`,
      [bookingId],
    );
    expect(stored.rows[0]?.external_event_ref).toBe(
      `google|${seeded.integrationId}|${CALENDAR}|velyric${bookingId.replaceAll('-', '')}`,
    );
    const eventRequest = provider.requests.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/events'),
    );
    expect(eventRequest?.headers['authorization']).toBe('Bearer ya29.test');
    expect(JSON.parse(eventRequest?.body ?? '{}')).toMatchObject({
      summary: 'Konzultáció – Kiss Anna',
      description: 'Első alkalom',
      start: { dateTime: '2030-01-08T07:30:00.000Z' },
    });
    const canceled = await executeBookingTool(
      request(seeded.tenantId, 'cancel_booking', { booking_id: bookingId }),
      { db: database().db, calendar: google },
    );
    expect(canceled.result).toMatchObject({ status: 'CANCELED', calendar_sync: 'SYNCED' });
    expect(provider.requests.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
    expect(provider.requests.filter((entry) => entry.path === '/google/token')).toHaveLength(1);
  });

  it('marks integrations as expired when the refresh token is revoked', async () => {
    const seeded = await seedCalendarLocation('google', 'revoked-refresh');
    provider.route((incoming) =>
      incoming.path === '/google/token' &&
      new URLSearchParams(incoming.body).get('refresh_token') === 'revoked-refresh'
        ? { status: 400, body: { error: 'invalid_grant' } }
        : undefined,
    );
    let code = '';
    try {
      await executeBookingTool(
        request(seeded.tenantId, 'check_availability', {
          service_id: seeded.serviceId,
          date_from: '2030-01-08',
        }),
        { db: database().db, calendar: connector('google') },
      );
    } catch (error) {
      code = error instanceof ToolExecutionError ? error.code : String(error);
    }
    expect(code).toBe('INTEGRATION_AUTH_EXPIRED');
    const status = await database().admin.query<{ status: string; last_error_code: string }>(
      `SELECT status, last_error_code FROM app.integrations WHERE id = $1`,
      [seeded.integrationId],
    );
    expect(status.rows[0]).toEqual({ status: 'AUTH_EXPIRED', last_error_code: 'invalid_grant' });
  });
});

describe('Microsoft 365 connector', () => {
  it('reads schedules in UTC and creates events with a transaction id', async () => {
    const seeded = await seedCalendarLocation('microsoft', 'ms-refresh');
    provider.requests.length = 0;
    provider.route((incoming) => {
      if (incoming.path === '/microsoft/token') {
        return { status: 200, body: { access_token: 'eyJ.ms', expires_in: 3600 } };
      }
      if (
        incoming.path ===
        `/microsoft/api/users/${encodeURIComponent(CALENDAR)}/calendar/getSchedule`
      ) {
        return {
          status: 200,
          body: {
            value: [
              {
                scheduleId: CALENDAR,
                scheduleItems: [
                  {
                    status: 'busy',
                    start: { dateTime: '2030-01-08T07:00:00.0000000', timeZone: 'UTC' },
                    end: { dateTime: '2030-01-08T07:30:00.0000000', timeZone: 'UTC' },
                  },
                  {
                    status: 'free',
                    start: { dateTime: '2030-01-08T08:00:00.0000000', timeZone: 'UTC' },
                    end: { dateTime: '2030-01-08T09:00:00.0000000', timeZone: 'UTC' },
                  },
                ],
              },
            ],
          },
        };
      }
      if (
        incoming.method === 'POST' &&
        incoming.path === `/microsoft/api/users/${encodeURIComponent(CALENDAR)}/events`
      ) {
        return { status: 201, body: { id: 'AAMkAGI2' } };
      }
      return undefined;
    });
    const microsoft = connector('microsoft');
    const available = await executeBookingTool(
      request(seeded.tenantId, 'lookup_availability', {
        service_id: seeded.serviceId,
        date_from: '2030-01-08',
        max_results: 2,
      }),
      {
        db: database().db,
        calendar: microsoft,
      },
    );
    const slots = available.result['slots'] as { slot_id: string; local_start: string }[];
    expect(slots.map((slot) => slot.local_start)).toEqual(['2030-01-08 08:30', '2030-01-08 08:45']);
    const booked = await executeBookingTool(
      request(seeded.tenantId, 'create_booking', {
        slot_id: slots[0]?.slot_id,
        customer_name: 'Nagy Béla',
      }),
      { db: database().db, calendar: microsoft },
    );
    expect(booked.result).toMatchObject({ calendar_sync: 'SYNCED' });
    const eventRequest = provider.requests.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/events'),
    );
    expect(JSON.parse(eventRequest?.body ?? '{}')).toMatchObject({
      subject: 'Konzultáció – Nagy Béla',
      start: { dateTime: '2030-01-08T07:30:00', timeZone: 'UTC' },
      transactionId: booked.result['booking_id'],
    });
    expect(eventRequest?.headers['prefer']).toBe('outlook.timezone="UTC"');
  });
});
