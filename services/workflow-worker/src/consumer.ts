import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JsMsg,
} from '@nats-io/jetstream';
import { headers, nanos, type NatsConnection } from '@nats-io/transport-node';
import { eventEnvelopeIssues, type EventEnvelope } from '@velyric/contracts';
import type { DomainEventRouter } from './router.js';

export const DOMAIN_STREAM = 'DOMAIN';
export const DEAD_LETTER_STREAM = 'DEAD_LETTER';
export const CONSUMER_NAME = 'workflow-domain';

export interface ConsumerLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export type Disposition =
  | { readonly kind: 'ack' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'dead_letter'; readonly reason: string };

export async function dispose(
  router: DomainEventRouter,
  payload: Uint8Array,
  deliveryCount: number,
  maxDeliver: number,
): Promise<Disposition> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { kind: 'dead_letter', reason: 'malformed_json' };
  }
  const issues = eventEnvelopeIssues(envelope);
  if (issues.length > 0) {
    return { kind: 'dead_letter', reason: `invalid_envelope: ${issues.join('; ')}`.slice(0, 200) };
  }
  try {
    await router.route(envelope as EventEnvelope);
    return { kind: 'ack' };
  } catch (error) {
    if (deliveryCount >= maxDeliver) {
      return {
        kind: 'dead_letter',
        reason: `routing_failed: ${error instanceof Error ? error.message : 'unknown'}`.slice(
          0,
          200,
        ),
      };
    }
    return { kind: 'retry', delayMs: Math.min(60_000, 1_000 * 2 ** Math.min(deliveryCount, 6)) };
  }
}

export async function ensureStreams(nats: NatsConnection, replicas: number): Promise<void> {
  const manager = await jetstreamManager(nats);
  for (const spec of [
    { name: DOMAIN_STREAM, subjects: ['domain.v1.>'], maxAgeDays: 7 },
    { name: DEAD_LETTER_STREAM, subjects: ['dlq.v1.>'], maxAgeDays: 30 },
  ]) {
    try {
      await manager.streams.info(spec.name);
    } catch {
      await manager.streams.add({
        name: spec.name,
        subjects: spec.subjects,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: replicas,
        max_age: nanos(spec.maxAgeDays * 86_400_000),
        duplicate_window: nanos(120_000),
      });
    }
  }
}

export class DomainEventConsumer {
  readonly #nats: NatsConnection;
  readonly #router: DomainEventRouter;
  readonly #logger: ConsumerLogger;
  readonly #maxDeliver: number;
  #stopped = false;
  #loop: Promise<void> | null = null;
  #stop: (() => void) | null = null;

  constructor(options: {
    readonly nats: NatsConnection;
    readonly router: DomainEventRouter;
    readonly logger: ConsumerLogger;
    readonly maxDeliver?: number;
  }) {
    this.#nats = options.nats;
    this.#router = options.router;
    this.#logger = options.logger;
    this.#maxDeliver = options.maxDeliver ?? 20;
  }

  async start(): Promise<void> {
    const manager = await jetstreamManager(this.#nats);
    try {
      await manager.consumers.info(DOMAIN_STREAM, CONSUMER_NAME);
    } catch {
      await manager.consumers.add(DOMAIN_STREAM, {
        durable_name: CONSUMER_NAME,
        filter_subject: 'domain.v1.>',
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: nanos(60_000),
        max_deliver: this.#maxDeliver + 5,
      });
    }
    const client = jetstream(this.#nats);
    const consumer = await client.consumers.get(DOMAIN_STREAM, CONSUMER_NAME);
    const messages = await consumer.consume({ max_messages: 50 });
    this.#stop = () => {
      void messages.close();
    };
    this.#loop = (async () => {
      for await (const message of messages) {
        if (this.#stopped) {
          message.nak();
          break;
        }
        await this.#handle(message);
      }
    })();
  }

  async #handle(message: JsMsg): Promise<void> {
    const disposition = await dispose(
      this.#router,
      message.data,
      message.info.deliveryCount,
      this.#maxDeliver,
    );
    switch (disposition.kind) {
      case 'ack':
        message.ack();
        return;
      case 'retry':
        this.#logger.warn(
          { subject: message.subject, delivery: message.info.deliveryCount },
          'domain event routing failed; retrying',
        );
        message.nak(disposition.delayMs);
        return;
      case 'dead_letter': {
        try {
          const deadLetterHeaders = headers();
          deadLetterHeaders.set(
            'Nats-Msg-Id',
            `${DOMAIN_STREAM}:${CONSUMER_NAME}:${String(message.info.streamSequence)}`,
          );
          deadLetterHeaders.set('Velyric-Original-Subject', message.subject);
          deadLetterHeaders.set('Velyric-Dead-Letter-Reason', disposition.reason);
          await jetstream(this.#nats).publish(
            `dlq.v1.${DOMAIN_STREAM}.${CONSUMER_NAME}`,
            message.data,
            { headers: deadLetterHeaders },
          );
          this.#logger.error(
            { subject: message.subject, reason: disposition.reason },
            'domain event moved to the dead letter stream',
          );
          message.term();
        } catch (error) {
          this.#logger.error(
            {
              subject: message.subject,
              err: error instanceof Error ? error.message : String(error),
            },
            'dead letter publish failed',
          );
          message.nak(5_000);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stop?.();
    await this.#loop;
  }
}
