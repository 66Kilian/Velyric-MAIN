import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let otherTenant: SeededTenant;

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  otherTenant = await seedRuntimeTenant(harness());
});

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

async function internal(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  token: string | null,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  return harness().internal.inject({
    method,
    url,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.headers ?? {}),
    },
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
  });
}

function callPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    provider_call_id: `rtc_${randomUUID().slice(0, 12)}`,
    channel: 'PSTN',
    direction: 'INBOUND',
    caller_e164: '+36301112222',
    phone_number_id: tenant.phoneNumberId,
    location_id: tenant.locationId,
    agent_id: tenant.agentId,
    agent_version_id: tenant.versionId,
    language: 'hu',
    status: 'IN_PROGRESS',
    conversation_state: 'DISCOVERY',
    started_at: new Date().toISOString(),
    trace_id: randomUUID().replaceAll('-', ''),
    runtime_instance_id: 'runtime-a',
    recording_enabled: false,
    ...overrides,
  };
}

async function startCall(): Promise<string> {
  const callId = randomUUID();
  const response = await internal(
    'PUT',
    `/internal/v1/calls/${callId}`,
    await harness().serviceToken(['call.control'], tenant.tenantId),
    { payload: callPayload() },
  );
  expect(response.statusCode, response.body).toBe(200);
  return callId;
}

async function executeTool(
  callId: string,
  overrides: Record<string, unknown>,
  key = `${callId}:${randomUUID()}`,
) {
  const token = await harness().serviceToken(['tool.execute'], tenant.tenantId);
  const response = await internal('POST', '/internal/v1/tool-gateway/executions', token, {
    headers: { 'idempotency-key': key },
    payload: {
      tenant_id: tenant.tenantId,
      call_id: callId,
      agent_version_id: tenant.versionId,
      specialist: 'BOOKING',
      tool_name: 'lookup_availability',
      arguments: { date: '2026-10-01' },
      conversation_state: 'DISCOVERY',
      verified_identity: false,
      ...overrides,
    },
  });
  return {
    response,
    key,
    body: response.json<{
      status: string;
      error_code: string | null;
      result: unknown;
      retryable: boolean;
      replayed: boolean;
      code?: string;
    }>(),
  };
}

describe('service authentication', () => {
  it('requires a valid, scoped, tenant-bound, single-use service token', async () => {
    const url = `/internal/v1/runtime/agent-snapshots/${tenant.versionId}`;
    expect((await internal('GET', url, null)).json<Envelope>().code).toBe('SERVICE_TOKEN_INVALID');
    expect((await internal('GET', url, 'not.a.jwt')).json<Envelope>().code).toBe(
      'SERVICE_TOKEN_INVALID',
    );
    expect(
      (
        await internal('GET', url, await harness().serviceToken(['usage.write'], tenant.tenantId))
      ).json<Envelope>().code,
    ).toBe('SERVICE_SCOPE_MISSING');
    expect(
      (
        await internal('GET', url, await harness().serviceToken(['runtime.snapshot.read']))
      ).json<Envelope>(),
    ).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'tenant_claim_required' } });
    const token = await harness().serviceToken(['runtime.snapshot.read'], tenant.tenantId);
    expect((await internal('GET', url, token)).statusCode).toBe(200);
    expect((await internal('GET', url, token)).json<Envelope>().code).toBe('SERVICE_TOKEN_INVALID');
    const health = await harness().internal.inject({ method: 'GET', url: '/healthz/live' });
    expect(health.json()).toEqual({ status: 'ok' });
  });
});

describe('agent snapshots', () => {
  it('serves immutable snapshots with their tool contracts and supports ETag revalidation', async () => {
    const url = `/internal/v1/runtime/agent-snapshots/${tenant.versionId}`;
    const response = await internal(
      'GET',
      url,
      await harness().serviceToken(['runtime.snapshot.read'], tenant.tenantId),
    );
    expect(response.headers.etag).toBe(`"${tenant.configHash}"`);
    const body = response.json<{
      config_hash: string;
      tools: { name: string; side_effect_class: string }[];
      disclosure_version: string;
      status: string;
    }>();
    expect(body).toMatchObject({
      config_hash: tenant.configHash,
      status: 'PRODUCTION',
      disclosure_version: '2026-09-01.1',
    });
    expect(body.tools.map((tool) => `${tool.name}:${tool.side_effect_class}`).sort()).toEqual([
      'create_booking:WRITE',
      'lookup_availability:READ',
    ]);
    const revalidated = await internal(
      'GET',
      url,
      await harness().serviceToken(['runtime.snapshot.read'], tenant.tenantId),
      { headers: { 'if-none-match': `"${tenant.configHash}"` } },
    );
    expect(revalidated.statusCode).toBe(304);
    const foreign = await internal(
      'GET',
      url,
      await harness().serviceToken(['runtime.snapshot.read'], otherTenant.tenantId),
    );
    expect(foreign.statusCode).toBe(404);
  });
});

