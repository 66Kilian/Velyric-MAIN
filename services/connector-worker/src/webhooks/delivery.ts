import { createHmac } from 'node:crypto';
import {
  OUTBOUND_WEBHOOK_MAX_ATTEMPTS,
  OUTBOUND_WEBHOOK_SIGNATURE_HEADER,
  OUTBOUND_WEBHOOK_TIMEOUT_MS,
  outboundWebhookRetryDelaySeconds,
  type VelyricEnvironment,
} from '@velyric/contracts';
import type { DB } from '@velyric/db';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  safeRequest,
  type EgressPolicy,
  type HostResolver,
  type SafeRequest,
  type SafeRequestOptions,
  type SafeResponse,
} from '@velyric/security';
import type { TenantSecretReader } from '@velyric/tenant-secrets';
import { sql, type Kysely } from 'kysely';

export type WebhookTransport = (
  request: SafeRequest,
  options: SafeRequestOptions,
) => Promise<SafeResponse>;

export interface WebhookDeliveryLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface WebhookDeliveryOptions {
  readonly db: Kysely<DB>;
  readonly secrets: TenantSecretReader;
  readonly environment: VelyricEnvironment;
  readonly workerId: string;
  readonly logger: WebhookDeliveryLogger;
  readonly resolver?: HostResolver;
  readonly transport?: WebhookTransport;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly idleDelayMs?: number;
}

export interface ClaimedWebhookDelivery {
  readonly id: string;
  readonly tenant_id: string;
  readonly webhook_id: string;
  readonly url: string;
  readonly signing_secret_ref: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly occurred_at: Date | null;
  readonly attempt: number;
}

export type DeliveryStatus = 'DELIVERED' | 'RETRYING' | 'FAILED' | 'DEAD_LETTER';

export interface DeliveryOutcome {
  readonly status: DeliveryStatus;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly retryAfterSeconds: number;
  readonly responseMs: number | null;
}

export interface DeliveryBatchResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
}

