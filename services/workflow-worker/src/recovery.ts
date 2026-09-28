import { randomBytes } from 'node:crypto';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { temporalWorkflowIds } from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import type { Kysely } from 'kysely';
import type { RouterLogger, TaskQueue, WorkflowGateway } from './router.js';

const SETTLED_STATES = ['ACTIVE', 'COMPENSATED', 'CANCELED'];
const ISSUED_DOCUMENT_STATUSES: ReadonlySet<string> = new Set([
  'CREATED',
  'SENT',
  'SEND_FAILED',
  'FAILED',
]);
const RESTARTABLE_CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'FAILED',
  'TERMINATED',
  'TIMED_OUT',
]);

export interface ProvisioningRecoveryDependencies {
  readonly db: Kysely<DB>;
  readonly client: Pick<Client, 'workflow'>;
  readonly gateway: WorkflowGateway;
  readonly logger: RouterLogger;
  readonly restartedAfterFailure: Set<string>;
}

async function executionStatus(
  client: Pick<Client, 'workflow'>,
  workflowId: string,
): Promise<string | null> {
  try {
    return (await client.workflow.getHandle(workflowId).describe()).status.name;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return null;
    }
    throw error;
  }
}

async function ensureWorkflow(
  deps: ProvisioningRecoveryDependencies,
  workflowType: string,
  workflowId: string,
  taskQueue: TaskQueue,
  args: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const status = await executionStatus(deps.client, workflowId);
  const afterFailure = status !== null && RESTARTABLE_CLOSED_STATUSES.has(status);
  if (status !== null && (!afterFailure || deps.restartedAfterFailure.has(workflowId))) {
    return false;
  }
  if (afterFailure) {
    deps.restartedAfterFailure.add(workflowId);
  }
  const outcome = await deps.gateway.start(workflowType, {
    workflowId,
    taskQueue,
    args: [args],
    allowAfterFailure: afterFailure,
  });
  if (outcome !== 'STARTED') {
    return false;
  }
  deps.logger.warn(
    { workflow_type: workflowType, workflow_id: workflowId, previous_status: status ?? 'MISSING' },
    'workflow restarted by recovery',
  );
  return true;
}

export async function recoverOrphanedProvisioning(
  deps: ProvisioningRecoveryDependencies,
): Promise<number> {
  const tenants = await deps.db
    .selectFrom('tenant_directory')
    .select(['id'])
    .where('status', '=', 'PROVISIONING')
    .execute();
  let restarted = 0;
  for (const tenant of tenants) {
    const traceId = randomBytes(16).toString('hex');
    const { open, documents } = await withTenantTransaction(
      deps.db,
      {
        tenantId: tenant.id,
        actorType: 'SYSTEM',
        actorId: 'provisioning-recovery',
        traceId,
      },
      async (trx) => {
        const rows = await trx
          .selectFrom('provisioning_workflows')
          .innerJoin('checkout_orders', 'checkout_orders.id', 'provisioning_workflows.order_id')
          .select(['provisioning_workflows.order_id', 'checkout_orders.stripe_invoice_id'])
          .where('provisioning_workflows.state', 'not in', SETTLED_STATES)
          .where('provisioning_workflows.completed_at', 'is', null)
          .execute();
        const keys = rows.flatMap((row) =>
          row.stripe_invoice_id === null ? [] : [`stripe_invoice:${row.stripe_invoice_id}`],
        );
        const issued =
          keys.length === 0
            ? []
            : await trx
                .selectFrom('billing_documents')
                .select(['idempotency_key', 'status'])
                .where('idempotency_key', 'in', keys)
                .execute();
        return { open: rows, documents: issued };
      },
    );
    for (const row of open) {
      const invoiceId = row.stripe_invoice_id;
      if (
        invoiceId !== null &&
        !documents.some(
          (document) =>
            document.idempotency_key === `stripe_invoice:${invoiceId}` &&
            ISSUED_DOCUMENT_STATUSES.has(document.status),
        ) &&
        (await ensureWorkflow(
          deps,
          'invoiceIssuanceWorkflow',
          temporalWorkflowIds.invoiceIssuance(invoiceId),
          'billing',
          { tenantId: tenant.id, stripeInvoiceId: invoiceId, orderId: row.order_id, traceId },
        ))
      ) {
        restarted += 1;
      }
      if (
        await ensureWorkflow(
          deps,
          'provisioningWorkflow',
          temporalWorkflowIds.provisioning(row.order_id),
          'provisioning',
          { orderId: row.order_id, tenantId: tenant.id, traceId },
        )
      ) {
        restarted += 1;
      }
    }
  }
  return restarted;
}
