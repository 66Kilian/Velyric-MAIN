import { BUILT_IN_TOOLS } from '@velyric/contracts';
import { sql, type Transaction } from 'kysely';
import type { DB } from './schema.js';

export async function ensureBuiltInTools(trx: Transaction<DB>, tenantId: string): Promise<number> {
  let changed = 0;
  for (const tool of BUILT_IN_TOOLS) {
    const inputSchema = JSON.stringify(tool.inputSchema);
    const outputSchema = JSON.stringify(tool.outputSchema);
    const result = await trx
      .insertInto('tool_definitions')
      .values({
        tenant_id: tenantId,
        name: tool.name,
        description: tool.description,
        kind: 'BUILT_IN',
        input_schema: inputSchema,
        output_schema: outputSchema,
        side_effect_class: tool.sideEffectClass,
        confirmation_policy: tool.confirmationPolicy,
        idempotency_supported: tool.idempotencySupported,
        timeout_ms: tool.timeoutMs,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['tenant_id', 'name'])
          .doUpdateSet({
            description: tool.description,
            input_schema: inputSchema,
            output_schema: outputSchema,
            side_effect_class: tool.sideEffectClass,
            confirmation_policy: tool.confirmationPolicy,
            idempotency_supported: tool.idempotencySupported,
            timeout_ms: tool.timeoutMs,
            version: sql<number>`tool_definitions.version + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where('tool_definitions.kind', '=', 'BUILT_IN')
          .where((eb) =>
            eb.or([
              eb('tool_definitions.description', '<>', tool.description),
              eb(sql`tool_definitions.input_schema`, '<>', sql`${inputSchema}::jsonb`),
              eb(sql`tool_definitions.output_schema`, '<>', sql`${outputSchema}::jsonb`),
              eb('tool_definitions.side_effect_class', '<>', tool.sideEffectClass),
              eb('tool_definitions.confirmation_policy', '<>', tool.confirmationPolicy),
              eb('tool_definitions.timeout_ms', '<>', tool.timeoutMs),
            ]),
          ),
      )
      .executeTakeFirst();
    changed += Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
  return changed;
}
