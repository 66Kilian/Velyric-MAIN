import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  bundleWorkflowCode,
  DefaultLogger,
  Runtime,
  Worker,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NON_RETRYABLE_ERROR,
  type BillingActivities,
  type NotifyInput,
  type ProvisioningActivities,
  type RetentionActivities,
} from '../src/workflows/types.js';

const TENANT = '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
    logger: new DefaultLogger('WARN'),
  });
});

afterAll(async () => {
  await env.teardown();
});

function day(offset: number): string {
  return new Date(Date.UTC(2026, 8, 14 + offset, 8)).toISOString();
}

async function withWorker(
  taskQueue: string,
  activities: object,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  return worker.runUntil(run);
}

async function serverNow(): Promise<number> {
  return env.currentTimeMs();
}

function billingActivities(state: {
  paid: boolean;
  notifications: string[];
  suspended: number;
}): BillingActivities {
  return {
    issueInvoiceDocument: () =>
      Promise.resolve({ status: 'SENT', billingDocumentId: 'doc-1', invoiceNumber: 'VLY-1' }),
    renewalSchedule: () => Promise.resolve({ steps: [], payload: {} }),
    subscriptionRenewsAt: () => Promise.resolve(true),
    enterGracePeriod: async () => {
      const start = await serverNow();
      return {
        alreadyPaid: false,
        reminderAt: new Date(start + 3 * 86_400_000).toISOString(),
        finalDayAt: new Date(start + 6 * 86_400_000).toISOString(),
        suspendAt: new Date(start + 7 * 86_400_000).toISOString(),
        payload: { amount: '38 100 Ft' },
      };
    },
    invoiceIsPaid: () => Promise.resolve(state.paid),
    suspendForNonPayment: () => {
      state.suspended += 1;
      return Promise.resolve(true);
    },
    notify: (input: NotifyInput) => {
      state.notifications.push(input.type);
      return Promise.resolve({ status: 'SENT' });
    },
  };
}

describe('billing workflows', () => {
  it('suspends service after the grace period when the invoice stays unpaid', async () => {
    const state = { paid: false, notifications: [] as string[], suspended: 0 };
    const result = await withWorker('billing-unpaid', billingActivities(state), () =>
      env.client.workflow.execute('dunningWorkflow', {
        taskQueue: 'billing-unpaid',
        workflowId: `dunning:${TENANT}:in_unpaid`,
        args: [{ tenantId: TENANT, stripeInvoiceId: 'in_unpaid', traceId: TRACE }],
      }),
    );
    expect(result).toBe('SUSPENDED');
    expect(state.notifications).toEqual([
      'PAYMENT_FAILED_GRACE_STARTED',
      'GRACE_PERIOD_REMINDER',
      'GRACE_PERIOD_FINAL_DAY',
      'SERVICE_SUSPENDED_BILLING',
    ]);
    expect(state.suspended).toBe(1);
  });

  it('stops dunning as soon as the payment signal arrives', async () => {
    const state = { paid: false, notifications: [] as string[], suspended: 0 };
    const result = await withWorker('billing-paid', billingActivities(state), async () => {
      const handle = await env.client.workflow.start('dunningWorkflow', {
        taskQueue: 'billing-paid',
        workflowId: `dunning:${TENANT}:in_paid`,
        args: [{ tenantId: TENANT, stripeInvoiceId: 'in_paid', traceId: TRACE }],
      });
      await env.sleep('4 days');
      state.paid = true;
      await handle.signal('dunningInvoicePaid');
      return handle.result();
    });
    expect(result).toBe('PAID');
    expect(state.notifications).toEqual(['PAYMENT_FAILED_GRACE_STARTED', 'GRACE_PERIOD_REMINDER']);
    expect(state.suspended).toBe(0);
  });

  it('sends renewal reminders only while the subscription still renews', async () => {
    const notifications: string[] = [];
    let renews = true;
    const activities: BillingActivities = {
      ...billingActivities({ paid: false, notifications, suspended: 0 }),
      renewalSchedule: async () => {
        const start = await serverNow();
        return {
          steps: [
            { at: new Date(start + 86_400_000).toISOString(), notification: 'RENEWAL_REMINDER_7D' },
            {
              at: new Date(start + 5 * 86_400_000).toISOString(),
              notification: 'RENEWAL_REMINDER_1D',
            },
          ],
          payload: { renewal_date: day(6) },
        };
      },
      subscriptionRenewsAt: () => {
        const current = renews;
        renews = false;
        return Promise.resolve(current);
      },
    };
    const sent = await withWorker('billing-renewal', activities, () =>
      env.client.workflow.execute('renewalRemindersWorkflow', {
        taskQueue: 'billing-renewal',
        workflowId: `renewal-reminders:${TENANT}:2026-09-20`,
        args: [
          { tenantId: TENANT, stripeSubscriptionId: 'sub_1', periodEnd: day(6), traceId: TRACE },
        ],
      }),
    );
    expect(sent).toBe(1);
    expect(notifications).toEqual(['RENEWAL_REMINDER_7D']);
  });
});

