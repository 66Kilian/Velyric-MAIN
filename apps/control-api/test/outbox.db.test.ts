import { randomBytes, randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@velyric/contracts';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  OutboxRelay,
  retryDelaySeconds,
  type OutboxLogger,
  type OutboxPublisher,
} from '../src/outbox/relay.js';
import { useApiHarness } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;

const silent: OutboxLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class RecordingPublisher implements OutboxPublisher {
  readonly published: { subject: string; envelope: EventEnvelope }[] = [];
  failFor = new Set<string>();

  publish(subject: string, envelope: EventEnvelope): Promise<void> {
    if (this.failFor.has(envelope.event_id)) {
      return Promise.reject(new Error('nats: timeout'));
    }
    this.published.push({ subject, envelope });
    return Promise.resolve();
  }
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  await harness().admin.query(
    `UPDATE app.outbox_events SET published_at = now() WHERE published_at IS NULL`,
  );
});

async function insertEvent(
  overrides: {
    eventType?: string;
    subject?: string;
    tenantId?: string | null;
    traceId?: string | null;
  } = {},
): Promise<string> {
  const eventId = uuidv7();
  const tenantId = overrides.tenantId === undefined ? tenant.tenantId : overrides.tenantId;
  const eventType = overrides.eventType ?? 'booking.created';
  await harness().admin.query(
    `INSERT INTO app.outbox_events (tenant_id, event_id, event_type, schema_version, subject, payload, trace_id, occurred_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, '2030-01-01T10:00:00.123Z')`,
    [
      tenantId,
      eventId,
      eventType,
      overrides.subject ?? `domain.v1.${tenantId ?? 'platform'}.${eventType}`,
      JSON.stringify({ booking_id: randomUUID() }),
      overrides.traceId === undefined ? randomBytes(16).toString('hex') : overrides.traceId,
    ],
  );
  return eventId;
}

async function state(eventId: string) {
  const result = await harness().admin.query<{
    published: boolean;
    attempts: number;
    last_error: string | null;
    delayed: boolean;
  }>(
    `SELECT published_at IS NOT NULL AS published, publish_attempts AS attempts, last_error, available_at > now() AS delayed FROM app.outbox_events WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0];
}

describe('outbox relay', () => {
  it('publishes contract-valid envelopes exactly once and marks them published', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-${randomUUID()}`,
      logger: silent,
    });
    const first = await insertEvent();
    const second = await insertEvent({ eventType: 'booking.canceled', traceId: null });
    const result = await relay.runOnce();
    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, rejected: 0 });
    const byId = new Map(publisher.published.map((entry) => [entry.envelope.event_id, entry]));
    expect(byId.get(first)?.subject).toBe(`domain.v1.${tenant.tenantId}.booking.created`);
    expect(byId.get(first)?.envelope).toMatchObject({
      event_id: first,
      event_type: 'booking.created',
      tenant_id: tenant.tenantId,
      producer: 'control-api',
      occurred_at: '2030-01-01T10:00:00.123Z',
      schema_version: 1,
    });
    expect(byId.get(second)?.envelope.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(await state(first)).toMatchObject({ published: true, attempts: 1, last_error: null });
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0, rejected: 0 });
    expect(publisher.published).toHaveLength(2);
  });

  it('fans job-requesting events out to the jobs stream with the same message id', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-${randomUUID()}`,
      logger: silent,
    });
    const eventId = await insertEvent({ eventType: 'knowledge.ingestion_requested' });
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0, rejected: 0 });
    expect(publisher.published.map((entry) => [entry.subject, entry.envelope.event_id])).toEqual([
      [`domain.v1.${tenant.tenantId}.knowledge.ingestion_requested`, eventId],
      [`jobs.v1.knowledge_ingest.${tenant.tenantId}`, eventId],
    ]);
  });

  it('backs off failed publishes and never lets two workers claim the same event', async () => {
    const publisher = new RecordingPublisher();
    const failing = await insertEvent();
    publisher.failFor.add(failing);
    const relayA = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-a-${randomUUID()}`,
      logger: silent,
    });
    const relayB = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-b-${randomUUID()}`,
      logger: silent,
    });
    const [a, b] = await Promise.all([relayA.runOnce(), relayB.runOnce()]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.failed + b.failed).toBe(1);
    expect(await state(failing)).toMatchObject({
      published: false,
      attempts: 1,
      delayed: true,
      last_error: 'Error: nats: timeout',
    });
    expect(await relayA.runOnce()).toMatchObject({ claimed: 0 });
    publisher.failFor.clear();
    await harness().admin.query(
      `UPDATE app.outbox_events SET available_at = now() WHERE event_id = $1`,
      [failing],
    );
    expect(await relayB.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0, rejected: 0 });
    expect(await state(failing)).toMatchObject({ published: true, attempts: 2 });
    expect([retryDelaySeconds(1), retryDelaySeconds(4), retryDelaySeconds(40)]).toEqual([
      2, 16, 300,
    ]);
  });

  it('quarantines events that violate the envelope or subject contract', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-${randomUUID()}`,
      logger: silent,
    });
    const wrongSubject = await insertEvent({
      subject: `domain.v1.${randomUUID()}.booking.created`,
    });
    const platformWithoutScope = await insertEvent({
      tenantId: null,
      eventType: 'booking.created',
    });
    const result = await relay.runOnce();
    expect(result).toMatchObject({ claimed: 2, published: 0, rejected: 2 });
    expect(publisher.published).toHaveLength(0);
    expect(await state(wrongSubject)).toMatchObject({
      published: false,
      delayed: true,
      last_error: 'contract: subject does not match tenant and event type',
    });
    expect((await state(platformWithoutScope))?.last_error).toContain(
      'tenant_id may only be null for platform-scoped event types',
    );
  });

  it('runs continuously until stopped', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({
      db: harness().db,
      publisher,
      workerId: `relay-${randomUUID()}`,
      logger: silent,
      idleDelayMs: 20,
    });
    relay.start();
    const eventId = await insertEvent({
      tenantId: null,
      eventType: 'kill_switch.changed',
      subject: 'domain.v1.platform.kill_switch.changed',
    });
    for (
      let attempt = 0;
      attempt < 100 && !publisher.published.some((entry) => entry.envelope.event_id === eventId);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await relay.stop();
    expect(publisher.published.map((entry) => entry.envelope.event_id)).toContain(eventId);
  });
});
