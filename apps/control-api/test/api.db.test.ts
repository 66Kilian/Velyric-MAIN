import { randomUUID } from 'node:crypto';
import { generateApiKey } from '@velyric/security';
import { agentConfigFixture } from '@velyric/testkit';
import { describe, expect, it } from 'vitest';
import { browserHeaders, TEST_ORIGIN, useApiHarness, type TestUser } from './support/harness.js';

const harness = useApiHarness();

interface Envelope {
  code: string;
  message_key: string;
  trace_id: string;
  details?: Record<string, unknown>;
}

function workspaceBody(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    legal_name: `${slug} Kft.`,
    display_name: slug,
    slug,
    default_locale: 'hu',
    timezone: 'Europe/Budapest',
    billing_market: 'HU',
    primary_location: { name: 'Budapest', country: 'HU', timezone: 'Europe/Budapest' },
    ...overrides,
  };
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function createWorkspace(
  user: TestUser,
  slug = uniqueSlug('ws'),
): Promise<{ id: string; version: number }> {
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: browserHeaders(user, undefined, { 'idempotency-key': `create-${randomUUID()}` }),
    payload: workspaceBody(slug),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; version: number }>();
}

async function userId(user: TestUser): Promise<string> {
  const response = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  return response.json<{ user: { id: string } }>().user.id;
}

async function createAgent(
  user: TestUser,
  workspace: string,
  name = `Agent ${randomUUID().slice(0, 6)}`,
): Promise<{ id: string }> {
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: browserHeaders(user, workspace, { 'idempotency-key': `agent-${randomUUID()}` }),
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>();
}

