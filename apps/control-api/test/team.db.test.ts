import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, TEST_ORIGIN, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

interface Member {
  id: string;
  email: string | null;
  role: string;
  status: string;
  version: number;
  user_id: string | null;
}

function write(user: TestUser, extra: Record<string, string> = {}): Record<string, string> {
  return browserHeaders(user, tenant.tenantId, {
    'idempotency-key': `team-${randomUUID()}`,
    ...extra,
  });
}

async function userId(user: TestUser): Promise<string> {
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  return me.json<{ user: { id: string } }>().user.id;
}

async function addMember(
  role: string,
  email = `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
): Promise<{ user: TestUser; membershipId: string }> {
  const user = harness().sessions.issue(email);
  const id = await userId(user);
  const inserted = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [tenant.tenantId, id, role],
  );
  return { user, membershipId: inserted.rows[0]?.id ?? '' };
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

describe('member invitations', () => {
  it('invites by email, queues the invitation email and lets only the invited address accept', async () => {
    const email = `new-operator-${randomUUID().slice(0, 6)}@example.test`;
    const invited = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: write(tenant.owner),
      payload: {
        email: email.toUpperCase(),
        role: 'OPERATOR',
        location_scope: [tenant.locationId],
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const member = invited.json<Member>();
    expect(member).toMatchObject({ email, role: 'OPERATOR', status: 'INVITED', user_id: null });
    const outbox = await harness().admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'notification.requested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(outbox.rows[0]?.payload).toMatchObject({
      notification_type: 'SECURITY_MEMBER_INVITED',
      recipient_membership_id: member.id,
      template_payload: {
        role_label: 'Operator',
        accept_url: `${TEST_ORIGIN}/hu/invite/${tenant.tenantId}/${member.id}`,
      },
    });
    expect(JSON.stringify(outbox.rows[0]?.payload)).not.toContain(email);

    const stranger = harness().sessions.issue(`stranger-${randomUUID().slice(0, 6)}@example.test`);
    const stolen = await harness().app.inject({
      method: 'POST',
      url: `/v1/invitations/${tenant.tenantId}/${member.id}/accept`,
      headers: browserHeaders(stranger),
    });
    expect(stolen.statusCode).toBe(404);

    const invitee = harness().sessions.issue(email);
    const pending = await harness().app.inject({
      method: 'GET',
      url: '/v1/invitations',
      headers: browserHeaders(invitee),
    });
    expect(pending.json<{ data: { id: string; role: string }[] }>().data).toEqual([
      expect.objectContaining({ id: member.id, tenant_id: tenant.tenantId, role: 'OPERATOR' }),
    ]);
    // Someone who already has an account finds the workspace in the switcher
    // before accepting anything.
    const waiting = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(invitee),
    });
    expect(waiting.json<{ workspaces: unknown[] }>().workspaces).toEqual([]);
    expect(waiting.json<{ invitations: { id: string }[] }>().invitations).toEqual([
      expect.objectContaining({ id: member.id, tenant_id: tenant.tenantId, role: 'OPERATOR' }),
    ]);
    const accepted = await harness().app.inject({
      method: 'POST',
      url: `/v1/invitations/${tenant.tenantId}/${member.id}/accept`,
      headers: browserHeaders(invitee),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(invitee),
    });
    expect(
      me.json<{ workspaces: { id: string; role: string; location_scope: string[] }[] }>()
        .workspaces,
    ).toEqual([
      expect.objectContaining({
        id: tenant.tenantId,
        role: 'OPERATOR',
        location_scope: [tenant.locationId],
      }),
    ]);
    const again = await harness().app.inject({
      method: 'POST',
      url: `/v1/invitations/${tenant.tenantId}/${member.id}/accept`,
      headers: browserHeaders(invitee),
    });
    expect(again.statusCode).toBe(404);
    const duplicate = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: write(tenant.owner),
      payload: { email, role: 'VIEWER' },
    });
    expect(duplicate.json()).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already_a_member' },
    });

    await harness().admin.query(
      `UPDATE app.memberships SET invitation_expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND invited_email = 'expired@example.test'`,
      [tenant.tenantId],
    );
    const expiring = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: write(tenant.owner),
      payload: { email: 'expired@example.test', role: 'VIEWER' },
    });
    const expiringId = expiring.json<Member>().id;
    await harness().admin.query(
      `UPDATE app.memberships SET invitation_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expiringId],
    );
    const late = await harness().app.inject({
      method: 'POST',
      url: `/v1/invitations/${tenant.tenantId}/${expiringId}/accept`,
      headers: browserHeaders(harness().sessions.issue('expired@example.test')),
    });
    expect(late.json()).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { reason: 'invitation_expired' },
    });
  });

  it('lets someone who already owns a workspace accept an invitation to another one', async () => {
    const secondOwner = harness().sessions.issue(`owner-${randomUUID().slice(0, 6)}@example.test`);
    const slug = `second-${randomUUID().slice(0, 8)}`;
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(secondOwner, undefined, { 'idempotency-key': `ws-${randomUUID()}` }),
      payload: {
        legal_name: `${slug} Kft.`,
        display_name: slug,
        slug,
        default_locale: 'hu',
        timezone: 'Europe/Budapest',
        billing_market: 'HU',
        primary_location: { name: 'Budapest', country: 'HU', timezone: 'Europe/Budapest' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const secondTenantId = created.json<{ id: string }>().id;

    const email = tenant.owner.session.email;
    const invited = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: browserHeaders(secondOwner, secondTenantId, {
        'idempotency-key': `invite-${randomUUID()}`,
      }),
      payload: { email, role: 'ANALYST' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const membershipId = invited.json<Member>().id;

    const accepted = await harness().app.inject({
      method: 'POST',
      url: `/v1/invitations/${secondTenantId}/${membershipId}/accept`,
      headers: browserHeaders(tenant.owner),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(tenant.owner),
    });
    expect(
      me.json<{ workspaces: { id: string }[] }>().workspaces.map((workspace) => workspace.id),
    ).toEqual(expect.arrayContaining([tenant.tenantId, secondTenantId]));

    // The member list of one workspace never picks up memberships from the other.
    const members = await harness().app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: browserHeaders(secondOwner, secondTenantId),
    });
    expect(members.json<{ data: Member[] }>().data.map((row) => row.id)).toEqual(
      expect.arrayContaining([membershipId]),
    );
    expect(members.json<{ data: Member[] }>().data).toHaveLength(2);
  });

  it('describes an invitation to a signed-out visitor and says whether the address has an account', async () => {
    const email = `invited-${randomUUID().slice(0, 6)}@example.test`;
    const invited = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: write(tenant.owner),
      payload: { email, role: 'VIEWER' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const membershipId = invited.json<Member>().id;

    const preview = await harness().app.inject({
      method: 'GET',
      url: `/v1/invitations/${tenant.tenantId}/${membershipId}/preview`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      id: membershipId,
      tenant_id: tenant.tenantId,
      role: 'VIEWER',
      has_account: false,
    });
    expect(preview.json<{ email: string }>().email).not.toBe(email);
    expect(preview.json<{ workspace_name: string }>().workspace_name.length).toBeGreaterThan(0);

    await harness().admin.query(
      `INSERT INTO app.credentials (auth_subject, email, password_hash) VALUES ($1, $2, 'stub')`,
      [`user_${randomUUID().replaceAll('-', '')}`, email],
    );
    const known = await harness().app.inject({
      method: 'GET',
      url: `/v1/invitations/${tenant.tenantId}/${membershipId}/preview`,
    });
    expect(known.json<{ has_account: boolean }>().has_account).toBe(true);

    const wrongTenant = await harness().app.inject({
      method: 'GET',
      url: `/v1/invitations/${randomUUID()}/${membershipId}/preview`,
    });
    expect(wrongTenant.statusCode).toBe(404);

    await harness().admin.query(
      `UPDATE app.memberships SET invitation_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [membershipId],
    );
    await harness().admin.query(
      `UPDATE app.invitation_directory SET invitation_expires_at = now() - interval '1 minute' WHERE membership_id = $1`,
      [membershipId],
    );
    const expired = await harness().app.inject({
      method: 'GET',
      url: `/v1/invitations/${tenant.tenantId}/${membershipId}/preview`,
    });
    expect(expired.statusCode).toBe(404);
  });

  it('restricts member management to owners, blocks self changes and never removes the last owner', async () => {
    const admin = await addMember('ADMIN');
    const adminInvite = await harness().app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: write(admin.user),
      payload: { email: `x-${randomUUID().slice(0, 6)}@example.test`, role: 'VIEWER' },
    });
    expect(adminInvite.json()).toMatchObject({
      code: 'FORBIDDEN',
      details: { required_permission: 'members:manage' },
    });
    const operator = await addMember('OPERATOR');
    const changed = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/members/${operator.membershipId}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: { role: 'ANALYST' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<Member>()).toMatchObject({ role: 'ANALYST', version: 2 });
    const roleEvent = await harness().admin.query(
      `SELECT count(*)::int AS count FROM app.outbox_events WHERE tenant_id = $1 AND payload->>'notification_type' = 'SECURITY_MEMBER_ROLE_CHANGED'`,
      [tenant.tenantId],
    );
    expect(roleEvent.rows[0]).toEqual({ count: 1 });
    const stale = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/members/${operator.membershipId}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: { role: 'VIEWER' },
    });
    expect(stale.statusCode).toBe(412);

    const owners = await harness().admin.query<{ id: string }>(
      `SELECT id FROM app.memberships WHERE tenant_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
      [tenant.tenantId],
    );
    const ownerMembership = owners.rows[0]?.id ?? '';
    const self = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/members/${ownerMembership}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: { role: 'VIEWER' },
    });
    expect(self.json()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'cannot_modify_own_membership' },
    });
    const secondOwner = await addMember('OWNER');
    const removed = await harness().app.inject({
      method: 'DELETE',
      url: `/v1/members/${ownerMembership}`,
      headers: write(secondOwner.user),
    });
    expect(removed.statusCode).toBe(204);
    const lastOwner = await harness().app.inject({
      method: 'DELETE',
      url: `/v1/members/${secondOwner.membershipId}`,
      headers: write(secondOwner.user),
    });
    expect(lastOwner.json()).toMatchObject({ code: 'CONFLICT', details: { reason: 'last_owner' } });
    await harness().admin.query(`UPDATE app.memberships SET status = 'ACTIVE' WHERE id = $1`, [
      ownerMembership,
    ]);

    const viewer = await addMember('VIEWER');
    const listed = await harness().app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: browserHeaders(admin.user, tenant.tenantId),
    });
    expect(
      listed.json<{ data: Member[] }>().data.find((row) => row.id === viewer.membershipId)?.email,
    ).toMatch(/@example\.test$/);
    const denied = await harness().app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: browserHeaders(viewer.user, tenant.tenantId),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('API keys', () => {
  it('creates scoped keys once, authenticates with them and revokes them', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: write(tenant.owner),
      payload: { name: 'CRM export', scopes: ['calls:read', 'agents:read'], expires_in_days: 30 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = created.json<{ id: string; secret: string; prefix: string; status: string }>();
    expect(key.secret.startsWith(`${key.prefix}_`)).toBe(true);
    expect(key.status).toBe('ACTIVE');
    expect(created.headers['cache-control']).toBe('no-store');
    const stored = await harness().admin.query<{ text: string }>(
      `SELECT row_to_json(api_keys)::text AS text FROM app.api_keys WHERE id = $1`,
      [key.id],
    );
    expect(stored.rows[0]?.text).not.toContain(key.secret.split('_').at(-1));
    const listed = await harness().app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(listed.body).not.toContain(key.secret);

    const bearer = { authorization: `Bearer ${key.secret}`, origin: TEST_ORIGIN };
    expect(
      (await harness().app.inject({ method: 'GET', url: '/v1/calls', headers: bearer })).statusCode,
    ).toBe(200);
    expect(
      (await harness().app.inject({ method: 'GET', url: '/v1/members', headers: bearer }))
        .statusCode,
    ).toBe(403);

    const nonDelegable = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: write(tenant.owner),
      payload: { name: 'Too much', scopes: ['members:manage'] },
    });
    expect(nonDelegable.json()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'scope_not_delegable', scopes: ['members:manage'] },
    });
    const developer = await addMember('DEVELOPER');
    const beyondRole = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: write(developer.user),
      payload: { name: 'Billing', scopes: ['invoices:read'] },
    });
    expect(beyondRole.json()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'scope_not_delegable' },
    });

    const revoked = await harness().app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: write(tenant.owner),
    });
    expect(revoked.json()).toMatchObject({ status: 'REVOKED' });
    expect(
      (await harness().app.inject({ method: 'GET', url: '/v1/calls', headers: bearer })).json(),
    ).toMatchObject({ code: 'API_KEY_INVALID' });
    const viaKey = await harness().app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { ...bearer, 'idempotency-key': `k-${randomUUID()}` },
      payload: { name: 'x', scopes: ['calls:read'] },
    });
    expect([401, 403]).toContain(viaKey.statusCode);
  });
});

