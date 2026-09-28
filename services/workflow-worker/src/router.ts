import type { Client } from '@temporalio/client';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from '@temporalio/common';
import {
  isOutboundWebhookEventType,
  temporalWorkflowIds,
  type EventEnvelope,
} from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import { sql, type Kysely } from 'kysely';

export type TaskQueue = 'provisioning' | 'billing' | 'notifications' | 'retention';

export const REQUESTABLE_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'SECURITY_MEMBER_INVITED',
  'SECURITY_MEMBER_ROLE_CHANGED',
  'SECURITY_API_KEY_CREATED',
  'SUPPORT_REQUEST_RECEIVED',
  'SUPPORT_REQUEST_UPDATED',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    entries.length > 30 ||
    !entries.every(
      ([key, entry]) =>
        /^[a-z][a-z0-9_]{0,40}$/.test(key) && typeof entry === 'string' && entry.length <= 500,
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries);
}

export interface WorkflowGateway {
  start(
    workflowType: string,
    options: {
      readonly workflowId: string;
      readonly taskQueue: TaskQueue;
      readonly args: readonly unknown[];
      readonly allowAfterFailure?: boolean;
    },
  ): Promise<'STARTED' | 'ALREADY_STARTED'>;
  signal(
    workflowId: string,
    signalName: string,
    args: readonly unknown[],
  ): Promise<'SIGNALED' | 'NOT_FOUND'>;
}

export interface RouterRepository {
  openProvisioningWorkflowIds(tenantId: string, traceId: string): Promise<readonly string[]>;
  subscriptionPeriodEnd(
    tenantId: string,
    stripeSubscriptionId: string,
    traceId: string,
  ): Promise<Date | null>;
  enqueueWebhookDeliveries(tenantId: string, envelope: EventEnvelope): Promise<number>;
}

export interface RouterLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export class TemporalWorkflowGateway implements WorkflowGateway {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async start(
    workflowType: string,
    options: {
      readonly workflowId: string;
      readonly taskQueue: TaskQueue;
      readonly args: readonly unknown[];
      readonly allowAfterFailure?: boolean;
    },
  ): Promise<'STARTED' | 'ALREADY_STARTED'> {
    try {
      await this.#client.workflow.start(workflowType, {
        workflowId: options.workflowId,
        taskQueue: options.taskQueue,
        args: [...options.args],
        workflowIdReusePolicy:
          options.allowAfterFailure === true
            ? WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY
            : WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
      return 'STARTED';
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return 'ALREADY_STARTED';
      }
      throw error;
    }
  }

  async signal(
    workflowId: string,
    signalName: string,
    args: readonly unknown[],
  ): Promise<'SIGNALED' | 'NOT_FOUND'> {
    try {
      await this.#client.workflow.getHandle(workflowId).signal(signalName, ...args);
      return 'SIGNALED';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return 'NOT_FOUND';
      }
      throw error;
    }
  }
}

export class KyselyRouterRepository implements RouterRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  openProvisioningWorkflowIds(tenantId: string, traceId: string): Promise<readonly string[]> {
    return withTenantTransaction(
      this.#db,
      { tenantId, actorType: 'SERVICE', actorId: 'workflow-worker', traceId },
      async (trx) =>
        (
          await trx
            .selectFrom('provisioning_workflows')
            .select(['temporal_workflow_id'])
            .where('state', 'not in', ['ACTIVE', 'COMPENSATED', 'CANCELED'])
            .execute()
        ).map((row) => row.temporal_workflow_id),
    );
  }

  subscriptionPeriodEnd(
    tenantId: string,
    stripeSubscriptionId: string,
    traceId: string,
  ): Promise<Date | null> {
    return withTenantTransaction(
      this.#db,
      { tenantId, actorType: 'SERVICE', actorId: 'workflow-worker', traceId },
      async (trx) => {
        const row = await trx
          .selectFrom('subscriptions')
          .select(['current_period_end', 'status'])
          .where('stripe_subscription_id', '=', stripeSubscriptionId)
          .executeTakeFirst();
        return row === undefined || (row.status !== 'ACTIVE' && row.status !== 'TRIALING')
          ? null
          : row.current_period_end;
      },
    );
  }

  enqueueWebhookDeliveries(tenantId: string, envelope: EventEnvelope): Promise<number> {
    return withTenantTransaction(
      this.#db,
      { tenantId, actorType: 'SERVICE', actorId: 'workflow-worker', traceId: envelope.trace_id },
      async (trx) => {
        const entitlement = await trx
          .selectFrom('entitlement_snapshots')
          .select(['features'])
          .where('effective_from', '<=', new Date())
          .orderBy('version', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (
          !Array.isArray(entitlement?.features) ||
          !entitlement.features.includes('outbound_webhooks')
        ) {
          return 0;
        }
        const webhooks = await trx
          .selectFrom('outbound_webhooks')
          .select(['id'])
          .where('active', '=', true)
          .where(sql<boolean>`${envelope.event_type} = ANY(event_types)`)
          .execute();
        if (webhooks.length === 0) {
          return 0;
        }
        const occurredAt = new Date(envelope.occurred_at);
        const inserted = await trx
          .insertInto('webhook_deliveries')
          .values(
            webhooks.map((webhook) => ({
              tenant_id: tenantId,
              webhook_id: webhook.id,
              event_id: envelope.event_id,
              event_type: envelope.event_type,
              status: 'PENDING',
              next_attempt_at: new Date(),
              occurred_at: occurredAt,
              payload: JSON.stringify(envelope.payload),
            })),
          )
          .onConflict((conflict) => conflict.columns(['webhook_id', 'event_id']).doNothing())
          .returning(['id'])
          .execute();
        return inserted.length;
      },
    );
  }
}

