import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { PRICING_VERSION } from '@velyric/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();

let tenant: SeededTenant;
let fakeSmtpServer: Server;
let fakeSmtpPort: number;

function startFakeSmtpServer(): Promise<{ readonly server: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.write('220 smtp.partner.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8').trim().toUpperCase();
        if (line.startsWith('EHLO')) {
          socket.write('250-smtp.partner.test\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (line.startsWith('AUTH')) {
          socket.write('235 authenticated\r\n');
        } else if (line.startsWith('QUIT')) {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind fake SMTP server'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function grantCustomSmtpFeature(): Promise<void> {
  await harness().admin.query(
    `INSERT INTO app.entitlement_snapshots (tenant_id, version, plan_code, pricing_version, billing_period_start, billing_period_end, effective_from, included_voice_seconds, overage_minor_per_minute, currency, concurrency_limit, burst_policy, features, limits, source_kind, source_ref)
     SELECT $1, max(version) + 1, 'BUSINESS', $2, now() - interval '1 day', now() + interval '30 days', now() - interval '1 second', 9000, 14900, 'HUF', 2, 'NONE', '["custom_smtp"]'::jsonb, '{"max_call_duration_seconds":1800}', 'ADMIN_OVERRIDE', $3
     FROM app.entitlement_snapshots WHERE tenant_id = $1`,
    [tenant.tenantId, PRICING_VERSION, `test-${randomUUID()}`],
  );
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  await grantCustomSmtpFeature();
  const started = await startFakeSmtpServer();
  fakeSmtpServer = started.server;
  fakeSmtpPort = started.port;
});

afterAll(() => {
  fakeSmtpServer.close();
});

function smtpBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'smtp.partner.test',
    port: fakeSmtpPort,
    security: 'NONE',
    username: 'notifications',
    password: 'super-secret-app-password',
    from_address: 'bookings@partner.test',
    from_name: 'Partner Bookings',
    ...overrides,
  };
}

describe('tenant custom SMTP integration', () => {
  it('rejects invalid settings without attempting a connection', async () => {
    const response = await harness().app.inject({
      method: 'PUT',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `smtp-${randomUUID()}`,
      }),
      payload: smtpBody({ from_address: 'not-an-email' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns 404 before any SMTP integration has been configured', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(response.statusCode).toBe(404);
  });

  it('verifies, stores and returns a tenant SMTP configuration', async () => {
    const created = await harness().app.inject({
      method: 'PUT',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `smtp-${randomUUID()}`,
      }),
      payload: smtpBody(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{
      status: string;
      host: string;
      port: number;
      from_address: string;
    }>();
    expect(body.status).toBe('CONNECTED');
    expect(body.host).toBe('smtp.partner.test');
    expect(body.port).toBe(fakeSmtpPort);
    expect(body.from_address).toBe('bookings@partner.test');
    expect(JSON.stringify(body)).not.toContain('super-secret-app-password');

    const fetched = await harness().app.inject({
      method: 'GET',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ status: 'CONNECTED', host: 'smtp.partner.test' });
  });

  it('rejects a connection to a host that refuses the connection', async () => {
    const response = await harness().app.inject({
      method: 'PUT',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `smtp-${randomUUID()}`,
      }),
      payload: smtpBody({ port: fakeSmtpPort + 1 }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'SMTP_VERIFICATION_FAILED' });
  });

  it('disconnects the configured SMTP integration', async () => {
    const deleted = await harness().app.inject({
      method: 'DELETE',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const fetched = await harness().app.inject({
      method: 'GET',
      url: '/v1/integrations/smtp',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(fetched.json()).toMatchObject({ status: 'DISCONNECTED' });
  });
});
