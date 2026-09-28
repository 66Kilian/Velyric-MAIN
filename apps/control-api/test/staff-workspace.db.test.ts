import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedPlatformStaff, seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let lead: Awaited<ReturnType<typeof seedPlatformStaff>>;
let agent: Awaited<ReturnType<typeof seedPlatformStaff>>;

function write(user: TestUser, workspace: string): Record<string, string> {
  return browserHeaders(user, workspace, { 'idempotency-key': `staffws-${randomUUID()}` });
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  lead = await seedPlatformStaff(harness(), 'SUPPORT_LEAD');
  agent = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
});

describe('staff working inside a customer workspace', () => {
  it('opens the workspace without a membership and reads its configuration', async () => {
    const workspace = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: browserHeaders(lead.user, tenant.tenantId),
    });
    expect(workspace.statusCode, workspace.body).toBe(200);
    expect(workspace.json()).toMatchObject({ id: tenant.tenantId });

    const agents = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: browserHeaders(lead.user, tenant.tenantId),
    });
    expect(agents.statusCode, agents.body).toBe(200);

    const locations = await harness().app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: browserHeaders(lead.user, tenant.tenantId),
    });
    expect(locations.statusCode, locations.body).toBe(200);
  });

  it('writes as the staff member, and the audit row names them', async () => {
    const current = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: browserHeaders(lead.user, tenant.tenantId),
    });
    const version = current.json<{ version: number }>().version;
    const updated = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: {
        ...write(lead.user, tenant.tenantId),
        'if-match': `W/"${String(version)}"`,
      },
      payload: { timezone: 'Europe/Vienna' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ timezone: 'Europe/Vienna' });

    const audit = await harness().admin.query<{
      actor_type: string;
      actor_label: string | null;
      action: string;
    }>(
      `SELECT actor_type, actor_label, action FROM app.audit_logs
       WHERE tenant_id = $1 AND actor_type = 'SUPPORT_STAFF' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'SUPPORT_STAFF',
      actor_label: lead.email,
    });
  });

  it('gives a read-only rank read access but refuses writes', async () => {
    const read = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: browserHeaders(agent.user, tenant.tenantId),
    });
    expect(read.statusCode, read.body).toBe(200);

    const denied = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: {
        ...write(agent.user, tenant.tenantId),
        'if-match': 'W/"1"',
      },
      payload: { timezone: 'Europe/Prague' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('never lets staff cancel a customer workspace', async () => {
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/workspaces/${tenant.tenantId}/cancellation`,
      headers: write(lead.user, tenant.tenantId),
      payload: { reason: 'staff should not be able to do this' },
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('still refuses a customer who belongs to another workspace', async () => {
    const other = await seedRuntimeTenant(harness());
    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${tenant.tenantId}`,
      headers: browserHeaders(other.owner, tenant.tenantId),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ details: { reason: 'not_a_member' } });
  });

  it('refuses an unknown workspace even for staff', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: browserHeaders(lead.user, randomUUID()),
    });
    expect(response.statusCode).toBe(403);
  });
});
