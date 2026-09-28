import { randomUUID } from 'node:crypto';
import type { ServiceScope } from '@velyric/security';
import { agentConfigFixture } from '@velyric/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateGate } from '../src/routes/simulations.js';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let other: SeededTenant;

interface Suite {
  id: string;
  version: number;
  is_release_gate: boolean;
  min_pass_ratio: number;
  scenarios?: { id: string; scenario_key: string; active: boolean }[];
}

interface Run {
  id: string;
  status: string;
  passed_count: number;
  failed_count: number;
  gate_passed: boolean | null;
  scores: { pass_ratio?: number } | null;
  previous_run?: { id: string } | null;
}

function headers(seeded: SeededTenant, extra: Record<string, string> = {}) {
  return browserHeaders(seeded.owner, seeded.tenantId, {
    'idempotency-key': `sim-${randomUUID()}`,
    ...extra,
  });
}

async function internal(
  url: string,
  payload: unknown,
  scopes: readonly ServiceScope[] = ['simulation.run'],
  tenantId: string = tenant.tenantId,
) {
  const token = await harness().serviceToken(scopes, tenantId);
  return harness().internal.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

const scenario = {
  scenario_key: 'booking.happy-path',
  scenario_class: 'HAPPY_PATH',
  language: 'hu',
  definition: {
    caller_goal: 'Időpontot foglalni kedd délelőttre',
    opening_line: 'Jó napot, szeretnék időpontot foglalni.',
    caller_facts: { name: 'Kiss Anna' },
    max_turns: 8,
  },
  deterministic_assertions: [
    { type: 'TOOL_CALLED', tool: 'check_availability' },
    { type: 'NOT_TRANSFERRED' },
  ],
};

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  other = await seedRuntimeTenant(harness());
});

describe('simulation gate evaluation', () => {
  it('requires the minimum pass ratio and no errored scenarios', () => {
    const base = { score: 1, failed_assertions: [], turns: 4, duration_ms: 1000, tools_called: [] };
    const id = randomUUID();
    expect(
      evaluateGate(
        [
          { ...base, scenario_id: id, verdict: 'PASSED' },
          { ...base, scenario_id: id, verdict: 'FAILED' },
        ],
        0.5,
      ),
    ).toMatchObject({ passed: 1, failed: 1, passRatio: 0.5, gatePassed: true });
    expect(
      evaluateGate(
        [
          { ...base, scenario_id: id, verdict: 'PASSED' },
          { ...base, scenario_id: id, verdict: 'ERRORED' },
        ],
        0.5,
      ),
    ).toMatchObject({ errored: 1, gatePassed: false });
    expect(
      evaluateGate(
        [
          { ...base, scenario_id: id, verdict: 'PASSED' },
          { ...base, scenario_id: id, verdict: 'FAILED' },
        ],
        1,
      ),
    ).toMatchObject({ gatePassed: false });
  });
});

