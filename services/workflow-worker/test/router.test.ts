import { describe, expect, it } from 'vitest';
import { dispose } from '../src/consumer.js';
import {
  DomainEventRouter,
  type RouterRepository,
  type TaskQueue,
  type WorkflowGateway,
} from '../src/router.js';

const TENANT = '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

class RecordingGateway implements WorkflowGateway {
  readonly started: {
    workflowType: string;
    workflowId: string;
    taskQueue: TaskQueue;
    args: readonly unknown[];
  }[] = [];
  readonly signals: { workflowId: string; signalName: string }[] = [];
  readonly running = new Set<string>();
  failNext: Error | null = null;

  start(
    workflowType: string,
    options: {
      readonly workflowId: string;
      readonly taskQueue: TaskQueue;
      readonly args: readonly unknown[];
    },
  ): Promise<'STARTED' | 'ALREADY_STARTED'> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    if (this.running.has(options.workflowId)) {
      return Promise.resolve('ALREADY_STARTED');
    }
    this.running.add(options.workflowId);
    this.started.push({ workflowType, ...options });
    return Promise.resolve('STARTED');
  }

  signal(workflowId: string, signalName: string): Promise<'SIGNALED' | 'NOT_FOUND'> {
    if (!this.running.has(workflowId)) {
      return Promise.resolve('NOT_FOUND');
    }
    this.signals.push({ workflowId, signalName });
    return Promise.resolve('SIGNALED');
  }
}

function setup(repository: Partial<RouterRepository> = {}): {
  router: DomainEventRouter;
  gateway: RecordingGateway;
} {
  const gateway = new RecordingGateway();
  const silent = (): void => undefined;
  const router = new DomainEventRouter({
    gateway,
    repository: {
      openProvisioningWorkflowIds:
        repository.openProvisioningWorkflowIds ?? (() => Promise.resolve([])),
      subscriptionPeriodEnd: repository.subscriptionPeriodEnd ?? (() => Promise.resolve(null)),
      enqueueWebhookDeliveries: repository.enqueueWebhookDeliveries ?? (() => Promise.resolve(0)),
    },
    logger: { info: silent, warn: silent },
    now: () => new Date('2026-09-14T08:00:00Z'),
  });
  return { router, gateway };
}

function envelope(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      event_id: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60',
      event_type: eventType,
      tenant_id: TENANT,
      trace_id: TRACE,
      occurred_at: '2026-09-14T07:59:59.000Z',
      producer: 'control-api',
      payload,
    }),
  );
}

