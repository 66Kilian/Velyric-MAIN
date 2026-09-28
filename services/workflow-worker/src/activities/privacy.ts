import { withTenantTransaction } from '@velyric/db';
import { sql } from 'kysely';
import type { ErasureInput, ErasureResult, PrivacyActivities } from '../workflows/types.js';
import type { ActivityDependencies } from './support.js';

type PrivacyDependencies = Pick<ActivityDependencies, 'db' | 'now' | 'logger'>;

export function createPrivacyActivities(deps: PrivacyDependencies): PrivacyActivities {
  return {
    async eraseCallerData(input: ErasureInput): Promise<ErasureResult> {
      const context = {
        tenantId: input.tenantId,
        actorType: 'SERVICE' as const,
        actorId: 'workflow-worker',
        traceId: input.traceId,
      };
      return withTenantTransaction(deps.db, context, async (trx) => {
        const request = await trx
          .selectFrom('dsar_requests')
          .select(['id', 'person_id', 'request_type', 'status', 'version'])
          .where('id', '=', input.requestId)
          .forUpdate()
          .executeTakeFirst();
        if (request === undefined || request.request_type !== 'DELETE') {
          return { outcome: 'NOT_APPLICABLE', affected: {} };
        }
        if (request.status !== 'IN_PROGRESS') {
          return {
            outcome: request.status === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'NOT_APPLICABLE',
            affected: {},
          };
        }
        const now = deps.now();
        if (request.person_id === null) {
          await trx
            .updateTable('dsar_requests')
            .set({
              status: 'COMPLETED',
              completed_at: now,
              version: request.version + 1,
              updated_at: now,
            })
            .where('id', '=', request.id)
            .execute();
          return { outcome: 'COMPLETED', affected: {} };
        }
        const personId = request.person_id;
        const hold = await trx
          .selectFrom('legal_holds')
          .select(['id'])
          .where('released_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('scope_type', '=', 'TENANT'),
              eb.and([eb('scope_type', '=', 'PERSON'), eb('scope_ref', '=', personId)]),
            ]),
          )
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst();
        if (hold !== undefined) {
          await trx
            .updateTable('dsar_requests')
            .set({
              status: 'ON_LEGAL_HOLD',
              legal_hold_id: hold.id,
              version: request.version + 1,
              updated_at: now,
            })
            .where('id', '=', request.id)
            .execute();
          return { outcome: 'ON_LEGAL_HOLD', affected: {} };
        }

        const lineage = await sql<{ id: string }>`
          WITH RECURSIVE merged(id, depth) AS (
            SELECT ${personId}::uuid, 0
            UNION ALL
            SELECT p.id, merged.depth + 1 FROM app.caller_profiles p JOIN merged ON p.merged_into_profile_id = merged.id WHERE merged.depth < 16
          )
          SELECT DISTINCT id FROM merged`.execute(trx);
        const people = lineage.rows.map((row) => row.id);
        const heldCalls = trx
          .selectFrom('legal_holds')
          .select('scope_ref')
          .where('scope_type', '=', 'CALL')
          .where('released_at', 'is', null)
          .where('scope_ref', 'is not', null);
        const calls = await trx
          .selectFrom('calls')
          .select(['id'])
          .where('person_id', 'in', people)
          .where((eb) =>
            eb(
              'id',
              'not in',
              eb.selectFrom(heldCalls.as('held')).select('held.scope_ref').$castTo<string>(),
            ),
          )
          .execute();
        const callIds = calls.map((call) => call.id);

        const transcripts =
          callIds.length === 0
            ? 0
            : Number(
                (
                  await trx
                    .updateTable('transcript_segments')
                    .set({ content: '', redaction_state: 'PURGED', updated_at: now })
                    .where('call_id', 'in', callIds)
                    .where('redaction_state', '<>', 'PURGED')
                    .executeTakeFirst()
                ).numUpdatedRows,
              );
        if (callIds.length > 0) {
          await trx
            .updateTable('calls')
            .set({
              summary: null,
              summary_redaction_state: 'PURGED',
              caller_e164: null,
              updated_at: now,
            })
            .where('id', 'in', callIds)
            .execute();
          await trx
            .updateTable('call_recordings')
            .set({ deleted_at: now })
            .where('call_id', 'in', callIds)
            .where('deleted_at', 'is', null)
            .execute();
          await trx
            .updateTable('tool_runs')
            .set({ response_meta: JSON.stringify({}) })
            .where('call_id', 'in', callIds)
            .execute();
        }
        const bookings = Number(
          (
            await trx
              .updateTable('bookings')
              .set({ customer_note: null, updated_at: now })
              .where('person_id', 'in', people)
              .where('customer_note', 'is not', null)
              .executeTakeFirst()
          ).numUpdatedRows,
        );
        const waitlist = Number(
          (
            await trx
              .updateTable('waitlist_entries')
              .set((eb) => ({
                status: 'CANCELED',
                version: eb('version', '+', 1),
                updated_at: now,
              }))
              .where('person_id', 'in', people)
              .where('status', 'in', ['ACTIVE', 'OFFERED', 'ACCEPTED', 'DECLINED'])
              .executeTakeFirst()
          ).numUpdatedRows,
        );
        const identities = Number(
          (
            await trx
              .deleteFrom('person_identities')
              .where('person_id', 'in', people)
              .executeTakeFirst()
          ).numDeletedRows,
        );
        await trx
          .updateTable('caller_profiles')
          .set((eb) => ({
            display_name: null,
            display_name_verification: null,
            preferred_language: null,
            preferred_language_source: null,
            memory_enabled: false,
            shared_phone_suspected: false,
            trust_level: 'UNVERIFIED',
            version: eb('version', '+', 1),
            updated_at: now,
          }))
          .where('id', 'in', people)
          .execute();
        await trx
          .updateTable('dsar_requests')
          .set({
            status: 'COMPLETED',
            completed_at: now,
            version: request.version + 1,
            updated_at: now,
          })
          .where('id', '=', request.id)
          .execute();
        const held = await trx
          .selectFrom('calls')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('person_id', 'in', people)
          .executeTakeFirstOrThrow();
        const affected = {
          profiles: people.length,
          calls: callIds.length,
          transcripts,
          bookings,
          waitlist,
          identities,
          held_calls: Number(held.count) - callIds.length,
        };
        await trx
          .insertInto('audit_logs')
          .values({
            tenant_id: input.tenantId,
            actor_type: 'SYSTEM',
            actor_id: 'workflow-worker',
            action: 'privacy_request.erasure_completed',
            object_type: 'dsar_request',
            object_id: request.id,
            metadata: JSON.stringify(affected),
            trace_id: input.traceId,
          })
          .execute();
        deps.logger.info(
          { tenant_id: input.tenantId, request_id: request.id, ...affected },
          'caller data erased',
        );
        return { outcome: 'COMPLETED', affected };
      });
    },
  };
}