function text(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(payload: unknown, key: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Record<string, unknown>)[key] === true
  );
}

export type RouteOutcome = 'HANDLED' | 'IGNORED';

export class DomainEventRouter {
  readonly #gateway: WorkflowGateway;
  readonly #repository: RouterRepository;
  readonly #logger: RouterLogger;
  readonly #now: () => Date;

  constructor(options: {
    readonly gateway: WorkflowGateway;
    readonly repository: RouterRepository;
    readonly logger: RouterLogger;
    readonly now?: () => Date;
  }) {
    this.#gateway = options.gateway;
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async route(envelope: EventEnvelope): Promise<RouteOutcome> {
    const tenantId = envelope.tenant_id;
    if (tenantId === null) {
      return 'IGNORED';
    }
    const queued = isOutboundWebhookEventType(envelope.event_type)
      ? await this.#repository.enqueueWebhookDeliveries(tenantId, envelope)
      : 0;
    if (queued > 0) {
      this.#logger.info(
        { tenant_id: tenantId, event_id: envelope.event_id, deliveries: queued },
        'outbound webhook deliveries queued',
      );
    }
    const outcome = await this.#dispatch(tenantId, envelope);
    return queued > 0 ? 'HANDLED' : outcome;
  }

  async #dispatch(tenantId: string, envelope: EventEnvelope): Promise<RouteOutcome> {
    const traceId = envelope.trace_id;
    const eventType: string = envelope.event_type;
    switch (eventType) {
      case 'checkout.order_paid': {
        const orderId = text(envelope.payload, 'order_id');
        if (orderId === null) {
          return 'IGNORED';
        }
        const invoiceId = text(envelope.payload, 'stripe_invoice_id');
        if (invoiceId !== null) {
          await this.#gateway.start('invoiceIssuanceWorkflow', {
            workflowId: temporalWorkflowIds.invoiceIssuance(invoiceId),
            taskQueue: 'billing',
            args: [{ tenantId, stripeInvoiceId: invoiceId, orderId, traceId }],
          });
        }
        const started = await this.#gateway.start('provisioningWorkflow', {
          workflowId: temporalWorkflowIds.provisioning(orderId),
          taskQueue: 'provisioning',
          args: [{ orderId, tenantId, traceId }],
        });
        this.#logger.info(
          { tenant_id: tenantId, order_id: orderId, outcome: started },
          'provisioning workflow requested',
        );
        return 'HANDLED';
      }
      case 'subscription.updated': {
        const invoiceId = text(envelope.payload, 'stripe_invoice_id');
        const subscriptionId = text(envelope.payload, 'stripe_subscription_id');
        if (invoiceId !== null && flag(envelope.payload, 'payment_failed')) {
          await this.#gateway.start('dunningWorkflow', {
            workflowId: temporalWorkflowIds.dunning(tenantId, invoiceId),
            taskQueue: 'billing',
            args: [{ tenantId, stripeInvoiceId: invoiceId, traceId }],
          });
          return 'HANDLED';
        }
        if (invoiceId !== null && flag(envelope.payload, 'invoice_paid')) {
          await this.#gateway.signal(
            temporalWorkflowIds.dunning(tenantId, invoiceId),
            'dunningInvoicePaid',
            [],
          );
          await this.#gateway.start('invoiceIssuanceWorkflow', {
            workflowId: temporalWorkflowIds.invoiceIssuance(invoiceId),
            taskQueue: 'billing',
            args: [{ tenantId, stripeInvoiceId: invoiceId, orderId: null, traceId }],
          });
          if (subscriptionId !== null) {
            const periodEnd = await this.#repository.subscriptionPeriodEnd(
              tenantId,
              subscriptionId,
              traceId,
            );
            if (periodEnd !== null && periodEnd.getTime() > this.#now().getTime()) {
              const periodEndIso = periodEnd.toISOString();
              await this.#gateway.start('renewalRemindersWorkflow', {
                workflowId: temporalWorkflowIds.renewalReminders(
                  tenantId,
                  periodEndIso.slice(0, 10),
                ),
                taskQueue: 'billing',
                args: [
                  {
                    tenantId,
                    stripeSubscriptionId: subscriptionId,
                    periodEnd: periodEndIso,
                    traceId,
                  },
                ],
              });
            }
          }
          return 'HANDLED';
        }
        return 'IGNORED';
      }
      case 'agent_version.published': {
        const workflowIds = await this.#repository.openProvisioningWorkflowIds(tenantId, traceId);
        for (const workflowId of workflowIds) {
          const outcome = await this.#gateway.signal(workflowId, 'provisioningAgentPublished', []);
          if (outcome === 'NOT_FOUND') {
            this.#logger.warn(
              { tenant_id: tenantId, workflow_id: workflowId },
              'open provisioning workflow is not running in Temporal',
            );
          }
        }
        return workflowIds.length > 0 ? 'HANDLED' : 'IGNORED';
      }
      case 'privacy.request_created': {
        const requestId = text(envelope.payload, 'request_id');
        if (
          requestId === null ||
          !UUID.test(requestId) ||
          text(envelope.payload, 'request_type') !== 'DELETE' ||
          text(envelope.payload, 'status') !== 'IN_PROGRESS'
        ) {
          return 'IGNORED';
        }
        await this.#gateway.start('callerErasureWorkflow', {
          workflowId: `caller-erasure:${requestId}:${envelope.event_id}`,
          taskQueue: 'retention',
          args: [{ tenantId, requestId, traceId }],
        });
        return 'HANDLED';
      }
      case 'booking.created':
      case 'booking.changed':
      case 'booking.canceled': {
        const bookingId = text(envelope.payload, 'booking_id');
        if (bookingId === null || !UUID.test(bookingId)) {
          return 'IGNORED';
        }
        await this.#gateway.start('guestNotificationWorkflow', {
          workflowId: `guest-notification:${envelope.event_id}`,
          taskQueue: 'notifications',
          args: [
            {
              tenantId,
              eventType,
              bookingId,
              eventId: envelope.event_id,
              traceId,
            },
          ],
        });
        return 'HANDLED';
      }
      case 'notification.requested': {
        const type = text(envelope.payload, 'notification_type');
        const dedupeKey = text(envelope.payload, 'dedupe_key');
        const payload = stringRecord(
          typeof envelope.payload === 'object' && envelope.payload !== null
            ? (envelope.payload as Record<string, unknown>)['template_payload']
            : null,
        );
        const recipient = text(envelope.payload, 'recipient_membership_id');
        if (
          type === null ||
          !REQUESTABLE_NOTIFICATIONS.has(type) ||
          dedupeKey === null ||
          dedupeKey.length > 200 ||
          payload === null ||
          (recipient !== null && !UUID.test(recipient))
        ) {
          this.#logger.warn(
            { tenant_id: tenantId, event_id: envelope.event_id },
            'notification request rejected',
          );
          return 'IGNORED';
        }
        await this.#gateway.start('notificationWorkflow', {
          workflowId: `notification:${envelope.event_id}`,
          taskQueue: 'notifications',
          args: [
            {
              tenantId,
              type,
              dedupeKey,
              payload,
              traceId,
              ...(recipient === null ? {} : { recipientMembershipId: recipient }),
            },
          ],
        });
        return 'HANDLED';
      }
      default:
        return 'IGNORED';
    }
  }
}
