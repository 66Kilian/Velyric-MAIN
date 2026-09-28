import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useApiHarness } from './support/harness.js';

const harness = useApiHarness();

function email(): string {
  return `owner-${randomUUID().slice(0, 8)}@example.test`;
}

describe('local email/password authentication', () => {
  it('registers, logs in, and rejects wrong passwords with lockout after repeated failures', async () => {
    const app = harness().app;
    const address = email();

    const registered = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toEqual({ email: address });
    const sessionCookie = registered.cookies.find((cookie) => cookie.name === 'vly_session');
    expect(sessionCookie?.value).toBeTruthy();

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });

    const weak = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: email(), password: 'weak' },
    });
    expect(weak.statusCode).toBe(422);
    expect(weak.json()).toMatchObject({ code: 'WEAK_PASSWORD' });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: address, password: 'totally-wrong-1' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const correctLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    expect(correctLogin.statusCode).toBe(200);
    const loginCookie = correctLogin.cookies.find((cookie) => cookie.name === 'vly_session');
    expect(loginCookie?.value).toBeTruthy();
    expect(loginCookie?.value).not.toBe(sessionCookie?.value);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `vly_session=${loginCookie?.value ?? ''}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(address);

    const csrf = 'x'.repeat(43);
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: `vly_session=${loginCookie?.value ?? ''}; vly_csrf=${csrf}`,
        origin: 'http://app.velyric.test',
        'x-csrf-token': csrf,
      },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `vly_session=${loginCookie?.value ?? ''}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('locks the account after five consecutive failed login attempts', async () => {
    const app = harness().app;
    const address = email();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: address, password: 'wrong-password-1' },
      });
      expect(response.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: address, password: 'Correct-Horse-9' },
    });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('does not reveal whether an email is registered', async () => {
    const app = harness().app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: email(), password: 'whatever-password-1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});
