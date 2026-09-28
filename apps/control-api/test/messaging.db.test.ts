import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { PRICING_VERSION } from '@velyric/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Settings {
  sms_enabled: boolean;
  brand_color: string;
  brand_footer: string | null;
  brand_logo: string | null;
  version: number;
}

interface Template {
  notification_type: string;
  locale: string;
  subject: string;
  body: string;
  customized: boolean;
  placeholders: string[];
}

let tenant: SeededTenant;
let smtpServer: Server;
let smtpPort: number;
const delivered: string[] = [];

function startSmtpServer(): Promise<{ readonly server: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let inData = false;
      let message = '';
      socket.write('220 smtp.partner.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (inData) {
          message += text;
          if (message.includes('\r\n.\r\n')) {
            inData = false;
            delivered.push(message);
            message = '';
            socket.write('250 queued\r\n');
          }
          return;
        }
        for (const line of text.split('\r\n').filter((entry) => entry !== '')) {
          const command = line.toUpperCase();
          if (command.startsWith('EHLO')) {
            socket.write('250-smtp.partner.test\r\n250 AUTH LOGIN PLAIN\r\n');
          } else if (command.startsWith('AUTH')) {
            socket.write('235 authenticated\r\n');
          } else if (command === 'DATA') {
            inData = true;
            socket.write('354 go ahead\r\n');
          } else if (command.startsWith('QUIT')) {
            socket.write('221 bye\r\n');
            socket.end();
          } else {
            socket.write('250 ok\r\n');
          }
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

async function grantFeatures(seeded: SeededTenant, features: readonly string[]): Promise<void> {
  await harness().admin.query(
    `INSERT INTO app.entitlement_snapshots (tenant_id, version, plan_code, pricing_version, billing_period_start, billing_period_end, effective_from, included_voice_seconds, overage_minor_per_minute, currency, concurrency_limit, burst_policy, features, limits, source_kind, source_ref)
     SELECT $1, max(version) + 1, 'BUSINESS', $2, now() - interval '1 day', now() + interval '30 days', now() - interval '1 second', 9000, 14900, 'HUF', 2, 'NONE', $3::jsonb, '{"max_call_duration_seconds":1800}', 'ADMIN_OVERRIDE', $4
     FROM app.entitlement_snapshots WHERE tenant_id = $1`,
    [seeded.tenantId, PRICING_VERSION, JSON.stringify(features), `test-${randomUUID()}`],
  );
}

function request(
  seeded: SeededTenant,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  return harness().app.inject({
    method,
    url,
    headers: browserHeaders(seeded.owner, seeded.tenantId, {
      ...(method === 'GET' ? {} : { 'idempotency-key': `msg-${randomUUID()}` }),
      ...extra,
    }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  await grantFeatures(tenant, ['transactional_email', 'custom_smtp']);
  const started = await startSmtpServer();
  smtpServer = started.server;
  smtpPort = started.port;
});

afterAll(() => {
  smtpServer.close();
});

describe('messaging settings', () => {
  it('starts with SMS off and the default brand, then saves with optimistic locking', async () => {
    const initial = await request(tenant, 'GET', '/v1/messaging-settings');
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json<Settings>()).toMatchObject({
      sms_enabled: false,
      brand_color: '#6D28D9',
      brand_logo: null,
      version: 0,
    });

    const body = {
      sms_enabled: true,
      sms_sender_label: null,
      brand_color: '#0f766e',
      brand_footer: '1052 Budapest, Váci utca 1.',
    };
    const first = await request(tenant, 'PUT', '/v1/messaging-settings', body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<Settings>()).toMatchObject({
      sms_enabled: true,
      brand_color: '#0F766E',
      version: 1,
    });

    const withoutEtag = await request(tenant, 'PUT', '/v1/messaging-settings', body);
    expect(withoutEtag.statusCode).toBe(428);

    const stale = await request(tenant, 'PUT', '/v1/messaging-settings', body, {
      'if-match': 'W/"7"',
    });
    expect(stale.statusCode).toBe(412);

    const second = await request(
      tenant,
      'PUT',
      '/v1/messaging-settings',
      { ...body, sms_enabled: false },
      { 'if-match': 'W/"1"' },
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<Settings>()).toMatchObject({ sms_enabled: false, version: 2 });
  });

  it('stores the logo in the database and removes it again', async () => {
    const uploaded = await request(tenant, 'PUT', '/v1/messaging-settings/logo', {
      content_type: 'image/png',
      data_base64: PNG_1PX.toString('base64'),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<Settings>().brand_logo).toBe(
      `data:image/png;base64,${PNG_1PX.toString('base64')}`,
    );
    const stored = await harness().admin.query<{ bytes: number; type: string }>(
      `SELECT octet_length(brand_logo_bytes) AS bytes, brand_logo_content_type AS type
         FROM app.tenant_messaging_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(stored.rows[0]).toEqual({ bytes: PNG_1PX.length, type: 'image/png' });

    const tooLarge = await request(tenant, 'PUT', '/v1/messaging-settings/logo', {
      content_type: 'image/png',
      data_base64: Buffer.alloc(262_145, 1).toString('base64'),
    });
    expect(tooLarge.statusCode).toBe(400);

    const removed = await request(tenant, 'DELETE', '/v1/messaging-settings/logo');
    expect(removed.statusCode).toBe(204);
    const after = await request(tenant, 'GET', '/v1/messaging-settings');
    expect(after.json<Settings>().brand_logo).toBeNull();
  });
});

describe('guest email templates', () => {
  it('lists every guest email in every language with its default text and placeholders', async () => {
    const response = await request(tenant, 'GET', '/v1/email-templates');
    expect(response.statusCode, response.body).toBe(200);
    const templates = response.json<{ data: Template[] }>().data;
    expect(templates).toHaveLength(12);
    const confirmation = templates.find(
      (entry) => entry.notification_type === 'CALLER_BOOKING_CONFIRMATION' && entry.locale === 'hu',
    );
    expect(confirmation).toMatchObject({ customized: false });
    expect(confirmation?.body).toContain('{{booking_date}}');
    expect(confirmation?.placeholders).toContain('caller_name');
  });

  it('saves a custom text, rejects unknown placeholders, previews safely and resets', async () => {
    const url = '/v1/email-templates/CALLER_BOOKING_CONFIRMATION/hu';
    const rejected = await request(tenant, 'PUT', url, {
      subject: 'Foglalás {{booking_date}}',
      body: 'Kedves {{guest_nickname}}!',
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toContain('unknown_placeholder:guest_nickname');

    const saved = await request(tenant, 'PUT', url, {
      subject: 'Várunk {{booking_date}} napon',
      body: 'Szia {{caller_name}}!\n\nAsztalod {{party_size}} főre foglalva <3',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const listed = await request(tenant, 'GET', '/v1/email-templates');
    expect(
      listed
        .json<{ data: Template[] }>()
        .data.find(
          (entry) =>
            entry.notification_type === 'CALLER_BOOKING_CONFIRMATION' && entry.locale === 'hu',
        ),
    ).toMatchObject({ customized: true, subject: 'Várunk {{booking_date}} napon' });

    const preview = await request(tenant, 'POST', `${url}/preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const rendered = preview.json<{ subject: string; html: string; text: string }>();
    expect(rendered.subject).toBe('Várunk 2026. október 3., szombat napon');
    expect(rendered.text).toContain('Szia Kovács Anna!');
    expect(rendered.html).toContain('4 főre foglalva &lt;3');
    expect(rendered.html).not.toContain('<3');
    expect(rendered.html).toContain('#0F766E');

    const draft = await request(tenant, 'POST', `${url}/preview`, {
      subject: 'Piszkozat',
      body: 'Csak egy próba',
    });
    expect(draft.json<{ subject: string }>().subject).toBe('Piszkozat');

    const other = await seedRuntimeTenant(harness());
    const isolated = await request(other, 'GET', '/v1/email-templates');
    expect(isolated.json<{ data: Template[] }>().data.every((entry) => !entry.customized)).toBe(
      true,
    );

    const reset = await request(tenant, 'DELETE', url);
    expect(reset.statusCode).toBe(204);
    const again = await request(tenant, 'DELETE', url);
    expect(again.statusCode).toBe(404);
  });
});

describe('workspace email sender', () => {
  it('sends a test email through the workspace mail server to the signed-in user', async () => {
    const connected = await request(tenant, 'PUT', '/v1/integrations/smtp', {
      host: 'smtp.partner.test',
      port: smtpPort,
      security: 'NONE',
      username: 'bookings@partner.test',
      password: 'app-password-1234',
      from_address: 'bookings@partner.test',
      from_name: 'Partner Bistro',
    });
    expect(connected.statusCode, connected.body).toBe(201);
    expect(connected.json()).toMatchObject({ auth_method: 'PASSWORD' });

    const before = delivered.length;
    const sent = await request(tenant, 'POST', '/v1/integrations/smtp/test');
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json<{ sent_to: string }>().sent_to).toContain('@example.test');
    expect(delivered.length).toBe(before + 1);
    expect(delivered.at(-1)).toContain('Partner Bistro');
  });

  it('connects Gmail with Google sign-in without touching the calendar connection', async () => {
    const seeded = await seedRuntimeTenant(harness());
    const startFor = async (integrationType: string) => {
      const started = await request(seeded, 'POST', '/v1/integrations/oauth/authorizations', {
        integration_type: integrationType,
      });
      expect(started.statusCode, started.body).toBe(201);
      return started.json<{ integration_id: string; authorization_url: string }>();
    };
    const finish = (authorizationUrl: string, code: string) =>
      harness().app.inject({
        method: 'GET',
        url: `/v1/integrations/oauth/callback?${new URLSearchParams({
          state: new URL(authorizationUrl).searchParams.get('state') ?? '',
          code,
        }).toString()}`,
        headers: { cookie: `vly_session=${seeded.owner.cookie}` },
      });

    const calendar = await startFor('GOOGLE_CALENDAR');
    expect((await finish(calendar.authorization_url, 'calendar-code')).statusCode).toBe(302);

    const mail = await startFor('CUSTOM_SMTP');
    expect(new URL(mail.authorization_url).searchParams.get('scope')).toContain(
      'https://mail.google.com/',
    );
    harness().oauth.respond = (input) => ({
      refreshToken: `refresh-${input.code}`,
      scopes: ['openid', 'email', 'https://mail.google.com/'],
      accountRef: 'bistro@gmail.com',
    });
    try {
      expect((await finish(mail.authorization_url, 'mail-code')).statusCode).toBe(302);
    } finally {
      harness().oauth.respond = (input) => ({
        refreshToken: `refresh-${input.code}`,
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
        accountRef: 'clinic@example.com',
      });
    }

    const sender = await request(seeded, 'GET', '/v1/integrations/smtp');
    expect(sender.statusCode, sender.body).toBe(200);
    expect(sender.json()).toMatchObject({
      status: 'CONNECTED',
      auth_method: 'GOOGLE_OAUTH',
      host: 'smtp.gmail.com',
      port: 465,
      security: 'TLS',
      from_address: 'bistro@gmail.com',
    });

    const secrets = await harness().admin.query<{ subject_id: string; status: string }>(
      `SELECT subject_id, status FROM app.tenant_secret_refs
        WHERE tenant_id = $1 AND kind = 'OAUTH_REFRESH_TOKEN' ORDER BY created_at`,
      [seeded.tenantId],
    );
    expect(secrets.rows).toEqual([
      { subject_id: calendar.integration_id, status: 'ACTIVE' },
      { subject_id: mail.integration_id, status: 'ACTIVE' },
    ]);
  });
});
