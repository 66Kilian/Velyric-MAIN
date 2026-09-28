import { randomUUID } from 'node:crypto';
import { PRICING_VERSION, type AgentConfig } from '@velyric/contracts';
import { agentConfigFixture } from '@velyric/testkit';
import { expect } from 'vitest';
import { browserHeaders, type Harness, type TestUser } from './harness.js';

export interface SeededTenant {
  readonly owner: TestUser;
  readonly tenantId: string;
  readonly locationId: string;
  readonly agentId: string;
  readonly versionId: string;
  readonly configHash: string;
  readonly phoneNumberId: string;
  readonly e164: string;
  readonly lookupToolId: string;
  readonly bookingToolId: string;
}

export const LOOKUP_INPUT = {
  type: 'object',
  required: ['date'],
  properties: { date: { type: 'string', format: 'date' } },
  additionalProperties: false,
};
export const LOOKUP_OUTPUT = {
  type: 'object',
  required: ['slots'],
  properties: { slots: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
};
export const BOOKING_INPUT = {
  type: 'object',
  required: ['start', 'party_size'],
  properties: {
    start: { type: 'string', format: 'date-time' },
    party_size: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};
export const BOOKING_OUTPUT = {
  type: 'object',
  required: ['booking_id'],
  properties: { booking_id: { type: 'string' } },
  additionalProperties: false,
};

export function runtimeAgentConfig(): AgentConfig {
  const base = agentConfigFixture();
  return agentConfigFixture({
    specialists: [
      {
        kind: 'RECEPTION_ROUTER',
        enabled: true,
        tool_allowlist: ['lookup_availability'],
        max_tool_executions: 2,
        model_tier: 'ROUTINE',
      },
      {
        kind: 'BOOKING',
        enabled: true,
        tool_allowlist: ['lookup_availability', 'create_booking'],
        max_tool_executions: 4,
        model_tier: 'ROUTINE',
      },
      {
        kind: 'HANDOFF_COMPLIANCE',
        enabled: true,
        tool_allowlist: [],
        max_tool_executions: 0,
        model_tier: 'ROUTINE',
      },
    ],
    limits: { ...base.limits, max_tool_executions_per_call: 4 },
    handoff: {
      ...base.handoff,
      destinations: [
        { label: 'front-desk', e164: '+3612345678', description: 'Recepció' },
        { label: 'manager', e164: '+3613456789', description: 'Üzletvezető' },
      ],
    },
  });
}

export interface SeededStaff {
  readonly user: TestUser;
  readonly userId: string;
  readonly email: string;
}

export async function seedPlatformStaff(
  harness: Harness,
  platformRole: string,
  active = true,
): Promise<SeededStaff> {
  const email = `staff-${randomUUID().slice(0, 8)}@velyric.test`;
  const user = harness.sessions.issue(email);
  const me = await harness.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  expect(me.statusCode, me.body).toBe(200);
  const userId = me.json<{ user: { id: string } }>().user.id;
  await harness.admin.query(
    `INSERT INTO app.platform_staff (user_id, platform_role, active) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET platform_role = EXCLUDED.platform_role, active = EXCLUDED.active`,
    [userId, platformRole, active],
  );
  return { user, userId, email };
}

export async function seedRuntimeTenant(harness: Harness): Promise<SeededTenant> {
  const owner = harness.sessions.issue(`runtime-${randomUUID().slice(0, 6)}@example.test`);
  const slug = `rt-${randomUUID().slice(0, 8)}`;
  const workspace = await harness.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: browserHeaders(owner, undefined, { 'idempotency-key': `ws-${randomUUID()}` }),
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
  expect(workspace.statusCode, workspace.body).toBe(201);
  const tenantId = workspace.json<{ id: string }>().id;
  const location = await harness.admin.query<{ id: string }>(
    'SELECT id FROM app.locations WHERE tenant_id = $1',
    [tenantId],
  );
  const locationId = location.rows[0]?.id ?? '';

  await harness.admin.query(
    `DELETE FROM app.tool_definitions WHERE tenant_id = $1 AND name IN ('lookup_availability', 'create_booking')`,
    [tenantId],
  );
  const lookupToolId = randomUUID();
  const bookingToolId = randomUUID();
  await harness.admin.query(
    `INSERT INTO app.tool_definitions (id, tenant_id, name, description, kind, connector_key, input_schema, output_schema, side_effect_class, confirmation_policy, idempotency_supported, timeout_ms)
     VALUES ($1, $3, 'lookup_availability', 'Find free slots', 'CONNECTOR', 'google_calendar', $4, $5, 'READ', 'NONE', true, 3000),
            ($2, $3, 'create_booking', 'Create a booking', 'CONNECTOR', 'google_calendar', $6, $7, 'WRITE', 'CALLER_CONFIRMATION', true, 5000)`,
    [
      lookupToolId,
      bookingToolId,
      tenantId,
      JSON.stringify(LOOKUP_INPUT),
      JSON.stringify(LOOKUP_OUTPUT),
      JSON.stringify(BOOKING_INPUT),
      JSON.stringify(BOOKING_OUTPUT),
    ],
  );

  const agent = await harness.app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: browserHeaders(owner, tenantId, { 'idempotency-key': `agent-${randomUUID()}` }),
    payload: { name: 'Recepció', location_id: locationId },
  });
  const agentId = agent.json<{ id: string }>().id;
  const version = await harness.app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/versions`,
    headers: browserHeaders(owner, tenantId, { 'idempotency-key': `version-${randomUUID()}` }),
    payload: { config: runtimeAgentConfig() },
  });
  expect(version.statusCode, version.body).toBe(201);
  const { id: versionId, config_hash: configHash } = version.json<{
    id: string;
    config_hash: string;
  }>();

  await harness.admin.query(
    `UPDATE app.agent_versions SET status = 'PRODUCTION', rollout_percent = 100, published_at = now() WHERE id = $1`,
    [versionId],
  );
  await harness.admin.query(
    `UPDATE app.agents SET status = 'ACTIVE', production_version_id = $1 WHERE id = $2`,
    [versionId, agentId],
  );

  const e164 = `+3615${String(Math.floor(100_000 + Math.random() * 899_999))}`;
  const phone = await harness.admin.query<{ id: string }>(
    `INSERT INTO app.phone_numbers (tenant_id, location_id, provider, e164, country, number_type, status) VALUES ($1, $2, 'telnyx', $3, 'HU', 'LOCAL', 'ACTIVE') RETURNING id`,
    [tenantId, locationId, e164],
  );
  const phoneNumberId = phone.rows[0]?.id ?? '';
  await harness.admin.query(
    `INSERT INTO app.agent_phone_bindings (tenant_id, agent_id, phone_number_id, priority) VALUES ($1, $2, $3, 0)`,
    [tenantId, agentId, phoneNumberId],
  );
  await harness.admin.query(
    `INSERT INTO app.entitlement_snapshots (tenant_id, version, plan_code, pricing_version, billing_period_start, billing_period_end, effective_from, included_voice_seconds, overage_minor_per_minute, currency, concurrency_limit, burst_policy, features, limits, source_kind, source_ref)
     VALUES ($1, 1, 'START', $2, now() - interval '1 day', now() + interval '30 days', now(), 9000, 14900, 'HUF', 2, 'NONE', '["knowledge_base"]', '{"max_call_duration_seconds":1800}', 'ADMIN_OVERRIDE', 'test')`,
    [tenantId, PRICING_VERSION],
  );
  await harness.admin.query(`UPDATE app.tenants SET status = 'ACTIVE' WHERE id = $1`, [tenantId]);
  return {
    owner,
    tenantId,
    locationId,
    agentId,
    versionId,
    configHash,
    phoneNumberId,
    e164,
    lookupToolId,
    bookingToolId,
  };
}

export async function insertCall(
  harness: Harness,
  tenant: SeededTenant,
  overrides: {
    status?: string;
    locationId?: string;
    outcome?: string | null;
    callerE164?: string;
    ended?: boolean;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const ended =
    overrides.ended ??
    ['COMPLETED', 'FAILED', 'ABANDONED', 'TRANSFERRED', 'REJECTED'].includes(
      overrides.status ?? 'IN_PROGRESS',
    );
  await harness.admin.query(
    `INSERT INTO app.calls (id, tenant_id, location_id, phone_number_id, agent_id, agent_version_id, provider, provider_call_id, channel, direction, caller_e164, language, status, outcome, started_at, ended_at, connected_seconds, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'telnyx', $7, 'PSTN', 'INBOUND', $8, 'hu', $9, $10, now() - interval '5 minutes', $11, $12, $13)`,
    [
      id,
      tenant.tenantId,
      overrides.locationId ?? tenant.locationId,
      tenant.phoneNumberId,
      tenant.agentId,
      tenant.versionId,
      `v3:${id}`,
      overrides.callerE164 ?? '+36301234567',
      overrides.status ?? 'IN_PROGRESS',
      overrides.outcome ?? null,
      ended ? new Date() : null,
      ended ? 252 : null,
      randomUUID().replaceAll('-', ''),
    ],
  );
  return id;
}
