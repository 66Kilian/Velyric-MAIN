import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedPlatformStaff, seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let admin: Awaited<ReturnType<typeof seedPlatformStaff>>;

function get(url: string, user: TestUser, workspace?: string) {
  return harness().app.inject({ method: 'GET', url, headers: browserHeaders(user, workspace) });
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  admin = await seedPlatformStaff(harness(), 'PLATFORM_ADMIN');
});

describe('admin console access', () => {
  it('hides every endpoint from a signed-in customer', async () => {
    for (const url of [
      '/v1/admin/me',
      '/v1/admin/stats',
      '/v1/admin/tenants',
      `/v1/admin/tenants/${tenant.tenantId}`,
      '/v1/admin/audit-logs',
      '/v1/admin/staff',
    ]) {
      const response = await get(url, tenant.owner, tenant.tenantId);
      expect(response.statusCode, `${url} ${response.body}`).toBe(403);
    }
  });

  it('refuses a staff member whose row was deactivated', async () => {
    const suspended = await seedPlatformStaff(harness(), 'PLATFORM_OPS', false);
    const response = await get('/v1/admin/me', suspended.user);
    expect(response.statusCode).toBe(403);
  });

  it('enforces the permission set of each rank', async () => {
    const agent = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
    const identity = await get('/v1/admin/me', agent.user);
    expect(identity.statusCode, identity.body).toBe(200);
    expect(identity.json()).toMatchObject({ platform_role: 'SUPPORT_AGENT' });
    expect(identity.json<{ permissions: string[] }>().permissions).toContain(
      'platform.tickets:read',
    );
    expect(identity.json<{ permissions: string[] }>().permissions).not.toContain(
      'platform.staff:manage',
    );

    const staffList = await get('/v1/admin/staff', agent.user);
    expect(staffList.statusCode).toBe(403);
    expect(staffList.json()).toMatchObject({
      details: { required_permission: 'platform.staff:manage' },
    });

    const tenants = await get('/v1/admin/tenants', agent.user);
    expect(tenants.statusCode, tenants.body).toBe(200);
  });
});

describe('admin console reads', () => {
  it('lists and searches customers across tenants', async () => {
    const all = await get('/v1/admin/tenants', admin.user);
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json<{ data: { id: string; member_count: number }[]; total: number }>();
    expect(body.total).toBeGreaterThan(0);
    const seeded = body.data.find((row) => row.id === tenant.tenantId);
    expect(seeded).toBeDefined();
    expect(seeded?.member_count).toBe(1);

    const byId = await get(`/v1/admin/tenants?query=${tenant.tenantId}`, admin.user);
    expect(byId.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toEqual([
      tenant.tenantId,
    ]);

    const missing = await get('/v1/admin/tenants?query=nothing-matches-this', admin.user);
    expect(missing.json<{ data: unknown[]; total: number }>()).toMatchObject({
      data: [],
      total: 0,
    });
  });

  it('opens one customer with its service state', async () => {
    const response = await get(`/v1/admin/tenants/${tenant.tenantId}`, admin.user);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: tenant.tenantId,
      owner_email: tenant.owner.session.email,
      member_count: 1,
      location_count: 1,
    });
    expect(response.json<{ phone_numbers: unknown[] }>().phone_numbers.length).toBeGreaterThan(0);

    const unknown = await get(`/v1/admin/tenants/${randomUUID()}`, admin.user);
    expect(unknown.statusCode).toBe(404);
  });

  it('reports platform statistics', async () => {
    const response = await get('/v1/admin/stats', admin.user);
    expect(response.statusCode, response.body).toBe(200);
    const stats = response.json<{ tenants: { total: number }; staff_active: number }>();
    expect(stats.tenants.total).toBeGreaterThan(0);
    expect(stats.staff_active).toBeGreaterThan(0);
  });

  it('reads audit rows across tenants, including platform-scoped ones', async () => {
    const feed = await get('/v1/admin/audit-logs?limit=200', admin.user);
    expect(feed.statusCode, feed.body).toBe(200);
    const rows = feed.json<{ data: { tenant_id: string | null; action: string }[] }>().data;
    expect(rows.some((row) => row.tenant_id === tenant.tenantId)).toBe(true);

    const scoped = await get(`/v1/admin/audit-logs?tenant_id=${tenant.tenantId}`, admin.user);
    expect(
      scoped
        .json<{ data: { tenant_id: string | null }[] }>()
        .data.every((row) => row.tenant_id === tenant.tenantId),
    ).toBe(true);
  });
});

describe('staff rank management', () => {
  it('promotes a user, records it in the platform audit trail and refuses self service', async () => {
    const target = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
    const promoted = await harness().app.inject({
      method: 'PUT',
      url: `/v1/admin/staff/${target.userId}`,
      headers: browserHeaders(admin.user, undefined, {
        'idempotency-key': `staff-${randomUUID()}`,
      }),
      payload: { platform_role: 'SUPPORT_LEAD', active: true, reason: 'promoted after onboarding' },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json()).toMatchObject({
      user_id: target.userId,
      platform_role: 'SUPPORT_LEAD',
      active: true,
    });

    const identity = await get('/v1/admin/me', target.user);
    expect(identity.json()).toMatchObject({ platform_role: 'SUPPORT_LEAD' });

    const feed = await get('/v1/admin/audit-logs?action=platform.staff_updated', admin.user);
    expect(
      feed.json<{ data: { object_id: string; actor: { label: string | null } }[] }>().data[0],
    ).toMatchObject({ object_id: target.userId, actor: { label: admin.email } });

    const self = await harness().app.inject({
      method: 'PUT',
      url: `/v1/admin/staff/${admin.userId}`,
      headers: browserHeaders(admin.user, undefined, {
        'idempotency-key': `staff-${randomUUID()}`,
      }),
      payload: { platform_role: 'SUPPORT_AGENT', active: true, reason: 'trying to demote myself' },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ details: { reason: 'cannot_change_own_role' } });
  });

  it('keeps rank changes away from ranks that only support customers', async () => {
    const lead = await seedPlatformStaff(harness(), 'SUPPORT_LEAD');
    const target = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
    const response = await harness().app.inject({
      method: 'PUT',
      url: `/v1/admin/staff/${target.userId}`,
      headers: browserHeaders(lead.user, undefined, { 'idempotency-key': `staff-${randomUUID()}` }),
      payload: { platform_role: 'PLATFORM_ADMIN', active: true, reason: 'attempted escalation' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('looks a user up by email before granting them a rank', async () => {
    const response = await get(
      `/v1/admin/staff/lookup?email=${encodeURIComponent(tenant.owner.session.email)}`,
      admin.user,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      email: tenant.owner.session.email,
      platform_role: null,
      active: false,
    });
  });
});
