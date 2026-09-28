import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

interface Contact {
  id: string;
  display_name: string | null;
  version: number;
  identities: { id: string; identity_type: string; value: string }[];
  calls?: { id: string }[];
  bookings?: { id: string }[];
  privacy_requests?: { id: string; status: string }[];
}

function write(user: TestUser, extra: Record<string, string> = {}) {
  return browserHeaders(user, tenant.tenantId, {
    'idempotency-key': `contact-${randomUUID()}`,
    ...extra,
  });
}

async function startCall(e164: string, channel: 'PSTN' | 'SIMULATION' = 'PSTN'): Promise<string> {
  const callId = randomUUID();
  const token = await harness().serviceToken(['call.control'], tenant.tenantId);
  const response = await harness().internal.inject({
    method: 'PUT',
    url: `/internal/v1/calls/${callId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      provider: 'openai',
      provider_call_id: `pc-${callId}`,
      channel,
      direction: 'INBOUND',
      caller_e164: e164,
      location_id: tenant.locationId,
      agent_id: tenant.agentId,
      agent_version_id: tenant.versionId,
      status: 'IN_PROGRESS',
      started_at: new Date().toISOString(),
      trace_id: randomBytes(16).toString('hex'),
      runtime_instance_id: 'vr-test',
      recording_enabled: false,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return callId;
}

async function personOf(callId: string): Promise<string | null> {
  const result = await harness().admin.query<{ person_id: string | null }>(
    'SELECT person_id FROM app.calls WHERE id = $1',
    [callId],
  );
  return result.rows[0]?.person_id ?? null;
}

async function member(role: string): Promise<TestUser> {
  const user = harness().sessions.issue(
    `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
  );
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  await harness().admin.query(
    `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenant.tenantId, me.json<{ user: { id: string } }>().user.id, role],
  );
  return user;
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

describe('caller identity and contacts', () => {
  it('links calls from the same number to one profile and ignores simulations', async () => {
    const first = await startCall('+36301234567');
    const second = await startCall('+36301234567');
    const simulated = await startCall('+36301234567', 'SIMULATION');
    const person = await personOf(first);
    expect(person).not.toBeNull();
    expect(await personOf(second)).toBe(person);
    expect(await personOf(simulated)).toBeNull();
    const identities = await harness().admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.person_identities WHERE tenant_id = $1 AND normalized_value = '+36301234567'`,
      [tenant.tenantId],
    );
    expect(identities.rows[0]?.count).toBe(1);
  });

  it('searches, masks for restricted roles, updates, adds identities and exports', async () => {
    const callId = await startCall('+36309998877');
    const personId = (await personOf(callId)) ?? '';
    const app = harness().app;

    const searched = await app.inject({
      method: 'GET',
      url: '/v1/contacts?q=99988',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(searched.statusCode, searched.body).toBe(200);
    const found = searched.json<{ data: Contact[] }>().data;
    expect(found.map((contact) => contact.id)).toEqual([personId]);
    expect(found[0]?.identities[0]?.value).toBe('+36309998877');

    const analyst = await member('ANALYST');
    const masked = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${personId}`,
      headers: browserHeaders(analyst, tenant.tenantId),
    });
    expect(masked.statusCode).toBe(403);
    const operator = await member('OPERATOR');
    const operatorView = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${personId}`,
      headers: browserHeaders(operator, tenant.tenantId),
    });
    expect(operatorView.json<Contact>().identities[0]?.value).toBe('+36309998877');
    const viewer = await member('VIEWER');
    const viewerList = await app.inject({
      method: 'GET',
      url: '/v1/contacts?q=99988',
      headers: browserHeaders(viewer, tenant.tenantId),
    });
    if (viewerList.statusCode === 200) {
      expect(viewerList.json<{ data: Contact[] }>().data[0]?.identities[0]?.value).toMatch(
        /^\+363\*+77$/,
      );
    } else {
      expect(viewerList.statusCode).toBe(403);
    }

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${personId}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const contact = detail.json<Contact>();
    expect(contact.calls?.map((call) => call.id)).toEqual([callId]);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/contacts/${personId}`,
      headers: write(tenant.owner, { 'if-match': 'W/"99"' }),
      payload: { display_name: 'Nagy Péter' },
    });
    expect(stale.json<{ code: string }>().code).toBe('VERSION_CONFLICT');
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/contacts/${personId}`,
      headers: write(tenant.owner, { 'if-match': `W/"${String(contact.version)}"` }),
      payload: { display_name: 'Nagy Péter', preferred_language: 'hu', memory_enabled: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      display_name: 'Nagy Péter',
      display_name_verification: 'HUMAN_VERIFIED',
      preferred_language: 'hu',
      memory_enabled: true,
    });

    const email = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${personId}/identities`,
      headers: write(tenant.owner),
      payload: { identity_type: 'EMAIL', value: ' Peter.Nagy@Example.test ' },
    });
    expect(email.statusCode, email.body).toBe(201);
    expect(email.json()).toMatchObject({
      identity_type: 'EMAIL',
      value: 'peter.nagy@example.test',
      verification_state: 'HUMAN_VERIFIED',
    });
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${personId}/identities`,
      headers: write(tenant.owner),
      payload: { identity_type: 'PHONE', value: '0630' },
    });
    expect(invalid.statusCode).toBe(400);

    const byName = await app.inject({
      method: 'GET',
      url: '/v1/contacts?q=nagy',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(byName.json<{ data: Contact[] }>().data.map((entry) => entry.id)).toContain(personId);

    const exported = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${personId}/export`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['cache-control']).toBe('private, no-store');
    expect(exported.json()).toMatchObject({
      format: 'velyric.contact_export.v1',
      profile: { id: personId },
      calls: [{ id: callId }],
    });
    const audit = await harness().admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.audit_logs WHERE tenant_id = $1 AND action = 'contact.exported' AND object_id = $2`,
      [tenant.tenantId, personId],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('merges duplicates and records erasure requests with legal hold awareness', async () => {
    const app = harness().app;
    const sourceCall = await startCall('+36701112222');
    const targetCall = await startCall('+36703334444');
    const source = (await personOf(sourceCall)) ?? '';
    const target = (await personOf(targetCall)) ?? '';

    const merged = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${source}/merge`,
      headers: write(tenant.owner),
      payload: { target_id: target },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(await personOf(sourceCall)).toBe(target);
    const gone = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${source}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(gone.statusCode).toBe(404);
    const again = await startCall('+36701112222');
    expect(await personOf(again)).toBe(target);
    const mergeEvent = await harness().admin.query<{ merge_kind: string }>(
      'SELECT merge_kind FROM app.identity_merge_events WHERE source_person_id = $1',
      [source],
    );
    expect(mergeEvent.rows[0]?.merge_kind).toBe('MANUAL');

    const erasure = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${target}/erasure`,
      headers: write(tenant.owner),
      payload: { received_via: 'PHONE', verification_method: 'booking reference confirmed' },
    });
    expect(erasure.statusCode, erasure.body).toBe(202);
    expect(erasure.json()).toMatchObject({ status: 'IN_PROGRESS' });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${target}/erasure`,
      headers: write(tenant.owner),
      payload: { received_via: 'PHONE', verification_method: 'booking reference confirmed' },
    });
    expect(duplicate.json<{ code: string }>().code).toBe('CONFLICT');
    const event = await harness().admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'privacy.request_created'`,
      [tenant.tenantId],
    );
    expect(event.rows[0]?.count).toBe(1);

    const heldCall = await startCall('+36705556666');
    const held = (await personOf(heldCall)) ?? '';
    await harness().admin.query(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, scope_ref, reason, legal_basis, created_by) VALUES ($1, 'PERSON', $2, 'pending court case evidence', 'litigation', 'legal')`,
      [tenant.tenantId, held],
    );
    const onHold = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${held}/erasure`,
      headers: write(tenant.owner),
      payload: { received_via: 'EMAIL', verification_method: 'email verification' },
    });
    expect(onHold.json()).toMatchObject({ status: 'ON_LEGAL_HOLD' });

    const operator = await member('OPERATOR');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${held}/erasure`,
      headers: write(operator),
      payload: { received_via: 'EMAIL', verification_method: 'email verification' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('waitlist', () => {
  it('creates entries for contacts and enforces transitions and versions', async () => {
    const app = harness().app;
    const person = (await personOf(await startCall('+36208887766'))) ?? '';
    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const payload = {
      person_id: person,
      location_id: tenant.locationId,
      desired_from: from.toISOString(),
      desired_to: to.toISOString(),
      party_size: 2,
      contact_channel: 'SMS',
      contact_consent: true,
      expires_at: to.toISOString(),
    };

    const invalidWindow = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      headers: write(tenant.owner),
      payload: { ...payload, desired_to: from.toISOString() },
    });
    expect(invalidWindow.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      headers: write(tenant.owner),
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const entry = created.json<{
      id: string;
      status: string;
      version: number;
      person: { id: string };
      desired_from: string;
    }>();
    expect(entry).toMatchObject({
      status: 'ACTIVE',
      person: { id: person },
      desired_from: from.toISOString(),
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/waitlist?status=ACTIVE',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(listed.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toContain(entry.id);

    const fulfilled = await app.inject({
      method: 'PATCH',
      url: `/v1/waitlist/${entry.id}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: { status: 'FULFILLED' },
    });
    expect(fulfilled.statusCode, fulfilled.body).toBe(200);
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/v1/waitlist/${entry.id}`,
      headers: write(tenant.owner, { 'if-match': 'W/"2"' }),
      payload: { status: 'ACTIVE' },
    });
    expect(reopen.json<{ code: string }>().code).toBe('INVALID_STATE_TRANSITION');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/waitlist/${entry.id}`,
      headers: write(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: { priority: 5 },
    });
    expect(stale.json<{ code: string }>().code).toBe('VERSION_CONFLICT');
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/waitlist/${entry.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json()).toMatchObject({ status: 'FULFILLED', offers: [] });
  });
});
