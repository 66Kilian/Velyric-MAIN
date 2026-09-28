import { randomUUID } from 'node:crypto';
import { LocalVaultTenantSecrets } from '@velyric/tenant-secrets';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

async function storeOpenAiKey(seeded: SeededTenant, value: string): Promise<void> {
  const secrets = new LocalVaultTenantSecrets(harness().vaultDir);
  const secretRefId = randomUUID();
  const secretRef = await secrets.store({
    tenantId: seeded.tenantId,
    kind: 'OPENAI_SERVICE_ACCOUNT_KEY',
    secretRefId,
    version: 1,
    value,
  });
  await harness().admin.query(
    `INSERT INTO app.tenant_secret_refs (id, tenant_id, kind, provider, secret_ref, secret_version, status, activated_at)
     VALUES ($1, $2, 'OPENAI_SERVICE_ACCOUNT_KEY', 'openai', $3, 1, 'ACTIVE', now())`,
    [secretRefId, seeded.tenantId, secretRef],
  );
}

async function startSession(seeded: SeededTenant) {
  return harness().app.inject({
    method: 'POST',
    url: `/v1/agents/${seeded.agentId}/web-test-session`,
    headers: browserHeaders(seeded.owner, seeded.tenantId, {
      'idempotency-key': `web-test-${randomUUID()}`,
    }),
    payload: {},
  });
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

describe('web test session', () => {
  it('mints a realtime client secret from the tenant OpenAI key and the published config', async () => {
    const seeded = await seedRuntimeTenant(harness());
    await storeOpenAiKey(seeded, 'sk-svcacct-tenant-key');
    const response = await startSession(seeded);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ client_secret: string; model: string; voice: string }>();
    expect(body.client_secret).toMatch(/^ek_test/);
    expect(body.voice).toBe('alloy');
    const call = harness().realtime.calls.at(-1);
    expect(call?.apiKey).toBe('sk-svcacct-tenant-key');
    expect(call?.model).toBe(body.model);
    expect(call?.instructions).toContain('Opening hours');
    expect(call?.instructions).toContain('no tools here');
    expect(call?.instructions).toContain('Say that greeting only once');
    expect(call?.instructions).toContain('Only discuss this business');
    expect(call?.speed).toBeGreaterThan(0.8);
    const audit = await harness().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.audit_logs WHERE tenant_id = $1 AND action = 'agent.web_test_session_started'`,
      [seeded.tenantId],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('falls back to the next realtime model when the preferred one is unavailable', async () => {
    const seeded = await seedRuntimeTenant(harness());
    await storeOpenAiKey(seeded, 'sk-svcacct-fallback');
    const before = harness().realtime.calls.length;
    harness().realtime.unavailableModels.add('gpt-realtime-2.1-mini');
    try {
      const response = await startSession(seeded);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ model: string }>().model).toBe('gpt-realtime-2.1');
      expect(
        harness()
          .realtime.calls.slice(before)
          .map((call) => call.model),
      ).toEqual(['gpt-realtime-2.1-mini', 'gpt-realtime-2.1']);
    } finally {
      harness().realtime.unavailableModels.delete('gpt-realtime-2.1-mini');
    }
  });

  it('gives the assistant the saved questions and answers of the workspace', async () => {
    const seeded = await seedRuntimeTenant(harness());
    await storeOpenAiKey(seeded, 'sk-svcacct-faq');
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: browserHeaders(seeded.owner, seeded.tenantId, {
        'idempotency-key': `faq-${randomUUID()}`,
      }),
      payload: {
        source_type: 'MANUAL_QA',
        title: 'Kérdések és válaszok',
        language: 'hu',
        entries: [
          { question: 'Van parkoló?', answer: 'Igen, ingyenes parkoló van az étterem mellett.' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const response = await startSession(seeded);
    expect(response.statusCode, response.body).toBe(200);
    const call = harness().realtime.calls.at(-1);
    expect(call?.instructions).toContain('Van parkoló?');
    expect(call?.instructions).toContain('ingyenes parkoló');
  });

  it('runs real tools for the browser call and records the call with its transcript', async () => {
    const seeded = await seedRuntimeTenant(harness());
    await storeOpenAiKey(seeded, 'sk-svcacct-tools');
    const started = await startSession(seeded);
    expect(started.statusCode, started.body).toBe(200);
    const session = started.json<{
      call_id: string;
      tools: { name: string; specialist: string }[];
    }>();
    expect(session.tools.map((tool) => tool.name).sort()).toEqual([
      'create_booking',
      'lookup_availability',
    ]);
    expect(
      harness()
        .realtime.calls.at(-1)
        ?.tools.map((tool) => tool.name),
    ).toContain('lookup_availability');
    harness().dispatcher.respond = () => ({
      status: 'SUCCEEDED',
      result: { slots: ['2026-09-18T10:00:00Z'] },
      httpStatus: 200,
      latencyMs: 12,
    });
    const executed = await harness().app.inject({
      method: 'POST',
      url: `/v1/web-test-calls/${session.call_id}/tools`,
      headers: browserHeaders(seeded.owner, seeded.tenantId, {
        'idempotency-key': `tool-${randomUUID()}`,
      }),
      payload: {
        tool_name: 'lookup_availability',
        specialist: 'BOOKING',
        arguments: { date: '2026-09-18' },
        conversation_state: 'TOOL_EXECUTION',
        provider_call_id: `${session.call_id}:1`,
      },
    });
    expect(executed.statusCode, executed.body).toBe(200);
    expect(executed.json<{ status: string; result: unknown }>()).toMatchObject({
      status: 'SUCCEEDED',
      result: { slots: ['2026-09-18T10:00:00Z'] },
    });
    const runs = await harness().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.tool_runs WHERE call_id = $1 AND status = 'SUCCEEDED'`,
      [session.call_id],
    );
    expect(runs.rows[0]?.n).toBe(1);

    const ended = await harness().app.inject({
      method: 'POST',
      url: `/v1/web-test-calls/${session.call_id}/end`,
      headers: browserHeaders(seeded.owner, seeded.tenantId, {
        'idempotency-key': `end-${randomUUID()}`,
      }),
      payload: {
        transcript: [
          { speaker: 'AGENT', content: 'Jó napot kívánok!', start_ms: 0, end_ms: 0 },
          { speaker: 'CALLER', content: 'Szeretnék foglalni.', start_ms: 1200, end_ms: 1200 },
        ],
      },
    });
    expect(ended.statusCode, ended.body).toBe(200);
    const call = await harness().admin.query<{ status: string; channel: string; segments: number }>(
      `SELECT c.status, c.channel,
              (SELECT count(*)::int FROM app.transcript_segments s WHERE s.call_id = c.id) AS segments
         FROM app.calls c WHERE c.id = $1`,
      [session.call_id],
    );
    expect(call.rows[0]).toMatchObject({
      status: 'COMPLETED',
      channel: 'WEB_VOICE',
      segments: 2,
    });
  });

  it('refuses when the workspace has no OpenAI credentials', async () => {
    const response = await startSession(tenant);
    expect(response.statusCode).toBe(503);
    expect(response.json<Envelope>()).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { reason: 'openai_credentials_missing' },
    });
  });
});
