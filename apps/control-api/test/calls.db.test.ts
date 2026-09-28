import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { insertCall, seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

let tenant: SeededTenant;
let activeCall: string;
let completedCall: string;
let branchCall: string;
let branchLocationId: string;

async function member(role: string, locationScope: string[] = []): Promise<TestUser> {
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
    `INSERT INTO app.memberships (tenant_id, user_id, role, status, location_scope) VALUES ($1, $2, $3, 'ACTIVE', $4::uuid[])`,
    [tenant.tenantId, userId, role, locationScope],
  );
  return user;
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  const branch = await harness().admin.query<{ id: string }>(
    `INSERT INTO app.locations (tenant_id, name, timezone, country) VALUES ($1, 'Szeged', 'Europe/Budapest', 'HU') RETURNING id`,
    [tenant.tenantId],
  );
  branchLocationId = branch.rows[0]?.id ?? '';
  activeCall = await insertCall(harness(), tenant, {
    status: 'IN_PROGRESS',
    callerE164: '+36301234567',
  });
  completedCall = await insertCall(harness(), tenant, {
    status: 'COMPLETED',
    outcome: 'BOOKING_CREATED',
  });
  branchCall = await insertCall(harness(), tenant, {
    status: 'COMPLETED',
    outcome: 'TRANSFERRED_TO_HUMAN',
    locationId: branchLocationId,
  });
  await harness().admin.query(
    `INSERT INTO app.transcript_segments (tenant_id, call_id, seq, speaker, language, start_ms, end_ms, content) VALUES ($1, $2, 0, 'AGENT', 'hu', 0, 1800, 'Üdvözlöm, AI-asszisztens vagyok.'), ($1, $2, 1, 'CALLER', 'hu', 1900, 3200, 'Időpontot szeretnék.')`,
    [tenant.tenantId, activeCall],
  );
});

describe('call list', () => {
  it('filters, paginates and scopes calls to permitted locations', async () => {
    const owner = tenant.owner;
    const active = await harness().app.inject({
      method: 'GET',
      url: '/v1/calls?status=ACTIVE',
      headers: browserHeaders(owner, tenant.tenantId),
    });
    expect(active.json<{ data: { id: string }[] }>().data.map((call) => call.id)).toEqual([
      activeCall,
    ]);
    const booked = await harness().app.inject({
      method: 'GET',
      url: '/v1/calls?outcome=BOOKING_CREATED',
      headers: browserHeaders(owner, tenant.tenantId),
    });
    expect(booked.json<{ data: { id: string }[] }>().data.map((call) => call.id)).toEqual([
      completedCall,
    ]);
    const firstPage = await harness().app.inject({
      method: 'GET',
      url: '/v1/calls?limit=2',
      headers: browserHeaders(owner, tenant.tenantId),
    });
    const page = firstPage.json<{ data: unknown[]; page: { next_cursor: string | null } }>();
    expect(page.data).toHaveLength(2);
    const secondPage = await harness().app.inject({
      method: 'GET',
      url: `/v1/calls?limit=2&cursor=${encodeURIComponent(page.page.next_cursor ?? '')}`,
      headers: browserHeaders(owner, tenant.tenantId),
    });
    expect(secondPage.json<{ data: unknown[] }>().data).toHaveLength(1);

    const branchOperator = await member('OPERATOR', [branchLocationId]);
    const scoped = await harness().app.inject({
      method: 'GET',
      url: '/v1/calls',
      headers: browserHeaders(branchOperator, tenant.tenantId),
    });
    expect(scoped.json<{ data: { id: string }[] }>().data.map((call) => call.id)).toEqual([
      branchCall,
    ]);
    const outOfScope = await harness().app.inject({
      method: 'GET',
      url: `/v1/calls/${activeCall}`,
      headers: browserHeaders(branchOperator, tenant.tenantId),
    });
    expect(outOfScope.statusCode).toBe(404);
    const forbiddenFilter = await harness().app.inject({
      method: 'GET',
      url: `/v1/calls?location_id=${tenant.locationId}`,
      headers: browserHeaders(branchOperator, tenant.tenantId),
    });
    expect(forbiddenFilter.json<Envelope>().code).toBe('FORBIDDEN');
  });
});