describe('locations', () => {
  it('manages locations with validation, optimistic concurrency and a single primary', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: write(tenant.owner),
      payload: {
        name: `Debrecen ${randomUUID().slice(0, 4)}`,
        timezone: 'Europe/Budapest',
        country: 'HU',
        address: { line1: 'Piac utca 1.', city: 'Debrecen', postal_code: '4024' },
        business_hours: [
          { iso_weekday: 1, opens: '08:00', closes: '12:00' },
          { iso_weekday: 1, opens: '13:00', closes: '17:00' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const location = created.json<{ id: string; is_primary: boolean; version: number }>();
    expect(location.is_primary).toBe(false);
    const overlap = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/locations/${location.id}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: {
        business_hours: [
          { iso_weekday: 2, opens: '08:00', closes: '12:00' },
          { iso_weekday: 2, opens: '11:00', closes: '15:00' },
        ],
      },
    });
    expect(overlap.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ rule: 'no_overlap' }] },
    });
    const badZone = await harness().app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: write(tenant.owner),
      payload: { name: 'Mars', timezone: 'Mars/Olympus', country: 'HU' },
    });
    expect(badZone.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: '/body/timezone' }] },
    });
    const primary = await harness().app.inject({
      method: 'POST',
      url: `/v1/locations/${location.id}/make-primary`,
      headers: write(tenant.owner),
    });
    expect(primary.json()).toMatchObject({ is_primary: true });
    const primaries = await harness().admin.query(
      `SELECT count(*)::int AS count FROM app.locations WHERE tenant_id = $1 AND is_primary`,
      [tenant.tenantId],
    );
    expect(primaries.rows[0]).toEqual({ count: 1 });
    const current = await harness().app.inject({
      method: 'GET',
      url: `/v1/locations/${location.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const etag = current.headers['etag'] as string;
    const deactivatePrimary = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/locations/${location.id}`,
      headers: write(tenant.owner, { 'if-match': etag }),
      payload: { status: 'INACTIVE' },
    });
    expect(deactivatePrimary.json()).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await harness().app.inject({
      method: 'POST',
      url: `/v1/locations/${tenant.locationId}/make-primary`,
      headers: write(tenant.owner),
    });
    const original = await harness().app.inject({
      method: 'GET',
      url: `/v1/locations/${tenant.locationId}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const blocked = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/locations/${tenant.locationId}`,
      headers: write(tenant.owner, { 'if-match': original.headers['etag'] as string }),
      payload: { name: 'Budapest Központ' },
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
    const stale = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/locations/${tenant.locationId}`,
      headers: write(tenant.owner, { 'if-match': original.headers['etag'] as string }),
      payload: { name: 'Again' },
    });
    expect(stale.statusCode).toBe(412);

    const scoped = await addMember('OPERATOR');
    await harness().admin.query(
      `UPDATE app.memberships SET location_scope = $2::uuid[] WHERE id = $1`,
      [scoped.membershipId, [tenant.locationId]],
    );
    const visible = await harness().app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: browserHeaders(scoped.user, tenant.tenantId),
    });
    expect(visible.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toEqual([
      tenant.locationId,
    ]);
  });
});
