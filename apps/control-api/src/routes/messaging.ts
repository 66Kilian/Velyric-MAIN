import {
  CALLER_NOTIFICATION_TYPES,
  callerPlaceholders,
  defaultCallerTemplate,
  isCallerNotificationType,
  renderCallerEmail,
  unknownPlaceholders,
  type CallerNotificationType,
} from '@velyric/notifications/caller';
import type { NotificationLocale } from '@velyric/notifications';
import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { requireFeature } from '../entitlements.js';
import { ApiError } from '../errors.js';
import { writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';

const LOCALES: readonly NotificationLocale[] = ['hu', 'de', 'en'];
const LOGO_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const LOGO_MAX_BYTES = 262_144;

const SettingsBody = Type.Object(
  {
    sms_enabled: Type.Boolean(),
    sms_sender_label: Type.Union([Type.String({ pattern: '^[A-Za-z0-9 ]{3,11}$' }), Type.Null()]),
    brand_color: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
    brand_footer: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const LogoBody = Type.Object(
  {
    content_type: Type.Union(Object.keys(LOGO_TYPES).map((value) => Type.Literal(value))),
    data_base64: Type.String({ minLength: 16, maxLength: 360_000 }),
  },
  { additionalProperties: false },
);

const TemplateParams = Type.Object(
  {
    type: Type.String({ pattern: '^CALLER_[A-Z_]{5,40}$' }),
    locale: Type.Union(LOCALES.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);

const TemplateBody = Type.Object(
  {
    subject: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);

const PreviewBody = Type.Object(
  {
    subject: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  },
  { additionalProperties: false },
);

interface SettingsRow {
  readonly sms_enabled: boolean;
  readonly sms_sender_label: string | null;
  readonly brand_color: string;
  readonly brand_footer: string | null;
  readonly brand_logo_bytes: Buffer | null;
  readonly brand_logo_content_type: string | null;
  readonly version: number;
}

const DEFAULT_SETTINGS: SettingsRow = {
  sms_enabled: false,
  sms_sender_label: null,
  brand_color: '#6D28D9',
  brand_footer: null,
  brand_logo_bytes: null,
  brand_logo_content_type: null,
  version: 0,
};

export function logoDataUrl(row: {
  readonly brand_logo_bytes: Buffer | null;
  readonly brand_logo_content_type: string | null;
}): string | null {
  return row.brand_logo_bytes === null || row.brand_logo_content_type === null
    ? null
    : `data:${row.brand_logo_content_type};base64,${row.brand_logo_bytes.toString('base64')}`;
}

function owner(actor: TenantActor): { readonly tenantId: string; readonly userId: string | null } {
  return { tenantId: actor.tenantId, userId: actor.userId ?? null };
}

async function readSettings(trx: Trx): Promise<SettingsRow> {
  const row = await trx
    .selectFrom('tenant_messaging_settings')
    .select([
      'sms_enabled',
      'sms_sender_label',
      'brand_color',
      'brand_footer',
      'brand_logo_bytes',
      'brand_logo_content_type',
      'version',
    ])
    .executeTakeFirst();
  return row ?? DEFAULT_SETTINGS;
}

function presentSettings(row: SettingsRow, logoDataUrl: string | null): Record<string, unknown> {
  return {
    sms_enabled: row.sms_enabled,
    sms_sender_label: row.sms_sender_label,
    brand_color: row.brand_color,
    brand_footer: row.brand_footer,
    brand_logo: logoDataUrl,
    version: row.version,
  };
}

function sampleValues(locale: NotificationLocale, business: string): Record<string, string> {
  const shared: Record<NotificationLocale, Record<string, string>> = {
    hu: {
      caller_name: 'Kovács Anna',
      service_name: 'Vacsora',
      booking_date: '2026. október 3., szombat',
      booking_time: '19:00',
      party_size: '4',
      previous_date: '2026. október 2., péntek',
      previous_time: '18:30',
      offer_expires_at: '2026. október 1., 12:00',
    },
    de: {
      caller_name: 'Anna Kovács',
      service_name: 'Abendessen',
      booking_date: 'Samstag, 3. Oktober 2026',
      booking_time: '19:00',
      party_size: '4',
      previous_date: 'Freitag, 2. Oktober 2026',
      previous_time: '18:30',
      offer_expires_at: '1. Oktober 2026, 12:00',
    },
    en: {
      caller_name: 'Anna Kovacs',
      service_name: 'Dinner',
      booking_date: 'Saturday, 3 October 2026',
      booking_time: '19:00',
      party_size: '4',
      previous_date: 'Friday, 2 October 2026',
      previous_time: '18:30',
      offer_expires_at: '1 October 2026, 12:00',
    },
  };
  return {
    ...shared[locale],
    business_name: business,
    location_name: business,
    location_address: '1052 Budapest, Váci utca 1.',
    business_phone: '+36 1 234 5678',
    booking_reference: 'VLY-4821',
  };
}

export function createMessagingRoutes(): RouteModule {
  return (app, services) => {
    app.get('/v1/messaging-settings', async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'workspace:read');
      const row = await inTenant(services, actor, request, readSettings);
      void reply.header('etag', weakEtag(row.version));
      return presentSettings(row, logoDataUrl(row));
    });

    app.put(
      '/v1/messaging-settings',
      { schema: { body: SettingsBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'notifications:manage');
        const body = request.body;
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          owner(actor),
          'messaging_settings.update',
          async (trx) => {
            const existing = await readSettings(trx);
            if (existing.version !== 0 && existing.version !== requireIfMatch(request)) {
              throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });
            }
            const row = await trx
              .insertInto('tenant_messaging_settings')
              .values({
                tenant_id: actor.tenantId,
                sms_enabled: body.sms_enabled,
                sms_sender_label: body.sms_sender_label,
                brand_color: body.brand_color.toUpperCase(),
                brand_footer: body.brand_footer,
              })
              .onConflict((conflict) =>
                conflict.column('tenant_id').doUpdateSet((eb) => ({
                  sms_enabled: body.sms_enabled,
                  sms_sender_label: body.sms_sender_label,
                  brand_color: body.brand_color.toUpperCase(),
                  brand_footer: body.brand_footer,
                  updated_at: new Date(),
                  version: eb('tenant_messaging_settings.version', '+', 1),
                })),
              )
              .returning([
                'sms_enabled',
                'sms_sender_label',
                'brand_color',
                'brand_footer',
                'brand_logo_bytes',
                'brand_logo_content_type',
                'version',
              ])
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'messaging.settings_updated',
              objectType: 'tenant',
              objectId: actor.tenantId,
              diff: { sms_enabled: body.sms_enabled, brand_color: row.brand_color },
            });
            return {
              status: 200,
              body: presentSettings(row, logoDataUrl(row)),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.put('/v1/messaging-settings/logo', { schema: { body: LogoBody } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'notifications:manage');
      const body = request.body;
      const bytes = Buffer.from(body.data_base64, 'base64');
      if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/data_base64', rule: 'size' }],
        });
      }
      const row = await inTenant(services, actor, request, async (trx) => {
        const updated = await trx
          .insertInto('tenant_messaging_settings')
          .values({
            tenant_id: actor.tenantId,
            brand_logo_bytes: bytes,
            brand_logo_content_type: body.content_type,
            brand_logo_uploaded_at: new Date(),
          })
          .onConflict((conflict) =>
            conflict.column('tenant_id').doUpdateSet((eb) => ({
              brand_logo_bytes: bytes,
              brand_logo_content_type: body.content_type,
              brand_logo_uploaded_at: new Date(),
              updated_at: new Date(),
              version: eb('tenant_messaging_settings.version', '+', 1),
            })),
          )
          .returning([
            'sms_enabled',
            'sms_sender_label',
            'brand_color',
            'brand_footer',
            'brand_logo_bytes',
            'brand_logo_content_type',
            'version',
          ])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'messaging.logo_updated',
          objectType: 'tenant',
          objectId: actor.tenantId,
          diff: { content_type: body.content_type, bytes: bytes.length },
        });
        return updated;
      });
      return presentSettings(row, logoDataUrl(row));
    });

    app.delete('/v1/messaging-settings/logo', async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'notifications:manage');
      await inTenant(services, actor, request, async (trx) => {
        const updated = await trx
          .updateTable('tenant_messaging_settings')
          .set((eb) => ({
            brand_logo_bytes: null,
            brand_logo_content_type: null,
            brand_logo_uploaded_at: null,
            updated_at: new Date(),
            version: eb('version', '+', 1),
          }))
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) {
          throw new ApiError('NOT_FOUND');
        }
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'messaging.logo_removed',
          objectType: 'tenant',
          objectId: actor.tenantId,
        });
      });
      return reply.status(204).send();
    });

    app.get('/v1/email-templates', async (request) => {
      const actor = requireTenantActor(request.principal, 'workspace:read');
      const rows = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('tenant_email_templates')
          .select(['notification_type', 'locale', 'subject', 'body', 'version', 'updated_at'])
          .execute(),
      );
      const overrides = new Map(
        rows.map((row) => [`${row.notification_type}:${row.locale}`, row] as const),
      );
      return {
        data: CALLER_NOTIFICATION_TYPES.flatMap((type) =>
          LOCALES.map((locale) => {
            const override = overrides.get(`${type}:${locale}`);
            const fallback = defaultCallerTemplate(type, locale);
            return {
              notification_type: type,
              locale,
              subject: override?.subject ?? fallback.subject,
              body: override?.body ?? fallback.body,
              default_subject: fallback.subject,
              default_body: fallback.body,
              customized: override !== undefined,
              placeholders: callerPlaceholders(type),
              version: override?.version ?? 0,
              updated_at: override?.updated_at.toISOString() ?? null,
            };
          }),
        ),
      };
    });

    const templateTarget = (
      params: Readonly<{ type: string; locale: NotificationLocale }>,
    ): { type: CallerNotificationType; locale: NotificationLocale } => {
      if (!isCallerNotificationType(params.type)) {
        throw new ApiError('NOT_FOUND');
      }
      return { type: params.type, locale: params.locale };
    };

    app.put(
      '/v1/email-templates/:type/:locale',
      { schema: { params: TemplateParams, body: TemplateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'notifications:manage');
        const target = templateTarget(request.params);
        const body = request.body;
        const unknown = unknownPlaceholders(target.type, body.subject, body.body);
        if (unknown.length > 0) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: unknown.map((key) => ({ path: '/body', rule: `unknown_placeholder:${key}` })),
          });
        }
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          owner(actor),
          'email_templates.update',
          async (trx) => {
            await requireFeature(trx, 'transactional_email', services.now());
            const row = await trx
              .insertInto('tenant_email_templates')
              .values({
                tenant_id: actor.tenantId,
                notification_type: target.type,
                locale: target.locale,
                subject: body.subject,
                body: body.body,
                updated_by_user_id: actor.userId ?? null,
              })
              .onConflict((conflict) =>
                conflict
                  .columns(['tenant_id', 'notification_type', 'locale'])
                  .doUpdateSet((eb) => ({
                    subject: body.subject,
                    body: body.body,
                    updated_by_user_id: actor.userId ?? null,
                    updated_at: new Date(),
                    version: eb('tenant_email_templates.version', '+', 1),
                  })),
              )
              .returning(['subject', 'body', 'version', 'updated_at'])
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'messaging.template_updated',
              objectType: 'tenant',
              objectId: actor.tenantId,
              diff: { notification_type: target.type, locale: target.locale },
            });
            return {
              status: 200,
              body: {
                notification_type: target.type,
                locale: target.locale,
                subject: row.subject,
                body: row.body,
                customized: true,
                version: row.version,
                updated_at: row.updated_at.toISOString(),
              },
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.delete(
      '/v1/email-templates/:type/:locale',
      { schema: { params: TemplateParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'notifications:manage');
        const target = templateTarget(request.params);
        await inTenant(services, actor, request, async (trx) => {
          const deleted = await trx
            .deleteFrom('tenant_email_templates')
            .where('notification_type', '=', target.type)
            .where('locale', '=', target.locale)
            .executeTakeFirst();
          if (deleted.numDeletedRows === 0n) {
            throw new ApiError('NOT_FOUND');
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'messaging.template_reset',
            objectType: 'tenant',
            objectId: actor.tenantId,
            diff: { notification_type: target.type, locale: target.locale },
          });
        });
        return reply.status(204).send();
      },
    );

    app.post(
      '/v1/email-templates/:type/:locale/preview',
      { schema: { params: TemplateParams, body: PreviewBody } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'workspace:read');
        const target = templateTarget(request.params);
        const draft = request.body as { subject?: string; body?: string } | undefined;
        const prepared = await inTenant(services, actor, request, async (trx) => {
          const tenant = await trx
            .selectFrom('tenants')
            .select(['display_name'])
            .where('id', '=', actor.tenantId)
            .executeTakeFirstOrThrow();
          const stored = await trx
            .selectFrom('tenant_email_templates')
            .select(['subject', 'body'])
            .where('notification_type', '=', target.type)
            .where('locale', '=', target.locale)
            .executeTakeFirst();
          return { tenant, stored, settings: await readSettings(trx) };
        });
        const fallback = defaultCallerTemplate(target.type, target.locale);
        const subject = draft?.subject ?? prepared.stored?.subject ?? fallback.subject;
        const body = draft?.body ?? prepared.stored?.body ?? fallback.body;
        const unknown = unknownPlaceholders(target.type, subject, body);
        if (unknown.length > 0) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: unknown.map((key) => ({ path: '/body', rule: `unknown_placeholder:${key}` })),
          });
        }
        const rendered = renderCallerEmail({
          type: target.type,
          locale: target.locale,
          template: { subject, body },
          payload: sampleValues(target.locale, prepared.tenant.display_name),
          branding: {
            businessName: prepared.tenant.display_name,
            logoUrl: logoDataUrl(prepared.settings),
            color: prepared.settings.brand_color,
            footer: prepared.settings.brand_footer,
          },
          customized: prepared.stored !== undefined,
        });
        return { subject: rendered.subject, text: rendered.text, html: rendered.html };
      },
    );
  };
}
