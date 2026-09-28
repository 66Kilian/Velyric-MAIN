import { randomBytes } from 'node:crypto';
import type { JetStreamClient } from '@nats-io/jetstream';
import { headers } from '@nats-io/transport-node';
import {
  eventEnvelopeIssues,
  natsSubjects,
  type EventEnvelope,
  type JobQueue,
} from '@velyric/contracts';
import type { DB } from '@velyric/db';
import { sql, type Kysely } from 'kysely';

export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly subject: string;
  readonly payload: unknown;
  readonly trace_id: string | null;
  readonly occurred_at: Date;
  readonly publish_attempts: number;
}

export interface OutboxPublisher {
  publish(subject: string, envelope: EventEnvelope, traceId: string): Promise<void>;
}

export interface OutboxLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface OutboxRelayOptions {
  readonly db: Kysely<DB>;
  readonly publisher: OutboxPublisher;
  readonly workerId: string;
  readonly logger: OutboxLogger;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly idleDelayMs?: number;
}

export interface RelayBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly rejected: number;
}

const TRACE_ID = /^[0-9a-f]{32}$/;

export const JOB_FANOUT: Readonly<Record<string, JobQueue>> = Object.freeze({
  'knowledge.ingestion_requested': 'knowledge_ingest',
  'quality.score_requested': 'quality_score',
  'simulation.run_requested': 'simulation_run',
});
const INVALID_RETRY_SECONDS = 3_600;
const MAX_RETRY_SECONDS = 300;

export function retryDelaySeconds(attempts: number): number {
  return Math.min(MAX_RETRY_SECONDS, 2 ** Math.min(Math.max(attempts, 1), 9));
}

export function toEnvelope(row: OutboxRow): EventEnvelope {
  const traceId =
    row.trace_id !== null && TRACE_ID.test(row.trace_id) && !/^0+$/.test(row.trace_id)
      ? row.trace_id
      : randomBytes(16).toString('hex');
  return {
    schema_version: row.schema_version,
    event_id: row.event_id,
    event_type: row.event_type as EventEnvelope['event_type'],
    tenant_id: row.tenant_id,
    trace_id: traceId,
    occurred_at: row.occurred_at.toISOString(),
    producer: 'control-api',
    payload: row.payload,
  };
}

export class JetStreamOutboxPublisher implements OutboxPublisher {
  readonly #jetstream: JetStreamClient;
  readonly #timeoutMs: number;

  constructor(jetstream: JetStreamClient, timeoutMs = 5_000) {
    this.#jetstream = jetstream;
    this.#timeoutMs = timeoutMs;
  }

  async publish(subject: string, envelope: EventEnvelope, traceId: string): Promise<void> {
    const messageHeaders = headers();
    messageHeaders.set('traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    messageHeaders.set('velyric-event-type', envelope.event_type);
    await this.#jetstream.publish(subject, JSON.stringify(envelope), {
      msgID: envelope.event_id,
      timeout: this.#timeoutMs,
      headers: messageHeaders,
    });
  }
}

export class OutboxRelay {
  readonly #options: OutboxRelayOptions;
  readonly #batchSize: number;
  readonly #leaseSeconds: number;
  readonly #idleDelayMs: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: OutboxRelayOptions) {
    this.#options = options;
    this.#batchSize = options.batchSize ?? 100;
    this.#leaseSeconds = options.leaseSeconds ?? 30;
    this.#idleDelayMs = options.idleDelayMs ?? 500;
  }

  async runOnce(): Promise<RelayBatchResult> {
    const { db, publisher, workerId, logger } = this.#options;
    const claimed = await sql<OutboxRow>`
      select id, tenant_id, event_id, event_type, schema_version, subject, payload, trace_id, occurred_at, publish_attempts
      from app.outbox_claim(${workerId}, ${this.#batchSize}, ${this.#leaseSeconds})`.execute(db);
    const published: string[] = [];
    let failed = 0;
    let rejected = 0;
    for (const row of claimed.rows) {
      const envelope = toEnvelope(row);
      const issues = eventEnvelopeIssues(envelope);
      const expectedPrefix = `domain.v1.${row.tenant_id ?? 'platform'}.`;
      if (issues.length > 0 || row.subject !== `${expectedPrefix}${row.event_type}`) {
        rejected += 1;
        const reason =
          issues.length > 0 ? issues.join('; ') : 'subject does not match tenant and event type';
        logger.error(
          { outbox_id: row.id, event_type: row.event_type, reason },
          'outbox event violates the event contract',
        );
        await sql`select app.outbox_mark_failed(${workerId}, ${row.id}::uuid, ${`contract: ${reason}`}, ${INVALID_RETRY_SECONDS})`.execute(
          db,
        );
        continue;
      }
      try {
        await publisher.publish(row.subject, envelope, envelope.trace_id);
        const queue = JOB_FANOUT[row.event_type];
        if (queue !== undefined && row.tenant_id !== null) {
          await publisher.publish(
            natsSubjects.job(queue, row.tenant_id),
            envelope,
            envelope.trace_id,
          );
        }
        published.push(row.id);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const delay = retryDelaySeconds(row.publish_attempts);
        logger.warn(
          {
            outbox_id: row.id,
            event_type: row.event_type,
            attempts: row.publish_attempts,
            retry_in_seconds: delay,
          },
          'outbox publish failed',
        );
        await sql`select app.outbox_mark_failed(${workerId}, ${row.id}::uuid, ${message}, ${delay})`.execute(
          db,
        );
      }
    }
    if (published.length > 0) {
      await sql`select app.outbox_mark_published(${workerId}, ${published}::uuid[])`.execute(db);
    }
    return { claimed: claimed.rows.length, published: published.length, failed, rejected };
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = (async () => {
      while (this.#running) {
        let result: RelayBatchResult | null = null;
        try {
          result = await this.runOnce();
        } catch (error) {
          this.#options.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'outbox relay batch failed',
          );
        }
        if (this.#stopping()) {
          break;
        }
        if (result !== null && result.claimed >= this.#batchSize && result.failed === 0) {
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            result === null ? this.#idleDelayMs * 4 : this.#idleDelayMs,
          );
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = null;
      }
    })();
  }

  #stopping(): boolean {
    return !this.#running;
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }
}
