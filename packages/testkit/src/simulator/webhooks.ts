import { createHmac } from 'node:crypto';

export interface WebhookTarget {
  readonly url: string;
  readonly secret: string;
}

export interface WebhookDelivery {
  readonly provider: 'stripe' | 'openai';
  readonly eventId: string;
  readonly eventType: string;
  readonly url: string;
  readonly attempt: number;
  readonly status: number | null;
  readonly error: string | null;
  readonly deliveredAt: string;
}

export function stripeSignature(secret: string, timestamp: number, payload: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${digest}`;
}

export function standardWebhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  payload: string,
): string {
  const key = Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  );
  const digest = createHmac('sha256', key)
    .update(`${id}.${String(timestamp)}.${payload}`)
    .digest('base64');
  return `v1,${digest}`;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export class WebhookDispatcher {
  readonly #deliveries: WebhookDelivery[] = [];
  readonly #now: () => Date;
  readonly #pending = new Set<Promise<void>>();

  constructor(now: () => Date) {
    this.#now = now;
  }

  get deliveries(): readonly WebhookDelivery[] {
    return [...this.#deliveries];
  }

  async idle(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  send(
    provider: WebhookDelivery['provider'],
    target: WebhookTarget | null,
    event: { readonly id: string; readonly type: string; readonly payload: string },
    options: { readonly delayMs?: number; readonly attempt?: number } = {},
  ): void {
    if (target === null) {
      return;
    }
    const task = this.#deliver(provider, target, event, options.delayMs ?? 0, options.attempt ?? 1);
    this.#pending.add(task);
    void task.finally(() => {
      this.#pending.delete(task);
    });
  }

  async #deliver(
    provider: WebhookDelivery['provider'],
    target: WebhookTarget,
    event: { readonly id: string; readonly type: string; readonly payload: string },
    delayMs: number,
    attempt: number,
  ): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const timestamp = Math.floor(this.#now().getTime() / 1000);
    const headers: Record<string, string> =
      provider === 'stripe'
        ? { 'stripe-signature': stripeSignature(target.secret, timestamp, event.payload) }
        : {
            'webhook-id': event.id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': standardWebhookSignature(
              target.secret,
              event.id,
              timestamp,
              event.payload,
            ),
          };
    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `velyric-provider-simulator/${provider}`,
          ...headers,
        },
        body: event.payload,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch (caught) {
      error = caught instanceof Error ? caught.name : 'delivery_failed';
    }
    this.#deliveries.push({
      provider,
      eventId: event.id,
      eventType: event.type,
      url: target.url,
      attempt,
      status,
      error,
      deliveredAt: this.#now().toISOString(),
    });
    const retryDelay = RETRY_DELAYS_MS[attempt - 1];
    if (
      retryDelay !== undefined &&
      (status === null || status === 409 || status === 429 || status >= 500)
    ) {
      this.send(provider, target, event, { delayMs: retryDelay, attempt: attempt + 1 });
    }
  }
}
