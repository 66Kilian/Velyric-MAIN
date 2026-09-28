import { createHash } from 'node:crypto';
import type { NotificationLocale } from '@velyric/notifications';
import { renderCallerSms, type CallerNotificationType } from '@velyric/notifications/caller';
import { sql } from 'kysely';
import { ProviderCallError } from '../providers/errors.js';
import type { NotifyInput, NotifyResult } from '../workflows/types.js';
import { inTenant, newId, nonRetryable, type ActivityDependencies } from './support.js';

const LOCALES: readonly NotificationLocale[] = ['hu', 'de', 'en'];
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)}${'*'.repeat(Math.max(3, e164.length - 6))}${e164.slice(-3)}`;
}

export function createCallerSmsActivity(
  deps: ActivityDependencies,
): (input: NotifyInput, type: CallerNotificationType) => Promise<NotifyResult> {
  return async (input, type) => {
    const recipient = input.payload['caller_phone']?.replace(/[\s().-]/g, '') ?? '';
    if (!E164.test(recipient)) {
      deps.logger.warn({ tenant_id: input.tenantId, type }, 'caller SMS has no valid number');
      return { status: 'SUPPRESSED' };
    }
    const prepared = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select(['display_name', 'default_locale'])
        .where('id', '=', input.tenantId)
        .executeTakeFirstOrThrow();
      const settings = await trx
        .selectFrom('tenant_messaging_settings')
        .select(['sms_enabled'])
        .executeTakeFirst();
      if (settings?.sms_enabled !== true) {
        return { suppressed: 'sms_disabled' as const };
      }
      const preference = await trx
        .selectFrom('notification_preferences')
        .select(['enabled'])
        .where('notification_type', '=', type)
        .where('channel', '=', 'SMS')
        .where('user_id', 'is', null)
        .executeTakeFirst();
      if (preference !== undefined && !preference.enabled) {
        return { suppressed: 'preference' as const };
      }
      const requestedSender = input.payload['sms_from'];
      const sender = await trx
        .selectFrom('phone_numbers')
        .select(['e164'])
        .where('status', '=', 'ACTIVE')
        .$if(requestedSender !== undefined, (query) =>
          query.where('e164', '=', requestedSender ?? ''),
        )
        .orderBy(sql`case when location_id is null then 0 else 1 end`)
        .orderBy('created_at')
        .executeTakeFirst();
      if (sender === undefined) {
        return { suppressed: 'sender_number_missing' as const };
      }
      const requested = input.payload['locale'];
      const locale =
        LOCALES.find((entry) => entry === requested) ??
        LOCALES.find((entry) => entry === tenant.default_locale) ??
        'hu';
      const text = renderCallerSms(type, locale, {
        business_name: tenant.display_name,
        ...input.payload,
      });
      const inserted = await trx
        .insertInto('notification_events')
        .values({
          id: newId(),
          tenant_id: input.tenantId,
          notification_type: type,
          channel: 'SMS',
          locale,
          destination_hash: createHash('sha256').update(recipient).digest(),
          destination_masked: maskPhone(recipient),
          template_key: `${type.toLowerCase()}.${locale}.sms`,
          template_version: 'sms-1',
          payload: JSON.stringify(input.payload),
          dedupe_key: input.dedupeKey,
          trace_id: input.traceId,
        })
        .onConflict((conflict) => conflict.columns(['tenant_id', 'dedupe_key']).doNothing())
        .returning(['id'])
        .executeTakeFirst();
      const eventId =
        inserted?.id ??
        (
          await trx
            .selectFrom('notification_events')
            .select(['id'])
            .where('dedupe_key', '=', input.dedupeKey)
            .executeTakeFirstOrThrow()
        ).id;
      const delivered = await trx
        .selectFrom('notification_attempts')
        .select(['id'])
        .where('notification_event_id', '=', eventId)
        .where('status', 'in', ['SENT', 'DELIVERED'])
        .executeTakeFirst();
      return { eventId, text, from: sender.e164, alreadySent: delivered !== undefined };
    });
    if ('suppressed' in prepared) {
      deps.logger.warn(
        { tenant_id: input.tenantId, type, reason: prepared.suppressed },
        'caller SMS suppressed',
      );
      return { status: 'SUPPRESSED' };
    }
    if (prepared.alreadySent) {
      return { status: 'ALREADY_SENT' };
    }
    const record = (status: 'SENT' | 'FAILED', extra: Record<string, string>) =>
      inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .insertInto('notification_attempts')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            notification_event_id: prepared.eventId,
            status,
            provider: 'telnyx',
            ...extra,
          })
          .execute(),
      );
    try {
      const messageId = await deps.carrier.sendSms(prepared.from, recipient, prepared.text);
      await record('SENT', { provider_message_id: messageId });
      return { status: 'SENT' };
    } catch (error) {
      const code = error instanceof ProviderCallError ? error.code : 'send_failed';
      await record('FAILED', { error_code: code.slice(0, 100) });
      if (error instanceof ProviderCallError && (!error.retryable || error.outcomeUnknown)) {
        throw nonRetryable(`notification:${code}`, error.message);
      }
      throw error;
    }
  };
}