const PERMANENT_EGRESS_REASONS: ReadonlySet<string> = new Set([
  'INVALID_URL',
  'SCHEME_NOT_ALLOWED',
  'CREDENTIALS_IN_URL',
  'PORT_NOT_ALLOWED',
  'HOST_NOT_ALLOWLISTED',
  'ADDRESS_NOT_PUBLIC',
  'POLICY_INVALID',
  'REDIRECT_NOT_ALLOWED',
  'TOO_MANY_REDIRECTS',
]);
const LEASE_SECONDS = 60;

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${digest}`;
}

export function webhookRequestBody(delivery: ClaimedWebhookDelivery, now: Date): string {
  return JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    created_at: (delivery.occurred_at ?? now).toISOString(),
    delivery_attempt: delivery.attempt,
    data: delivery.payload,
  });
}

export function webhookEgressPolicy(url: URL): EgressPolicy {
  return {
    ...DEFAULT_EGRESS_POLICY,
    allowedHosts: [url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')],
    allowHttp: false,
    allowedPorts: [443],
    maxRedirects: 0,
    totalTimeoutMs: OUTBOUND_WEBHOOK_TIMEOUT_MS,
    maxResponseBytes: 16_384,
    allowedContentTypes: [],
    trustedPrivateCidrs: [],
  };
}

function retryOrDeadLetter(
  attempt: number,
  httpStatus: number | null,
  errorCode: string,
  responseMs: number | null,
): DeliveryOutcome {
  if (attempt >= OUTBOUND_WEBHOOK_MAX_ATTEMPTS) {
    return { status: 'DEAD_LETTER', httpStatus, errorCode, retryAfterSeconds: 0, responseMs };
  }
  return {
    status: 'RETRYING',
    httpStatus,
    errorCode,
    retryAfterSeconds: outboundWebhookRetryDelaySeconds(attempt),
    responseMs,
  };
}

export function classifyResponse(attempt: number, response: SafeResponse): DeliveryOutcome {
  if (response.status >= 200 && response.status < 300) {
    return {
      status: 'DELIVERED',
      httpStatus: response.status,
      errorCode: null,
      retryAfterSeconds: 0,
      responseMs: response.durationMs,
    };
  }
  if (response.status === 410) {
    return {
      status: 'FAILED',
      httpStatus: 410,
      errorCode: 'ENDPOINT_GONE',
      retryAfterSeconds: 0,
      responseMs: response.durationMs,
    };
  }
  return retryOrDeadLetter(
    attempt,
    response.status,
    `HTTP_${String(response.status)}`,
    response.durationMs,
  );
}

export function classifyError(attempt: number, error: unknown): DeliveryOutcome {
  if (error instanceof EgressBlockedError) {
    if (PERMANENT_EGRESS_REASONS.has(error.reason)) {
      return {
        status: 'FAILED',
        httpStatus: null,
        errorCode: `EGRESS_${error.reason}`,
        retryAfterSeconds: 0,
        responseMs: null,
      };
    }
    return retryOrDeadLetter(attempt, null, `EGRESS_${error.reason}`, null);
  }
  return retryOrDeadLetter(attempt, null, 'NETWORK_ERROR', null);
}

export class WebhookDeliveryWorker {
  readonly #options: WebhookDeliveryOptions;
  readonly #transport: WebhookTransport;
  readonly #now: () => Date;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #idleDelayMs: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: WebhookDeliveryOptions) {
    this.#options = options;
    this.#transport = options.transport ?? safeRequest;
    this.#now = options.now ?? (() => new Date());
    this.#batchSize = options.batchSize ?? 50;
    this.#concurrency = Math.max(1, options.concurrency ?? 10);
    this.#idleDelayMs = options.idleDelayMs ?? 1_000;
  }

  get running(): boolean {
    return this.#running;
  }

  async runOnce(): Promise<DeliveryBatchResult> {
    const claimed = await sql<ClaimedWebhookDelivery>`
      select * from app.webhook_delivery_claim(${this.#options.workerId}, ${this.#batchSize}, ${LEASE_SECONDS})`.execute(
      this.#options.db,
    );
    const counts = { delivered: 0, retrying: 0, failed: 0 };
    const queue = [...claimed.rows];
    const lanes = Array.from({ length: Math.min(this.#concurrency, queue.length) }, async () => {
      for (let delivery = queue.shift(); delivery !== undefined; delivery = queue.shift()) {
        const outcome = await this.#deliver(delivery);
        await this.#complete(delivery, outcome);
        if (outcome.status === 'DELIVERED') {
          counts.delivered += 1;
        } else if (outcome.status === 'RETRYING') {
          counts.retrying += 1;
        } else {
          counts.failed += 1;
        }
      }
    });
    await Promise.all(lanes);
    return { claimed: claimed.rows.length, ...counts };
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = (async () => {
      while (this.#running) {
        let result: DeliveryBatchResult | null = null;
        try {
          result = await this.runOnce();
        } catch (error) {
          this.#options.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'webhook delivery batch failed',
          );
        }
        if (!this.running) {
          break;
        }
        if (result !== null && result.claimed >= this.#batchSize) {
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            result === null ? this.#idleDelayMs * 5 : this.#idleDelayMs,
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

  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  async #deliver(delivery: ClaimedWebhookDelivery): Promise<DeliveryOutcome> {
    let url: URL;
    try {
      url = new URL(delivery.url);
    } catch {
      return {
        status: 'FAILED',
        httpStatus: null,
        errorCode: 'EGRESS_INVALID_URL',
        retryAfterSeconds: 0,
        responseMs: null,
      };
    }
    let secret: string;
    try {
      secret = await this.#options.secrets.read(delivery.signing_secret_ref);
    } catch (error) {
      this.#options.logger.warn(
        {
          tenant_id: delivery.tenant_id,
          webhook_id: delivery.webhook_id,
          err: error instanceof Error ? error.name : 'unknown',
        },
        'webhook signing secret unavailable',
      );
      return retryOrDeadLetter(delivery.attempt, null, 'SECRET_UNAVAILABLE', null);
    }
    const now = this.#now();
    const body = webhookRequestBody(delivery, now);
    const timestamp = Math.floor(now.getTime() / 1000);
    try {
      const response = await this.#transport(
        {
          url: url.toString(),
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Velyric-Webhooks/1.0',
            [OUTBOUND_WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, timestamp, body),
            'velyric-event-id': delivery.event_id,
            'velyric-event-type': delivery.event_type,
            'velyric-delivery-id': delivery.id,
            'idempotency-key': delivery.event_id,
          },
          body,
        },
        {
          policy: webhookEgressPolicy(url),
          environment: this.#options.environment,
          ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
        },
      );
      return classifyResponse(delivery.attempt, response);
    } catch (error) {
      const outcome = classifyError(delivery.attempt, error);
      this.#options.logger.warn(
        {
          tenant_id: delivery.tenant_id,
          webhook_id: delivery.webhook_id,
          delivery_id: delivery.id,
          error_code: outcome.errorCode,
        },
        'webhook delivery attempt failed',
      );
      return outcome;
    }
  }

  async #complete(delivery: ClaimedWebhookDelivery, outcome: DeliveryOutcome): Promise<void> {
    const result = await sql<{ ok: boolean }>`
      select app.webhook_delivery_complete(
        ${this.#options.workerId}, ${delivery.id}::uuid, ${outcome.status}, ${outcome.httpStatus}::integer,
        ${outcome.errorCode}, ${outcome.retryAfterSeconds}::integer, ${outcome.responseMs === null ? null : Math.round(outcome.responseMs)}::integer
      ) as ok`.execute(this.#options.db);
    if (result.rows[0]?.ok !== true) {
      this.#options.logger.warn(
        { tenant_id: delivery.tenant_id, delivery_id: delivery.id },
        'webhook delivery lease lost before completion',
      );
    }
  }
}