describe('domain event router', () => {
  it('starts guest notifications for bookings made, moved and canceled', async () => {
    const { router, gateway } = setup();
    const booking = '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60';
    const eventTypes = ['booking.created', 'booking.changed', 'booking.canceled'];
    for (const [index, eventType] of eventTypes.entries()) {
      const message = JSON.parse(
        new TextDecoder().decode(envelope(eventType, { booking_id: booking })),
      ) as Record<string, unknown>;
      message['event_id'] = `0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e7${String(index)}`;
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      expect(await dispose(router, bytes, 1, 20)).toEqual({ kind: 'ack' });
      expect(await dispose(router, bytes, 2, 20)).toEqual({ kind: 'ack' });
    }
    await dispose(router, envelope('booking.created', { booking_id: 'not-a-uuid' }), 1, 20);
    expect(gateway.started.map((start) => [start.workflowType, start.taskQueue])).toEqual(
      eventTypes.map(() => ['guestNotificationWorkflow', 'notifications']),
    );
    for (const [index, eventType] of eventTypes.entries()) {
      expect(gateway.started[index]?.args[0]).toMatchObject({
        tenantId: TENANT,
        eventType,
        bookingId: booking,
        traceId: TRACE,
      });
    }
  });

  it('starts provisioning and invoice issuance exactly once for a paid order', async () => {
    const { router, gateway } = setup();
    const message = envelope('checkout.order_paid', {
      tenant_id: TENANT,
      order_id: 'order-1',
      plan_code: 'STARTER',
      stripe_subscription_id: 'sub_1',
      stripe_invoice_id: 'in_1',
    });
    expect(await dispose(router, message, 1, 20)).toEqual({ kind: 'ack' });
    expect(await dispose(router, message, 2, 20)).toEqual({ kind: 'ack' });
    expect(
      gateway.started.map((start) => [start.workflowType, start.workflowId, start.taskQueue]),
    ).toEqual([
      ['invoiceIssuanceWorkflow', 'invoice:in_1', 'billing'],
      ['provisioningWorkflow', 'provisioning:order-1', 'provisioning'],
    ]);
    expect(gateway.started[1]?.args).toEqual([
      { orderId: 'order-1', tenantId: TENANT, traceId: TRACE },
    ]);
  });

  it('starts dunning on failure and on payment signals it, issues the invoice and schedules renewal reminders', async () => {
    const periodEnd = new Date('2026-10-14T08:00:00Z');
    const { router, gateway } = setup({
      subscriptionPeriodEnd: (_tenant, subscription) =>
        Promise.resolve(subscription === 'sub_1' ? periodEnd : null),
    });
    await dispose(
      router,
      envelope('subscription.updated', {
        tenant_id: TENANT,
        stripe_subscription_id: 'sub_1',
        status: 'PAST_DUE',
        stripe_invoice_id: 'in_2',
        payment_failed: true,
      }),
      1,
      20,
    );
    await dispose(
      router,
      envelope('subscription.updated', {
        tenant_id: TENANT,
        stripe_subscription_id: 'sub_1',
        status: 'ACTIVE',
        stripe_invoice_id: 'in_2',
        invoice_paid: true,
      }),
      1,
      20,
    );
    expect(gateway.started.map((start) => start.workflowId)).toEqual([
      `dunning:${TENANT}:in_2`,
      'invoice:in_2',
      `renewal-reminders:${TENANT}:2026-10-14`,
    ]);
    expect(gateway.signals).toEqual([
      { workflowId: `dunning:${TENANT}:in_2`, signalName: 'dunningInvoicePaid' },
    ]);
    expect(gateway.started[2]?.args).toEqual([
      {
        tenantId: TENANT,
        stripeSubscriptionId: 'sub_1',
        periodEnd: periodEnd.toISOString(),
        traceId: TRACE,
      },
    ]);
  });

  it('ignores plan changes and forwards agent publications to open provisioning workflows', async () => {
    const { router, gateway } = setup({
      openProvisioningWorkflowIds: () => Promise.resolve(['provisioning:order-9']),
    });
    gateway.running.add('provisioning:order-9');
    await dispose(
      router,
      envelope('subscription.updated', {
        tenant_id: TENANT,
        stripe_subscription_id: 'sub_1',
        status: 'ACTIVE',
        plan_code: 'GROWTH',
      }),
      1,
      20,
    );
    await dispose(
      router,
      envelope('agent_version.published', { tenant_id: TENANT, agent_id: 'agent-1', version: 3 }),
      1,
      20,
    );
    expect(gateway.started).toEqual([]);
    expect(gateway.signals).toEqual([
      { workflowId: 'provisioning:order-9', signalName: 'provisioningAgentPublished' },
    ]);
  });

  it('starts notification workflows only for requestable security notifications with safe payloads', async () => {
    const { router, gateway } = setup();
    const membership = '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e61';
    await dispose(
      router,
      envelope('notification.requested', {
        notification_type: 'SECURITY_MEMBER_INVITED',
        dedupe_key: `invite:${membership}:1`,
        recipient_membership_id: membership,
        template_payload: { workspace_name: 'Demo' },
      }),
      1,
      20,
    );
    await dispose(
      router,
      envelope('notification.requested', {
        notification_type: 'PAYMENT_SUCCEEDED',
        dedupe_key: 'x',
        template_payload: {},
      }),
      1,
      20,
    );
    await dispose(
      router,
      envelope('notification.requested', {
        notification_type: 'SECURITY_API_KEY_CREATED',
        dedupe_key: 'y',
        template_payload: { nested: { a: 1 } },
      }),
      1,
      20,
    );
    expect(gateway.started.map((start) => [start.workflowType, start.taskQueue])).toEqual([
      ['notificationWorkflow', 'notifications'],
    ]);
    expect(gateway.started[0]?.args).toEqual([
      {
        tenantId: TENANT,
        type: 'SECURITY_MEMBER_INVITED',
        dedupeKey: `invite:${membership}:1`,
        payload: { workspace_name: 'Demo' },
        traceId: TRACE,
        recipientMembershipId: membership,
      },
    ]);
  });

  it('queues outbound webhook deliveries only for subscribable events', async () => {
    const queued: { tenantId: string; eventType: string; eventId: string }[] = [];
    const { router, gateway } = setup({
      enqueueWebhookDeliveries: (tenantId, event) => {
        queued.push({ tenantId, eventType: event.event_type, eventId: event.event_id });
        return Promise.resolve(2);
      },
    });
    expect(
      await dispose(
        router,
        envelope('booking.created', { tenant_id: TENANT, booking_id: 'b-1' }),
        1,
        20,
      ),
    ).toEqual({ kind: 'ack' });
    expect(
      await dispose(router, envelope('usage.recorded', { tenant_id: TENANT, seconds: 30 }), 1, 20),
    ).toEqual({ kind: 'ack' });
    expect(queued).toEqual([
      {
        tenantId: TENANT,
        eventType: 'booking.created',
        eventId: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60',
      },
    ]);
    expect(gateway.started).toEqual([]);

    const failing = setup({
      enqueueWebhookDeliveries: () => Promise.reject(new Error('database unavailable')),
    });
    expect(
      await dispose(failing.router, envelope('call.ended', { tenant_id: TENANT }), 1, 20),
    ).toEqual({ kind: 'retry', delayMs: 2000 });
  });

  it('starts caller erasure only for verified deletion requests', async () => {
    const { router, gateway } = setup();
    const requestId = '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e61';
    const base = {
      tenant_id: TENANT,
      request_id: requestId,
      person_id: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e62',
    };
    expect(
      await dispose(
        router,
        envelope('privacy.request_created', {
          ...base,
          request_type: 'DELETE',
          status: 'ON_LEGAL_HOLD',
        }),
        1,
        20,
      ),
    ).toEqual({ kind: 'ack' });
    expect(
      await dispose(
        router,
        envelope('privacy.request_created', {
          ...base,
          request_type: 'EXPORT',
          status: 'IN_PROGRESS',
        }),
        1,
        20,
      ),
    ).toEqual({ kind: 'ack' });
    expect(
      await dispose(
        router,
        envelope('privacy.request_created', {
          ...base,
          request_id: 'not-a-uuid',
          request_type: 'DELETE',
          status: 'IN_PROGRESS',
        }),
        1,
        20,
      ),
    ).toEqual({ kind: 'ack' });
    expect(gateway.started).toEqual([]);
    expect(
      await dispose(
        router,
        envelope('privacy.request_created', {
          ...base,
          request_type: 'DELETE',
          status: 'IN_PROGRESS',
        }),
        1,
        20,
      ),
    ).toEqual({ kind: 'ack' });
    expect(gateway.started).toEqual([
      {
        workflowType: 'callerErasureWorkflow',
        workflowId: `caller-erasure:${requestId}:0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60`,
        taskQueue: 'retention',
        args: [{ tenantId: TENANT, requestId, traceId: TRACE }],
      },
    ]);
  });

  it('retries transient failures with backoff and dead-letters poison messages', async () => {
    const { router, gateway } = setup();
    const message = envelope('checkout.order_paid', { tenant_id: TENANT, order_id: 'order-2' });
    gateway.failNext = new Error('temporal unavailable');
    expect(await dispose(router, message, 3, 20)).toEqual({ kind: 'retry', delayMs: 8_000 });
    gateway.failNext = new Error('temporal unavailable');
    expect(await dispose(router, message, 20, 20)).toMatchObject({ kind: 'dead_letter' });
    expect(await dispose(router, new TextEncoder().encode('{not json'), 1, 20)).toEqual({
      kind: 'dead_letter',
      reason: 'malformed_json',
    });
    const invalid = await dispose(
      router,
      new TextEncoder().encode(JSON.stringify({ event_type: 'checkout.order_paid' })),
      1,
      20,
    );
    expect(invalid.kind).toBe('dead_letter');
    expect(gateway.started).toEqual([]);
  });
});
