import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
const PDF = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

let tenant: SeededTenant;
let phoneOrderId: string;
let workflowRowId: string;
let requirementIds: string[];

async function member(role: string): Promise<TestUser> {
  const user = harness().sessions.issue(
    `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
  );
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  const userId = me.json<{ user: { id: string } }>().user.id;
  await harness().admin.query(
    `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenant.tenantId, userId, role],
  );
  return user;
}

function submission(): { values: Record<string, unknown>[] } {
  return {
    values: [
      { kyc_requirement_id: requirementIds[0], text: '01-09-123456' },
      {
        kyc_requirement_id: requirementIds[1],
        document: { filename: 'proof.pdf', content_base64: PDF },
      },
    ],
  };
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(tenant.owner),
  });
  const ownerId = me.json<{ user: { id: string } }>().user.id;
  const profile = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.billing_profiles (tenant_id, customer_type, legal_name, country, postal_code, city, address_line1, billing_email, hu_tax_number)
     VALUES ($1, 'BUSINESS', 'Demo Kft.', 'HU', '1051', 'Budapest', 'Nádor utca 7.', 'szamla@demo.hu', '12345678-2-41') RETURNING id`,
    [tenant.tenantId],
  );
  const orderId = randomUUID();
  await harness().admin.query(
    `INSERT INTO app.checkout_orders (id, tenant_id, billing_profile_id, created_by_user_id, status, plan_code, pricing_version, market, currency, subtotal_minor, tax_minor, total_minor, terms_version, idempotency_key, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, 'PAID', 'START', '2026-09', 'HU', 'HUF', 3000000, 810000, 3810000, '2026-09-01', $5, now() + interval '1 day', now())`,
    [orderId, tenant.tenantId, profile.rows[0]?.id, ownerId, `checkout:${orderId}`],
  );
  const workflow = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.provisioning_workflows (tenant_id, order_id, temporal_workflow_id, state, blocking_reason) VALUES ($1, $2, $3, 'WAITING_FOR_CUSTOMER', 'regulatory_details_required') RETURNING id`,
    [tenant.tenantId, orderId, `provisioning:${orderId}`],
  );
  workflowRowId = workflow.rows[0]?.id ?? '';
  await harness().admin.query(
    `INSERT INTO app.provisioning_step_runs (tenant_id, workflow_id, step, status, idempotency_key) VALUES ($1, $2, 'BILLING_DOCUMENT', 'SUCCEEDED', $3)`,
    [tenant.tenantId, workflowRowId, `provisioning:${orderId}:billing_document`],
  );
  const order = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.phone_orders (tenant_id, workflow_id, provider, e164, country, number_type, status, requirements_status, inventory_checked_at, idempotency_key)
     VALUES ($1, $2, 'telnyx', '+3612345678', 'HU', 'LOCAL', 'KYC_REQUIRED', 'REQUIRED', now(), $3) RETURNING id`,
    [tenant.tenantId, workflowRowId, `provisioning:${orderId}:phone`],
  );
  phoneOrderId = order.rows[0]?.id ?? '';
  const requirements = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.kyc_requirements (tenant_id, phone_order_id, provider_requirement_id, field_type, label_key)
     VALUES ($1, $2, 'req-registration', 'TEXTUAL', 'carrier.requirement.registration'), ($1, $2, 'req-proof', 'DOCUMENT', 'carrier.requirement.proof') RETURNING id`,
    [tenant.tenantId, phoneOrderId],
  );
  requirementIds = requirements.rows.map((row) => row.id);
});

beforeEach(() => {
  harness().provisioning.requests.length = 0;
  harness().provisioning.respond = () => ({ ok: true, result: {} });
});

