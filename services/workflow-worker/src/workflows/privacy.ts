import { proxyActivities } from '@temporalio/workflow';
import {
  NON_RETRYABLE_ERROR,
  type ErasureInput,
  type ErasureResult,
  type PrivacyActivities,
} from './types.js';

const privacy = proxyActivities<PrivacyActivities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 hour',
    maximumAttempts: 50,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

export async function callerErasureWorkflow(input: ErasureInput): Promise<ErasureResult> {
  return privacy.eraseCallerData(input);
}