describe('routing and admission snapshot', () => {
  it('resolves the production agent and reports admission blocks', async () => {
    const routing = async (e164: string) =>
      internal(
        'GET',
        `/internal/v1/runtime/routing?provider=telnyx&e164=${encodeURIComponent(e164)}`,
        await harness().serviceToken(['runtime.admission.read']),
      );
    expect((await routing('+3619999999')).statusCode).toBe(404);
    const ok = await routing(tenant.e164);
    expect(ok.json()).toMatchObject({
      tenant_id: tenant.tenantId,
      production_agent_version_id: tenant.versionId,
      entitlement: { max_concurrent_calls: 2, max_call_duration_seconds: 1800 },
      admission_block_reason: null,
      kill_switches: [],
    });
    await harness().admin.query(
      `INSERT INTO app.kill_switches (switch_key, scope_type, scope_ref, engaged, reason, engaged_by, engaged_at) VALUES ('kill.tenant_traffic', 'TENANT', $1, true, 'abuse investigation', 'ops', now())`,
      [tenant.tenantId],
    );
    expect((await routing(tenant.e164)).json()).toMatchObject({
      admission_block_reason: 'KILL_SWITCH',
      kill_switches: ['kill.tenant_traffic'],
    });
    await harness().admin.query(
      `UPDATE app.kill_switches SET engaged = false, released_by = 'ops', released_at = now() WHERE scope_ref = $1`,
      [tenant.tenantId],
    );
    await harness().admin.query(
      `UPDATE app.tenants SET status = 'SUSPENDED_BILLING' WHERE id = $1`,
      [tenant.tenantId],
    );
    expect((await routing(tenant.e164)).json()).toMatchObject({
      admission_block_reason: 'TENANT_SUSPENDED',
    });
    await harness().admin.query(`UPDATE app.tenants SET status = 'ACTIVE' WHERE id = $1`, [
      tenant.tenantId,
    ]);
  });
});

describe('call ingestion', () => {
  it('upserts call lifecycle monotonically and deduplicates events and transcript segments', async () => {
    const callId = randomUUID();
    const payload = callPayload();
    const token = async () => harness().serviceToken(['call.control'], tenant.tenantId);
    expect(
      (await internal('PUT', `/internal/v1/calls/${callId}`, await token(), { payload })).json(),
    ).toMatchObject({ created: true });
    const ended = {
      ...payload,
      status: 'COMPLETED',
      ended_at: new Date().toISOString(),
      connected_seconds: 95,
      outcome: 'BOOKING_CREATED',
      end_reason: 'CALLER_HANGUP',
    };
    expect(
      (
        await internal('PUT', `/internal/v1/calls/${callId}`, await token(), { payload: ended })
      ).json(),
    ).toMatchObject({ created: false, status: 'COMPLETED' });
    expect(
      (
        await internal('PUT', `/internal/v1/calls/${callId}`, await token(), { payload })
      ).json<Envelope>().code,
    ).toBe('INVALID_STATE_TRANSITION');

    const events = {
      events: [
        {
          event_id: randomUUID(),
          seq: 0,
          event_type: 'call.started',
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          payload: { channel: 'PSTN' },
        },
        {
          event_id: randomUUID(),
          seq: 1,
          event_type: 'call.disclosure_delivered',
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          payload: { disclosure_version: '2026-09-01.1' },
        },
      ],
      transcript: [
        {
          seq: 0,
          speaker: 'AGENT',
          language: 'hu',
          start_ms: 0,
          end_ms: 2100,
          content: 'Üdvözlöm, a Példa Kft. AI-asszisztense vagyok.',
        },
        {
          seq: 1,
          speaker: 'CALLER',
          language: 'hu',
          start_ms: 2300,
          end_ms: 4000,
          content: 'Asztalt szeretnék foglalni.',
        },
      ],
    };
    expect(
      (
        await internal('POST', `/internal/v1/calls/${callId}/events`, await token(), {
          payload: events,
        })
      ).json(),
    ).toEqual({ accepted: 2, inserted: 2, transcript_inserted: 2 });
    expect(
      (
        await internal('POST', `/internal/v1/calls/${callId}/events`, await token(), {
          payload: events,
        })
      ).json(),
    ).toEqual({ accepted: 2, inserted: 0, transcript_inserted: 0 });
    const foreign = await internal(
      'POST',
      `/internal/v1/calls/${callId}/events`,
      await harness().serviceToken(['call.control'], otherTenant.tenantId),
      { payload: events },
    );
    expect(foreign.statusCode).toBe(404);
  });
});

