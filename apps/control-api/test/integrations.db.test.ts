import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuthExchangeError } from '../src/integrations/oauth.js';
import {
  browserHeaders,
  OAUTH_SIMULATOR,
  TEST_API_ORIGIN,
  TEST_ORIGIN,
  useApiHarness,
  type TestUser,
} from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

interface Started {
  integration_id: string;
  authorization_url: string;
  expires_at: string;
}

function sessionHeaders(user: TestUser): Record<string, string> {
  return { cookie: `vly_session=${user.cookie}` };
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
    headers: sessionHeaders(user),
  });
}

async function freshTenant(): Promise<SeededTenant> {
  return seedRuntimeTenant(harness());
}

describe('calendar OAuth connection', () => {
  it('returns to the setup wizard when the authorization was started from it', async () => {
    const seeded = await freshTenant();
    const started = await start({ integration_type: 'MICROSOFT_365', return_to: 'setup' }, seeded);
    expect(started.statusCode, started.body).toBe(201);
    const body = started.json<Started>();
    const state = new URL(body.authorization_url).searchParams.get('state') ?? '';
    const done = await callback(seeded.owner, { state, code: 'auth-code-setup' });
    expect(done.statusCode, done.body).toBe(302);
    expect(done.headers.location).toBe(
      `${TEST_ORIGIN}/app/setup/${seeded.tenantId}?step=bookings&integration_id=${body.integration_id}&status=connected`,
    );
  });

  it('connects with PKCE, stores the refresh token only in the vault and redirects to the dashboard', async () => {
    const seeded = await freshTenant();
    const started = await start(
      { integration_type: 'GOOGLE_CALENDAR', display_name: 'Rendelői naptár' },
      seeded,
    );
    expect(started.statusCode, started.body).toBe(201);
    const body = started.json<Started>();
    const url = new URL(body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${OAUTH_SIMULATOR}/google/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'google-test-client',
      redirect_uri: `${TEST_API_ORIGIN}/v1/integrations/oauth/callback`,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    const state = url.searchParams.get('state') ?? '';
    const done = await callback(seeded.owner, { state, code: 'auth-code-1', scope: 'email' });
    expect(done.statusCode, done.body).toBe(302);
    expect(done.headers.location).toBe(
      `${TEST_ORIGIN}/app/${seeded.tenantId}/integrations?integration_id=${body.integration_id}&status=connected`,
    );

    const exchange = harness().oauth.exchanges.at(-1);
    expect(exchange).toMatchObject({
      provider: 'google',
      code: 'auth-code-1',
      redirectUri: `${TEST_API_ORIGIN}/v1/integrations/oauth/callback`,
    });
    expect(
      createHash('sha256')
        .update(exchange?.codeVerifier ?? '', 'ascii')
        .digest('base64url'),
    ).toBe(url.searchParams.get('code_challenge'));

    const integration = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/${body.integration_id}`,
      headers: browserHeaders(seeded.owner, seeded.tenantId),
    });
    expect(integration.json()).toMatchObject({
      status: 'CONNECTED',
      provider: 'google',
      display_name: 'Rendelői naptár',
      external_account_ref: 'clinic@example.com',
      last_error_code: null,
    });
    expect(integration.body).not.toContain('refresh-auth-code-1');
    const refs = await harness().admin.query<{
      secret_ref: string;
      status: string;
      secret_version: number;
    }>(
      `SELECT secret_ref, status, secret_version FROM app.tenant_secret_refs WHERE tenant_id = $1 AND kind = 'OAUTH_REFRESH_TOKEN'`,
      [seeded.tenantId],
    );
    expect(refs.rows).toHaveLength(1);
    expect(refs.rows[0]).toMatchObject({ status: 'ACTIVE', secret_version: 1 });
    const secretRef = refs.rows[0]?.secret_ref ?? '';
    expect(secretRef).toMatch(
      new RegExp(`^local-vault://tenants/${seeded.tenantId}/oauth_refresh_token/[0-9a-f-]{36}/v1$`),
    );
    const stored = JSON.parse(
      await readFile(
        path.join(harness().vaultDir, `${secretRef.slice('local-vault://'.length)}.secret`),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      refresh_token: 'refresh-auth-code-1',
      account: 'clinic@example.com',
    });
    const leaked = await harness().admin.query(
      `SELECT 1 FROM app.integrations WHERE config::text LIKE '%refresh-auth-code-1%' OR external_account_ref LIKE '%refresh%'`,
    );
    expect(leaked.rowCount).toBe(0);

    const replay = await callback(seeded.owner, { state, code: 'auth-code-1' });
    expect(replay.json<Envelope>()).toMatchObject({ code: 'OAUTH_STATE_INVALID' });

    const duplicate = await start({ integration_type: 'GOOGLE_CALENDAR' }, seeded);
    expect(duplicate.json<Envelope>()).toMatchObject({
      code: 'CONFLICT',
      details: { integration_id: body.integration_id },
    });
  });

  it('rotates the refresh token when an integration is reconnected and revokes it on disconnect', async () => {
    const seeded = await freshTenant();
    const first = (await start({ integration_type: 'MICROSOFT_365' }, seeded)).json<Started>();
    await callback(seeded.owner, {
      state: new URL(first.authorization_url).searchParams.get('state') ?? '',
      code: 'first',
    });
    const again = await start(
      { integration_type: 'MICROSOFT_365', integration_id: first.integration_id },
      seeded,
    );
    expect(again.statusCode, again.body).toBe(201);
    const second = again.json<Started>();
    expect(new URL(second.authorization_url).pathname).toBe('/microsoft/authorize');
    const reconnected = await callback(seeded.owner, {
      state: new URL(second.authorization_url).searchParams.get('state') ?? '',
      code: 'second',
    });
    expect(reconnected.statusCode).toBe(302);
    const refs = await harness().admin.query<{
      status: string;
      secret_version: number;
      secret_ref: string;
    }>(
      `SELECT status, secret_version, secret_ref FROM app.tenant_secret_refs WHERE tenant_id = $1 ORDER BY secret_version`,
      [seeded.tenantId],
    );
    expect(refs.rows.map((row) => [row.secret_version, row.status])).toEqual([
      [1, 'REVOKED'],
      [2, 'ACTIVE'],
    ]);
    const oldFile = path.join(
      harness().vaultDir,
      `${(refs.rows[0]?.secret_ref ?? '').slice('local-vault://'.length)}.secret`,
    );
    await vi.waitFor(async () => {
      await expect(readFile(oldFile, 'utf8')).rejects.toThrow();
    });

    const resource = await harness().app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: browserHeaders(seeded.owner, seeded.tenantId, {
        'idempotency-key': `res-${randomUUID()}`,
      }),
      payload: {
        location_id: seeded.locationId,
        name: 'Dr. Naptár',
        resource_type: 'DOCTOR',
        calendar_integration_id: first.integration_id,
        external_calendar_ref: 'dr@example.com',
      },
    });
    expect(resource.statusCode, resource.body).toBe(201);

    const disconnected = await harness().app.inject({
      method: 'POST',
      url: `/v1/integrations/${first.integration_id}/disconnect`,
      headers: browserHeaders(seeded.owner, seeded.tenantId, {
        'idempotency-key': `disc-${randomUUID()}`,
      }),
    });
    expect(disconnected.statusCode, disconnected.body).toBe(200);
    expect(disconnected.json()).toMatchObject({ status: 'DISCONNECTED' });
    const after = await harness().admin.query<{ status: string }>(
      `SELECT status FROM app.tenant_secret_refs WHERE tenant_id = $1 AND secret_version = 2`,
      [seeded.tenantId],
    );
    expect(after.rows[0]?.status).toBe('REVOKED');
    const unlinked = await harness().admin.query<{ calendar_integration_id: string | null }>(
      `SELECT calendar_integration_id FROM app.resources WHERE id = $1`,
      [resource.json<{ id: string }>().id],
    );
    expect(unlinked.rows[0]?.calendar_integration_id).toBeNull();
  });

  it('records provider denials and exchange failures without storing secrets', async () => {
    const seeded = await freshTenant();
    const denied = (await start({ integration_type: 'GOOGLE_CALENDAR' }, seeded)).json<Started>();
    const deniedRedirect = await callback(seeded.owner, {
      state: new URL(denied.authorization_url).searchParams.get('state') ?? '',
      error: 'access_denied',
    });
    expect(deniedRedirect.headers.location).toBe(
      `${TEST_ORIGIN}/app/${seeded.tenantId}/integrations?integration_id=${denied.integration_id}&status=denied&error=access_denied`,
    );
    const failing = (await start({ integration_type: 'GOOGLE_CALENDAR' }, seeded)).json<Started>();
    expect(failing.integration_id).toBe(denied.integration_id);
    harness().oauth.respond = () => new OAuthExchangeError('invalid_grant', 'bad code');
    try {
      const failedRedirect = await callback(seeded.owner, {
        state: new URL(failing.authorization_url).searchParams.get('state') ?? '',
        code: 'expired',
      });
      expect(failedRedirect.headers.location).toContain('status=failed&error=invalid_grant');
    } finally {
      harness().oauth.respond = (input) => ({
        refreshToken: `refresh-${input.code}`,
        scopes: ['openid'],
        accountRef: null,
      });
    }
    const integration = await harness().admin.query<{ status: string; last_error_code: string }>(
      `SELECT status, last_error_code FROM app.integrations WHERE id = $1`,
      [denied.integration_id],
    );
    expect(integration.rows[0]).toEqual({ status: 'ERROR', last_error_code: 'invalid_grant' });
    const refs = await harness().admin.query(
      `SELECT 1 FROM app.tenant_secret_refs WHERE tenant_id = $1`,
      [seeded.tenantId],
    );
    expect(refs.rowCount).toBe(0);
  });

  it('rejects forged, foreign-user and expired states and unprivileged members', async () => {
    const seeded = await freshTenant();
    const started = (await start({ integration_type: 'GOOGLE_CALENDAR' }, seeded)).json<Started>();
    const state = new URL(started.authorization_url).searchParams.get('state') ?? '';
    const [body, signature] = state.split('.');
    const tampered = `${body ?? ''}x.${signature ?? ''}`;
    expect(
      (await callback(seeded.owner, { state: tampered, code: 'c' })).json<Envelope>(),
    ).toMatchObject({ code: 'OAUTH_STATE_INVALID' });

    const stranger = harness().sessions.issue(`stranger-${randomUUID().slice(0, 6)}@example.test`);
    expect((await callback(stranger, { state, code: 'c' })).json<Envelope>()).toMatchObject({
      code: 'OAUTH_STATE_INVALID',
    });

    const viewer = harness().sessions.issue(`viewer-${randomUUID().slice(0, 6)}@example.test`);
    await harness().app.inject({ method: 'GET', url: '/v1/me', headers: sessionHeaders(viewer) });
    const viewerRow = await harness().admin.query<{ id: string }>(
      `SELECT id FROM app.users WHERE auth_subject = $1`,
      [viewer.session.authSubject],
    );
    await harness().admin.query(
      `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'VIEWER', 'ACTIVE')`,
      [seeded.tenantId, viewerRow.rows[0]?.id],
    );
    const forbidden = await start(
      { integration_type: 'MICROSOFT_365' },
      { ...seeded, owner: viewer },
    );
    expect(forbidden.json<Envelope>()).toMatchObject({
      code: 'FORBIDDEN',
      details: { required_permission: 'integrations:manage' },
    });

    await harness().admin.query(
      `UPDATE app.oauth_authorizations SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE integration_id = $1`,
      [started.integration_id],
    );
    expect((await callback(seeded.owner, { state, code: 'c' })).json<Envelope>()).toMatchObject({
      code: 'OAUTH_STATE_INVALID',
    });
    const anonymous = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=c`,
    });
    expect(anonymous.json<Envelope>()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
