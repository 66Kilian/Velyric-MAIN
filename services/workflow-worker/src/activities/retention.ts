import type { RetentionClass } from '@velyric/contracts';
import { withTenantTransaction } from '@velyric/db';
import { retentionCutoff } from '@velyric/domain';
import { sql } from 'kysely';
import type {
  RetentionActivities,
  TenantRetentionInput,
  TenantRetentionResult,
} from '../workflows/types.js';
import type { ActivityDependencies } from './support.js';

type RetentionDependencies = Pick<ActivityDependencies, 'db' | 'now' | 'logger'>;

export const SWEPT_RETENTION_CLASSES: readonly RetentionClass[] = [
  'TRANSCRIPT',
  'CALL_EVENTS',
  'TOOL_PAYLOAD',
  'RAW_AUDIO',
  'CALLER_PROFILE',
];
const FINAL_DELIVERY_STATUSES = ['DELIVERED', 'FAILED', 'DEAD_LETTER'] as const;

export function createRetentionActivities(deps: RetentionDependencies): RetentionActivities {
  return {
    async listRetentionTenants(): Promise<readonly string[]> {
      const rows = await deps.db
        .selectFrom('tenant_directory')
        .select(['id'])
        .where('status', '<>', 'DELETED')
        .orderBy('id')
        .execute();
      return rows.map((row) => row.id);
    },

    async applyTenantRetention(input: TenantRetentionInput): Promise<TenantRetentionResult> {
      const now = deps.now();
      const context = {
        tenantId: input.tenantId,
        actorType: 'SYSTEM' as const,
        actorId: 'retention',
        traceId: input.traceId,
      };
      const policies = await withTenantTransaction(deps.db, context, (trx) =>
        trx.selectFrom('retention_policies').select(['retention_class', 'retain_days']).execute(),
      );
      const affected: Record<string, number> = {};
      for (const retentionClass of SWEPT_RETENTION_CLASSES) {
        const configured = policies.find(
          (policy) => policy.retention_class === retentionClass,
        )?.retain_days;
        const cutoff = retentionCutoff(retentionClass, configured, now);
        if (cutoff === null) {
          continue;
        }
        const result = await sql<{ affected: number }>`
          select app.apply_retention(${input.tenantId}::uuid, ${retentionClass}, ${cutoff}, ${input.jobRunId}::uuid) as affected`.execute(
          deps.db,
        );
        affected[retentionClass] = result.rows[0]?.affected ?? 0;
      }
      const deliveryCutoff = retentionCutoff('OPERATIONAL_LOG', null, now);
      if (deliveryCutoff !== null) {
        affected['WEBHOOK_DELIVERIES'] = await withTenantTransaction(
          deps.db,
          context,
          async (trx) =>
            Number(
              (
                await trx
                  .deleteFrom('webhook_deliveries')
                  .where('created_at', '<', deliveryCutoff)
                  .where('status', 'in', FINAL_DELIVERY_STATUSES)
                  .executeTakeFirst()
              ).numDeletedRows,
            ),
        );
      }
      deps.logger.info(
        { tenant_id: input.tenantId, job_run_id: input.jobRunId, ...affected },
        'tenant retention applied',
      );
      return { tenantId: input.tenantId, affected };
    },

    async applyPlatformRetention(input: { readonly jobRunId: string }): Promise<number> {
      const cutoff = retentionCutoff('RAW_PROVIDER_PAYLOAD', null, deps.now());
      if (cutoff === null) {
        return 0;
      }
      const result = await sql<{
        affected: number;
      }>`select app.apply_webhook_payload_retention(${cutoff}, ${input.jobRunId}::uuid) as affected`.execute(
        deps.db,
      );
      return result.rows[0]?.affected ?? 0;
    },
  };
}
