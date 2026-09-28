import { randomBytes } from 'node:crypto';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import { natsSubjects } from '@velyric/contracts';

export type RuntimeCommand =
  | {
      readonly type: 'TRANSFER';
      readonly transferAttemptId: string;
      readonly destinationE164: string;
      readonly transferType: 'COLD' | 'WARM';
      readonly reason: string;
      readonly requestedBy: string;
    }
  | { readonly type: 'TERMINATE'; readonly reason: string; readonly requestedBy: string };

export interface RuntimeCommandResult {
  readonly accepted: boolean;
  readonly state: string;
  readonly errorCode: string | null;
}

export interface RuntimeCommandBus {
  send(
    tenantId: string,
    callId: string,
    command: RuntimeCommand,
    traceId: string,
  ): Promise<RuntimeCommandResult>;
}

export class NatsRuntimeCommandBus implements RuntimeCommandBus {
  readonly #nats: NatsConnection;
  readonly #token: (tenantId: string) => Promise<string>;

  constructor(nats: NatsConnection, token: (tenantId: string) => Promise<string>) {
    this.#nats = nats;
    this.#token = token;
  }

  async send(
    tenantId: string,
    callId: string,
    command: RuntimeCommand,
    traceId: string,
  ): Promise<RuntimeCommandResult> {
    const messageHeaders = headers();
    messageHeaders.set('authorization', `Bearer ${await this.#token(tenantId)}`);
    messageHeaders.set('traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    try {
      const payload =
        command.type === 'TRANSFER'
          ? {
              type: command.type,
              call_id: callId,
              transfer_attempt_id: command.transferAttemptId,
              destination_e164: command.destinationE164,
              transfer_type: command.transferType,
              reason: command.reason,
              requested_by: command.requestedBy,
            }
          : {
              type: command.type,
              call_id: callId,
              reason: command.reason,
              requested_by: command.requestedBy,
            };
      const reply = await this.#nats.request(
        natsSubjects.runtimeCommand(tenantId, callId),
        JSON.stringify(payload),
        {
          timeout: 5_000,
          headers: messageHeaders,
        },
      );
      const body: unknown = reply.json();
      if (typeof body !== 'object' || body === null) {
        return { accepted: false, state: 'UNKNOWN', errorCode: 'PROVIDER_ERROR' };
      }
      const record = body as Record<string, unknown>;
      return {
        accepted: record['accepted'] === true,
        state: typeof record['state'] === 'string' ? record['state'] : 'UNKNOWN',
        errorCode: typeof record['error_code'] === 'string' ? record['error_code'] : null,
      };
    } catch (error) {
      const description = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      if (/timeout|no responders|503/i.test(description)) {
        return { accepted: false, state: 'UNREACHABLE', errorCode: 'SERVICE_UNAVAILABLE' };
      }
      throw error;
    }
  }
}
