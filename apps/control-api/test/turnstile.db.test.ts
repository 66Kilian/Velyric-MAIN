import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { useApiHarness } from './support/harness.js';

const harness = useApiHarness();

function email(): string {
  return `signup-${randomUUID().slice(0, 8)}@example.test`;
}

function register(payload: Record<string, unknown>) {
  return harness().app.inject({ method: 'POST', url: '/v1/auth/register', payload });
}

describe('signup bot verification', () => {
  afterEach(() => {
    harness().turnstile.enabled = false;
    harness().turnstile.respond = () => true;
    harness().turnstile.calls.length = 0;
  });

  it('lets signups through untouched while no secret is configured', async () => {
    const response = await register({ email: email(), password: 'Correct-Horse-9' });
    expect(response.statusCode).toBe(201);
    expect(harness().turnstile.calls).toHaveLength(0);
  });

  it('rejects a signup with no token once verification is required', async () => {
    harness().turnstile.enabled = true;
    const response = await register({ email: email(), password: 'Correct-Horse-9' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'TURNSTILE_VERIFICATION_FAILED' });
    expect(harness().turnstile.calls).toHaveLength(0);
  });

  it('rejects a signup whose token Cloudflare declines', async () => {
    harness().turnstile.enabled = true;
    harness().turnstile.respond = () => false;
    const response = await register({
      email: email(),
      password: 'Correct-Horse-9',
      turnstile_token: 'bad-token-0',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'TURNSTILE_VERIFICATION_FAILED' });
  });

  it('accepts a signup with a token Cloudflare confirms, passing the caller IP through', async () => {
    harness().turnstile.enabled = true;
    const address = email();
    const response = await register({
      email: address,
      password: 'Correct-Horse-9',
      turnstile_token: 'good-token',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({ email: address });
    expect(harness().turnstile.calls).toHaveLength(1);
    expect(harness().turnstile.calls[0]?.token).toBe('good-token');
    expect(typeof harness().turnstile.calls[0]?.remoteIp).toBe('string');
  });
});
