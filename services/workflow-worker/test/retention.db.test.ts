import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRetentionActivities } from '../src/activities/retention.js';
import { seedTenant, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function seedCallWithTranscript(tenantId: string, ageDays: number): Promise<string> {
  const call = await database().admin.query<{ id: string }>(
    `INSERT INTO app.calls (tenant_id, provider, provider_call_id, channel, direction, started_at, trace_id, summary)
     VALUES ($1, 'openai', $2, 'PSTN', 'INBOUND', now() - make_interval(days => $3), $4, 'Foglalás egyeztetése') RETURNING id`,
    [tenantId, `pc-${randomUUID()}`, ageDays, TRACE],
  );
  const callId = call.rows[0]?.id ?? '';
  await database().admin.query(
    `INSERT INTO app.transcript_segments (tenant_id, call_id, seq, speaker, start_ms, end_ms, content, created_at)
     VALUES ($1, $2, 0, 'CALLER', 0, 900, 'Szeretnék időpontot kérni.', now() - make_interval(days => $3))`,
    [tenantId, callId, ageDays],
  );
  return callId;
}

async function transcriptState(callId: string): Promise<string> {
  const result = await database().admin.query<{ redaction_state: string }>(
    `SELECT redaction_state FROM app.transcript_segments WHERE call_id = $1`,
    [callId],
  );
  return result.rows[0]?.redaction_state ?? 'missing';
}

describe('retention activities', () => {
  it('applies tenant retention policies, platform defaults and call holds', async () => {
    const shortened = await seedTenant(database().admin);
    const defaults = await seedTenant(database().admin);
    await database().admin.query(
      `INSERT INTO app.retention_policies (tenant_id, retention_class, retain_days, platform_max_days) VALUES ($1, 'TRANSCRIPT', 14, 90)`,
      [shortened],
    );
    const expired = await seedCallWithTranscript(shortened, 20);
    const held = await seedCallWithTranscript(shortened, 20);
    const recent = await seedCallWithTranscript(shortened, 3);
    const defaultKept = await seedCallWithTranscript(defaults, 20);
    const defaultExpired = await seedCallWithTranscript(defaults, 120);
    await database().admin.query(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, scope_ref, reason, legal_basis, created_by) VALUES ($1, 'CALL', $2, 'Complaint under investigation', 'Consumer protection', 'owner')`,
      [shortened, held],
    );

    const activities = createRetentionActivities({
      db: database().db,
      now: () => new Date(),
      logger: silent,
    });
    const tenants = await activities.listRetentionTenants();
    expect(tenants).toEqual(expect.arrayContaining([shortened, defaults]));

    const jobRunId = randomUUID();
    const first = await activities.applyTenantRetention({
      tenantId: shortened,
      jobRunId,
      traceId: TRACE,
    });
    expect(first.affected['TRANSCRIPT']).toBe(1);
    await activities.applyTenantRetention({ tenantId: defaults, jobRunId, traceId: TRACE });

    expect(await transcriptState(expired)).toBe('PURGED');
    expect(await transcriptState(held)).not.toBe('PURGED');
    expect(await transcriptState(recent)).not.toBe('PURGED');
    expect(await transcriptState(defaultKept)).not.toBe('PURGED');
    expect(await transcriptState(defaultExpired)).toBe('PURGED');

    const again = await activities.applyTenantRetention({
      tenantId: shortened,
      jobRunId,
      traceId: TRACE,
    });
    expect(again.affected['TRANSCRIPT']).toBe(0);
    const audit = await database().admin.query(
      `SELECT 1 FROM app.audit_logs WHERE tenant_id = $1 AND action = 'retention.applied' AND metadata->>'job_run_id' = $2`,
      [shortened, jobRunId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(5);
  });

  it('skips a tenant entirely while a workspace-wide legal hold is active', async () => {
    const tenantId = await seedTenant(database().admin);
    const old = await seedCallWithTranscript(tenantId, 200);
    await database().admin.query(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, reason, legal_basis, created_by) VALUES ($1, 'TENANT', 'Authority request for all records', 'Data protection authority inquiry', 'owner')`,
      [tenantId],
    );
    const activities = createRetentionActivities({
      db: database().db,
      now: () => new Date(),
      logger: silent,
    });
    const result = await activities.applyTenantRetention({
      tenantId,
      jobRunId: randomUUID(),
      traceId: TRACE,
    });
    expect(result.affected['TRANSCRIPT']).toBe(0);
    expect(await transcriptState(old)).not.toBe('PURGED');
  });
});
