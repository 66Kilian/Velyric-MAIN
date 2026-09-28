import { randomUUID } from 'node:crypto';
import { PRICING_VERSION } from '@velyric/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

function write(user: TestUser, extra: Record<string, string> = {}) {
  return browserHeaders(user, tenant.tenantId, {
    'idempotency-key': `settings-${randomUUID()}`,
    ...extra,
  });
}

async function member(role: string): Promise<TestUser> {
  const user = harness().sessions.issue(
    `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
  );
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  await harness().admin.query(
    `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenant.tenantId, me.json<{ user: { id: string } }>().user.id, role],
  );
  return user;
}

async function grantFeatures(features: readonly string[]): Promise<void> {
  await harness().admin.query(
    `INSERT INTO app.entitlement_snapshots (tenant_id, version, plan_code, pricing_version, billing_period_start, billing_period_end, effective_from, included_voice_seconds, overage_minor_per_minute, currency, concurrency_limit, burst_policy, features, limits, source_kind, source_ref)
     SELECT $1, max(version) + 1, 'PRO', $2, now() - interval '1 day', now() + interval '30 days', now() - interval '1 second', 9000, 14900, 'HUF', 2, 'NONE', $3::jsonb, '{"max_call_duration_seconds":1800}', 'ADMIN_OVERRIDE', $4
     FROM app.entitlement_snapshots WHERE tenant_id = $1`,
    [tenant.tenantId, PRICING_VERSION, JSON.stringify(features), `test-${randomUUID()}`],
  );
}

async function createPerson(name: string): Promise<string> {
  const result = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.caller_profiles (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
    [tenant.tenantId, name],
  );
  return result.rows[0]?.id ?? '';
}