describe('provisioning status', () => {
  it('shows the onboarding pipeline and outstanding regulatory requirements without submitted values', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/provisioning',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      workflow: Record<string, unknown>;
      steps: Record<string, unknown>[];
      phone_orders: { requirements: Record<string, unknown>[] }[];
    }>();
    expect(body.workflow).toMatchObject({
      id: workflowRowId,
      state: 'WAITING_FOR_CUSTOMER',
      blocking_reason: 'regulatory_details_required',
    });
    expect(body.steps).toEqual([
      expect.objectContaining({ step: 'BILLING_DOCUMENT', status: 'SUCCEEDED' }),
    ]);
    expect(body.phone_orders).toEqual([
      expect.objectContaining({
        id: phoneOrderId,
        e164: '+3612345678',
        status: 'KYC_REQUIRED',
        requirements: [
          {
            id: requirementIds[0],
            field_type: 'TEXTUAL',
            label_key: 'carrier.requirement.registration',
            status: 'REQUIRED',
            decline_reason: null,
            submitted_at: null,
            reviewed_at: null,
          },
          {
            id: requirementIds[1],
            field_type: 'DOCUMENT',
            label_key: 'carrier.requirement.proof',
            status: 'REQUIRED',
            decline_reason: null,
            submitted_at: null,
            reviewed_at: null,
          },
        ],
      }),
    ]);
    const viewer = await member('VIEWER');
    const denied = await harness().app.inject({
      method: 'GET',
      url: '/v1/provisioning',
      headers: browserHeaders(viewer, tenant.tenantId),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('KYC submission', () => {
  it('forwards the submission to the workflow worker once per idempotency key', async () => {
    harness().provisioning.respond = () => ({
      ok: true,
      result: {
        phone_order_id: phoneOrderId,
        status: 'SUBMITTED',
        requirement_group_ref: 'rg_1',
        workflow_signaled: true,
      },
    });
    const key = `kyc-${randomUUID()}`;
    const request = {
      method: 'POST' as const,
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, { 'idempotency-key': key }),
      payload: submission(),
    };
    const first = await harness().app.inject(request);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toEqual({
      phone_order_id: phoneOrderId,
      status: 'SUBMITTED',
      requirement_group_ref: 'rg_1',
      workflow_signaled: true,
    });
    const replay = await harness().app.inject(request);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(harness().provisioning.requests).toHaveLength(1);
    expect(harness().provisioning.requests[0]).toMatchObject({
      tenantId: tenant.tenantId,
      request: { action: 'KYC_SUBMIT', phone_order_id: phoneOrderId, values: submission().values },
    });
    const audit = await harness().admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_logs WHERE tenant_id = $1 AND action = 'phone_order.kyc_submitted'`,
      [tenant.tenantId],
    );
    expect(audit.rows).toEqual([
      { metadata: { requirement_count: 2, requirement_group_ref: 'rg_1' } },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('01-09-123456');
  });

  it('maps worker failures to API errors and lets the caller retry', async () => {
    const headers = (): Record<string, string> =>
      browserHeaders(tenant.owner, tenant.tenantId, { 'idempotency-key': `kyc-${randomUUID()}` });
    harness().provisioning.respond = () => ({
      ok: false,
      errorCode: 'VALIDATION_FAILED',
      details: {
        issues: [{ path: `/values/${requirementIds[1] ?? ''}`, rule: 'field_type_document' }],
      },
    });
    const invalid = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: headers(),
      payload: submission(),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ code: string; details: unknown }>()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ rule: 'field_type_document' }] },
    });

    harness().provisioning.respond = () => ({
      ok: false,
      errorCode: 'SERVICE_UNAVAILABLE',
      details: null,
    });
    const unavailable = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: headers(),
      payload: submission(),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('30');

    harness().provisioning.respond = () => ({
      ok: false,
      errorCode: 'SERVICE_TOKEN_INVALID',
      details: null,
    });
    const misconfigured = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: headers(),
      payload: submission(),
    });
    expect(misconfigured.statusCode).toBe(500);
  });

  it('validates payloads, permissions and order state before contacting the worker', async () => {
    const billing = await member('BILLING');
    const forbidden = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: browserHeaders(billing, tenant.tenantId, {
        'idempotency-key': `kyc-${randomUUID()}`,
      }),
      payload: submission(),
    });
    expect(forbidden.statusCode).toBe(403);
    const malformed = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${phoneOrderId}/kyc-submissions`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `kyc-${randomUUID()}`,
      }),
      payload: {
        values: [
          {
            kyc_requirement_id: requirementIds[1],
            document: { filename: 'malware.exe', content_base64: PDF },
          },
        ],
      },
    });
    expect(malformed.statusCode).toBe(400);
    const unknown = await harness().app.inject({
      method: 'POST',
      url: `/v1/phone-orders/${randomUUID()}/kyc-submissions`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `kyc-${randomUUID()}`,
      }),
      payload: submission(),
    });
    expect(unknown.statusCode).toBe(404);
    expect(harness().provisioning.requests).toHaveLength(0);
  });
});

describe('provisioning cancellation', () => {
  it('lets billing managers cancel an unfinished onboarding', async () => {
    harness().provisioning.respond = () => ({
      ok: true,
      result: { workflow_id: workflowRowId, state: 'WAITING_FOR_CUSTOMER', signal: 'CANCEL' },
    });
    const billing = await member('BILLING');
    const response = await harness().app.inject({
      method: 'POST',
      url: '/v1/provisioning/cancel',
      headers: browserHeaders(billing, tenant.tenantId, {
        'idempotency-key': `cancel-${randomUUID()}`,
      }),
      payload: { reason: 'customer_requested' },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(harness().provisioning.requests[0]?.request).toMatchObject({
      action: 'CANCEL',
      reason: 'customer_requested',
    });
    const operator = await member('OPERATOR');
    const denied = await harness().app.inject({
      method: 'POST',
      url: '/v1/provisioning/cancel',
      headers: browserHeaders(operator, tenant.tenantId, {
        'idempotency-key': `cancel-${randomUUID()}`,
      }),
      payload: { reason: 'customer_requested' },
    });
    expect(denied.statusCode).toBe(403);
  });
});