describe('simulation lab', () => {
  it('runs a release gate suite end to end and unblocks publishing', async () => {
    const app = harness().app;
    const version = await app.inject({
      method: 'POST',
      url: `/v1/agents/${tenant.agentId}/versions`,
      headers: headers(tenant),
      payload: { config: agentConfigFixture(), change_summary: 'gate candidate' },
    });
    expect(version.statusCode, version.body).toBe(201);
    const versionId = version.json<{ id: string }>().id;

    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/agent-versions/${versionId}/publish`,
      headers: headers(tenant),
      payload: { rollout_percent: 100 },
    });
    expect(blocked.json<{ code: string }>().code).toBe('SIMULATION_GATE_FAILED');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/simulation-suites',
      headers: headers(tenant),
      payload: {
        agent_id: tenant.agentId,
        name: 'Release gate',
        is_release_gate: true,
        min_pass_ratio: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const suite = created.json<Suite>();

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/simulation-suites',
      headers: headers(tenant),
      payload: { agent_id: tenant.agentId, name: 'Release gate' },
    });
    expect(duplicate.json<{ code: string }>().code).toBe('CONFLICT');

    const emptyRun = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/runs`,
      headers: headers(tenant),
      payload: { agent_version_id: versionId },
    });
    expect(
      emptyRun.json<{ details: { issues: { rule: string }[] } }>().details.issues[0]?.rule,
    ).toBe('active_scenarios_required');

    const invalidScenario = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/scenarios`,
      headers: headers(tenant),
      payload: { ...scenario, deterministic_assertions: [{ type: 'TOOL_CALLED' }] },
    });
    expect(invalidScenario.statusCode).toBe(400);

    const added = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/scenarios`,
      headers: headers(tenant),
      payload: scenario,
    });
    expect(added.statusCode, added.body).toBe(201);
    const scenarioId = added.json<{ id: string }>().id;

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/simulation-suites/${suite.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json<Suite>().scenarios?.map((entry) => entry.scenario_key)).toEqual([
      'booking.happy-path',
    ]);

    const started = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/runs`,
      headers: headers(tenant),
      payload: { agent_version_id: versionId },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json<Run>();
    expect(run.status).toBe('QUEUED');
    const outbox = await harness().admin.query<{ payload: { run_id: string } }>(
      `SELECT payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'simulation.run_requested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(outbox.rows[0]?.payload.run_id).toBe(run.id);

    const foreignClaim = await internal(
      `/internal/v1/simulation-runs/${run.id}/claim`,
      { model_versions: { caller: 'gpt-test' } },
      ['simulation.run'],
      other.tenantId,
    );
    expect(foreignClaim.statusCode).toBe(404);
    const wrongScope = await internal(
      `/internal/v1/simulation-runs/${run.id}/claim`,
      { model_versions: {} },
      ['knowledge.ingest'],
    );
    expect(wrongScope.statusCode).toBe(403);

    const claim = await internal(`/internal/v1/simulation-runs/${run.id}/claim`, {
      model_versions: { caller: 'gpt-test', judge: 'gpt-judge' },
    });
    expect(claim.statusCode, claim.body).toBe(200);
    const claimed = claim.json<{
      run: Run;
      scenarios: { id: string }[];
      agent_version: { id: string; config: unknown };
    }>();
    expect(claimed.run.status).toBe('RUNNING');
    expect(claimed.scenarios.map((entry) => entry.id)).toEqual([scenarioId]);
    expect(claimed.agent_version.id).toBe(versionId);

    const unknownScenario = await internal(`/internal/v1/simulation-runs/${run.id}/complete`, {
      results: [
        {
          scenario_id: randomUUID(),
          verdict: 'PASSED',
          score: 1,
          failed_assertions: [],
          turns: 5,
          duration_ms: 8000,
          tools_called: [],
        },
      ],
    });
    expect(unknownScenario.statusCode).toBe(400);

    const completed = await internal(`/internal/v1/simulation-runs/${run.id}/complete`, {
      results: [
        {
          scenario_id: scenarioId,
          verdict: 'PASSED',
          score: 0.92,
          failed_assertions: [],
          turns: 6,
          duration_ms: 9400,
          outcome: 'BOOKING_CREATED',
          intent: 'BOOKING',
          tools_called: ['check_availability', 'create_booking'],
        },
      ],
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<Run>()).toMatchObject({
      status: 'PASSED',
      passed_count: 1,
      gate_passed: true,
      scores: { pass_ratio: 1 },
    });

    const replayed = await internal(`/internal/v1/simulation-runs/${run.id}/complete`, {
      results: [
        {
          scenario_id: scenarioId,
          verdict: 'FAILED',
          score: 0,
          failed_assertions: ['late'],
          turns: 1,
          duration_ms: 1,
          tools_called: [],
        },
      ],
    });
    expect(replayed.json<Run>().status).toBe('PASSED');

    const published = await app.inject({
      method: 'POST',
      url: `/v1/agent-versions/${versionId}/publish`,
      headers: headers(tenant),
      payload: { rollout_percent: 100 },
    });
    expect(published.statusCode, published.body).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/runs`,
      headers: headers(tenant),
      payload: { agent_version_id: versionId },
    });
    const secondRun = second.json<Run>();
    await internal(`/internal/v1/simulation-runs/${secondRun.id}/claim`, { model_versions: {} });
    const failed = await internal(`/internal/v1/simulation-runs/${secondRun.id}/complete`, {
      results: [
        {
          scenario_id: scenarioId,
          verdict: 'FAILED',
          score: 0.2,
          failed_assertions: ['TOOL_CALLED check_availability'],
          turns: 8,
          duration_ms: 12000,
          tools_called: [],
        },
      ],
    });
    expect(failed.json<Run>()).toMatchObject({
      status: 'FAILED',
      gate_passed: false,
      failed_count: 1,
    });
    const comparison = await app.inject({
      method: 'GET',
      url: `/v1/simulation-runs/${secondRun.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(comparison.json<Run>().previous_run?.id).toBe(run.id);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/simulation-runs?suite_id=${suite.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(listed.json<{ data: Run[] }>().data.map((entry) => entry.id)).toEqual([
      secondRun.id,
      run.id,
    ]);

    const isolated = await app.inject({
      method: 'GET',
      url: `/v1/simulation-suites/${suite.id}`,
      headers: browserHeaders(other.owner, other.tenantId),
    });
    expect(isolated.statusCode).toBe(404);
  });

  it('limits concurrent runs, supports cancellation, errors and optimistic suite updates', async () => {
    const app = harness().app;
    const suite = (
      await app.inject({
        method: 'POST',
        url: '/v1/simulation-suites',
        headers: headers(other),
        payload: { agent_id: other.agentId, name: 'Load' },
      })
    ).json<Suite>();
    await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/scenarios`,
      headers: headers(other),
      payload: { ...scenario, scenario_key: 'load.one' },
    });

    const runs: Run[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/simulation-suites/${suite.id}/runs`,
        headers: headers(other),
        payload: { agent_version_id: other.versionId },
      });
      expect(response.statusCode, response.body).toBe(202);
      runs.push(response.json<Run>());
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/v1/simulation-suites/${suite.id}/runs`,
      headers: headers(other),
      payload: { agent_version_id: other.versionId },
    });
    expect(limited.statusCode).toBe(429);

    const canceled = await app.inject({
      method: 'POST',
      url: `/v1/simulation-runs/${runs[0]?.id ?? ''}/cancel`,
      headers: headers(other),
    });
    expect(canceled.json<Run>().status).toBe('CANCELED');
    const errored = await internal(
      `/internal/v1/simulation-runs/${runs[1]?.id ?? ''}/error`,
      { error_code: 'provider_unavailable' },
      ['simulation.run'],
      other.tenantId,
    );
    expect(errored.json<Run>().status).toBe('ERRORED');
    const claimCanceled = await internal(
      `/internal/v1/simulation-runs/${runs[0]?.id ?? ''}/claim`,
      { model_versions: {} },
      ['simulation.run'],
      other.tenantId,
    );
    expect(claimCanceled.statusCode).toBe(409);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/simulation-suites/${suite.id}`,
      headers: headers(other, { 'if-match': 'W/"1"' }),
      payload: { is_release_gate: true },
    });
    expect(stale.json<{ code: string }>().code).toBe('VERSION_CONFLICT');
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/simulation-suites/${suite.id}`,
      headers: headers(other, { 'if-match': 'W/"2"' }),
      payload: { is_release_gate: true, min_pass_ratio: 0.8 },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<Suite>()).toMatchObject({
      is_release_gate: true,
      min_pass_ratio: 0.8,
      version: 3,
    });

    const viewer = harness().sessions.issue(`sim-viewer-${randomUUID().slice(0, 6)}@example.test`);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: browserHeaders(viewer) });
    await harness().admin.query(
      `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'ANALYST', 'ACTIVE')`,
      [other.tenantId, me.json<{ user: { id: string } }>().user.id],
    );
    const readable = await app.inject({
      method: 'GET',
      url: `/v1/simulation-suites/${suite.id}`,
      headers: browserHeaders(viewer, other.tenantId),
    });
    expect(readable.statusCode, readable.body).toBe(200);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/simulation-suites',
      headers: browserHeaders(viewer, other.tenantId, { 'idempotency-key': `sim-${randomUUID()}` }),
      payload: { agent_id: other.agentId, name: 'Viewer suite' },
    });
    expect(
      forbidden.json<{ code: string; details: { required_permission: string } }>(),
    ).toMatchObject({ code: 'FORBIDDEN', details: { required_permission: 'simulations:run' } });
  });
});
