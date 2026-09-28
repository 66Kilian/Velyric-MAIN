import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

async function call(options: {
  startedAt: string;
  status: string;
  outcome: string | null;
  intent?: string;
  language?: string;
  connected?: number;
  cost?: number;
  quality?: number;
  locationId?: string;
  channel?: string;
}): Promise<string> {
  const id = randomUUID();
  await harness().admin.query(
    `INSERT INTO app.calls (id, tenant_id, location_id, phone_number_id, agent_id, agent_version_id, provider, provider_call_id, channel, direction, caller_e164, language, status, outcome, intent, started_at, ended_at, connected_seconds, cost_usd_micros, quality_score, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'telnyx', $7, $8, 'INBOUND', '+36301234567', $9, $10, $11, $12, $13::timestamptz, $13::timestamptz + interval '4 minutes', $14, $15, $16, $17)`,
    [
      id,
      tenant.tenantId,
      options.locationId ?? tenant.locationId,
      tenant.phoneNumberId,
      tenant.agentId,
      tenant.versionId,
      `op:${id}`,
      options.channel ?? 'PSTN',
      options.language ?? 'hu',
      options.status,
      options.outcome,
      options.intent ?? null,
      options.startedAt,
      options.connected ?? 120,
      options.cost ?? 60_000,
      options.quality ?? null,
      randomUUID().replaceAll('-', ''),
    ],
  );
  return id;
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  await call({
    startedAt: '2026-09-01T06:30:00Z',
    status: 'COMPLETED',
    outcome: 'BOOKING_CREATED',
    intent: 'BOOKING',
    connected: 180,
    quality: 4.5,
  });
  await call({
    startedAt: '2026-09-01T07:10:00Z',
    status: 'COMPLETED',
    outcome: 'INFORMATION_PROVIDED',
    intent: 'GENERAL_INQUIRY',
    connected: 60,
    quality: 3.5,
  });
  await call({
    startedAt: '2026-09-01T22:30:00Z',
    status: 'TRANSFERRED',
    outcome: 'TRANSFERRED_TO_HUMAN',
    intent: 'BILLING',
    language: 'en',
    connected: 240,
  });
  await call({
    startedAt: '2026-09-02T08:00:00Z',
    status: 'ABANDONED',
    outcome: 'ABANDONED',
    connected: 0,
    cost: 0,
  });
  await call({
    startedAt: '2026-08-31T22:01:00Z',
    status: 'COMPLETED',
    outcome: 'RESOLVED',
    intent: 'GENERAL_INQUIRY',
    channel: 'WEB_VOICE',
  });
  await call({
    startedAt: '2026-08-31T21:59:00Z',
    status: 'COMPLETED',
    outcome: 'RESOLVED',
    intent: 'GENERAL_INQUIRY',
  });
  await call({ startedAt: '2026-09-05T08:00:00Z', status: 'IN_PROGRESS', outcome: null });
});

