import { createHmac, randomUUID } from 'node:crypto';
import {
  EgressBlockedError,
  type SafeRequest,
  type SafeRequestOptions,
  type SafeResponse,
} from '@velyric/security';
import { TenantSecretError, type TenantSecretReader } from '@velyric/tenant-secrets';
import { describe, expect, it } from 'vitest';
import {
  classifyError,
  classifyResponse,
  signWebhookPayload,
  WebhookDeliveryWorker,
  webhookEgressPolicy,
} from '../src/webhooks/delivery.js';
import { seedTenant, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const SECRET = 'whsec_test_signing_secret_value';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Sent {
  readonly request: SafeRequest;
  readonly options: SafeRequestOptions;
}

function response(status: number): SafeResponse {
  return {
    status,
    headers: {},
    body: new Uint8Array(),
    finalUrl: 'https://hooks.partner.test/velyric',
    remoteAddress: '93.184.216.34',
    redirects: 0,
    durationMs: 42,
  };
}

async function seedWebhook(secretRef: string): Promise<{ tenantId: string; webhookId: string }> {
  const { admin } = database();
  const tenantId = await seedTenant(admin);
  const refId = randomUUID();
  const webhookId = randomUUID();
  await admin.query(
    `INSERT INTO app.tenant_secret_refs (id, tenant_id, kind, provider, subject_id, secret_ref, secret_version, status, activated_at)
     VALUES ($1, $2, 'OUTBOUND_WEBHOOK_SIGNING_SECRET', 'custom_api', $3, $4, 1, 'ACTIVE', now())`,
    [refId, tenantId, webhookId, secretRef],
  );
  await admin.query(
    `INSERT INTO app.outbound_webhooks (id, tenant_id, url, event_types, signing_secret_ref_id) VALUES ($1, $2, 'https://hooks.partner.test/velyric', ARRAY['booking.created'], $3)`,
    [webhookId, tenantId, refId],
  );
  return { tenantId, webhookId };
}

async function enqueue(
  tenantId: string,
  webhookId: string,
  attempt = 0,
): Promise<{ deliveryId: string; eventId: string }> {
  const eventId = randomUUID();
  const result = await database().admin.query<{ id: string }>(
    `INSERT INTO app.webhook_deliveries (tenant_id, webhook_id, event_id, event_type, status, attempt, next_attempt_at, occurred_at, payload)
     VALUES ($1, $2, $3, 'booking.created', 'PENDING', $4, now() - interval '1 second', '2026-09-15T08:00:00Z', '{"booking_id":"b-1"}') RETURNING id`,
    [tenantId, webhookId, eventId, attempt],
  );
  return { deliveryId: result.rows[0]?.id ?? '', eventId };
}

async function deliveryRow(id: string): Promise<{
  status: string;
  attempt: number;
  http_status: number | null;
  last_error_code: string | null;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  claimed_by: string | null;
}> {
  const result = await database().admin.query<{
    status: string;
    attempt: number;
    http_status: number | null;
    last_error_code: string | null;
    next_attempt_at: Date | null;
    delivered_at: Date | null;
    claimed_by: string | null;
  }>(
    `SELECT status, attempt, http_status, last_error_code, next_attempt_at, delivered_at, claimed_by FROM app.webhook_deliveries WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('delivery not found');
  }
  return row;
}

function worker(
  statuses: (number | Error)[],
  secrets: TenantSecretReader,
  sent: Sent[],
): WebhookDeliveryWorker {
  return new WebhookDeliveryWorker({
    db: database().db,
    secrets,
    environment: 'ci',
    workerId: `webhooks-${randomUUID()}`,
    logger: silent,
    now: () => new Date('2026-09-15T08:00:05Z'),
    transport: (request, options) => {
      sent.push({ request, options });
      const next = statuses.shift() ?? 200;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(response(next));
    },
  });
}

describe('outbound webhook delivery', () => {
  it('signs, delivers and records successful deliveries exactly once', async () => {
    const ref = `local-vault://tenants/webhooks/${randomUUID()}/v1`;
    const { tenantId, webhookId } = await seedWebhook(ref);
    const { deliveryId, eventId } = await enqueue(tenantId, webhookId);
    const sent: Sent[] = [];
    const secrets: TenantSecretReader = {
      read: (reference) =>
        reference === ref
          ? Promise.resolve(SECRET)
          : Promise.reject(new TenantSecretError('SECRET_UNAVAILABLE', 'missing')),
    };
    const delivery = worker([200], secrets, sent);

    expect(await delivery.runOnce()).toEqual({ claimed: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(await delivery.runOnce()).toEqual({ claimed: 0, delivered: 0, retrying: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    const request = sent[0]?.request;
    const body = String(request?.body);
    expect(JSON.parse(body)).toEqual({
      id: eventId,
      type: 'booking.created',
      created_at: '2026-09-15T08:00:00.000Z',
      delivery_attempt: 1,
      data: { booking_id: 'b-1' },
    });
    const timestamp = Math.floor(new Date('2026-09-15T08:00:05Z').getTime() / 1000);
    const expected = createHmac('sha256', SECRET)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');
    expect(request?.headers?.['velyric-signature']).toBe(`t=${String(timestamp)},v1=${expected}`);
    expect(request?.headers).toMatchObject({
      'velyric-event-id': eventId,
      'velyric-delivery-id': deliveryId,
      'idempotency-key': eventId,
    });
    expect(sent[0]?.options.policy).toMatchObject({
      allowHttp: false,
      allowedPorts: [443],
      maxRedirects: 0,
      allowedHosts: ['hooks.partner.test'],
    });
    expect(JSON.stringify(sent[0]?.options)).not.toContain(SECRET);

    const row = await deliveryRow(deliveryId);
    expect(row).toMatchObject({
      status: 'DELIVERED',
      attempt: 1,
      http_status: 200,
      last_error_code: null,
      next_attempt_at: null,
      claimed_by: null,
    });
    expect(row.delivered_at).not.toBeNull();
  });

  it('retries transient failures with backoff and dead-letters after the final attempt', async () => {
    const ref = `local-vault://tenants/webhooks/${randomUUID()}/v1`;
    const { tenantId, webhookId } = await seedWebhook(ref);
    const secrets: TenantSecretReader = { read: () => Promise.resolve(SECRET) };
    const retrying = await enqueue(tenantId, webhookId);
    const sent: Sent[] = [];
    expect(await worker([503], secrets, sent).runOnce()).toMatchObject({ claimed: 1, retrying: 1 });
    const first = await deliveryRow(retrying.deliveryId);
    expect(first).toMatchObject({
      status: 'RETRYING',
      attempt: 1,
      http_status: 503,
      last_error_code: 'HTTP_503',
    });
    expect(first.next_attempt_at).not.toBeNull();
    expect(await worker([200], secrets, sent).runOnce()).toMatchObject({ claimed: 0 });

    const exhausted = await enqueue(tenantId, webhookId, 7);
    expect(await worker([new Error('socket hang up')], secrets, sent).runOnce()).toMatchObject({
      claimed: 1,
      failed: 1,
    });
    expect(await deliveryRow(exhausted.deliveryId)).toMatchObject({
      status: 'DEAD_LETTER',
      attempt: 8,
      last_error_code: 'NETWORK_ERROR',
      next_attempt_at: null,
    });

    const blocked = await enqueue(tenantId, webhookId);
    expect(
      await worker(
        [new EgressBlockedError('ADDRESS_NOT_PUBLIC', 'resolved address is private')],
        secrets,
        sent,
      ).runOnce(),
    ).toMatchObject({ failed: 1 });
    expect(await deliveryRow(blocked.deliveryId)).toMatchObject({
      status: 'FAILED',
      last_error_code: 'EGRESS_ADDRESS_NOT_PUBLIC',
    });
  });

  it('keeps deliveries pending when the signing secret is unavailable and skips inactive endpoints', async () => {
    const ref = `local-vault://tenants/webhooks/${randomUUID()}/v1`;
    const { tenantId, webhookId } = await seedWebhook(ref);
    const sent: Sent[] = [];
    const unavailable: TenantSecretReader = {
      read: () => Promise.reject(new TenantSecretError('SECRET_UNAVAILABLE', 'vault offline')),
    };
    const pending = await enqueue(tenantId, webhookId);
    expect(await worker([], unavailable, sent).runOnce()).toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    expect(sent).toHaveLength(0);
    expect(await deliveryRow(pending.deliveryId)).toMatchObject({
      status: 'RETRYING',
      last_error_code: 'SECRET_UNAVAILABLE',
    });

    await database().admin.query(`UPDATE app.outbound_webhooks SET active = false WHERE id = $1`, [
      webhookId,
    ]);
    const skipped = await enqueue(tenantId, webhookId);
    expect(
      await worker([200], { read: () => Promise.resolve(SECRET) }, sent).runOnce(),
    ).toMatchObject({ claimed: 0 });
    expect(await deliveryRow(skipped.deliveryId)).toMatchObject({ status: 'PENDING', attempt: 0 });
  });

  it('classifies responses and builds a strict egress policy', () => {
    expect(classifyResponse(1, response(204)).status).toBe('DELIVERED');
    expect(classifyResponse(1, response(410))).toMatchObject({
      status: 'FAILED',
      errorCode: 'ENDPOINT_GONE',
    });
    expect(classifyResponse(3, response(429))).toMatchObject({
      status: 'RETRYING',
      retryAfterSeconds: 600,
    });
    expect(classifyResponse(8, response(500)).status).toBe('DEAD_LETTER');
    expect(classifyError(2, new EgressBlockedError('TIMEOUT', 'slow')).status).toBe('RETRYING');
    expect(classifyError(2, new EgressBlockedError('HOST_NOT_ALLOWLISTED', 'nope')).status).toBe(
      'FAILED',
    );
    expect(signWebhookPayload('secret', 1_700_000_000, '{}')).toMatch(
      /^t=1700000000,v1=[0-9a-f]{64}$/,
    );
    expect(webhookEgressPolicy(new URL('https://[2001:db8::1]/hook')).allowedHosts).toEqual([
      '2001:db8::1',
    ]);
  });
});
