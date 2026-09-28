import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNotificationActivity } from '../src/activities/notifications.js';
import { seedTenant, testDependencies, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const LOGO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let server: Server;
let port: number;
const received: string[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    let inData = false;
    let message = '';
    socket.write('220 mail.bistro.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (inData) {
        message += text;
        if (message.includes('\r\n.\r\n')) {
          inData = false;
          received.push(message);
          message = '';
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter((entry) => entry !== '')) {
        const command = line.toUpperCase();
        if (command.startsWith('EHLO')) {
          socket.write('250-mail.bistro.test\r\n250 AUTH LOGIN PLAIN\r\n');
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
  port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind fake SMTP server'));
        return;
      }
      resolve(address.port);
    });
  });
});

afterAll(() => {
  server.close();
});

async function connectMailServer(
  tenantId: string,
  secrets: ReturnType<typeof testDependencies>['deps']['secrets'],
) {
  const integrationId = randomUUID();
  const secretRefId = randomUUID();
  const secretRef = await secrets.store({
    tenantId,
    kind: 'SMTP_PASSWORD',
    secretRefId,
    version: 1,
    value: 'bistro-app-password',
  });
  await database().admin.query(
    `INSERT INTO app.tenant_secret_refs (id, tenant_id, kind, provider, subject_id, secret_ref, secret_version, status, activated_at)
     VALUES ($1, $2, 'SMTP_PASSWORD', 'smtp', $3, $4, 1, 'ACTIVE', now())`,
    [secretRefId, tenantId, integrationId, secretRef],
  );
  await database().admin.query(
    `INSERT INTO app.integrations (id, tenant_id, integration_type, provider, status, display_name, secret_ref_id, config)
     VALUES ($1, $2, 'CUSTOM_SMTP', 'smtp', 'CONNECTED', 'Bistro Test', $3, $4)`,
    [
      integrationId,
      tenantId,
      secretRefId,
      JSON.stringify({
        host: 'mail.bistro.test',
        port,
        security: 'NONE',
        username: 'bookings@bistro.test',
        from_address: 'bookings@bistro.test',
        from_name: 'Bistro Test',
        reply_to: null,
        auth_method: 'PASSWORD',
      }),
    ],
  );
}

function confirmation(tenantId: string, dedupeKey: string) {
  return {
    tenantId,
    type: 'CALLER_BOOKING_CONFIRMATION',
    dedupeKey,
    payload: {
      caller_email: 'Guest@Example.test',
      caller_name: 'Anna',
      locale: 'en',
      booking_date: 'Saturday, 3 October',
      booking_time: '19:00',
      party_size: '4',
      service_name: 'Dinner',
      location_name: 'Bistro Test',
      location_address: 'Main street 1',
      business_phone: '+36 1 234 5678',
      booking_reference: 'VLY-1',
    },
    traceId: TRACE,
  };
}

describe('guest notifications', () => {
  it('sends guest emails through the workspace mail server with its own text and logo', async () => {
    const tenantId = await seedTenant(database().admin, { locale: 'hu' });
    const { deps, providers } = testDependencies(database(), new Date('2026-09-17T08:00:00Z'));
    const notify = createNotificationActivity(deps);

    expect(await notify(confirmation(tenantId, 'booking:1:confirmation'))).toEqual({
      status: 'SUPPRESSED',
    });

    await connectMailServer(tenantId, deps.secrets);
    await database().admin.query(
      `INSERT INTO app.tenant_messaging_settings (tenant_id, brand_color, brand_logo_bytes, brand_logo_content_type, brand_logo_uploaded_at, brand_footer)
       VALUES ($1, '#0F766E', $2, 'image/png', now(), 'Bistro Test, Main street 1')`,
      [tenantId, LOGO],
    );
    await database().admin.query(
      `INSERT INTO app.tenant_email_templates (tenant_id, notification_type, locale, subject, body)
       VALUES ($1, 'CALLER_BOOKING_CONFIRMATION', 'en', 'See you at {{booking_time}}, {{caller_name}}', 'Table for {{party_size}} is ready.')`,
      [tenantId],
    );

    const before = received.length;
    const input = confirmation(tenantId, 'booking:2:confirmation');
    expect(await notify(input)).toEqual({ status: 'SENT' });
    expect(await notify(input)).toEqual({ status: 'ALREADY_SENT' });
    expect(received.length).toBe(before + 1);
    const message = received.at(-1) ?? '';
    expect(message).toContain('From: Bistro Test <bookings@bistro.test>');
    expect(message).toContain('To: guest@example.test');
    expect(message).toContain('Subject: See you at 19:00, Anna');
    expect(message).toContain('Content-ID: <velyric-brand-logo>');
    expect(providers.email.messages).toHaveLength(0);

    const event = await database().admin.query<{ template_key: string; masked: string }>(
      `SELECT template_key, destination_masked AS masked FROM app.notification_events WHERE tenant_id = $1 AND dedupe_key = $2`,
      [tenantId, 'booking:2:confirmation'],
    );
    expect(event.rows[0]).toEqual({
      template_key: 'caller_booking_confirmation.en.custom',
      masked: 'gu***@example.test',
    });

    await database().admin.query(
      `INSERT INTO app.notification_preferences (tenant_id, notification_type, channel, enabled) VALUES ($1, 'CALLER_BOOKING_CONFIRMATION', 'EMAIL', false)`,
      [tenantId],
    );
    expect(await notify(confirmation(tenantId, 'booking:3:confirmation'))).toEqual({
      status: 'SUPPRESSED',
    });
    expect(received.length).toBe(before + 1);
  });
});
