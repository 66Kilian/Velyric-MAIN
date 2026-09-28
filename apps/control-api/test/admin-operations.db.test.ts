import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedPlatformStaff, seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let ops: Awaited<ReturnType<typeof seedPlatformStaff>>;
let finance: Awaited<ReturnType<typeof seedPlatformStaff>>;
let agent: Awaited<ReturnType<typeof seedPlatformStaff>>;
const period = '2026-09-01T00:00:00.000Z';

function write(user: TestUser): Record<string, string> {
  return browserHeaders(user, undefined, { 'idempotency-key': `ops-${randomUUID()}` });
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  ops = await seedPlatformStaff(harness(), 'PLATFORM_OPS');
  finance = await seedPlatformStaff(harness(), 'FINANCE_OPS');
  agent = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
  await harness().admin.query(
    `INSERT INTO app.usage_aggregates (tenant_id, billing_period_start, metric, quantity, cost_usd_micros, event_count)
     VALUES ($1, $2, 'billable_voice_seconds', 1200, 4500000, 300),
            ($1, $2, 'backend_input_tokens', 950000, 190000, 820)`,
    [tenant.tenantId, period],
  );
  await harness().admin.query(
    `INSERT INTO app.cost_budgets (tenant_id, billing_period_start, billing_period_end, period_budget_usd_micros, daily_cap_usd_micros, monthly_cap_usd_micros, consumed_usd_micros, hard_cap_reached_at)
     VALUES ($1, $2, $3, 20000000, 2000000, 20000000, 19500000, now())`,
    [tenant.tenantId, period, '2026-10-01T00:00:00.000Z'],
  );
});