describe('call detail', () => {
  it('masks caller numbers and hides transcripts from roles without transcript permission', async () => {
    const analyst = await member('ANALYST');
    const analystView = await harness().app.inject({
      method: 'GET',
      url: `/v1/calls/${activeCall}`,
      headers: browserHeaders(analyst, tenant.tenantId),
    });
    expect(analystView.json()).toMatchObject({
      caller_e164: '+363******67',
      transcript: null,
      summary: null,
    });
    const ownerView = await harness().app.inject({
      method: 'GET',
      url: `/v1/calls/${activeCall}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const body = ownerView.json<{
      caller_e164: string;
      transcript: { speaker: string; content: string }[];
    }>();
    expect(body.caller_e164).toBe('+36301234567');
    expect(body.transcript.map((segment) => segment.speaker)).toEqual(['AGENT', 'CALLER']);
  });
});

describe('operator call control', () => {
  it('transfers only to allowlisted destinations, exactly once per idempotency key', async () => {
    const operator = await member('OPERATOR');
    const url = `/v1/calls/${activeCall}/transfer`;
    const denied = await harness().app.inject({
      method: 'POST',
      url,
      headers: browserHeaders(operator, tenant.tenantId, {
        'idempotency-key': `transfer-${randomUUID()}`,
      }),
      payload: {
        destination_label: 'premium-line',
        transfer_type: 'WARM',
        reason: 'caller asked for a human',
      },
    });
    expect(denied.json<Envelope>().code).toBe('TRANSFER_DESTINATION_NOT_ALLOWED');

    const key = `transfer-${randomUUID()}`;
    const request = () =>
      harness().app.inject({
        method: 'POST',
        url,
        headers: browserHeaders(operator, tenant.tenantId, { 'idempotency-key': key }),
        payload: {
          destination_label: 'manager',
          transfer_type: 'WARM',
          reason: 'caller asked for a human',
        },
      });
    const accepted = await request();
    expect(accepted.statusCode, accepted.body).toBe(202);
    const replayed = await request();
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    const commands = harness().commandBus.commands.filter((entry) => entry.callId === activeCall);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toMatchObject({
      type: 'TRANSFER',
      destinationE164: '+3613456789',
      transferType: 'WARM',
    });
    const state = await harness().admin.query<{ status: string }>(
      'SELECT status FROM app.calls WHERE id = $1',
      [activeCall],
    );
    expect(state.rows[0]?.status).toBe('TRANSFERRING');

    const analyst = await member('ANALYST');
    const forbidden = await harness().app.inject({
      method: 'POST',
      url: `/v1/calls/${completedCall}/transfer`,
      headers: browserHeaders(analyst, tenant.tenantId, {
        'idempotency-key': `transfer-${randomUUID()}`,
      }),
      payload: { destination_label: 'manager', transfer_type: 'COLD', reason: 'not allowed' },
    });
    expect(forbidden.json<Envelope>().code).toBe('FORBIDDEN');
    const ended = await harness().app.inject({
      method: 'POST',
      url: `/v1/calls/${completedCall}/transfer`,
      headers: browserHeaders(operator, tenant.tenantId, {
        'idempotency-key': `transfer-${randomUUID()}`,
      }),
      payload: { destination_label: 'manager', transfer_type: 'COLD', reason: 'too late' },
    });
    expect(ended.json<Envelope>().code).toBe('INVALID_STATE_TRANSITION');
  });

  it('surfaces an unreachable runtime as a retryable service error', async () => {
    const liveCall = await insertCall(harness(), tenant, { status: 'IN_PROGRESS' });
    harness().commandBus.reply = {
      accepted: false,
      state: 'UNREACHABLE',
      errorCode: 'SERVICE_UNAVAILABLE',
    };
    const response = await harness().app.inject({
      method: 'POST',
      url: `/v1/calls/${liveCall}/terminate`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `terminate-${randomUUID()}`,
      }),
      payload: { reason: 'abusive caller' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('2');
    harness().commandBus.reply = { accepted: true, state: 'TERMINATING', errorCode: null };
    const retried = await harness().app.inject({
      method: 'POST',
      url: `/v1/calls/${liveCall}/terminate`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `terminate-${randomUUID()}`,
      }),
      payload: { reason: 'abusive caller' },
    });
    expect(retried.json()).toMatchObject({ call_id: liveCall, runtime_state: 'TERMINATING' });
  });
});
