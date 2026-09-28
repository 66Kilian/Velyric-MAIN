import { createHash } from 'node:crypto';
import type { NotificationLocale } from '@velyric/notifications';
import {
  defaultCallerTemplate,
  renderCallerEmail,
  type CallerNotificationType,
} from '@velyric/notifications/caller';
import { ProviderCallError } from '../providers/errors.js';
import {
  createTenantEmailSender,
  tenantSmtpSettings,
  TenantEmailUnavailableError,
} from '../providers/tenant-email.js';
import type { NotifyInput, NotifyResult } from '../workflows/types.js';
import { createCallerSmsActivity } from './caller-sms.js';
import { inTenant, newId, nonRetryable, type ActivityDependencies } from './support.js';
import { maskEmail } from './notifications.js';

const LOCALES: readonly NotificationLocale[] = ['hu', 'de', 'en'];
const LOGO_CID = 'velyric-brand-logo';
const LOGO_FILENAMES: Readonly<Record<string, string>> = {
  'image/png': 'logo.png',
  'image/jpeg': 'logo.jpg',
  'image/webp': 'logo.webp',
  'image/svg+xml': 'logo.svg',
};

function localeOf(value: string | undefined, fallback: string): NotificationLocale {
  const candidates = [value, fallback];
  for (const candidate of candidates) {
    const match = LOCALES.find((locale) => locale === candidate);
    if (match !== undefined) {
      return match;
    }
  }
  return 'hu';
}

export function createCallerNotificationActivity(
  deps: ActivityDependencies,
): (input: NotifyInput, type: CallerNotificationType) => Promise<NotifyResult> {
  const sms = createCallerSmsActivity(deps);
  return async (input, type) => {
    if (input.channel === 'SMS') {
      return sms(input, type);
    }
    const recipient = input.payload['caller_email']?.trim().toLowerCase() ?? '';
    if (recipient === '' || !recipient.includes('@')) {
      deps.logger.warn({ tenant_id: input.tenantId, type }, 'caller notification has no email');
      return { status: 'SUPPRESSED' };
    }
    const prepared = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select(['display_name', 'default_locale'])
        .where('id', '=', input.tenantId)
        .executeTakeFirstOrThrow();
      const preference = await trx
        .selectFrom('notification_preferences')
        .select(['enabled'])
        .where('notification_type', '=', type)
        .where('channel', '=', 'EMAIL')
        .where('user_id', 'is', null)
        .executeTakeFirst();
      if (preference !== undefined && !preference.enabled) {
        return { suppressed: 'preference' as const };
      }
      const settings = await trx
        .selectFrom('tenant_messaging_settings')
        .select(['brand_color', 'brand_footer', 'brand_logo_bytes', 'brand_logo_content_type'])
        .executeTakeFirst();
      const locale = localeOf(input.payload['locale'], tenant.default_locale);
      const override = await trx
        .selectFrom('tenant_email_templates')
        .select(['subject', 'body'])
        .where('notification_type', '=', type)
        .where('locale', '=', locale)
        .executeTakeFirst();
      const integration = await trx
        .selectFrom('integrations')
        .leftJoin('tenant_secret_refs', 'tenant_secret_refs.id', 'integrations.secret_ref_id')
        .select([
          'integrations.config',
          'integrations.status',
          'tenant_secret_refs.secret_ref',
          'tenant_secret_refs.status as secret_status',
        ])
        .where('integrations.integration_type', '=', 'CUSTOM_SMTP')
        .executeTakeFirst();
      if (
        integration === undefined ||
        integration.status !== 'CONNECTED' ||
        integration.secret_ref === null ||
        integration.secret_status !== 'ACTIVE'
      ) {
        return { suppressed: 'sender_missing' as const };
      }
      const rendered = renderCallerEmail({
        type,
        locale,
        template: override ?? defaultCallerTemplate(type, locale),
        payload: { business_name: tenant.display_name, ...input.payload },
        branding: {
          businessName: tenant.display_name,
          logoUrl:
            settings === undefined || settings.brand_logo_bytes === null ? null : `cid:${LOGO_CID}`,
          color: settings?.brand_color ?? '#6D28D9',
          footer: settings?.brand_footer ?? null,
        },
        customized: override !== undefined,
      });
      const inserted = await trx
        .insertInto('notification_events')
        .values({
          id: newId(),
          tenant_id: input.tenantId,
          notification_type: type,
          channel: 'EMAIL',
          locale,
          destination_hash: createHash('sha256').update(recipient).digest(),
          destination_masked: maskEmail(recipient),
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
      return {
        eventId,
        rendered,
        alreadySent: delivered !== undefined,
        config: integration.config,
        secretRef: integration.secret_ref,
        logo:
          settings === undefined ||
          settings.brand_logo_bytes === null ||
          settings.brand_logo_content_type === null
            ? null
            : {
                bytes: Buffer.from(settings.brand_logo_bytes),
                contentType: settings.brand_logo_content_type,
              },
      };
    });
    if ('suppressed' in prepared) {
      deps.logger.warn(
        { tenant_id: input.tenantId, type, reason: prepared.suppressed },
        'caller notification suppressed',
      );
      return { status: 'SUPPRESSED' };
    }
    if (prepared.alreadySent) {
      return { status: 'ALREADY_SENT' };
    }

    const recordAttempt = async (
      status: 'SENT' | 'FAILED',
      fields: { messageId?: string; errorCode?: string },
    ): Promise<void> => {
      await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .insertInto('notification_attempts')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            notification_event_id: prepared.eventId,
            status,
            provider: 'smtp',
            ...(fields.messageId === undefined ? {} : { provider_message_id: fields.messageId }),
            ...(fields.errorCode === undefined
              ? {}
              : { error_code: fields.errorCode.slice(0, 100) }),
          })
          .execute(),
      );
    };

    let sender;
    try {
      const settings = tenantSmtpSettings(prepared.config);
      sender = await createTenantEmailSender(
        settings,
        { authMethod: settings.authMethod, secret: await deps.secrets.read(prepared.secretRef) },
        deps.tenantEmail,
      );
    } catch (error) {
      if (error instanceof TenantEmailUnavailableError) {
        await recordAttempt('FAILED', { errorCode: error.reason });
        deps.logger.warn(
          { tenant_id: input.tenantId, type, reason: error.reason },
          'tenant email sender unavailable',
        );
        return { status: 'SUPPRESSED' };
      }
      throw error;
    }
    try {
      const messageId = await sender.send({
        to: recipient,
        subject: prepared.rendered.subject,
        text: prepared.rendered.text,
        html: prepared.rendered.html,
        idempotencyKey: createHash('sha256')
          .update(`${input.tenantId}:${input.dedupeKey}`)
          .digest('hex'),
        tags: { notification_type: type, tenant_id: input.tenantId },
        ...(prepared.logo === null
          ? {}
          : {
              inlineImages: [
                {
                  cid: LOGO_CID,
                  filename: LOGO_FILENAMES[prepared.logo.contentType] ?? 'logo.png',
                  content: prepared.logo.bytes,
                  contentType: prepared.logo.contentType,
                },
              ],
            }),
      });
      await recordAttempt('SENT', { messageId });
      return { status: 'SENT' };
    } catch (error) {
      const code = error instanceof ProviderCallError ? error.code : 'send_failed';
      await recordAttempt('FAILED', { errorCode: code });
      if (error instanceof ProviderCallError && !error.retryable) {
        throw nonRetryable(`notification:${code}`, error.message);
      }
      throw error;
    } finally {
      sender.close();
    }
  };
}
