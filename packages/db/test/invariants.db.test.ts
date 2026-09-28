import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inTenant, pgErrorCode, useMigratedDatabase } from './support/db.js';

const database = useMigratedDatabase();

interface Fixture {
  readonly tenantId: string;
  readonly locationId: string;
  readonly resourceId: string;
  readonly userId: string;
}

async function createFixture(parallelSlots = 1): Promise<Fixture> {
  const admin = database().admin;
  const tenantId = randomUUID();
  const userId = randomUUID();
  await admin.query(
    `INSERT INTO app.tenants (id, legal_name, display_name, slug) VALUES ($1, 'Fixture Kft.', 'Fixture', $2)`,
    [tenantId, `fx-${tenantId.slice(0, 12)}`],
  );
  await admin.query(`INSERT INTO app.users (id, auth_subject, email) VALUES ($1, $2, $3)`, [
    userId,
    `user_${userId.replaceAll('-', '')}`,
    `${userId}@example.test`,
  ]);
  const location = await admin.query<{ id: string }>(
    `INSERT INTO app.locations (tenant_id, name, timezone, country) VALUES ($1, 'Main', 'Europe/Budapest', 'HU') RETURNING id`,
    [tenantId],
  );
  const locationId = location.rows[0]?.id ?? '';
  const resource = await admin.query<{ id: string }>(
    `INSERT INTO app.resources (tenant_id, location_id, resource_type, name, parallel_slots) VALUES ($1, $2, 'TABLE', 'Table 1', $3) RETURNING id`,
    [tenantId, locationId, parallelSlots],
  );
  return { tenantId, locationId, resourceId: resource.rows[0]?.id ?? '', userId };
}

async function insertBooking(
  fixture: Fixture,
  key: string,
  start: string,
  end: string,
): Promise<string> {
  const result = await database().admin.query<{ id: string }>(
    `INSERT INTO app.bookings (tenant_id, location_id, starts_at, ends_at, timezone, source, idempotency_key)
     VALUES ($1, $2, $3, $4, 'Europe/Budapest', 'VOICE_AGENT', $5) RETURNING id`,
    [fixture.tenantId, fixture.locationId, start, end, key],
  );
  return result.rows[0]?.id ?? '';
}

