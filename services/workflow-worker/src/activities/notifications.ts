import { createHash } from 'node:crypto';
import {
  isTemplatedNotification,
  renderNotification,
  type NotificationLocale,
} from '@velyric/notifications';
import { isCallerNotificationType } from '@velyric/notifications/caller';
import { ProviderCallError } from '../providers/errors.js';
import { createCallerNotificationActivity } from './caller-notifications.js';
import type { NotifyInput, NotifyResult } from '../workflows/types.js';
import { inTenant, newId, nonRetryable, type ActivityDependencies } from './support.js';

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export function createNotificationActivity(
  deps: ActivityDependencies,
): (input: NotifyInput) => Promise<NotifyResult> {
  const callerNotification = createCallerNotificationActivity(deps);
  return async (input) => {
    if (isCallerNotificationType(input.type)) {
      return callerNotification(input, input.type);
    }
    if (!isTemplatedNotification(input.type)) {
      throw nonRetryable(
        'notification_type_unsupported',
        `notification type ${input.type} has no template`,
      );
    }
    const type = input.type;
    const prepared = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select(['default_locale'])
        .where('id', '=', input.tenantId)
        .executeTakeFirstOrThrow();
      const member =
        input.recipientMembershipId === undefined
          ? undefined
          : await trx
              .selectFrom('memberships')
              .leftJoin('users', 'users.id', 'memberships.user_id')
              .select(['memberships.status', 'memberships.invited_email', 'users.email'])
              .where('memberships.id', '=', input.recipientMembershipId)
              .executeTakeFirst();
      const memberEmail =
        member === undefined
          ? null
          : member.status === 'INVITED'
            ? member.invited_email
            : member.status === 'ACTIVE'
              ? member.email
              : null;
      if (input.recipientMembershipId !== undefined && memberEmail === null) {
        return null;
      }
      const profile =
        memberEmail !== null
          ? undefined
          : await trx
              .selectFrom('billing_profiles')
              .select(['billing_email'])
              .orderBy('created_at', 'desc')
              .limit(1)
              .executeTakeFirst();
      const owner =
        memberEmail !== null || profile !== undefined
          ? undefined
          : await trx
              .selectFrom('memberships')
              .innerJoin('users', 'users.id', 'memberships.user_id')
              .select(['users.email'])
              .where('memberships.role', '=', 'OWNER')
              .where('memberships.status', '=', 'ACTIVE')
              .orderBy('memberships.created_at')
              .limit(1)
              .executeTakeFirst();
      const recipient = memberEmail ?? profile?.billing_email ?? owner?.email ?? null;
      if (recipient === null) {
        return null;
      }
      const locale = tenant.default_locale as NotificationLocale;
      const payload = {
        billing_url: new URL(`/app/${input.tenantId}/billing`, deps.settings.webOrigin).toString(),
        action_url: new URL(`/app/${input.tenantId}/dashboard`, deps.settings.webOrigin).toString(),
        ...input.payload,
      };
      let rendered;
      try {
        rendered = renderNotification(type, locale, payload);
      } catch (error) {
        throw nonRetryable(
          'notification_payload_invalid',
          error instanceof Error ? error.message : 'invalid notification payload',
        );
      }
      const normalized = recipient.trim().toLowerCase();
      const inserted = await trx
        .insertInto('notification_events')
        .values({
          id: newId(),
          tenant_id: input.tenantId,
          notification_type: type,
          channel: 'EMAIL',
          locale,
          destination_hash: createHash('sha256').update(normalized).digest(),
          destination_masked: maskEmail(normalized),
          template_key: rendered.templateKey,
          template_version: rendered.templateVersion,
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
      return { eventId, recipient: normalized, rendered, alreadySent: delivered !== undefined };
    });
    if (prepared === null) {
      deps.logger.warn({ tenant_id: input.tenantId, type }, 'notification has no recipient');
      return { status: 'SUPPRESSED' };
    }
    if (prepared.alreadySent) {
      return { status: 'ALREADY_SENT' };
    }
    try {
      const messageId = await deps.email.send({
        to: prepared.recipient,
        subject: prepared.rendered.subject,
        text: prepared.rendered.text,
        html: prepared.rendered.html,
        idempotencyKey: createHash('sha256')
          .update(`${input.tenantId}:${input.dedupeKey}`)
          .digest('hex'),
        tags: { notification_type: type, tenant_id: input.tenantId },
      });
      await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .insertInto('notification_attempts')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            notification_event_id: prepared.eventId,
            status: 'SENT',
            provider: deps.email.provider,
            provider_message_id: messageId,
          })
          .execute(),
      );
      return { status: 'SENT' };
    } catch (error) {
      const code = error instanceof ProviderCallError ? error.code : 'send_failed';
      await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .insertInto('notification_attempts')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            notification_event_id: prepared.eventId,
            status: 'FAILED',
            provider: deps.email.provider,
            error_code: code.slice(0, 100),
          })
          .execute(),
      );
      if (error instanceof ProviderCallError && !error.retryable) {
        throw nonRetryable(`notification:${code}`, error.message);
      }
      throw error;
    }
  };
}