describe('settings APIs', () => {
  beforeAll(async () => {
    tenant = await seedRuntimeTenant(harness());
  });

  it('never persists one-time secrets in idempotency replays', async () => {
    const headers = write(tenant.owner);
    const first = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers,
      payload: { name: 'Replay key', scopes: ['calls:read'] },
    });
    expect(first.statusCode, first.body).toBe(201);
    const secret = first.json<{ secret: string }>().secret;
    expect(secret.length).toBeGreaterThan(20);
    const replay = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers,
      payload: { name: 'Replay key', scopes: ['calls:read'] },
    });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ secret: string | null; secret_redacted: boolean }>()).toMatchObject({
      secret: null,
      secret_redacted: true,
    });
    const stored = await harness().admin.query<{ body: string }>(
      `SELECT response_body::text AS body FROM app.idempotency_keys WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(stored.rows.some((row) => row.body.includes(secret))).toBe(false);
  });

  it('manages outbound webhooks behind the entitlement with redacted signing secrets', async () => {
    const payload = {
      url: 'https://api.partner.test/velyric/events',
      event_types: ['booking.created', 'call.ended'],
    };
    const denied = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers: write(tenant.owner),
      payload,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('ENTITLEMENT_REQUIRED');

    await grantFeatures(['knowledge_base', 'outbound_webhooks']);
    const blocked = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers: write(tenant.owner),
      payload: { ...payload, url: 'https://metadata.partner.test/hook' },
    });
    expect(blocked.statusCode, blocked.body).toBe(422);
    const insecure = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers: write(tenant.owner),
      payload: { ...payload, url: 'http://api.partner.test/hook' },
    });
    expect(insecure.statusCode).toBe(400);

    const headers = write(tenant.owner);
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers,
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const webhook = created.json<{
      id: string;
      signing_secret: string;
      version: number;
      event_types: string[];
    }>();
    expect(webhook.signing_secret).toMatch(/^whsec_/);
    expect(webhook.event_types).toEqual(['booking.created', 'call.ended']);
    const replay = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers,
      payload,
    });
    expect(replay.json<{ signing_secret: string | null }>().signing_secret).toBeNull();
    const refs = await harness().admin.query<{ secret_ref: string; status: string }>(
      `SELECT secret_ref, status FROM app.tenant_secret_refs WHERE subject_id = $1`,
      [webhook.id],
    );
    expect(refs.rows).toHaveLength(1);
    expect(refs.rows[0]?.secret_ref.includes(webhook.signing_secret)).toBe(false);

    const duplicate = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers: write(tenant.owner),
      payload,
    });
    expect(duplicate.statusCode).toBe(409);

    const viewer = await member('VIEWER');
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/outbound-webhooks',
      headers: browserHeaders(viewer, tenant.tenantId),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain('whsec_');
    const viewerCreate = await harness().app.inject({
      method: 'POST',
      url: '/v1/outbound-webhooks',
      headers: write(viewer),
      payload,
    });
    expect(viewerCreate.statusCode).toBe(403);

    const test = await harness().app.inject({
      method: 'POST',
      url: `/v1/outbound-webhooks/${webhook.id}/test`,
      headers: write(tenant.owner),
    });
    expect(test.statusCode, test.body).toBe(202);
    expect(test.json<{ event_type: string; status: string }>()).toMatchObject({
      event_type: 'webhook.test',
      status: 'PENDING',
    });

    const rotated = await harness().app.inject({
      method: 'POST',
      url: `/v1/outbound-webhooks/${webhook.id}/rotate-secret`,
      headers: write(tenant.owner),
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const rotation = rotated.json<{ signing_secret: string; version: number }>();
    expect(rotation.signing_secret).not.toBe(webhook.signing_secret);
    const statuses = await harness().admin.query<{ status: string }>(
      `SELECT status FROM app.tenant_secret_refs WHERE subject_id = $1 ORDER BY secret_version`,
      [webhook.id],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(['REVOKED', 'ACTIVE']);

    const stale = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/outbound-webhooks/${webhook.id}`,
      headers: write(tenant.owner, { 'if-match': `W/"${String(webhook.version)}"` }),
      payload: { active: false },
    });
    expect(stale.statusCode).toBe(412);
    const disabled = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/outbound-webhooks/${webhook.id}`,
      headers: write(tenant.owner, { 'if-match': `W/"${String(rotation.version)}"` }),
      payload: { active: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const deliveries = await harness().app.inject({
      method: 'GET',
      url: `/v1/outbound-webhooks/${webhook.id}/deliveries`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(
      deliveries.json<{ data: { status: string; last_error_code: string | null }[] }>().data,
    ).toEqual([
      expect.objectContaining({ status: 'FAILED', last_error_code: 'ENDPOINT_DISABLED' }),
    ]);

    const removed = await harness().app.inject({
      method: 'DELETE',
      url: `/v1/outbound-webhooks/${webhook.id}`,
      headers: write(tenant.owner),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const remaining = await harness().admin.query(
      `SELECT 1 FROM app.webhook_deliveries WHERE webhook_id = $1`,
      [webhook.id],
    );
    expect(remaining.rowCount).toBe(0);
  });

  it('enforces retention bounds and audits changes', async () => {
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/retention-policies',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const transcript = list
      .json<{
        data: { retention_class: string; retain_days: number; tenant_configurable: boolean }[];
      }>()
      .data.find((entry) => entry.retention_class === 'TRANSCRIPT');
    expect(transcript).toMatchObject({ retain_days: 90, tenant_configurable: true });

    const tooLong = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(tenant.owner),
      payload: { retain_days: 120 },
    });
    expect(tooLong.statusCode).toBe(400);
    const fixed = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/AUDIT',
      headers: write(tenant.owner),
      payload: { retain_days: 30 },
    });
    expect(fixed.json<{ details: { issues: { rule: string }[] } }>().details.issues[0]?.rule).toBe(
      'not_configurable',
    );
    const unknown = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/UNKNOWN_CLASS',
      headers: write(tenant.owner),
      payload: { retain_days: 30 },
    });
    expect(unknown.statusCode).toBe(404);

    const admin = await member('ADMIN');
    const forbidden = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(admin),
      payload: { retain_days: 30 },
    });
    expect(forbidden.statusCode).toBe(403);

    const saved = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(tenant.owner),
      payload: { retain_days: 30 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const version = saved.json<{ version: number }>().version;
    const withoutPrecondition = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(tenant.owner),
      payload: { retain_days: 14 },
    });
    expect(withoutPrecondition.statusCode).toBe(428);
    const updated = await harness().app.inject({
      method: 'PUT',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(tenant.owner, { 'if-match': `W/"${String(version)}"` }),
      payload: { retain_days: 14 },
    });
    expect(updated.json<{ retain_days: number }>().retain_days).toBe(14);
    const audit = await harness().admin.query(
      `SELECT 1 FROM app.audit_logs WHERE tenant_id = $1 AND action = 'retention_policy.updated'`,
      [tenant.tenantId],
    );
    expect(audit.rowCount).toBe(2);
    const reset = await harness().app.inject({
      method: 'DELETE',
      url: '/v1/retention-policies/TRANSCRIPT',
      headers: write(tenant.owner),
    });
    expect(reset.json<{ retain_days: number; customized: boolean }>()).toMatchObject({
      retain_days: 90,
      customized: false,
    });
  });

  it('runs privacy requests through verification and legal holds', async () => {
    const person = await createPerson('Privacy Person');
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/privacy-requests',
      headers: write(tenant.owner),
      payload: { person_id: person, request_type: 'DELETE', received_via: 'EMAIL' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pending = created.json<{ id: string; status: string }>();
    expect(pending.status).toBe('VERIFYING');
    const duplicate = await harness().app.inject({
      method: 'POST',
      url: '/v1/privacy-requests',
      headers: write(tenant.owner),
      payload: { person_id: person, request_type: 'DELETE', received_via: 'PHONE' },
    });
    expect(duplicate.statusCode).toBe(409);

    const hold = await harness().app.inject({
      method: 'POST',
      url: '/v1/legal-holds',
      headers: write(tenant.owner),
      payload: {
        scope_type: 'PERSON',
        scope_ref: person,
        reason: 'Pending consumer protection complaint',
        legal_basis: 'GDPR Art. 17(3)(e)',
      },
    });
    expect(hold.statusCode, hold.body).toBe(201);
    const holdId = hold.json<{ id: string }>().id;
    const invalidHold = await harness().app.inject({
      method: 'POST',
      url: '/v1/legal-holds',
      headers: write(tenant.owner),
      payload: {
        scope_type: 'TENANT',
        scope_ref: person,
        reason: 'Invalid scope reference',
        legal_basis: 'n/a',
      },
    });
    expect(invalidHold.statusCode).toBe(400);

    const verified = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${pending.id}/verify`,
      headers: write(tenant.owner),
      payload: { verification_method: 'Callback to registered number' },
    });
    expect(verified.json<{ status: string; legal_hold_id: string }>()).toMatchObject({
      status: 'ON_LEGAL_HOLD',
      legal_hold_id: holdId,
    });

    const admin = await member('ADMIN');
    const adminRelease = await harness().app.inject({
      method: 'POST',
      url: `/v1/legal-holds/${holdId}/release`,
      headers: write(admin),
      payload: { reason: 'Complaint withdrawn by the customer' },
    });
    expect(adminRelease.statusCode).toBe(403);
    const released = await harness().app.inject({
      method: 'POST',
      url: `/v1/legal-holds/${holdId}/release`,
      headers: write(tenant.owner),
      payload: { reason: 'Complaint withdrawn by the customer' },
    });
    expect(released.statusCode, released.body).toBe(200);
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/privacy-requests?request_type=DELETE',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(
      list.json<{ data: { id: string; status: string; person_display_name: string }[] }>().data,
    ).toEqual([
      expect.objectContaining({
        id: pending.id,
        status: 'IN_PROGRESS',
        person_display_name: 'Privacy Person',
      }),
    ]);
    const events = await harness().admin.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'privacy.request_created' AND payload->>'request_id' = $2 ORDER BY created_at`,
      [tenant.tenantId, pending.id],
    );
    expect(events.rows.map((row) => row.status)).toEqual(['ON_LEGAL_HOLD', 'IN_PROGRESS']);

    const restrict = await harness().app.inject({
      method: 'POST',
      url: '/v1/privacy-requests',
      headers: write(tenant.owner),
      payload: {
        person_id: person,
        request_type: 'RESTRICT',
        received_via: 'LETTER',
        verification_method: 'Signed letter matched ID',
      },
    });
    const restrictId = restrict.json<{ id: string }>().id;
    const completeDelete = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${pending.id}/complete`,
      headers: write(tenant.owner),
      payload: { resolution: 'Should be handled by workflow' },
    });
    expect(completeDelete.statusCode).toBe(409);
    const completed = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${restrictId}/complete`,
      headers: write(tenant.owner),
      payload: { resolution: 'Caller memory disabled for this profile' },
    });
    expect(completed.json<{ status: string }>().status).toBe('COMPLETED');
    const profile = await harness().admin.query<{ memory_enabled: boolean }>(
      `SELECT memory_enabled FROM app.caller_profiles WHERE id = $1`,
      [person],
    );
    expect(profile.rows[0]?.memory_enabled).toBe(false);

    const exportRequest = await harness().app.inject({
      method: 'POST',
      url: '/v1/privacy-requests',
      headers: write(tenant.owner),
      payload: {
        person_id: person,
        request_type: 'EXPORT',
        received_via: 'EMAIL',
        verification_method: 'Reply from registered address',
      },
    });
    const exportId = exportRequest.json<{ id: string }>().id;
    const notDownloaded = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${exportId}/complete`,
      headers: write(tenant.owner),
      payload: { resolution: 'Export sent to the requester' },
    });
    expect(notDownloaded.json<{ details: { reason: string } }>().details.reason).toBe(
      'export_not_downloaded',
    );
    const download = await harness().app.inject({
      method: 'GET',
      url: `/v1/contacts/${person}/export`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(download.statusCode, download.body).toBe(200);
    const exportCompleted = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${exportId}/complete`,
      headers: write(tenant.owner),
      payload: { resolution: 'Export sent to the requester' },
    });
    expect(exportCompleted.json<{ status: string }>().status).toBe('COMPLETED');

    const other = await createPerson('Rejected Person');
    const toReject = await harness().app.inject({
      method: 'POST',
      url: '/v1/privacy-requests',
      headers: write(tenant.owner),
      payload: { person_id: other, request_type: 'EXPORT', received_via: 'PHONE' },
    });
    const rejected = await harness().app.inject({
      method: 'POST',
      url: `/v1/privacy-requests/${toReject.json<{ id: string }>().id}/reject`,
      headers: write(tenant.owner),
      payload: { reason: 'Identity could not be verified after two attempts' },
    });
    expect(rejected.json<{ status: string }>().status).toBe('REJECTED');
  });

  it('keeps mandatory notifications on and scopes personal preferences', async () => {
    const mandatory = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(tenant.owner),
      payload: {
        scope: 'WORKSPACE',
        preferences: [
          { notification_type: 'PAYMENT_FAILED_GRACE_STARTED', channel: 'EMAIL', enabled: false },
        ],
      },
    });
    expect(mandatory.statusCode).toBe(400);
    const workspace = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(tenant.owner),
      payload: {
        scope: 'WORKSPACE',
        preferences: [
          { notification_type: 'QUALITY_ALERT', channel: 'EMAIL', enabled: false },
          { notification_type: 'CALLER_BOOKING_CONFIRMATION', channel: 'SMS', enabled: false },
        ],
      },
    });
    expect(workspace.statusCode, workspace.body).toBe(200);

    const analyst = await member('ANALYST');
    const analystWorkspace = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(analyst),
      payload: {
        scope: 'WORKSPACE',
        preferences: [{ notification_type: 'QUALITY_ALERT', channel: 'EMAIL', enabled: true }],
      },
    });
    expect(analystWorkspace.statusCode).toBe(403);
    const callerPersonal = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(analyst),
      payload: {
        scope: 'USER',
        preferences: [
          { notification_type: 'CALLER_BOOKING_CONFIRMATION', channel: 'SMS', enabled: true },
        ],
      },
    });
    expect(callerPersonal.statusCode).toBe(400);
    const personal = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(analyst),
      payload: {
        scope: 'USER',
        preferences: [
          { notification_type: 'KNOWLEDGE_SYNC_FAILED', channel: 'IN_APP', enabled: false },
        ],
      },
    });
    expect(personal.statusCode, personal.body).toBe(200);
    const again = await harness().app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: write(analyst),
      payload: {
        scope: 'USER',
        preferences: [
          { notification_type: 'KNOWLEDGE_SYNC_FAILED', channel: 'IN_APP', enabled: true },
        ],
      },
    });
    expect(again.statusCode).toBe(200);

    const view = await harness().app.inject({
      method: 'GET',
      url: '/v1/notification-preferences',
      headers: browserHeaders(analyst, tenant.tenantId),
    });
    const body = view.json<{
      workspace: { notification_type: string; enabled: boolean }[];
      personal: { notification_type: string; enabled: boolean }[];
      rules: unknown[];
    }>();
    expect(body.workspace.map((entry) => entry.notification_type).sort()).toEqual([
      'CALLER_BOOKING_CONFIRMATION',
      'QUALITY_ALERT',
    ]);
    expect(body.personal).toEqual([
      expect.objectContaining({ notification_type: 'KNOWLEDGE_SYNC_FAILED', enabled: true }),
    ]);
    expect(body.rules.length).toBeGreaterThan(40);
    const ownerView = await harness().app.inject({
      method: 'GET',
      url: '/v1/notification-preferences',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(ownerView.json<{ personal: unknown[] }>().personal).toEqual([]);
  });
});