interface ProvisioningHarness {
  readonly activities: ProvisioningActivities;
  readonly states: string[];
  readonly notifications: string[];
  readonly calls: string[];
  kycSubmitted: boolean;
  agentReady: boolean;
  carrierChecks: number;
  goLiveFailures: string[];
}

function provisioningHarness(): ProvisioningHarness {
  const harness: ProvisioningHarness = {
    states: [],
    notifications: [],
    calls: [],
    kycSubmitted: false,
    agentReady: false,
    carrierChecks: 0,
    goLiveFailures: [],
    activities: undefined as unknown as ProvisioningActivities,
  };
  const record = <T>(name: string, value: T): Promise<T> => {
    harness.calls.push(name);
    return Promise.resolve(value);
  };
  (harness as { activities: ProvisioningActivities }).activities = {
    beginProvisioning: () =>
      record('beginProvisioning', {
        workflowRowId: 'row-1',
        state: 'ORDER_CREATED',
        country: 'HU',
        locationId: 'loc-1',
        planCode: 'STARTER',
        alreadyActive: false,
      }),
    recordState: (input) => {
      harness.states.push(input.state);
      return Promise.resolve();
    },
    ensureOrderInvoice: () => record('ensureOrderInvoice', undefined),
    ensureTenantProvisioning: () => record('ensureTenantProvisioning', undefined),
    ensureOpenAiProject: () => record('ensureOpenAiProject', 'proj_1'),
    ensureOpenAiServiceAccount: () => record('ensureOpenAiServiceAccount', undefined),
    reservePhoneNumber: () =>
      record('reservePhoneNumber', {
        phoneOrderId: 'po-1',
        e164: '+3612345678',
        requirementsRequired: true,
      }),
    requirementsSubmitted: () => record('requirementsSubmitted', harness.kycSubmitted),
    orderPhoneNumber: () => record('orderPhoneNumber', undefined),
    refreshPhoneOrder: () => {
      harness.carrierChecks += 1;
      return record('refreshPhoneOrder', {
        status: harness.carrierChecks < 3 ? ('UNDER_REVIEW' as const) : ('APPROVED' as const),
        declineReason: null,
      });
    },
    activatePhoneNumber: () => record('activatePhoneNumber', 'pn-1'),
    checkAgentReadiness: () =>
      record('checkAgentReadiness', {
        ready: harness.agentReady,
        reason: harness.agentReady ? null : 'agent_not_published',
      }),
    evaluateGoLive: () =>
      record('evaluateGoLive', {
        eligible: harness.goLiveFailures.length === 0,
        failures: harness.goLiveFailures,
      }),
    completeProvisioning: () => record('completeProvisioning', undefined),
    markManualReview: (input) => record(`markManualReview:${input.reason}`, undefined),
    compensateProvisioning: (input) => record(`compensateProvisioning:${input.reason}`, undefined),
    notify: (input) => {
      harness.notifications.push(input.type);
      return Promise.resolve({ status: 'SENT' });
    },
  };
  return harness;
}