describe('analytics overview', () => {
  it('aggregates finished calls in the tenant time zone with containment and hourly distribution', async () => {
    const response = await harness().app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?from=2026-09-01&to=2026-09-02',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      range: { timezone: string };
      totals: Record<string, number | null>;
      daily: { date: string; calls_total: number }[];
      hourly: { hour: number; calls_total: number }[];
      intents: { intent: string; calls_total: number }[];
      languages: { language: string; calls_total: number }[];
    }>();
    expect(body.range.timezone).toBe('Europe/Budapest');
    expect(body.totals).toMatchObject({
      calls_total: 5,
      resolved_by_ai: 3,
      transferred_to_human: 1,
      abandoned: 1,
      bookings_created: 1,
      web_voice_calls: 1,
      cost_usd_micros: 240_000,
      avg_quality_score: 4,
      containment_rate: 0.6,
    });
    expect(body.daily).toEqual([
      {
        date: '2026-09-01',
        calls_total: 3,
        resolved_by_ai: 3,
        transferred_to_human: 0,
        abandoned: 0,
        avg_connected_seconds: 120,
        avg_quality_score: 4,
      },
      {
        date: '2026-09-02',
        calls_total: 2,
        resolved_by_ai: 0,
        transferred_to_human: 1,
        abandoned: 1,
        avg_connected_seconds: 240,
        avg_quality_score: null,
      },
    ]);
    expect(body.hourly).toEqual([
      { hour: 0, calls_total: 2 },
      { hour: 8, calls_total: 1 },
      { hour: 9, calls_total: 1 },
      { hour: 10, calls_total: 1 },
    ]);
    const august = await harness().app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?from=2026-08-31&to=2026-08-31',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(
      august.json<{ totals: { calls_total: number; web_voice_calls: number } }>().totals,
    ).toMatchObject({ calls_total: 1, web_voice_calls: 0 });
    const tooLong = await harness().app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?from=2026-01-01&to=2026-06-30',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(tooLong.statusCode).toBe(400);
    const invalid = await harness().app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?from=2026-02-30&to=2026-03-01',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('phone numbers', () => {
  it('lists numbers with their bound agent and rebinds or unbinds agents atomically', async () => {
    const listed = await harness().app.inject({
      method: 'GET',
      url: '/v1/phone-numbers',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const numbers = listed.json<{
      data: { id: string; e164: string; agent: { id: string } | null; version: number }[];
    }>().data;
    expect(numbers).toEqual([
      expect.objectContaining({
        id: tenant.phoneNumberId,
        e164: tenant.e164,
        agent: expect.objectContaining({ id: tenant.agentId }) as unknown,
      }),
    ]);

    const unbound = await harness().app.inject({
      method: 'PUT',
      url: `/v1/phone-numbers/${tenant.phoneNumberId}/agent`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `bind-${randomUUID()}`,
      }),
      payload: { agent_id: null },
    });
    expect(unbound.json()).toMatchObject({ agent: null });
    const rebound = await harness().app.inject({
      method: 'PUT',
      url: `/v1/phone-numbers/${tenant.phoneNumberId}/agent`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `bind-${randomUUID()}`,
      }),
      payload: { agent_id: tenant.agentId },
    });
    expect(rebound.json()).toMatchObject({ agent: { id: tenant.agentId } });
    const active = await harness().admin.query(
      `SELECT count(*)::int AS count FROM app.agent_phone_bindings WHERE phone_number_id = $1 AND active`,
      [tenant.phoneNumberId],
    );
    expect(active.rows[0]).toEqual({ count: 1 });

    const draftAgent = await harness().admin.query<{ id: string }>(
      `INSERT INTO app.agents (tenant_id, name, status) VALUES ($1, 'Vázlat', 'DRAFT') RETURNING id`,
      [tenant.tenantId],
    );
    const refused = await harness().app.inject({
      method: 'PUT',
      url: `/v1/phone-numbers/${tenant.phoneNumberId}/agent`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `bind-${randomUUID()}`,
      }),
      payload: { agent_id: draftAgent.rows[0]?.id },
    });
    expect(refused.json()).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { reason: 'agent_has_no_production_version' },
    });

    const current = await harness().app.inject({
      method: 'GET',
      url: '/v1/phone-numbers',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const version = current.json<{ data: { version: number }[] }>().data[0]?.version ?? 0;
    const tooMany = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/phone-numbers/${tenant.phoneNumberId}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `pn-${randomUUID()}`,
        'if-match': `W/"${String(version)}"`,
      }),
      payload: { max_concurrent_calls: 50 },
    });
    expect(tooMany.json()).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'concurrency', max: 2 },
    });
    const limited = await harness().app.inject({
      method: 'PATCH',
      url: `/v1/phone-numbers/${tenant.phoneNumberId}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `pn-${randomUUID()}`,
        'if-match': `W/"${String(version)}"`,
      }),
      payload: { max_concurrent_calls: 1 },
    });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json()).toMatchObject({ max_concurrent_calls: 1, version: version + 1 });
  });
});
