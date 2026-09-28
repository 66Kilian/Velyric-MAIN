import {
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  NON_RETRYABLE_ERROR,
  type ProvisioningActivities,
  type ProvisioningInput,
  type ProvisioningStatus,
} from './types.js';

export const kycSubmittedSignal = defineSignal('provisioningKycSubmitted');
export const agentPublishedSignal = defineSignal('provisioningAgentPublished');
export const retryProvisioningSignal = defineSignal('provisioningRetry');
export const cancelProvisioningSignal = defineSignal<[string]>('provisioningCancel');
export const provisioningStatusQuery = defineQuery<ProvisioningStatus>('provisioningStatus');

const KYC_POLL_INTERVAL = '6 hours';
const KYC_POLL_LIMIT = 30 * 4;
const PROVIDER_POLL_INTERVAL = '30 minutes';
const PROVIDER_POLL_LIMIT = 14 * 48;
const AGENT_POLL_INTERVAL = '6 hours';
const AGENT_POLL_LIMIT = 60 * 4;

const invoiceGate = proxyActivities<Pick<ProvisioningActivities, 'ensureOrderInvoice'>>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 1.5,
    maximumInterval: '1 minute',
    maximumAttempts: 720,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

const activities = proxyActivities<ProvisioningActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '10 minutes',
    maximumAttempts: 12,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

const bookkeeping = proxyActivities<
  Pick<ProvisioningActivities, 'recordState' | 'markManualReview'>
>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 30,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

const notifier = proxyActivities<Pick<ProvisioningActivities, 'notify'>>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

async function notify(input: Parameters<ProvisioningActivities['notify']>[0]): Promise<void> {
  try {
    await notifier.notify(input);
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
  }
}

class CancelRequested extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'CancelRequested';
    this.reason = reason;
  }
}

function failureReason(error: unknown): { readonly reason: string; readonly message: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ApplicationFailure) {
      const detail = current.details?.[0];
      const code =
        typeof detail === 'object' &&
        detail !== null &&
        'code' in detail &&
        typeof detail.code === 'string'
          ? detail.code
          : (current.type ?? 'application_failure');
      return { reason: code, message: current.message.slice(0, 500) };
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return {
    reason: 'unexpected_failure',
    message: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
  };
}

