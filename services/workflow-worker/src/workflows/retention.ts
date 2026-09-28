import { continueAsNew, proxyActivities, uuid4 } from '@temporalio/workflow';
import type { RetentionActivities, RetentionSweepResult } from './types.js';

const TENANTS_PER_RUN = 500;

const retention = proxyActivities<RetentionActivities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '1 minute',
    backoffCoefficient: 2,
    maximumInterval: '30 minutes',
    maximumAttempts: 5,
  },
});

export interface RetentionSweepInput {
  readonly jobRunId?: string;
  readonly offset?: number;
  readonly failedTenants?: readonly string[];
  readonly processed?: number;
  readonly providerPayloads?: number;
}

export async function retentionSweepWorkflow(
  input: RetentionSweepInput = {},
): Promise<RetentionSweepResult> {
  const jobRunId = input.jobRunId ?? uuid4();
  const traceId = jobRunId.replaceAll('-', '');
  const offset = input.offset ?? 0;
  const failedTenants = [...(input.failedTenants ?? [])];
  let processed = input.processed ?? 0;
  const providerPayloads =
    input.providerPayloads ?? (await retention.applyPlatformRetention({ jobRunId }));

  const tenants = await retention.listRetentionTenants();
  const batch = tenants.slice(offset, offset + TENANTS_PER_RUN);
  for (const tenantId of batch) {
    try {
      await retention.applyTenantRetention({ tenantId, jobRunId, traceId });
      processed += 1;
    } catch {
      failedTenants.push(tenantId);
    }
  }
  if (offset + TENANTS_PER_RUN < tenants.length) {
    return continueAsNew<typeof retentionSweepWorkflow>({
      jobRunId,
      offset: offset + TENANTS_PER_RUN,
      failedTenants,
      processed,
      providerPayloads,
    });
  }
  return { jobRunId, tenants: processed, failedTenants, providerPayloads };
}
