import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { recoverOrphanedProvisioning } from '../src/recovery.js';
import type { WorkflowGateway } from '../src/router.js';
import { seedKycPhoneOrder, useTestDatabase } from './support/db.js';

const database = useTestDatabase();

describe('provisioning recovery', () => {
  it('restarts only open provisioning workflows that Temporal no longer knows about', async () => {
    const { db, admin } = database();
    const lost = await seedKycPhoneOrder(admin);
    const running = await seedKycPhoneOrder(admin);
    const settled = await seedKycPhoneOrder(admin);
    await admin.query(
      `UPDATE app.provisioning_workflows SET state = 'ACTIVE', completed_at = now() WHERE id = $1`,
      [settled.workflowRowId],
    );
    const failed = await seedKycPhoneOrder(admin);
    const orderOf = (workflowId: string): string => workflowId.slice('provisioning:'.length);
    await admin.query(`UPDATE app.checkout_orders SET stripe_invoice_id = $2 WHERE id = $1`, [
      orderOf(lost.temporalWorkflowId),
      'in_lost_1',
    ]);
    await admin.query(`UPDATE app.checkout_orders SET stripe_invoice_id = $2 WHERE id = $1`, [
      orderOf(running.temporalWorkflowId),
      'in_running_1',
    ]);
    const statuses = new Map([
      [running.temporalWorkflowId, 'RUNNING'],
      ['invoice:in_running_1', 'RUNNING'],
      [failed.temporalWorkflowId, 'FAILED'],
    ]);
    const client = {
      workflow: {
        getHandle: (workflowId: string) => ({
          describe: () => {
            const name = statuses.get(workflowId);
            return name === undefined
              ? Promise.reject(new WorkflowNotFoundError('not found', workflowId, undefined))
              : Promise.resolve({ workflowId, status: { name } });
          },
        }),
      },
    } as unknown as Pick<Client, 'workflow'>;
    const started: {
      workflowType: string;
      workflowId: string;
      args: readonly unknown[];
      allowAfterFailure: boolean | undefined;
    }[] = [];
    const gateway: WorkflowGateway = {
      start: (workflowType, options) => {
        started.push({
          workflowType,
          workflowId: options.workflowId,
          args: options.args,
          allowAfterFailure: options.allowAfterFailure,
        });
        return Promise.resolve('STARTED');
      },
      signal: () => Promise.resolve('NOT_FOUND'),
    };
    const logger = { info: () => undefined, warn: () => undefined };
    const recovery = { db, client, gateway, logger, restartedAfterFailure: new Set<string>() };

    await expect(recoverOrphanedProvisioning(recovery)).resolves.toBe(3);
    expect(started).toHaveLength(3);
    expect(started).toContainEqual({
      workflowType: 'provisioningWorkflow',
      workflowId: lost.temporalWorkflowId,
      args: [
        {
          tenantId: lost.tenantId,
          orderId: orderOf(lost.temporalWorkflowId),
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
        },
      ],
      allowAfterFailure: false,
    });
    expect(started.find((entry) => entry.workflowId === 'invoice:in_lost_1')).toMatchObject({
      workflowType: 'invoiceIssuanceWorkflow',
      args: [
        {
          tenantId: lost.tenantId,
          stripeInvoiceId: 'in_lost_1',
          orderId: orderOf(lost.temporalWorkflowId),
        },
      ],
      allowAfterFailure: false,
    });
    expect(started.find((entry) => entry.workflowId === failed.temporalWorkflowId)).toMatchObject({
      allowAfterFailure: true,
    });
    statuses.set(lost.temporalWorkflowId, 'RUNNING');
    statuses.set('invoice:in_lost_1', 'RUNNING');
    await expect(recoverOrphanedProvisioning(recovery)).resolves.toBe(0);
  });
});