export async function provisioningWorkflow(input: ProvisioningInput): Promise<ProvisioningStatus> {
  let status: ProvisioningStatus = {
    state: 'ORDER_CREATED',
    blockingReason: null,
    manualReviewReason: null,
  };
  let kycSubmitted = false;
  let agentPublished = false;
  let retryRequested = false;
  let cancelReason: string | null = null;
  const currentCancelReason = (): string | null => cancelReason;
  setHandler(kycSubmittedSignal, () => {
    kycSubmitted = true;
  });
  setHandler(agentPublishedSignal, () => {
    agentPublished = true;
  });
  setHandler(retryProvisioningSignal, () => {
    retryRequested = true;
  });
  setHandler(cancelProvisioningSignal, (reason) => {
    cancelReason = reason.slice(0, 200);
  });
  setHandler(provisioningStatusQuery, () => status);

  const begin = await activities.beginProvisioning({
    ...input,
    workflowId: workflowInfo().workflowId,
  });
  const row = {
    tenantId: input.tenantId,
    workflowRowId: begin.workflowRowId,
    traceId: input.traceId,
  };
  if (begin.alreadyActive) {
    status = { state: 'ACTIVE', blockingReason: null, manualReviewReason: null };
    return status;
  }

  const setState = async (state: string, blockingReason: string | null = null): Promise<void> => {
    status = { state, blockingReason, manualReviewReason: null };
    await bookkeeping.recordState({ ...row, state, blockingReason });
  };
  const assertNotCanceled = (): void => {
    if (cancelReason !== null) {
      throw new CancelRequested(cancelReason);
    }
  };
  const waitUnlessCanceled = async (
    predicate: () => boolean,
    timeout: string,
  ): Promise<boolean> => {
    const met = await condition(() => predicate() || cancelReason !== null, timeout);
    assertNotCanceled();
    return met;
  };

  const pipeline = async (): Promise<void> => {
    assertNotCanceled();
    await setState('BILLING_PENDING');
    await invoiceGate.ensureOrderInvoice({ ...row, orderId: input.orderId });
    await setState('BILLING_DOCUMENT_CREATED');

    assertNotCanceled();
    await setState('TENANT_PROVISIONING');
    await activities.ensureTenantProvisioning(row);
    await setState('TENANT_CREATED');

    assertNotCanceled();
    await setState('OPENAI_PROJECT_PROVISIONING');
    const projectId = await activities.ensureOpenAiProject({ ...row, planCode: begin.planCode });
    await setState('OPENAI_SERVICE_ACCOUNT_PROVISIONING');
    await activities.ensureOpenAiServiceAccount({ ...row, projectId });
    await setState('OPENAI_READY');

    assertNotCanceled();
    await setState('PHONE_RESERVING');
    const reservation = await activities.reservePhoneNumber({
      ...row,
      orderId: input.orderId,
      country: begin.country,
    });
    if (
      reservation.requirementsRequired &&
      !(await activities.requirementsSubmitted({ ...row, phoneOrderId: reservation.phoneOrderId }))
    ) {
      await setState('PHONE_KYC_REQUIRED', 'regulatory_details_required');
      await notify({
        tenantId: input.tenantId,
        type: 'PROVISIONING_KYC_REQUIRED',
        dedupeKey: `provisioning:${input.orderId}:kyc_required`,
        payload: { phone_number: reservation.e164 },
        traceId: input.traceId,
      });
      await setState('WAITING_FOR_CUSTOMER', 'regulatory_details_required');
      let submitted = false;
      for (let attempt = 0; attempt < KYC_POLL_LIMIT && !submitted; attempt += 1) {
        await waitUnlessCanceled(() => kycSubmitted, KYC_POLL_INTERVAL);
        kycSubmitted = false;
        submitted = await activities.requirementsSubmitted({
          ...row,
          phoneOrderId: reservation.phoneOrderId,
        });
      }
      if (!submitted) {
        throw ApplicationFailure.create({
          type: NON_RETRYABLE_ERROR,
          message: 'regulatory details were not submitted in time',
          nonRetryable: true,
          details: [{ code: 'kyc_timeout' }],
        });
      }
      await setState('PHONE_UNDER_REVIEW');
    }

    assertNotCanceled();
    await setState('PHONE_ORDERING');
    await activities.orderPhoneNumber({
      ...row,
      phoneOrderId: reservation.phoneOrderId,
      orderId: input.orderId,
    });
    await setState('WAITING_FOR_PROVIDER', 'carrier_processing');
    let approved = false;
    for (let attempt = 0; attempt < PROVIDER_POLL_LIMIT && !approved; attempt += 1) {
      const progress = await activities.refreshPhoneOrder({
        ...row,
        phoneOrderId: reservation.phoneOrderId,
      });
      if (progress.status === 'APPROVED') {
        approved = true;
      } else if (progress.status === 'DECLINED') {
        await notify({
          tenantId: input.tenantId,
          type: 'PROVISIONING_KYC_DECLINED',
          dedupeKey: `provisioning:${input.orderId}:kyc_declined`,
          payload: {
            phone_number: reservation.e164,
            reason: progress.declineReason ?? 'carrier_rejected',
          },
          traceId: input.traceId,
        });
        throw ApplicationFailure.create({
          type: NON_RETRYABLE_ERROR,
          message: 'the carrier declined the phone number order',
          nonRetryable: true,
          details: [{ code: 'phone_order_declined' }],
        });
      } else {
        if (progress.status === 'UNDER_REVIEW' && status.state !== 'PHONE_UNDER_REVIEW') {
          await setState('PHONE_UNDER_REVIEW', 'carrier_regulatory_review');
        }
        await waitUnlessCanceled(() => false, PROVIDER_POLL_INTERVAL);
      }
    }
    if (!approved) {
      throw ApplicationFailure.create({
        type: NON_RETRYABLE_ERROR,
        message: 'the carrier did not complete the order in time',
        nonRetryable: true,
        details: [{ code: 'carrier_review_timeout' }],
      });
    }
    const phoneNumberId = await activities.activatePhoneNumber({
      ...row,
      phoneOrderId: reservation.phoneOrderId,
      locationId: begin.locationId,
    });
    await setState('PHONE_READY');
    await notify({
      tenantId: input.tenantId,
      type: 'PHONE_NUMBER_ACTIVE',
      dedupeKey: `provisioning:${input.orderId}:phone_active`,
      payload: { phone_number: reservation.e164 },
      traceId: input.traceId,
    });

    assertNotCanceled();
    await setState('SIP_AGENT_BINDING');
    let readiness = await activities.checkAgentReadiness({ ...row, phoneNumberId });
    for (let attempt = 0; attempt < AGENT_POLL_LIMIT && !readiness.ready; attempt += 1) {
      if (status.state !== 'WAITING_FOR_CUSTOMER') {
        await setState('WAITING_FOR_CUSTOMER', readiness.reason ?? 'agent_not_published');
      }
      await waitUnlessCanceled(() => agentPublished, AGENT_POLL_INTERVAL);
      agentPublished = false;
      readiness = await activities.checkAgentReadiness({ ...row, phoneNumberId });
    }
    if (!readiness.ready) {
      throw ApplicationFailure.create({
        type: NON_RETRYABLE_ERROR,
        message: 'no production agent was published in time',
        nonRetryable: true,
        details: [{ code: 'agent_not_published' }],
      });
    }
    await setState('AGENT_READY');
    await setState('TEST_CALL_READY');
    await notify({
      tenantId: input.tenantId,
      type: 'TEST_CALL_READY',
      dedupeKey: `provisioning:${input.orderId}:test_call_ready`,
      payload: { phone_number: reservation.e164 },
      traceId: input.traceId,
    });

    assertNotCanceled();
    const evaluation = await activities.evaluateGoLive({ ...row, phoneNumberId });
    if (!evaluation.eligible) {
      throw ApplicationFailure.create({
        type: NON_RETRYABLE_ERROR,
        message: `go-live gate failed: ${evaluation.failures.join(', ')}`,
        nonRetryable: true,
        details: [{ code: `go_live_gate:${evaluation.failures[0] ?? 'unknown'}` }],
      });
    }
    await setState('GO_LIVE_ELIGIBLE');
    await activities.completeProvisioning(row);
    status = { state: 'ACTIVE', blockingReason: null, manualReviewReason: null };
    await notify({
      tenantId: input.tenantId,
      type: 'GO_LIVE_COMPLETED',
      dedupeKey: `provisioning:${input.orderId}:go_live`,
      payload: { phone_number: reservation.e164 },
      traceId: input.traceId,
    });
  };

  const compensate = async (reason: string): Promise<ProvisioningStatus> => {
    await setState('COMPENSATING', reason);
    await activities.compensateProvisioning({ ...row, reason });
    status = { state: 'COMPENSATED', blockingReason: reason, manualReviewReason: null };
    return status;
  };

  await notify({
    tenantId: input.tenantId,
    type: 'PROVISIONING_STARTED',
    dedupeKey: `provisioning:${input.orderId}:started`,
    payload: { plan_name: begin.planCode },
    traceId: input.traceId,
  });

  for (;;) {
    try {
      await pipeline();
      return status;
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      if (error instanceof CancelRequested) {
        return compensate(error.reason);
      }
      const failure = failureReason(error);
      status = {
        state: 'MANUAL_REVIEW_REQUIRED',
        blockingReason: failure.reason,
        manualReviewReason: failure.reason,
      };
      await bookkeeping.markManualReview({
        ...row,
        reason: failure.reason,
        errorMessage: failure.message,
      });
      await notify({
        tenantId: input.tenantId,
        type: 'PROVISIONING_DELAYED',
        dedupeKey: `provisioning:${input.orderId}:delayed:${failure.reason}`,
        payload: { reason: failure.reason },
        traceId: input.traceId,
      });
      retryRequested = false;
      await condition(() => retryRequested || cancelReason !== null);
      const requestedCancel = currentCancelReason();
      if (requestedCancel !== null) {
        return compensate(requestedCancel);
      }
    }
  }
}