describe('tool gateway', () => {
  it('enforces allowlists, conversation gates, schemas, budgets and idempotency', async () => {
    const callId = await startCall();
    harness().dispatcher.respond = (request) =>
      request.toolName === 'create_booking'
        ? { status: 'SUCCEEDED', result: { booking_id: 'bk_1001' }, httpStatus: 201, latencyMs: 12 }
        : {
            status: 'SUCCEEDED',
            result: { slots: ['18:00', '19:30'] },
            httpStatus: 200,
            latencyMs: 8,
          };
    const dispatched = () =>
      harness().dispatcher.calls.filter((call) => call.callId === callId).length;

    expect(
      (await executeTool(callId, { specialist: 'RECEPTION_ROUTER', tool_name: 'create_booking' }))
        .body,
    ).toMatchObject({ status: 'REJECTED_BY_POLICY', error_code: 'TOOL_NOT_ALLOWED' });
    expect(
      (
        await executeTool(callId, {
          tool_name: 'create_booking',
          arguments: { start: '2026-10-01T18:00:00Z', party_size: 4 },
        })
      ).body,
    ).toMatchObject({ status: 'REJECTED_BY_POLICY', error_code: 'INVALID_STATE_TRANSITION' });
    expect(
      (
        await executeTool(callId, {
          tool_name: 'create_booking',
          conversation_state: 'TOOL_EXECUTION',
          arguments: { start: '2026-10-01T18:00:00Z', party_size: 4 },
        })
      ).body,
    ).toMatchObject({ error_code: 'CONFIRMATION_REQUIRED' });
    expect((await executeTool(callId, { arguments: { day: 'tomorrow' } })).body).toMatchObject({
      status: 'FAILED',
      error_code: 'TOOL_SCHEMA_INVALID',
    });
    expect(dispatched()).toBe(0);

    const lookup = await executeTool(callId, {});
    expect(lookup.body).toMatchObject({
      status: 'SUCCEEDED',
      result: { slots: ['18:00', '19:30'] },
      replayed: false,
    });
    const replay = await executeTool(callId, {}, lookup.key);
    expect(replay.body).toMatchObject({
      status: 'SUCCEEDED',
      result: { slots: ['18:00', '19:30'] },
      replayed: true,
    });
    expect(dispatched()).toBe(1);
    expect(
      (await executeTool(callId, { arguments: { date: '2026-10-02' } }, lookup.key)).body.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');

    const booking = await executeTool(callId, {
      tool_name: 'create_booking',
      conversation_state: 'TOOL_EXECUTION',
      arguments: { start: '2026-10-01T18:00:00Z', party_size: 4 },
      confirmation: { confirmed_at: new Date().toISOString(), confirmation_turn_seq: 14 },
    });
    expect(booking.body).toMatchObject({ status: 'SUCCEEDED', result: { booking_id: 'bk_1001' } });

    harness().dispatcher.respond = () => ({
      status: 'SUCCEEDED',
      result: { unexpected: true },
      httpStatus: 200,
      latencyMs: 4,
    });
    expect((await executeTool(callId, {})).body).toMatchObject({
      status: 'FAILED',
      error_code: 'TOOL_SCHEMA_INVALID',
    });
    expect((await executeTool(callId, {})).body).toMatchObject({
      status: 'REJECTED_BY_POLICY',
      error_code: 'TOOL_BUDGET_EXCEEDED',
    });
    expect(dispatched()).toBe(3);

    const runs = await harness().admin.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM app.tool_runs WHERE call_id = $1 GROUP BY status ORDER BY status',
      [callId],
    );
    expect(runs.rows).toEqual([
      { status: 'FAILED', n: 2 },
      { status: 'REJECTED_BY_POLICY', n: 4 },
      { status: 'SUCCEEDED', n: 2 },
    ]);
  });

  it('reports timeouts as retryable, honours the tool kill switch and rejects tenant mismatches', async () => {
    const callId = await startCall();
    harness().dispatcher.respond = () => ({
      status: 'TIMED_OUT',
      errorCode: 'UPSTREAM_TIMEOUT',
      retryable: true,
      httpStatus: null,
      latencyMs: 3000,
    });
    expect((await executeTool(callId, {})).body).toMatchObject({
      status: 'TIMED_OUT',
      error_code: 'UPSTREAM_TIMEOUT',
      retryable: true,
    });

    await harness().admin.query(
      `INSERT INTO app.kill_switches (switch_key, scope_type, scope_ref, engaged, reason, engaged_by, engaged_at) VALUES ('kill.tool', 'TOOL', $1, true, 'calendar incident', 'ops', now())`,
      [tenant.lookupToolId],
    );
    expect((await executeTool(callId, {})).body).toMatchObject({
      status: 'REJECTED_BY_POLICY',
      error_code: 'KILL_SWITCH_ACTIVE',
    });
    await harness().admin.query(
      `UPDATE app.kill_switches SET engaged = false, released_by = 'ops', released_at = now() WHERE scope_ref = $1`,
      [tenant.lookupToolId],
    );

    const mismatch = await internal(
      'POST',
      '/internal/v1/tool-gateway/executions',
      await harness().serviceToken(['tool.execute'], otherTenant.tenantId),
      {
        headers: { 'idempotency-key': `${callId}:mismatch-0001` },
        payload: {
          tenant_id: tenant.tenantId,
          call_id: callId,
          agent_version_id: tenant.versionId,
          specialist: 'BOOKING',
          tool_name: 'lookup_availability',
          arguments: { date: '2026-10-01' },
          conversation_state: 'DISCOVERY',
          verified_identity: false,
        },
      },
    );
    expect(mismatch.json<Envelope>()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'tenant_claim_mismatch' },
    });
  });
});

