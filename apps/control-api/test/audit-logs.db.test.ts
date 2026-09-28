import { randomUUID } from 'node:crypto';
import { generateApiKey } from '@velyric/security';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, TEST_ORIGIN, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();

let tenant: SeededTenant;
let other: SeededTenant;

interface AuditEntry {
  id: string;
  action: string;
  actor: { type: string; id: string | null };
  object: { type: string; id: string | null };
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

async function member(target: SeededTenant, role: string): Promise<TestUser> {
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
    [target.tenantId, userId, role],
  );
  return user;
}

async function list(
  user: TestUser,
  query = '',
): Promise<{ status: number; data: AuditEntry[]; next: string | null }> {
  const response = await harness().app.inject({
    method: 'GET',
    url: `/v1/audit-logs${query}`,
    headers: browserHeaders(user, tenant.tenantId),
  });
  if (response.statusCode !== 200) {
    return { status: response.statusCode, data: [], next: null };
  }
  const body = response.json<{ data: AuditEntry[]; page: { next_cursor: string | null } }>();
  return { status: 200, data: body.data, next: body.page.next_cursor };
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  other = await seedRuntimeTenant(harness());
  const insert = `INSERT INTO app.audit_logs (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata, ip, user_agent, occurred_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  await harness().admin.query(insert, [
    tenant.tenantId,
    'USER',
    'user-1',
    'custom_tool.created',
    'tool_definition',
    'tool-1',
    '{"name":"lookup"}',
    '203.0.113.77',
    'Mozilla/5.0',
    '2026-09-10T08:00:00Z',
  ]);
  await harness().admin.query(insert, [
    tenant.tenantId,
    'USER',
    'user-2',
    'custom_tool.disabled',
    'tool_definition',
    'tool-1',
    '{}',
    '2001:db8:85a3::8a2e:370:7334',
    'curl/8',
    '2026-09-11T08:00:00Z',
  ]);
  await harness().admin.query(insert, [
    tenant.tenantId,
    'API_KEY',
    'key-1',
    'call.terminate_requested',
    'call',
    'call-1',
    '{"reason":"abuse"}',
    null,
    null,
    '2026-09-12T08:00:00Z',
  ]);
  await harness().admin.query(insert, [
    other.tenantId,
    'USER',
    'user-9',
    'custom_tool.created',
    'tool_definition',
    'tool-9',
    '{}',
    '198.51.100.1',
    'x',
    '2026-09-12T09:00:00Z',
  ]);
});

describe('audit log API', () => {
  it('lists only the active tenant with filters and cursor pagination', async () => {
    const all = await list(tenant.owner, '?limit=100');
    expect(all.data.map((entry) => entry.object.id)).not.toContain('tool-9');
    const seeded = all.data.filter((entry) => ['tool-1', 'call-1'].includes(entry.object.id ?? ''));
    expect(seeded.map((entry) => entry.action)).toEqual([
      'call.terminate_requested',
      'custom_tool.disabled',
      'custom_tool.created',
    ]);

    const prefix = await list(tenant.owner, '?action=custom_tool.&object_id=tool-1&limit=1');
    expect(prefix.data.map((entry) => entry.action)).toEqual(['custom_tool.disabled']);
    expect(prefix.next).not.toBeNull();
    const second = await list(
      tenant.owner,
      `?action=custom_tool.&object_id=tool-1&limit=1&cursor=${encodeURIComponent(prefix.next ?? '')}`,
    );
    expect(second.data.map((entry) => entry.action)).toEqual(['custom_tool.created']);
    expect(second.next).toBeNull();

    const window = await list(
      tenant.owner,
      '?from=2026-09-11T00:00:00Z&to=2026-09-12T00:00:00Z&actor_type=USER',
    );
    expect(window.data.map((entry) => entry.actor.id)).toEqual(['user-2']);
    const inverted = await harness().app.inject({
      method: 'GET',
      url: '/v1/audit-logs?from=2026-09-12T00:00:00Z&to=2026-09-11T00:00:00Z',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(inverted.statusCode).toBe(400);
  });

  it('shows network details to owners and admins and masks them for API key exports', async () => {
    const owner = await list(tenant.owner, '?object_id=tool-1');
    expect(owner.data.map((entry) => [entry.ip, entry.user_agent])).toEqual([
      ['2001:db8:85a3::8a2e:370:7334', 'curl/8'],
      ['203.0.113.77', 'Mozilla/5.0'],
    ]);
    const admin = await member(tenant, 'ADMIN');
    expect((await list(admin, '?object_id=tool-1')).data.map((entry) => entry.ip)).toEqual([
      '2001:db8:85a3::8a2e:370:7334',
      '203.0.113.77',
    ]);
    const ownerId = (
      await harness().app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: browserHeaders(tenant.owner),
      })
    ).json<{ user: { id: string } }>().user.id;
    const key = generateApiKey('test', harness().apiKeyPepper);
    await harness().admin.query(
      `INSERT INTO app.api_keys (tenant_id, name, prefix, key_hash, scopes, created_by_user_id) VALUES ($1, 'SIEM export', $2, $3, $4, $5)`,
      [tenant.tenantId, key.prefix, key.hash, ['audit_logs:read'], ownerId],
    );
    const exported = await harness().app.inject({
      method: 'GET',
      url: '/v1/audit-logs?object_id=tool-1',
      headers: { authorization: `Bearer ${key.plaintext}`, origin: TEST_ORIGIN },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(
      exported.json<{ data: AuditEntry[] }>().data.map((entry) => [entry.ip, entry.user_agent]),
    ).toEqual([
      ['2001:db8:85a3::/48', null],
      ['203.0.113.0/24', null],
    ]);
    const developer = await member(tenant, 'DEVELOPER');
    expect((await list(developer)).status).toBe(403);
    const viewer = await member(tenant, 'VIEWER');
    expect((await list(viewer)).status).toBe(403);
  });

  it('names the people behind entries and filters several event groups at once', async () => {
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(tenant.owner),
    });
    const ownerId = me.json<{ user: { id: string } }>().user.id;
    await harness().admin.query(`UPDATE app.users SET display_name = 'Kovács Anna' WHERE id = $1`, [
      ownerId,
    ]);
    await harness().admin.query(
      `INSERT INTO app.audit_logs (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata, occurred_at)
       VALUES ($1, 'USER', $2, 'messaging.logo_updated', 'tenant', $3, '{}', '2026-09-12T08:00:00Z'),
              ($1, 'USER', $2, 'member.invited', 'membership', 'member-1', '{}', '2026-09-12T08:01:00Z')`,
      [tenant.tenantId, ownerId, 'tenant-object'],
    );
    const grouped = await list(
      tenant.owner,
      '?action=messaging.,member.,notification_preferences.',
    );
    expect(grouped.status).toBe(200);
    expect(grouped.data.map((entry) => entry.action)).toEqual([
      'member.invited',
      'messaging.logo_updated',
    ]);
    const actor = grouped.data[0]?.actor as { name?: string | null; email?: string | null };
    expect(actor.name).toBe('Kovács Anna');
    expect(actor.email).toMatch(/@example\.test$/);
    expect((await list(tenant.owner, '?action=messaging.,bad value')).status).toBe(400);
  });

  it('does not reveal entries of other tenants by id', async () => {
    const foreign = await harness().admin.query<{ id: string }>(
      `SELECT id FROM app.audit_logs WHERE tenant_id = $1 AND object_id = 'tool-9'`,
      [other.tenantId],
    );
    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/audit-logs/${foreign.rows[0]?.id ?? ''}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(response.statusCode).toBe(404);
    const own = await harness().admin.query<{ id: string }>(
      `SELECT id FROM app.audit_logs WHERE tenant_id = $1 AND object_id = 'call-1'`,
      [tenant.tenantId],
    );
    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/audit-logs/${own.rows[0]?.id ?? ''}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json<AuditEntry>()).toMatchObject({
      action: 'call.terminate_requested',
      actor: { type: 'API_KEY', id: 'key-1' },
      metadata: { reason: 'abuse' },
    });
  });
});
