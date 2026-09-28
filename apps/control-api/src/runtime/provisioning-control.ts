import { randomBytes } from 'node:crypto';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import { natsSubjects } from '@velyric/contracts';

export type ProvisioningControlRequest =
  | {
      readonly action: 'KYC_SUBMIT';
      readonly phone_order_id: string;
      readonly submitted_by: string;
      readonly values: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly action: 'RETRY'; readonly requested_by: string }
  | { readonly action: 'CANCEL'; readonly requested_by: string; readonly reason: string };

export type ProvisioningControlReply =
  | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly details: Readonly<Record<string, unknown>> | null;
    };

export interface ProvisioningControl {
  send(
    tenantId: string,
    request: ProvisioningControlRequest,
    traceId: string,
  ): Promise<ProvisioningControlReply>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NatsProvisioningControl implements ProvisioningControl {
  readonly #nats: NatsConnection;
  readonly #token: (tenantId: string) => Promise<string>;
  readonly #timeoutMs: number;

  constructor(
    nats: NatsConnection,
    token: (tenantId: string) => Promise<string>,
    timeoutMs = 45_000,
  ) {
    this.#nats = nats;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async send(
    tenantId: string,
    request: ProvisioningControlRequest,
    traceId: string,
  ): Promise<ProvisioningControlReply> {
    const messageHeaders = headers();
    messageHeaders.set('authorization', `Bearer ${await this.#token(tenantId)}`);
    messageHeaders.set('traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    let body: unknown;
    try {
      const reply = await this.#nats.request(
        natsSubjects.provisioningControl(tenantId),
        JSON.stringify(request),
        { timeout: this.#timeoutMs, headers: messageHeaders },
      );
      body = reply.json();
    } catch {
      return { ok: false, errorCode: 'SERVICE_UNAVAILABLE', details: null };
    }
    if (!isRecord(body)) {
      return { ok: false, errorCode: 'INTERNAL_ERROR', details: null };
    }
    if (body['ok'] === true && isRecord(body['result'])) {
      return { ok: true, result: body['result'] };
    }
    return {
      ok: false,
      errorCode: typeof body['error_code'] === 'string' ? body['error_code'] : 'INTERNAL_ERROR',
      details: isRecord(body['details']) ? body['details'] : null,
    };
  }
}