describe('runtime credentials and transcript ingestion', () => {
  it('returns only the active OpenAI secret references of the token tenant', async () => {
    await harness().admin.query(
      `INSERT INTO app.tenant_secret_refs (tenant_id, kind, provider, secret_ref, secret_version, status, activated_at)
       VALUES ($1, 'OPENAI_SERVICE_ACCOUNT_KEY', 'openai', $2, 1, 'REVOKED', now()),
              ($1, 'OPENAI_SERVICE_ACCOUNT_KEY', 'openai', $3, 2, 'ACTIVE', now()),
              ($1, 'OPENAI_WEBHOOK_SECRET', 'openai', $4, 1, 'ACTIVE', now())`,
      [
        tenant.tenantId,
        `aws-sm://tenants/${tenant.tenantId}/openai-service-account-key/v1`,
        `aws-sm://tenants/${tenant.tenantId}/openai-service-account-key/v2`,
        `aws-sm://tenants/${tenant.tenantId}/openai-webhook-secret/v1`,
      ],
    );
    const url = `/internal/v1/runtime/tenants/${tenant.tenantId}/openai-credentials`;
    const response = await internal(
      'GET',
      url,
      await harness().serviceToken(['runtime.admission.read'], tenant.tenantId),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenant_id: tenant.tenantId,
      api_key: {
        secret_ref: `aws-sm://tenants/${tenant.tenantId}/openai-service-account-key/v2`,
        secret_version: 2,
      },
      webhook_secret: {
        secret_ref: `aws-sm://tenants/${tenant.tenantId}/openai-webhook-secret/v1`,
        secret_version: 1,
      },
    });
    const other = await internal(
      'GET',
      `/internal/v1/runtime/tenants/${otherTenant.tenantId}/openai-credentials`,
      await harness().serviceToken(['runtime.admission.read'], otherTenant.tenantId),
    );
    expect(other.json()).toEqual({
      tenant_id: otherTenant.tenantId,
      api_key: null,
      webhook_secret: null,
    });
    const mismatch = await internal(
      'GET',
      url,
      await harness().serviceToken(['runtime.admission.read'], otherTenant.tenantId),
    );
    expect(mismatch.json<Envelope>()).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'tenant_claim_mismatch' },
    });
    const unscoped = await internal(
      'GET',
      url,
      await harness().serviceToken(['call.control'], tenant.tenantId),
    );
    expect(unscoped.statusCode).toBe(403);
  });

  it('accepts transcript-only batches and rejects empty ones', async () => {
    const callId = await startCall();
    const eventsUrl = `/internal/v1/calls/${callId}/events`;
    const transcriptOnly = await internal(
      'POST',
      eventsUrl,
      await harness().serviceToken(['call.control'], tenant.tenantId),
      {
        payload: {
          events: [],
          transcript: [
            {
              seq: 900,
              speaker: 'CALLER',
              language: 'hu',
              start_ms: 0,
              end_ms: 800,
              content: 'Jó napot kívánok.',
            },
          ],
        },
      },
    );
    expect(transcriptOnly.statusCode).toBe(200);
    expect(transcriptOnly.json()).toMatchObject({
      accepted: 0,
      inserted: 0,
      transcript_inserted: 1,
    });
    const empty = await internal(
      'POST',
      eventsUrl,
      await harness().serviceToken(['call.control'], tenant.tenantId),
      { payload: { events: [] } },
    );
    expect(empty.json<Envelope>()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
