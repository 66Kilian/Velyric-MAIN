import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { CalendarListError } from '../src/integrations/calendar-list.js';
import { OAuthExchangeError } from '../src/integrations/oauth.js';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

interface Started {
  integration_id: string;
  authorization_url: string;
}

async function start(payload: Record<string, unknown>, seeded: SeededTenant = tenant) {
  return harness().app.inject({
    method: 'POST',
    url: '/v1/integrations/oauth/authorizations',
    headers: browserHeaders(seeded.owner, seeded.tenantId, {
      'idempotency-key': `oauth-${randomUUID()}`,
    }),
    payload,
  });
}

async function callback(user: TestUser, query: Record<string, string>) {
  return harness().app.inject({
    method: 'GET',
    url: `/v1/integrations/oauth/callback?${new URLSearchParams(query).toString()}`,
    headers: { cookie: `vly_session=${user.cookie}` },
  });
}

async function connectGoogleCalendar(seeded: SeededTenant): Promise<string> {
  const started = (await start({ integration_type: 'GOOGLE_CALENDAR' }, seeded)).json<Started>();
  const url = new URL(started.authorization_url);
  const state = url.searchParams.get('state') ?? '';
  const done = await callback(seeded.owner, { state, code: `auth-${randomUUID()}` });
  expect(done.statusCode, done.body).toBe(302);
  return started.integration_id;
}

describe('listing calendars for a connected integration', () => {
  it('returns the provider calendars using a refreshed access token', async () => {
    const seeded = await seedRuntimeTenant(harness());
    const integrationId = await connectGoogleCalendar(seeded);

    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/${integrationId}/calendars`,
      headers: browserHeaders(seeded.owner, seeded.tenantId),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { id: 'primary@example.test', name: 'primary@example.test', primary: true },
        { id: 'team@example.test', name: 'Team calendar', primary: false },
      ],
    });
  });

  it('returns 404 for an integration that is not a calendar provider', async () => {
    const seeded = await seedRuntimeTenant(harness());
    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/${randomUUID()}/calendars`,
      headers: browserHeaders(seeded.owner, seeded.tenantId),
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports INTEGRATION_AUTH_EXPIRED when the refresh token has been revoked', async () => {
    const seeded = await seedRuntimeTenant(harness());
    const integrationId = await connectGoogleCalendar(seeded);
    harness().oauth.respondToRefresh = () =>
      new OAuthExchangeError('invalid_grant', 'refresh token revoked');

    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/${integrationId}/calendars`,
      headers: browserHeaders(seeded.owner, seeded.tenantId),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'INTEGRATION_AUTH_EXPIRED' });
    harness().oauth.respondToRefresh = () => ({
      accessToken: 'fake-access-token',
      expiresInSeconds: 3_600,
    });
  });

  it('reports PROVIDER_UNAVAILABLE when the calendar API call fails', async () => {
    const seeded = await seedRuntimeTenant(harness());
    const integrationId = await connectGoogleCalendar(seeded);
    harness().calendarLister.respond = () =>
      new CalendarListError('unreachable', 'calendar provider is unreachable');

    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/${integrationId}/calendars`,
      headers: browserHeaders(seeded.owner, seeded.tenantId),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
