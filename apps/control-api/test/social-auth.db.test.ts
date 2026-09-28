import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OAuthExchangeError } from '../src/integrations/oauth.js';
import { OAUTH_SIMULATOR, TEST_ORIGIN, useApiHarness } from './support/harness.js';

const harness = useApiHarness();

function email(): string {
  return `owner-${randomUUID().slice(0, 8)}@example.test`;
}

interface StartResult {
  readonly state: string;
  readonly nonceCookie: string;
}

async function startGoogleLogin(returnTo?: string): Promise<StartResult> {
  const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
  const start = await harness().app.inject({
    method: 'GET',
    url: `/v1/auth/google/start${query}`,
  });
  expect(start.statusCode).toBe(302);
  const location = new URL(String(start.headers.location));
  expect(`${location.origin}${location.pathname}`).toBe(`${OAUTH_SIMULATOR}/google/authorize`);
  const state = location.searchParams.get('state') ?? '';
  const nonceCookie = start.cookies.find((cookie) => cookie.name === 'vly_oauth_nonce');
  expect(nonceCookie?.value).toBeTruthy();
  return { state, nonceCookie: `vly_oauth_nonce=${nonceCookie?.value ?? ''}` };
}

async function callback(start: StartResult, code: string, cookie = start.nonceCookie) {
  return harness().app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?state=${encodeURIComponent(start.state)}&code=${code}`,
    headers: cookie === '' ? {} : { cookie },
  });
}

describe('signing in with Google', () => {
  it('creates a new account on first login and redirects to the requested page', async () => {
    const start = await startGoogleLogin('/app/onboarding');
    const address = email();
    harness().oauth.respondToIdentity = () => ({ email: address });
    const done = await callback(start, 'auth-code-1');
    expect(done.statusCode, done.body).toBe(302);
    expect(done.headers.location).toBe(`${TEST_ORIGIN}/app/onboarding`);
    const sessionCookie = done.cookies.find((cookie) => cookie.name === 'vly_session');
    expect(sessionCookie?.value).toBeTruthy();
    const clearedNonce = done.cookies.find((cookie) => cookie.name === 'vly_oauth_nonce');
    expect(clearedNonce?.value).toBe('');

    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `vly_session=${sessionCookie?.value ?? ''}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(address);

    const credentials = await harness().admin.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM app.credentials WHERE email = $1`,
      [address],
    );
    expect(credentials.rows).toHaveLength(1);
    expect(credentials.rows[0]?.password_hash).toBeNull();
  });

  it('links to the existing account when a password account shares the Google email', async () => {
    const address = email();
    const registered = await harness().app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    expect(registered.statusCode).toBe(201);

    const start = await startGoogleLogin();
    harness().oauth.respondToIdentity = () => ({ email: address });
    const done = await callback(start, 'auth-code-2');
    expect(done.statusCode, done.body).toBe(302);
    expect(done.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_account_has_password`);

    const rows = await harness().admin.query<{ auth_subject: string }>(
      `SELECT auth_subject FROM app.credentials WHERE email = $1`,
      [address],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('links to the existing account when a second Google login uses the same email', async () => {
    const address = email();
    const first = await startGoogleLogin();
    harness().oauth.respondToIdentity = () => ({ email: address });
    const firstDone = await callback(first, 'auth-code-2a');
    expect(firstDone.statusCode, firstDone.body).toBe(302);

    const before = await harness().admin.query<{ auth_subject: string }>(
      `SELECT auth_subject FROM app.credentials WHERE email = $1`,
      [address],
    );
    expect(before.rows).toHaveLength(1);
    const authSubject = before.rows[0]?.auth_subject;

    const second = await startGoogleLogin();
    const secondDone = await callback(second, 'auth-code-2b');
    expect(secondDone.statusCode, secondDone.body).toBe(302);

    const after = await harness().admin.query<{ auth_subject: string }>(
      `SELECT auth_subject FROM app.credentials WHERE email = $1`,
      [address],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.auth_subject).toBe(authSubject);
  });

  it('redirects to the login page with an error when the provider denies consent', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?error=access_denied',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
  });

  it('redirects to the login page with an error when the token exchange fails', async () => {
    const start = await startGoogleLogin();
    harness().oauth.respondToIdentity = () => new OAuthExchangeError('invalid_grant', 'bad code');
    const done = await callback(start, 'auth-code-3');
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
    harness().oauth.respondToIdentity = () => ({ email: 'clinic@example.com' });
  });

  it('rejects a state that was never issued', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?state=not-a-real-state&code=auth-code-4',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_expired`);
  });

  it('rejects a callback with no nonce cookie (login CSRF protection)', async () => {
    const start = await startGoogleLogin();
    const done = await callback(start, 'auth-code-5', '');
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_expired`);
  });

  it('rejects a callback whose nonce cookie does not match the signed state', async () => {
    const start = await startGoogleLogin();
    const otherStart = await startGoogleLogin();
    const done = await callback(start, 'auth-code-6', otherStart.nonceCookie);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_expired`);
  });
});
