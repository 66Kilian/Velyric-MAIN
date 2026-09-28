import { condition, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import {
  NON_RETRYABLE_ERROR,
  type BillingActivities,
  type DunningInput,
  type InvoiceIssuanceInput,
  type InvoiceIssuanceResult,
  type RenewalRemindersInput,
} from './types.js';

export const invoicePaidSignal = defineSignal('dunningInvoicePaid');

const billing = proxyActivities<BillingActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '15 minutes',
    maximumAttempts: 16,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

function millisecondsUntil(isoTimestamp: string): number {
  return Math.max(1, Date.parse(isoTimestamp) - Date.now());
}

export async function invoiceIssuanceWorkflow(
  input: InvoiceIssuanceInput,
): Promise<InvoiceIssuanceResult> {
  return billing.issueInvoiceDocument(input);
}

export async function renewalRemindersWorkflow(input: RenewalRemindersInput): Promise<number> {
  const schedule = await billing.renewalSchedule(input);
  let sent = 0;
  for (const step of schedule.steps) {
    const wait = Date.parse(step.at) - Date.now();
    if (wait > 0) {
      await sleep(wait);
    } else if (wait < -12 * 3_600_000) {
      continue;
    }
    if (!(await billing.subscriptionRenewsAt(input))) {
      return sent;
    }
    await billing.notify({
      tenantId: input.tenantId,
      type: step.notification,
      dedupeKey: `renewal:${input.stripeSubscriptionId}:${input.periodEnd}:${step.notification}`,
      payload: schedule.payload,
      traceId: input.traceId,
    });
    sent += 1;
  }
  return sent;
}

export async function dunningWorkflow(
  input: DunningInput,
): Promise<'PAID' | 'SUSPENDED' | 'NOT_SUSPENDED'> {
  let paid = false;
  setHandler(invoicePaidSignal, () => {
    paid = true;
  });
  const grace = await billing.enterGracePeriod(input);
  if (grace.alreadyPaid) {
    return 'PAID';
  }
  await billing.notify({
    tenantId: input.tenantId,
    type: 'PAYMENT_FAILED_GRACE_STARTED',
    dedupeKey: `dunning:${input.stripeInvoiceId}:grace_started`,
    payload: grace.payload,
    traceId: input.traceId,
  });
  for (const step of [
    { at: grace.reminderAt, type: 'GRACE_PERIOD_REMINDER' },
    { at: grace.finalDayAt, type: 'GRACE_PERIOD_FINAL_DAY' },
  ]) {
    if (await condition(() => paid, millisecondsUntil(step.at))) {
      return 'PAID';
    }
    if (await billing.invoiceIsPaid(input)) {
      return 'PAID';
    }
    await billing.notify({
      tenantId: input.tenantId,
      type: step.type,
      dedupeKey: `dunning:${input.stripeInvoiceId}:${step.type}`,
      payload: grace.payload,
      traceId: input.traceId,
    });
  }
  if (await condition(() => paid, millisecondsUntil(grace.suspendAt))) {
    return 'PAID';
  }
  if (await billing.invoiceIsPaid(input)) {
    return 'PAID';
  }
  if (!(await billing.suspendForNonPayment(input))) {
    return 'NOT_SUSPENDED';
  }
  await billing.notify({
    tenantId: input.tenantId,
    type: 'SERVICE_SUSPENDED_BILLING',
    dedupeKey: `dunning:${input.stripeInvoiceId}:suspended`,
    payload: grace.payload,
    traceId: input.traceId,
  });
  return 'SUSPENDED';
}