async function createVersion(
  user: TestUser,
  workspace: string,
  agentId: string,
): Promise<{ id: string; config_hash: string }> {
  const response = await harness().app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/versions`,
    headers: browserHeaders(user, workspace, { 'idempotency-key': `version-${randomUUID()}` }),
    payload: { config: agentConfigFixture(), change_summary: 'initial' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; config_hash: string }>();
}

async function passReleaseGate(
  tenantId: string,
  agentId: string,
  versionId: string,
): Promise<void> {
  const admin = harness().admin;
  const suite = await admin.query<{ id: string }>(
    `INSERT INTO app.simulation_suites (tenant_id, agent_id, name, is_release_gate) VALUES ($1, $2, $3, true)
     ON CONFLICT (tenant_id, agent_id, name) DO UPDATE SET is_release_gate = true RETURNING id`,
    [tenantId, agentId, 'regression'],
  );
  await admin.query(
    `INSERT INTO app.simulation_runs (tenant_id, suite_id, agent_version_id, status, seed, model_versions, rubric_version, tool_fixture_version, requested_by, gate_passed, finished_at, passed_count)
     VALUES ($1, $2, $3, 'PASSED', 42, '{"voice":"gpt-live-1"}', 'rubric-2026.09', 'fixtures-1', 'test', true, now(), 12)`,
    [tenantId, suite.rows[0]?.id, versionId],
  );
}

async function publish(
  user: TestUser,
  workspace: string,
  versionId: string,
  rollout: number,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness().app.inject({
    method: 'POST',
    url: `/v1/agent-versions/${versionId}/publish`,
    headers: browserHeaders(user, workspace, { 'idempotency-key': `publish-${randomUUID()}` }),
    payload: { rollout_percent: rollout },
  });
  return { statusCode: response.statusCode, body: response.body };
}

describe('authentication and CSRF', () => {
  it('returns the error envelope with a trace id for unauthenticated requests', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<Envelope>()).toEqual({
      code: 'UNAUTHENTICATED',
      message_key: 'errors.unauthenticated',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(response.headers['x-trace-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('rejects cookie-authenticated writes without a matching CSRF token or allowed origin', async () => {
    const user = harness().sessions.issue('csrf@example.test');
    const base = browserHeaders(user, undefined, { 'idempotency-key': `csrf-${randomUUID()}` });
    const missing = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { ...base, 'x-csrf-token': '' },
      payload: workspaceBody(uniqueSlug('csrf')),
    });
    expect(missing.json<Envelope>().code).toBe('CSRF_TOKEN_INVALID');
    const wrongOrigin = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { ...base, origin: 'https://evil.test' },
      payload: workspaceBody(uniqueSlug('csrf')),
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const expired = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: 'vly_session=not-a-session' },
    });
    expect(expired.json<Envelope>().code).toBe('SESSION_EXPIRED');
  });
});

describe('workspaces', () => {
  it('creates a workspace idempotently and rejects key reuse with a different payload', async () => {
    const user = harness().sessions.issue('owner@example.test');
    const slug = uniqueSlug('idem');
    const headers = browserHeaders(user, undefined, { 'idempotency-key': `ws-${randomUUID()}` });
    const first = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers,
      payload: workspaceBody(slug),
    });
    expect(first.statusCode).toBe(201);
    const replay = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers,
      payload: workspaceBody(slug),
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const reused = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers,
      payload: workspaceBody(slug, { display_name: 'Other' }),
    });
    expect(reused.json<Envelope>().code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missingKey = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(user),
      payload: workspaceBody(uniqueSlug('nokey')),
    });
    expect(missingKey.json<Envelope>().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(user),
    });
    expect(
      me.json<{ workspaces: { id: string; role: string; status: string }[] }>().workspaces,
    ).toEqual([
      expect.objectContaining({
        id: first.json<{ id: string }>().id,
        role: 'OWNER',
        status: 'PROVISIONING',
      }),
    ]);
  });

  it('rejects duplicate slugs, invalid time zones and unknown fields', async () => {
    const user = harness().sessions.issue('slug@example.test');
    const slug = uniqueSlug('dup');
    await createWorkspace(user, slug);
    const duplicate = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(user, undefined, { 'idempotency-key': `dup-${randomUUID()}` }),
      payload: workspaceBody(slug),
    });
    expect(duplicate.json<Envelope>().code).toBe('CONFLICT');
    const badZone = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(user, undefined, { 'idempotency-key': `tz-${randomUUID()}` }),
      payload: workspaceBody(uniqueSlug('tz'), { timezone: 'Nowhere/City' }),
    });
    expect(badZone.json<Envelope>()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: '/body/timezone', rule: 'iana_time_zone' }] },
    });
    const extra = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(user, undefined, { 'idempotency-key': `extra-${randomUUID()}` }),
      payload: workspaceBody(uniqueSlug('extra'), { tenant_id: randomUUID() }),
    });
    expect(extra.json<Envelope>().code).toBe('VALIDATION_FAILED');
  });

  it('isolates workspaces between users', async () => {
    const alice = harness().sessions.issue('alice@example.test');
    const bob = harness().sessions.issue('bob@example.test');
    const aliceWorkspace = await createWorkspace(alice);
    const bobWorkspace = await createWorkspace(bob);
    const foreignHeader = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${aliceWorkspace.id}`,
      headers: browserHeaders(bob, aliceWorkspace.id),
    });
    expect(foreignHeader.json<Envelope>()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'not_a_member' },
    });
    const foreignPath = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${aliceWorkspace.id}`,
      headers: browserHeaders(bob, bobWorkspace.id),
    });
    expect(foreignPath.statusCode).toBe(404);
    const own = await harness().app.inject({
      method: 'GET',
      url: `/v1/workspaces/${bobWorkspace.id}`,
      headers: browserHeaders(bob, bobWorkspace.id),
    });
    expect(own.statusCode).toBe(200);
  });

  it('enforces optimistic concurrency with If-Match', async () => {
    const user = harness().sessions.issue('etag@example.test');
    const workspace = await createWorkspace(user);
    const url = `/v1/workspaces/${workspace.id}`;
    const missing = await harness().app.inject({
      method: 'PATCH',
      url,
      headers: browserHeaders(user, workspace.id),
      payload: { display_name: 'Renamed' },
    });
    expect(missing.json<Envelope>().code).toBe('PRECONDITION_REQUIRED');
    const stale = await harness().app.inject({
      method: 'PATCH',
      url,
      headers: browserHeaders(user, workspace.id, { 'if-match': 'W/"99"' }),
      payload: { display_name: 'Renamed' },
    });
    expect(stale.json<Envelope>()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { current_version: 1 },
    });
    const ok = await harness().app.inject({
      method: 'PATCH',
      url,
      headers: browserHeaders(user, workspace.id, { 'if-match': 'W/"1"' }),
      payload: { display_name: 'Renamed' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('W/"2"');
    const audit = await harness().admin.query<{ action: string }>(
      'SELECT action FROM app.audit_logs WHERE tenant_id = $1 ORDER BY occurred_at',
      [workspace.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['tenant.created', 'tenant.updated']);
  });
});

describe('agents and versions', () => {
  it('enforces role permissions for agent writes', async () => {
    const owner = harness().sessions.issue('rbac-owner@example.test');
    const analyst = harness().sessions.issue('rbac-analyst@example.test');
    const workspace = await createWorkspace(owner);
    const analystId = await userId(analyst);
    await harness().admin.query(
      `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'ANALYST', 'ACTIVE')`,
      [workspace.id, analystId],
    );
    const forbidden = await harness().app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: browserHeaders(analyst, workspace.id, { 'idempotency-key': `rbac-${randomUUID()}` }),
      payload: { name: 'Nope' },
    });
    expect(forbidden.json<Envelope>()).toMatchObject({
      code: 'FORBIDDEN',
      details: { required_permission: 'agents:write' },
    });
    await createAgent(owner, workspace.id);
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: browserHeaders(analyst, workspace.id),
    });
    expect(list.statusCode).toBe(200);
  });

  it('rejects semantically invalid agent configurations', async () => {
    const owner = harness().sessions.issue('config@example.test');
    const workspace = await createWorkspace(owner);
    const agent = await createAgent(owner, workspace.id);
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/agents/${agent.id}/versions`,
      headers: browserHeaders(owner, workspace.id, { 'idempotency-key': `cfg-${randomUUID()}` }),
      payload: { config: agentConfigFixture({ default_locale: 'de' }) },
    });
    expect(response.json<Envelope>()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        issues: [{ path: '/body/config/default_locale', rule: 'must_be_configured_language' }],
      },
    });
  });

  it('gates publishing on simulations, supports canary and rollback, and honours the kill switch', async () => {
    const owner = harness().sessions.issue('publish@example.test');
    const workspace = await createWorkspace(owner);
    const agent = await createAgent(owner, workspace.id);
    const v1 = await createVersion(owner, workspace.id, agent.id);

    const gated = await publish(owner, workspace.id, v1.id, 100);
    expect(JSON.parse(gated.body)).toMatchObject({
      code: 'SIMULATION_GATE_FAILED',
      details: { reason: 'no_release_gate_suite' },
    });

    await passReleaseGate(workspace.id, agent.id, v1.id);
    const canaryWithoutProduction = await publish(owner, workspace.id, v1.id, 10);
    expect(JSON.parse(canaryWithoutProduction.body)).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });

    const published = await publish(owner, workspace.id, v1.id, 100);
    expect(published.statusCode, published.body).toBe(200);
    expect(JSON.parse(published.body)).toMatchObject({
      status: 'PRODUCTION',
      rollout_percent: 100,
    });

    const v2 = await createVersion(owner, workspace.id, agent.id);
    await passReleaseGate(workspace.id, agent.id, v2.id);
    const canary = await publish(owner, workspace.id, v2.id, 20);
    expect(JSON.parse(canary.body)).toMatchObject({ status: 'CANARY', rollout_percent: 20 });

    const v3 = await createVersion(owner, workspace.id, agent.id);
    await passReleaseGate(workspace.id, agent.id, v3.id);
    await harness().admin.query(
      `INSERT INTO app.kill_switches (switch_key, scope_type, scope_ref, engaged, reason, engaged_by, engaged_at) VALUES ('kill.agent_publish', 'TENANT', $1, true, 'incident drill', 'ops', now())`,
      [workspace.id],
    );
    const killed = await publish(owner, workspace.id, v3.id, 100);
    expect(JSON.parse(killed.body)).toMatchObject({ code: 'KILL_SWITCH_ACTIVE' });
    await harness().admin.query(
      `UPDATE app.kill_switches SET engaged = false, released_by = 'ops', released_at = now() WHERE scope_ref = $1`,
      [workspace.id],
    );

    const promoted = await publish(owner, workspace.id, v3.id, 100);
    expect(JSON.parse(promoted.body)).toMatchObject({ status: 'PRODUCTION' });

    const rollback = await harness().app.inject({
      method: 'POST',
      url: `/v1/agent-versions/${v1.id}/rollback`,
      headers: browserHeaders(owner, workspace.id, {
        'idempotency-key': `rollback-${randomUUID()}`,
      }),
      payload: { reason: 'quality regression after v3' },
    });
    expect(rollback.json<{ status: string }>().status).toBe('PRODUCTION');

    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/agents/${agent.id}`,
      headers: browserHeaders(owner, workspace.id),
    });
    expect(detail.json()).toMatchObject({
      status: 'ACTIVE',
      production_version_id: v1.id,
      canary_version_id: null,
    });
    const statuses = await harness().admin.query<{ version_number: number; status: string }>(
      'SELECT version_number, status FROM app.agent_versions WHERE agent_id = $1 ORDER BY version_number',
      [agent.id],
    );
    expect(statuses.rows).toEqual([
      { version_number: 1, status: 'PRODUCTION' },
      { version_number: 2, status: 'SUPERSEDED' },
      { version_number: 3, status: 'ROLLED_BACK' },
    ]);
    const outbox = await harness().admin.query<{ event_type: string }>(
      'SELECT event_type FROM app.outbox_events WHERE tenant_id = $1 ORDER BY created_at',
      [workspace.id],
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual([
      'tenant.created',
      'agent_version.published',
      'agent_version.published',
      'agent_version.published',
      'agent_version.rolled_back',
    ]);
  });

  it('paginates with signed cursors', async () => {
    const owner = harness().sessions.issue('pages@example.test');
    const workspace = await createWorkspace(owner);
    for (let index = 0; index < 3; index += 1) {
      await createAgent(owner, workspace.id, `Paged ${String(index)}`);
    }
    const first = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents?limit=2',
      headers: browserHeaders(owner, workspace.id),
    });
    const firstBody = first.json<{
      data: { name: string }[];
      page: { next_cursor: string | null };
    }>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.page.next_cursor).not.toBeNull();
    const second = await harness().app.inject({
      method: 'GET',
      url: `/v1/agents?limit=2&cursor=${encodeURIComponent(firstBody.page.next_cursor ?? '')}`,
      headers: browserHeaders(owner, workspace.id),
    });
    const secondBody = second.json<{
      data: { name: string }[];
      page: { next_cursor: string | null };
    }>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.page.next_cursor).toBeNull();
    const names = [...firstBody.data, ...secondBody.data].map((item) => item.name).sort();
    expect(names).toEqual(['Paged 0', 'Paged 1', 'Paged 2']);
    const tampered = await harness().app.inject({
      method: 'GET',
      url: `/v1/agents?cursor=${encodeURIComponent(`${firstBody.page.next_cursor ?? ''}x`)}`,
      headers: browserHeaders(owner, workspace.id),
    });
    expect(tampered.json<Envelope>().code).toBe('VALIDATION_FAILED');
  });
});

describe('API keys', () => {
  it('authenticates tenant-bound API keys with scoped permissions and rejects revoked keys', async () => {
    const owner = harness().sessions.issue('apikey@example.test');
    const workspace = await createWorkspace(owner);
    await createAgent(owner, workspace.id);
    const ownerId = await userId(owner);
    const key = generateApiKey('test', harness().apiKeyPepper);
    const inserted = await harness().admin.query<{ id: string }>(
      `INSERT INTO app.api_keys (tenant_id, name, prefix, key_hash, scopes, created_by_user_id) VALUES ($1, 'CI', $2, $3, $4, $5) RETURNING id`,
      [workspace.id, key.prefix, key.hash, ['agents:read'], ownerId],
    );
    const bearer = { authorization: `Bearer ${key.plaintext}`, origin: TEST_ORIGIN };
    const read = await harness().app.inject({ method: 'GET', url: '/v1/agents', headers: bearer });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: unknown[] }>().data).toHaveLength(1);
    const write = await harness().app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { ...bearer, 'idempotency-key': `key-${randomUUID()}` },
      payload: { name: 'By key' },
    });
    expect(write.json<Envelope>().code).toBe('FORBIDDEN');
    const malformed = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer nope' },
    });
    expect(malformed.json<Envelope>().code).toBe('API_KEY_INVALID');
    const wrongSecret = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${key.plaintext.slice(0, -2)}AA` },
    });
    expect(wrongSecret.json<Envelope>().code).toBe('API_KEY_INVALID');
    await harness().admin.query('UPDATE app.api_keys SET revoked_at = now() WHERE id = $1', [
      inserted.rows[0]?.id,
    ]);
    const revoked = await harness().app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: bearer,
    });
    expect(revoked.json<Envelope>().code).toBe('API_KEY_INVALID');
  });
});