describe('staff administration of a customer', () => {
  it('suspends and restores a workspace with an audited reason', async () => {
    const suspended = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/status`,
      headers: write(ops.user),
      payload: { status: 'SUSPENDED_ADMIN', reason: 'fizetési vizsgálat folyamatban' },
    });
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(suspended.json()).toMatchObject({ status: 'SUSPENDED_ADMIN' });

    const repeat = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/status`,
      headers: write(ops.user),
      payload: { status: 'SUSPENDED_ADMIN', reason: 'ugyanaz az állapot újra' },
    });
    expect(repeat.statusCode).toBe(409);

    const history = await harness().admin.query<{ to_status: string; actor_type: string }>(
      `SELECT to_status, actor_type FROM app.tenant_status_history WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(history.rows[0]).toMatchObject({
      to_status: 'SUSPENDED_ADMIN',
      actor_type: 'SUPPORT_STAFF',
    });

    const restored = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/status`,
      headers: write(ops.user),
      payload: { status: 'ACTIVE', reason: 'vizsgálat lezárva, minden rendben' },
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const denied = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/status`,
      headers: write(agent.user),
      payload: { status: 'RESTRICTED', reason: 'ügyfélszolgálat nem tehetné' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('shows usage for a period and applies a compensating adjustment', async () => {
    const usage = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/usage?period=${encodeURIComponent(period)}`,
      headers: browserHeaders(ops.user),
    });
    expect(usage.statusCode, usage.body).toBe(200);
    const rows = usage.json<{
      data: { metric: string; quantity: number; adjusted_quantity: number }[];
      periods: string[];
    }>();
    expect(rows.periods).toContain(period);
    const voice = rows.data.find((row) => row.metric === 'billable_voice_seconds');
    expect(voice).toMatchObject({ quantity: 1200, adjusted_quantity: 1200 });

    const adjusted = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/usage-adjustments`,
      headers: write(ops.user),
      payload: {
        billing_period_start: period,
        metric: 'billable_voice_seconds',
        delta_quantity: -200,
        delta_cost_usd_micros: -750000,
        reason: 'hibás mérés a szolgáltatói kiesés miatt',
      },
    });
    expect(adjusted.statusCode, adjusted.body).toBe(201);

    const after = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/usage?period=${encodeURIComponent(period)}`,
      headers: browserHeaders(ops.user),
    });
    const corrected = after
      .json<{ data: { metric: string; quantity: number; adjusted_quantity: number }[] }>()
      .data.find((row) => row.metric === 'billable_voice_seconds');
    expect(corrected).toMatchObject({ quantity: 1200, adjusted_quantity: 1000 });

    const original = await harness().admin.query<{ quantity: string }>(
      `SELECT quantity FROM app.usage_aggregates WHERE tenant_id = $1 AND metric = 'billable_voice_seconds'`,
      [tenant.tenantId],
    );
    expect(Number(original.rows[0]?.quantity)).toBe(1200);
  });

  it('keeps usage adjustments away from ranks without the permission', async () => {
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/usage-adjustments`,
      headers: write(agent.user),
      payload: {
        billing_period_start: period,
        metric: 'billable_voice_seconds',
        delta_quantity: -1000,
        reason: 'ügyfélszolgálat nem írhatja felül',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('credits a balance, keeps the ledger append only and shows the running total', async () => {
    const credited = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/balance-entries`,
      headers: write(finance.user),
      payload: {
        kind: 'CREDIT',
        amount_minor: 50000,
        currency: 'HUF',
        reason: 'kompenzáció a szolgáltatás kiesés miatt',
      },
    });
    expect(credited.statusCode, credited.body).toBe(201);
    expect(credited.json()).toMatchObject({ balance_minor: 50000 });

    const debited = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/balance-entries`,
      headers: write(finance.user),
      payload: {
        kind: 'DEBIT',
        amount_minor: 20000,
        currency: 'HUF',
        reason: 'tévesen jóváírt összeg visszavonása',
      },
    });
    expect(debited.json()).toMatchObject({ balance_minor: 30000, amount_minor: -20000 });

    const finances = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/finance`,
      headers: browserHeaders(finance.user),
    });
    expect(finances.statusCode, finances.body).toBe(200);
    const body = finances.json<{
      balances: { currency: string; balance_minor: number }[];
      entries: { staff_label: string | null }[];
      budget: { consumed_usd_micros: number } | null;
    }>();
    expect(body.balances).toEqual([
      expect.objectContaining({ currency: 'HUF', balance_minor: 30000 }),
    ]);
    expect(body.entries[0]?.staff_label).toBe(finance.email);
    expect(body.budget?.consumed_usd_micros).toBe(19500000);

    await expect(
      harness().admin.query(
        `UPDATE app.balance_entries SET amount_minor = 1 WHERE tenant_id = $1`,
        [tenant.tenantId],
      ),
    ).rejects.toThrow();
  });

  it('refuses balance changes from a rank without the permission', async () => {
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/balance-entries`,
      headers: write(agent.user),
      payload: {
        kind: 'CREDIT',
        amount_minor: 1000,
        currency: 'HUF',
        reason: 'ügyfélszolgálat nem írhat jóvá',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('raises the spend cap and clears a reached hard cap', async () => {
    const updated = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenant.tenantId}/budget`,
      headers: write(finance.user),
      payload: {
        period_budget_usd_micros: 40000000,
        monthly_cap_usd_micros: 40000000,
        clear_hard_cap: true,
        reason: 'ügyfél kérésére megemelt keret',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      period_budget_usd_micros: 40000000,
      hard_cap_reached_at: null,
    });

    const invalid = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenant.tenantId}/budget`,
      headers: write(finance.user),
      payload: {
        daily_cap_usd_micros: 90000000,
        reason: 'napi keret a havi fölé menne',
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('lists numbers with provisioning state and can suspend one', async () => {
    const numbers = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/numbers`,
      headers: browserHeaders(ops.user),
    });
    expect(numbers.statusCode, numbers.body).toBe(200);
    const list = numbers.json<{ numbers: { id: string; status: string }[] }>().numbers;
    expect(list.length).toBeGreaterThan(0);
    const target = list[0];

    const suspended = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/numbers/${target?.id ?? ''}/status`,
      headers: write(ops.user),
      payload: { status: 'SUSPENDED', reason: 'visszaélés gyanúja miatt felfüggesztve' },
    });
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(suspended.json()).toMatchObject({ status: 'SUSPENDED' });

    const bindings = await harness().admin.query<{ active: boolean }>(
      `SELECT active FROM app.agent_phone_bindings WHERE phone_number_id = $1`,
      [target?.id ?? ''],
    );
    expect(bindings.rows.every((row) => !row.active)).toBe(true);
  });

  it('shows credential metadata without ever returning the secret', async () => {
    await harness().admin.query(
      `INSERT INTO app.tenant_secret_refs (tenant_id, kind, provider, secret_ref, secret_version, status, external_key_id)
       VALUES ($1, 'OPENAI_SERVICE_ACCOUNT_KEY', 'openai', 'local-vault://tenant/openai', 1, 'ACTIVE', 'key_abc')`,
      [tenant.tenantId],
    );
    const secrets = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/secrets`,
      headers: browserHeaders(ops.user),
    });
    expect(secrets.statusCode, secrets.body).toBe(200);
    expect(secrets.body).not.toContain('local-vault://');
    const row = secrets
      .json<{ data: { id: string; kind: string; status: string }[] }>()
      .data.find((entry) => entry.kind === 'OPENAI_SERVICE_ACCOUNT_KEY');
    expect(row).toMatchObject({ status: 'ACTIVE' });

    const revoked = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/secrets/${row?.id ?? ''}/revoke`,
      headers: write(ops.user),
      payload: { reason: 'kulcs kiszivárgott, azonnali visszavonás' },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'REVOKED' });

    const again = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/secrets/${row?.id ?? ''}/revoke`,
      headers: write(ops.user),
      payload: { reason: 'második visszavonási kísérlet' },
    });
    expect(again.statusCode).toBe(409);

    const denied = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/secrets`,
      headers: browserHeaders(agent.user),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('reports platform wide usage and revenue', async () => {
    const usage = await harness().app.inject({
      method: 'GET',
      url: '/v1/admin/usage?days=365',
      headers: browserHeaders(ops.user),
    });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(
      usage.json<{ data: { metric: string; quantity: number }[] }>().data.length,
    ).toBeGreaterThan(0);

    const revenue = await harness().app.inject({
      method: 'GET',
      url: '/v1/admin/revenue?days=365',
      headers: browserHeaders(finance.user),
    });
    expect(revenue.statusCode, revenue.body).toBe(200);
  });

  it('opens a time boxed break-glass session and revokes it', async () => {
    const lead = await seedPlatformStaff(harness(), 'SUPPORT_LEAD');
    const opened = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/support-sessions`,
      headers: write(lead.user),
      payload: {
        access_level: 'SENSITIVE',
        reason: 'hívás átirat ellenőrzése panasz miatt',
        minutes: 60,
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const grantId = opened.json<{ id: string; status: string }>().id;
    expect(opened.json()).toMatchObject({ status: 'ACTIVE', access_level: 'SENSITIVE' });

    const audit = await harness().admin.query<{ support_grant_id: string | null }>(
      `SELECT support_grant_id FROM app.audit_logs WHERE action = 'support_access.granted' AND tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(audit.rows[0]?.support_grant_id).toBe(grantId);

    const sessions = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenant.tenantId}/support-sessions`,
      headers: browserHeaders(lead.user),
    });
    expect(sessions.json<{ data: { id: string; staff_email: string }[] }>().data[0]).toMatchObject({
      id: grantId,
      staff_email: lead.email,
    });

    const revoked = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/support-sessions/${grantId}/revoke`,
      headers: write(lead.user),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'REVOKED' });
  });

  it('refuses a sensitive session to a rank that may not read sensitive content', async () => {
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/support-sessions`,
      headers: write(agent.user),
      payload: { access_level: 'SENSITIVE', reason: 'ügyfélszolgálat nem kaphat bizalmas szintet' },
    });
    expect(response.statusCode).toBe(403);

    const redacted = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenant.tenantId}/support-sessions`,
      headers: write(agent.user),
      payload: { access_level: 'REDACTED', reason: 'maszkolt adatok megtekintése hibakereséshez' },
    });
    expect(redacted.statusCode, redacted.body).toBe(201);
  });

  it('never lets a customer reach the staff endpoints', async () => {
    for (const url of [
      `/v1/admin/tenants/${tenant.tenantId}/usage`,
      `/v1/admin/tenants/${tenant.tenantId}/finance`,
      `/v1/admin/tenants/${tenant.tenantId}/numbers`,
      '/v1/admin/usage',
      '/v1/admin/revenue',
    ]) {
      const response = await harness().app.inject({
        method: 'GET',
        url,
        headers: browserHeaders(tenant.owner, tenant.tenantId),
      });
      expect(response.statusCode, url).toBe(403);
    }
  });
});