describe('provisioning workflow', () => {
  it('walks a paid order through KYC, carrier review and agent publication to go-live', async () => {
    const harness = provisioningHarness();
    const result = await withWorker('provisioning-happy', harness.activities, async () => {
      const handle = await env.client.workflow.start('provisioningWorkflow', {
        taskQueue: 'provisioning-happy',
        workflowId: 'provisioning:order-happy',
        args: [{ orderId: 'order-happy', tenantId: TENANT, traceId: TRACE }],
      });
      await env.sleep('1 hour');
      expect(await handle.query('provisioningStatus')).toMatchObject({
        state: 'WAITING_FOR_CUSTOMER',
        blockingReason: 'regulatory_details_required',
      });
      harness.kycSubmitted = true;
      await handle.signal('provisioningKycSubmitted');
      await env.sleep('3 hours');
      expect(await handle.query('provisioningStatus')).toMatchObject({
        state: 'WAITING_FOR_CUSTOMER',
        blockingReason: 'agent_not_published',
      });
      harness.agentReady = true;
      await handle.signal('provisioningAgentPublished');
      return handle.result();
    });
    expect(result).toEqual({ state: 'ACTIVE', blockingReason: null, manualReviewReason: null });
    expect(harness.states).toEqual([
      'BILLING_PENDING',
      'BILLING_DOCUMENT_CREATED',
      'TENANT_PROVISIONING',
      'TENANT_CREATED',
      'OPENAI_PROJECT_PROVISIONING',
      'OPENAI_SERVICE_ACCOUNT_PROVISIONING',
      'OPENAI_READY',
      'PHONE_RESERVING',
      'PHONE_KYC_REQUIRED',
      'WAITING_FOR_CUSTOMER',
      'PHONE_UNDER_REVIEW',
      'PHONE_ORDERING',
      'WAITING_FOR_PROVIDER',
      'PHONE_UNDER_REVIEW',
      'PHONE_READY',
      'SIP_AGENT_BINDING',
      'WAITING_FOR_CUSTOMER',
      'AGENT_READY',
      'TEST_CALL_READY',
      'GO_LIVE_ELIGIBLE',
    ]);
    expect(harness.notifications).toEqual([
      'PROVISIONING_STARTED',
      'PROVISIONING_KYC_REQUIRED',
      'PHONE_NUMBER_ACTIVE',
      'TEST_CALL_READY',
      'GO_LIVE_COMPLETED',
    ]);
    expect(harness.carrierChecks).toBe(3);
    expect(harness.calls.filter((call) => call === 'completeProvisioning')).toHaveLength(1);
  });

  it('parks failures for manual review, retries on request and compensates on cancellation', async () => {
    const harness = provisioningHarness();
    harness.kycSubmitted = true;
    harness.agentReady = true;
    harness.goLiveFailures = ['kill_switch_active'];
    const result = await withWorker('provisioning-review', harness.activities, async () => {
      const handle = await env.client.workflow.start('provisioningWorkflow', {
        taskQueue: 'provisioning-review',
        workflowId: 'provisioning:order-review',
        args: [{ orderId: 'order-review', tenantId: TENANT, traceId: TRACE }],
      });
      await env.sleep('3 hours');
      expect(await handle.query('provisioningStatus')).toMatchObject({
        state: 'MANUAL_REVIEW_REQUIRED',
        manualReviewReason: 'go_live_gate:kill_switch_active',
      });
      await handle.signal('provisioningRetry');
      await env.sleep('3 hours');
      await handle.signal('provisioningCancel', 'customer_requested_refund');
      return handle.result();
    });
    expect(result).toEqual({
      state: 'COMPENSATED',
      blockingReason: 'customer_requested_refund',
      manualReviewReason: null,
    });
    expect(harness.calls.filter((call) => call.startsWith('markManualReview'))).toEqual([
      'markManualReview:go_live_gate:kill_switch_active',
      'markManualReview:go_live_gate:kill_switch_active',
    ]);
    expect(harness.calls).toContain('compensateProvisioning:customer_requested_refund');
    expect(harness.calls).not.toContain('completeProvisioning');
  });

  it('treats non-retryable activity failures as manual review instead of retrying forever', async () => {
    const harness = provisioningHarness();
    let attempts = 0;
    const activities: ProvisioningActivities = {
      ...harness.activities,
      ensureOpenAiProject: () => {
        attempts += 1;
        return Promise.reject(
          ApplicationFailure.create({
            type: NON_RETRYABLE_ERROR,
            message: 'quota',
            nonRetryable: true,
            details: [{ code: 'openai:project_quota_exceeded' }],
          }),
        );
      },
    };
    const status = await withWorker('provisioning-failure', activities, async () => {
      const handle = await env.client.workflow.start('provisioningWorkflow', {
        taskQueue: 'provisioning-failure',
        workflowId: 'provisioning:order-failure',
        args: [{ orderId: 'order-failure', tenantId: TENANT, traceId: TRACE }],
      });
      await env.sleep('10 minutes');
      const current = await handle.query('provisioningStatus');
      await handle.terminate('test complete');
      return current;
    });
    expect(attempts).toBe(1);
    expect(status).toMatchObject({
      state: 'MANUAL_REVIEW_REQUIRED',
      manualReviewReason: 'openai:project_quota_exceeded',
    });
    expect(harness.notifications).toContain('PROVISIONING_DELAYED');
  });
});

describe('retention sweep workflow', () => {
  it('applies retention per tenant, continues after failures and continues as new for large fleets', async () => {
    const tenants = Array.from(
      { length: 503 },
      (_, index) => `0192f0a4-6b1e-7c3d-8e9f-${index.toString(16).padStart(12, '0')}`,
    );
    const applied: string[] = [];
    let platformRuns = 0;
    const activities: RetentionActivities = {
      listRetentionTenants: () => Promise.resolve(tenants),
      applyPlatformRetention: () => {
        platformRuns += 1;
        return Promise.resolve(7);
      },
      applyTenantRetention: (input) => {
        if (input.tenantId === tenants[1]) {
          return Promise.reject(
            ApplicationFailure.nonRetryable('database constraint violated', 'RetentionFailure'),
          );
        }
        applied.push(input.tenantId);
        expect(input.traceId).toMatch(/^[0-9a-f]{32}$/);
        return Promise.resolve({ tenantId: input.tenantId, affected: { TRANSCRIPT: 1 } });
      },
    };
    const result = await withWorker('retention-sweep', activities, () =>
      env.client.workflow.execute('retentionSweepWorkflow', {
        taskQueue: 'retention-sweep',
        workflowId: 'retention-sweep-test',
        args: [{}],
      }),
    );
    expect(result).toMatchObject({
      tenants: 502,
      failedTenants: [tenants[1]],
      providerPayloads: 7,
    });
    expect(platformRuns).toBe(1);
    expect(new Set(applied).size).toBe(502);
  });
});
