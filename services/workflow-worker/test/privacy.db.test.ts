import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPrivacyActivities } from '../src/activities/privacy.js';
import { seedTenant, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const NOW = new Date('2026-09-15T09:00:00Z');
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function one<T>(sqlText: string, values: unknown[]): Promise<T> {
  const result = await database().admin.query(sqlText, values);
  const row = result.rows[0] as T | undefined;
  if (row === undefined) {
    throw new Error(`no row returned for ${sqlText.slice(0, 40)}`);
  }
  return row;
}

async function seedCaller(tenantId: string): Promise<{
  personId: string;
  sourceId: string;
  callId: string;
  heldCallId: string;
  locationId: string;
}> {
  const { id: locationId } = await one<{ id: string }>(
    `INSERT INTO app.locations (tenant_id, name, timezone, country) VALUES ($1, 'Belváros', 'Europe/Budapest', 'HU') RETURNING id`,
    [tenantId],
  );
  const { id: personId } = await one<{ id: string }>(
    `INSERT INTO app.caller_profiles (tenant_id, display_name, preferred_language, memory_enabled) VALUES ($1, 'Kiss Anna', 'hu', true) RETURNING id`,
    [tenantId],
  );
  const { id: sourceId } = await one<{ id: string }>(
    `INSERT INTO app.caller_profiles (tenant_id, display_name, merged_into_profile_id) VALUES ($1, 'Anna K.', $2) RETURNING id`,
    [tenantId, personId],
  );
  await database().admin.query(
    `INSERT INTO app.person_identities (tenant_id, person_id, identity_type, normalized_value, value_hash, verification_state, source, confidence)
     VALUES ($1, $2, 'PHONE', '+36301234567', $3, 'OBSERVED', 'CALLER_ID', 0.9), ($1, $4, 'EMAIL', 'anna@example.test', $5, 'CALLER_PROVIDED', 'VOICE_AGENT', 0.8)`,
    [tenantId, personId, randomBytes(32), sourceId, randomBytes(32)],
  );
  const insertCall = async (person: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO app.calls (tenant_id, provider, provider_call_id, channel, direction, started_at, trace_id, person_id, caller_e164, summary, location_id)
         VALUES ($1, 'openai', $2, 'PSTN', 'INBOUND', now() - interval '1 day', $3, $4, '+36301234567', 'Időpontot foglalt fogtisztításra.', $5) RETURNING id`,
        [tenantId, `pc-${randomBytes(6).toString('hex')}`, TRACE, person, locationId],
      )
    ).id;
  const callId = await insertCall(personId);
  const heldCallId = await insertCall(sourceId);
  for (const call of [callId, heldCallId]) {
    await database().admin.query(
      `INSERT INTO app.transcript_segments (tenant_id, call_id, seq, speaker, start_ms, end_ms, content) VALUES ($1, $2, 0, 'CALLER', 0, 1200, 'Kiss Anna vagyok, a számom +36301234567.')`,
      [tenantId, call],
    );
  }
  await database().admin.query(
    `INSERT INTO app.waitlist_entries (tenant_id, location_id, person_id, desired_window, contact_consent, contact_channel, expires_at)
     VALUES ($1, $2, $3, tstzrange(now() + interval '1 day', now() + interval '2 days'), true, 'SMS', now() + interval '2 days')`,
    [tenantId, locationId, personId],
  );
  return { personId, sourceId, callId, heldCallId, locationId };
}

async function request(tenantId: string, personId: string): Promise<string> {
  return (
    await one<{ id: string }>(
      `INSERT INTO app.dsar_requests (tenant_id, person_id, request_type, status, received_via, verification_method, verified_at, due_at, created_by)
       VALUES ($1, $2, 'DELETE', 'IN_PROGRESS', 'EMAIL', 'Callback confirmed', now(), now() + interval '30 days', 'owner') RETURNING id`,
      [tenantId, personId],
    )
  ).id;
}

describe('caller erasure activity', () => {
  it('erases personal data across merged profiles while honouring call-level legal holds', async () => {
    const tenantId = await seedTenant(database().admin);
    const seeded = await seedCaller(tenantId);
    await database().admin.query(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, scope_ref, reason, legal_basis, created_by) VALUES ($1, 'CALL', $2, 'Complaint about this specific call', 'Consumer protection', 'owner')`,
      [tenantId, seeded.heldCallId],
    );
    const requestId = await request(tenantId, seeded.personId);
    const activities = createPrivacyActivities({
      db: database().db,
      now: () => NOW,
      logger: silent,
    });

    const result = await activities.eraseCallerData({ tenantId, requestId, traceId: TRACE });
    expect(result).toEqual({
      outcome: 'COMPLETED',
      affected: {
        profiles: 2,
        calls: 1,
        transcripts: 1,
        bookings: 0,
        waitlist: 1,
        identities: 2,
        held_calls: 1,
      },
    });

    const profiles = await database().admin.query<{
      display_name: string | null;
      memory_enabled: boolean;
      preferred_language: string | null;
    }>(
      `SELECT display_name, memory_enabled, preferred_language FROM app.caller_profiles WHERE id = ANY($1)`,
      [[seeded.personId, seeded.sourceId]],
    );
    expect(profiles.rows).toEqual([
      { display_name: null, memory_enabled: false, preferred_language: null },
      { display_name: null, memory_enabled: false, preferred_language: null },
    ]);
    const identities = await database().admin.query(
      `SELECT 1 FROM app.person_identities WHERE person_id = ANY($1)`,
      [[seeded.personId, seeded.sourceId]],
    );
    expect(identities.rowCount).toBe(0);
    const calls = await database().admin.query<{
      id: string;
      caller_e164: string | null;
      summary: string | null;
      content: string;
      redaction_state: string;
    }>(
      `SELECT c.id, c.caller_e164, c.summary, s.content, s.redaction_state FROM app.calls c JOIN app.transcript_segments s ON s.call_id = c.id WHERE c.id = ANY($1)`,
      [[seeded.callId, seeded.heldCallId]],
    );
    expect(calls.rows.find((row) => row.id === seeded.callId)).toMatchObject({
      caller_e164: null,
      summary: null,
      content: '',
      redaction_state: 'PURGED',
    });
    const heldCall = calls.rows.find((row) => row.id === seeded.heldCallId);
    expect(heldCall?.caller_e164).toBe('+36301234567');
    expect(heldCall?.redaction_state).not.toBe('PURGED');
    expect(heldCall?.content).toContain('Kiss Anna');
    const waitlist = await database().admin.query<{ status: string }>(
      `SELECT status FROM app.waitlist_entries WHERE person_id = $1`,
      [seeded.personId],
    );
    expect(waitlist.rows).toEqual([{ status: 'CANCELED' }]);
    const stored = await one<{ status: string; completed_at: Date | null }>(
      `SELECT status, completed_at FROM app.dsar_requests WHERE id = $1`,
      [requestId],
    );
    expect(stored.status).toBe('COMPLETED');
    expect(stored.completed_at?.toISOString()).toBe(NOW.toISOString());
    const audit = await one<{ metadata: { transcripts: number } }>(
      `SELECT metadata FROM app.audit_logs WHERE tenant_id = $1 AND action = 'privacy_request.erasure_completed' AND object_id = $2`,
      [tenantId, requestId],
    );
    expect(audit.metadata.transcripts).toBe(1);

    expect(await activities.eraseCallerData({ tenantId, requestId, traceId: TRACE })).toEqual({
      outcome: 'ALREADY_COMPLETED',
      affected: {},
    });
  });

  it('parks the request when a person or workspace hold was placed after verification', async () => {
    const tenantId = await seedTenant(database().admin);
    const seeded = await seedCaller(tenantId);
    const { id: holdId } = await one<{ id: string }>(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, scope_ref, reason, legal_basis, created_by) VALUES ($1, 'PERSON', $2, 'Litigation involving this caller', 'Civil procedure', 'owner') RETURNING id`,
      [tenantId, seeded.personId],
    );
    const requestId = await request(tenantId, seeded.personId);
    const activities = createPrivacyActivities({
      db: database().db,
      now: () => NOW,
      logger: silent,
    });

    expect(await activities.eraseCallerData({ tenantId, requestId, traceId: TRACE })).toEqual({
      outcome: 'ON_LEGAL_HOLD',
      affected: {},
    });
    const stored = await one<{ status: string; legal_hold_id: string }>(
      `SELECT status, legal_hold_id FROM app.dsar_requests WHERE id = $1`,
      [requestId],
    );
    expect(stored).toEqual({ status: 'ON_LEGAL_HOLD', legal_hold_id: holdId });
    const profile = await one<{ display_name: string | null }>(
      `SELECT display_name FROM app.caller_profiles WHERE id = $1`,
      [seeded.personId],
    );
    expect(profile.display_name).toBe('Kiss Anna');
  });
});