describe('booking double-booking protection', () => {
  it('lets exactly one of many concurrent transactions allocate the same slot', async () => {
    const fixture = await createFixture();
    const app = database().pool('velyric_app', 30);
    const start = '2026-10-01T18:00:00Z';
    const end = '2026-10-01T20:00:00Z';
    const bookingIds = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        insertBooking(fixture, `race-${String(index)}-${randomUUID()}`, start, end),
      ),
    );

    const outcomes = await Promise.allSettled(
      bookingIds.map((bookingId) =>
        inTenant(app, fixture.tenantId, async (client) => {
          await client.query('SELECT pg_sleep(0.01)');
          await client.query(
            `INSERT INTO app.resource_allocations (tenant_id, resource_id, slot_index, during, booking_id)
             VALUES ($1, $2, 0, tstzrange($3, $4, '[)'), $5)`,
            [fixture.tenantId, fixture.resourceId, start, end, bookingId],
          );
        }),
      ),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(24);
    expect(new Set(rejected.map((outcome) => pgErrorCode(outcome.reason)))).toEqual(
      new Set(['23P01']),
    );

    const count = await database().admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.resource_allocations WHERE resource_id = $1 AND is_active',
      [fixture.resourceId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('respects parallel slots, adjacent intervals and slot bounds', async () => {
    const fixture = await createFixture(2);
    const admin = database().admin;
    const insert = async (slot: number, start: string, end: string): Promise<void> => {
      const bookingId = await insertBooking(fixture, `slot-${randomUUID()}`, start, end);
      await admin.query(
        `INSERT INTO app.resource_allocations (tenant_id, resource_id, slot_index, during, booking_id)
         VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6)`,
        [fixture.tenantId, fixture.resourceId, slot, start, end, bookingId],
      );
    };
    await insert(0, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z');
    await insert(1, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z');
    await insert(0, '2026-10-02T11:00:00Z', '2026-10-02T12:00:00Z');
    expect(
      pgErrorCode(
        await insert(1, '2026-10-02T10:30:00Z', '2026-10-02T10:45:00Z').catch((e: unknown) => e),
      ),
    ).toBe('23P01');
    expect(
      pgErrorCode(
        await insert(2, '2026-10-02T13:00:00Z', '2026-10-02T14:00:00Z').catch((e: unknown) => e),
      ),
    ).toBe('23514');
  });

  it('frees slots held by expired holds only after release_expired_allocations runs', async () => {
    const fixture = await createFixture();
    const app = database().pool('velyric_app', 4);
    const start = '2026-10-03T09:00:00Z';
    const end = '2026-10-03T09:30:00Z';
    const holdId = randomUUID();
    await inTenant(app, fixture.tenantId, async (client) => {
      await client.query(
        `INSERT INTO app.booking_holds (id, tenant_id, location_id, starts_at, ends_at, expires_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 second', $6)`,
        [holdId, fixture.tenantId, fixture.locationId, start, end, `hold-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO app.resource_allocations (tenant_id, resource_id, slot_index, during, hold_id, hold_expires_at)
         VALUES ($1, $2, 0, tstzrange($3, $4, '[)'), $5, now() + interval '1 second')`,
        [fixture.tenantId, fixture.resourceId, start, end, holdId],
      );
    });
    const bookingId = await insertBooking(fixture, `after-hold-${randomUUID()}`, start, end);
    const allocate = (): Promise<unknown> =>
      inTenant(app, fixture.tenantId, (client) =>
        client.query(
          `INSERT INTO app.resource_allocations (tenant_id, resource_id, slot_index, during, booking_id)
           VALUES ($1, $2, 0, tstzrange($3, $4, '[)'), $5)`,
          [fixture.tenantId, fixture.resourceId, start, end, bookingId],
        ),
      );
    expect(pgErrorCode(await allocate().catch((e: unknown) => e))).toBe('23P01');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const released = await inTenant(app, fixture.tenantId, (client) =>
      client.query<{ n: number }>('SELECT app.release_expired_allocations($1) AS n', [
        fixture.resourceId,
      ]),
    );
    expect(released.rows[0]?.n).toBe(1);
    await expect(allocate()).resolves.toBeDefined();
    const hold = await database().admin.query<{ status: string }>(
      'SELECT status FROM app.booking_holds WHERE id = $1',
      [holdId],
    );
    expect(hold.rows[0]?.status).toBe('EXPIRED');
  });

  it('deduplicates bookings by idempotency key', async () => {
    const fixture = await createFixture();
    const key = `dup-${randomUUID()}`;
    await insertBooking(fixture, key, '2026-10-04T09:00:00Z', '2026-10-04T10:00:00Z');
    const error = await insertBooking(
      fixture,
      key,
      '2026-10-04T09:00:00Z',
      '2026-10-04T10:00:00Z',
    ).catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe('23505');
  });
});

describe('append-only ledgers', () => {
  it('blocks UPDATE and DELETE for the application role and for owners, but allows retention deletes', async () => {
    const fixture = await createFixture();
    const app = database().pool('velyric_app', 2);
    const auditId = randomUUID();
    await inTenant(app, fixture.tenantId, (client) =>
      client.query(
        `INSERT INTO app.audit_logs (id, tenant_id, actor_type, actor_id, action, object_type) VALUES ($1, $2, 'USER', 'u', 'agent.updated', 'agent')`,
        [auditId, fixture.tenantId],
      ),
    );
    const appUpdate = await inTenant(app, fixture.tenantId, (client) =>
      client.query(`UPDATE app.audit_logs SET action = 'agent.deleted' WHERE id = $1`, [auditId]),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(appUpdate)).toBe('42501');

    const ownerUpdate = await database()
      .admin.query(`UPDATE app.audit_logs SET action = 'agent.deleted' WHERE id = $1`, [auditId])
      .catch((e: unknown) => e);
    expect(pgErrorCode(ownerUpdate)).toBe('42501');

    const callId = randomUUID();
    await database().admin.query(
      `INSERT INTO app.calls (id, tenant_id, provider, provider_call_id, channel, direction, started_at, trace_id)
       VALUES ($1, $2, 'telnyx', $3, 'PSTN', 'INBOUND', now() - interval '400 days', '4bf92f3577b34da6a3ce929d0e0e4736')`,
      [callId, fixture.tenantId, `call-${callId}`],
    );
    await database().admin.query(
      `INSERT INTO app.call_events (tenant_id, call_id, seq, event_id, event_type, schema_version, payload, occurred_at)
       VALUES ($1, $2, 0, $3, 'call.started', 1, '{}', now() - interval '400 days')`,
      [fixture.tenantId, callId, randomUUID()],
    );
    const deleted = await inTenant(app, fixture.tenantId, (client) =>
      client.query<{ n: number }>(
        `SELECT app.apply_retention($1, 'CALL_EVENTS', now() - interval '365 days', $2) AS n`,
        [fixture.tenantId, randomUUID()],
      ),
    );
    expect(deleted.rows[0]?.n).toBe(1);
    const evidence = await database().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.audit_logs WHERE tenant_id = $1 AND action = 'retention.applied'`,
      [fixture.tenantId],
    );
    expect(evidence.rows[0]?.n).toBe(1);
  });

  it('skips retention entirely under a tenant legal hold', async () => {
    const fixture = await createFixture();
    const app = database().pool('velyric_app', 2);
    await database().admin.query(
      `INSERT INTO app.legal_holds (tenant_id, scope_type, reason, legal_basis, created_by) VALUES ($1, 'TENANT', 'Chargeback evidence retention', 'dispute', 'finance')`,
      [fixture.tenantId],
    );
    const result = await inTenant(app, fixture.tenantId, (client) =>
      client.query<{ n: number }>(
        `SELECT app.apply_retention($1, 'TRANSCRIPT', now() - interval '1 day', $2) AS n`,
        [fixture.tenantId, randomUUID()],
      ),
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});

describe('agent version immutability', () => {
  it('rejects config changes and deletion after publish while allowing status transitions', async () => {
    const fixture = await createFixture();
    const admin = database().admin;
    const agent = await admin.query<{ id: string }>(
      `INSERT INTO app.agents (tenant_id, name) VALUES ($1, 'Reception') RETURNING id`,
      [fixture.tenantId],
    );
    const agentId = agent.rows[0]?.id ?? '';
    const version = await admin.query<{ id: string }>(
      `INSERT INTO app.agent_versions (tenant_id, agent_id, version_number, status, config, config_hash, schema_version, rollout_percent, published_at)
       VALUES ($1, $2, 1, 'PRODUCTION', '{"voice":"alloy"}', $3, 1, 100, now()) RETURNING id`,
      [fixture.tenantId, agentId, 'a'.repeat(64)],
    );
    const versionId = version.rows[0]?.id ?? '';
    expect(
      pgErrorCode(
        await admin
          .query(`UPDATE app.agent_versions SET config = '{"voice":"verse"}' WHERE id = $1`, [
            versionId,
          ])
          .catch((e: unknown) => e),
      ),
    ).toBe('42501');
    expect(
      pgErrorCode(
        await admin
          .query('DELETE FROM app.agent_versions WHERE id = $1', [versionId])
          .catch((e: unknown) => e),
      ),
    ).toBe('42501');
    await expect(
      admin.query(
        `UPDATE app.agent_versions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1`,
        [versionId],
      ),
    ).resolves.toBeDefined();
  });
});
