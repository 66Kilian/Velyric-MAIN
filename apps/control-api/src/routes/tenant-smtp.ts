import {
  isEmailAddress,
  smtpSettingsIssues,
  tenantSmtpConfigJson,
  createTenantSmtpTransport,
  parseTenantSmtpConfig,
  verifyTenantSmtp,
  classifySmtpError,
  type SmtpCredential,
  type TenantSmtpSettings,
} from '@velyric/notifications/smtp';
import type { HostResolver } from '@velyric/security';
import type { TenantSecretReader, TenantSecretWriter } from '@velyric/tenant-secrets';
import Type from 'typebox';
import { idempotentWrite, inTenant, requestMeta, tenantContext, type RouteModule } from '../app.js';
import { requireFeature } from '../entitlements.js';
import { ApiError } from '../errors.js';
import { newId, writeAudit } from '../persistence.js';
import type { OAuthTokenClient } from '../integrations/oauth.js';
import { requireTenantActor } from '../principal.js';

export interface TenantSmtpRouteDependencies {
  readonly secrets: TenantSecretWriter & TenantSecretReader;
  readonly resolver: HostResolver;
  readonly tokenClient?: OAuthTokenClient;
  readonly onSecretCleanupFailure?: (secretRef: string, error: unknown) => void;
}

const PORT = Type.Integer({ minimum: 1, maximum: 65_535 });
const SECURITY = Type.Union([Type.Literal('TLS'), Type.Literal('STARTTLS'), Type.Literal('NONE')]);

const PutBody = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 255 }),
    port: PORT,
    security: SECURITY,
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 512 }),
    from_address: Type.String({ minLength: 3, maxLength: 255 }),
    from_name: Type.String({ minLength: 1, maxLength: 160 }),
    reply_to: Type.Optional(Type.String({ minLength: 3, maxLength: 255 })),
  },
  { additionalProperties: false },
);

function presentSmtpIntegration(row: {
  readonly id: string;
  readonly status: string;
  readonly config: unknown;
  readonly last_error_code: string | null;
  readonly last_health_check_at: Date | null;
  readonly updated_at: Date;
  readonly external_account_ref?: string | null;
}): Record<string, unknown> {
  const settings = parseTenantSmtpConfig(row.config);
  return {
    id: row.id,
    status: row.status,
    auth_method: settings?.authMethod ?? 'PASSWORD',
    account: row.external_account_ref ?? null,
    host: settings?.host ?? null,
    port: settings?.port ?? null,
    security: settings?.security ?? null,
    username: settings?.username ?? null,
    from_address: settings?.fromAddress ?? null,
    from_name: settings?.fromName ?? null,
    reply_to: settings?.replyTo ?? null,
    last_error_code: row.last_error_code,
    last_health_check_at: row.last_health_check_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

export function createTenantSmtpRoutes(deps: TenantSmtpRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/integrations/smtp', async (request) => {
      const actor = requireTenantActor(request.principal, 'integrations:read');
      const row = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('integrations')
          .select([
            'id',
            'status',
            'config',
            'last_error_code',
            'last_health_check_at',
            'updated_at',
            'external_account_ref',
          ])
          .where('integration_type', '=', 'CUSTOM_SMTP')
          .executeTakeFirst(),
      );
      if (row === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return presentSmtpIntegration(row);
    });

    app.put('/v1/integrations/smtp', { schema: { body: PutBody } }, async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'integrations:manage');
      const body = request.body;
      const settings: TenantSmtpSettings = {
        host: body.host.trim(),
        port: body.port,
        security: body.security,
        username: body.username,
        fromAddress: body.from_address.trim(),
        fromName: body.from_name.trim(),
        replyTo: body.reply_to?.trim() ?? null,
        authMethod: 'PASSWORD',
      };
      const issues = smtpSettingsIssues(settings, services.environment);
      if (issues.length > 0) {
        throw new ApiError('VALIDATION_FAILED', { issues });
      }
      try {
        await verifyTenantSmtp(
          settings,
          { kind: 'PASSWORD', password: body.password },
          {
            environment: services.environment,
            resolver: deps.resolver,
          },
        );
      } catch (error) {
        const classified = classifySmtpError(error);
        throw new ApiError('SMTP_VERIFICATION_FAILED', { reason: classified.code });
      }

      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'integrations.smtp.upsert',
        async (trx) => {
          await requireFeature(trx, 'custom_smtp', services.now());
          const existing = await trx
            .selectFrom('integrations')
            .select(['id', 'secret_ref_id', 'version'])
            .where('integration_type', '=', 'CUSTOM_SMTP')
            .executeTakeFirst();
          const integrationId = existing?.id ?? newId();
          const previousSecretRef =
            existing?.secret_ref_id === null || existing?.secret_ref_id === undefined
              ? null
              : await trx
                  .selectFrom('tenant_secret_refs')
                  .select(['secret_ref'])
                  .where('id', '=', existing.secret_ref_id)
                  .executeTakeFirst();
          const currentVersion = await trx
            .selectFrom('tenant_secret_refs')
            .select((eb) => eb.fn.max('secret_version').as('version'))
            .where('kind', '=', 'SMTP_PASSWORD')
            .where('provider', '=', 'smtp')
            .where('subject_id', '=', integrationId)
            .executeTakeFirst();
          const version = (currentVersion?.version ?? 0) + 1;
          const refId = newId();
          const secretRef = await deps.secrets.store({
            tenantId: actor.tenantId,
            kind: 'SMTP_PASSWORD',
            secretRefId: refId,
            version,
            value: body.password,
          });
          await trx
            .updateTable('tenant_secret_refs')
            .set({ status: 'REVOKED', revoked_at: new Date(), updated_at: new Date() })
            .where('kind', '=', 'SMTP_PASSWORD')
            .where('provider', '=', 'smtp')
            .where('subject_id', '=', integrationId)
            .where('status', '=', 'ACTIVE')
            .execute();
          await trx
            .insertInto('tenant_secret_refs')
            .values({
              id: refId,
              tenant_id: actor.tenantId,
              kind: 'SMTP_PASSWORD',
              provider: 'smtp',
              subject_id: integrationId,
              secret_ref: secretRef,
              secret_version: version,
              status: 'ACTIVE',
              activated_at: new Date(),
            })
            .execute();
          const now = new Date();
          const row =
            existing === undefined
              ? await trx
                  .insertInto('integrations')
                  .values({
                    id: integrationId,
                    tenant_id: actor.tenantId,
                    integration_type: 'CUSTOM_SMTP',
                    provider: 'smtp',
                    status: 'CONNECTED',
                    display_name: settings.fromName,
                    secret_ref_id: refId,
                    config: JSON.stringify(tenantSmtpConfigJson(settings)),
                    last_health_check_at: now,
                    connected_by_user_id: actor.userId ?? null,
                  })
                  .returning([
                    'id',
                    'status',
                    'config',
                    'last_error_code',
                    'last_health_check_at',
                    'updated_at',
                    'external_account_ref',
                  ])
                  .executeTakeFirstOrThrow()
              : await trx
                  .updateTable('integrations')
                  .set({
                    status: 'CONNECTED',
                    display_name: settings.fromName,
                    secret_ref_id: refId,
                    config: JSON.stringify(tenantSmtpConfigJson(settings)),
                    last_error_code: null,
                    last_health_check_at: now,
                    version: existing.version + 1,
                  })
                  .where('id', '=', existing.id)
                  .returning([
                    'id',
                    'status',
                    'config',
                    'last_error_code',
                    'last_health_check_at',
                    'updated_at',
                    'external_account_ref',
                  ])
                  .executeTakeFirstOrThrow();
          if (previousSecretRef !== undefined && previousSecretRef !== null) {
            const ref = previousSecretRef.secret_ref;
            deps.secrets
              .scheduleDeletion(ref)
              .catch((error: unknown) => deps.onSecretCleanupFailure?.(ref, error));
          }
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'integrations.smtp.upsert',
            objectType: 'integration',
            objectId: integrationId,
            diff: { host: settings.host, port: settings.port, security: settings.security },
          });
          return { status: existing === undefined ? 201 : 200, body: presentSmtpIntegration(row) };
        },
      );
    });

    app.delete('/v1/integrations/smtp', async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'integrations:manage');
      await inTenant(services, actor, request, async (trx) => {
        const existing = await trx
          .selectFrom('integrations')
          .select(['id', 'secret_ref_id'])
          .where('integration_type', '=', 'CUSTOM_SMTP')
          .executeTakeFirst();
        if (existing === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        await trx
          .updateTable('integrations')
          .set((eb) => ({
            status: 'DISCONNECTED',
            disconnected_at: new Date(),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', existing.id)
          .execute();
        if (existing.secret_ref_id !== null) {
          const secretRow = await trx
            .selectFrom('tenant_secret_refs')
            .select(['secret_ref'])
            .where('id', '=', existing.secret_ref_id)
            .executeTakeFirst();
          await trx
            .updateTable('tenant_secret_refs')
            .set({ status: 'REVOKED', revoked_at: new Date(), updated_at: new Date() })
            .where('id', '=', existing.secret_ref_id)
            .execute();
          if (secretRow !== undefined) {
            const ref = secretRow.secret_ref;
            deps.secrets
              .scheduleDeletion(ref)
              .catch((error: unknown) => deps.onSecretCleanupFailure?.(ref, error));
          }
        }
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'integrations.smtp.disconnect',
          objectType: 'integration',
          objectId: existing.id,
        });
      });
      return reply.status(204).send();
    });

    app.post('/v1/integrations/smtp/test', async (request) => {
      const actor = requireTenantActor(request.principal, 'integrations:manage');
      const loaded = await inTenant(services, actor, request, async (trx) => {
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
        const tenant = await trx
          .selectFrom('tenants')
          .select(['display_name'])
          .where('id', '=', actor.tenantId)
          .executeTakeFirstOrThrow();
        const recipient =
          actor.userId === undefined
            ? undefined
            : await trx
                .selectFrom('users')
                .select(['email'])
                .where('id', '=', actor.userId)
                .executeTakeFirst();
        return { integration, businessName: tenant.display_name, recipient: recipient?.email };
      });
      const settings = parseTenantSmtpConfig(loaded.integration?.config);
      if (
        loaded.integration === undefined ||
        loaded.integration.status !== 'CONNECTED' ||
        loaded.integration.secret_ref === null ||
        loaded.integration.secret_status !== 'ACTIVE' ||
        settings === null
      ) {
        throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'email_sender_not_connected' });
      }
      if (loaded.recipient === undefined) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/principal', rule: 'user_email_required' }],
        });
      }
      const stored = await deps.secrets.read(loaded.integration.secret_ref);
      let credential: SmtpCredential;
      if (settings.authMethod === 'GOOGLE_OAUTH') {
        const refreshToken = googleRefreshToken(stored);
        if (refreshToken === null || deps.tokenClient === undefined) {
          throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'google_credential_unusable' });
        }
        try {
          const refreshed = await deps.tokenClient.refresh('google', refreshToken);
          credential = { kind: 'OAUTH', accessToken: refreshed.accessToken };
        } catch {
          throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'google_authorization_expired' });
        }
      } else {
        credential = { kind: 'PASSWORD', password: stored };
      }
      const transport = await createTenantSmtpTransport(settings, credential, {
        environment: services.environment,
        resolver: deps.resolver,
      });
      try {
        await transport.sendMail({
          from: { name: settings.fromName, address: settings.fromAddress },
          to: loaded.recipient,
          subject: TEST_SUBJECT(loaded.businessName),
          text: TEST_BODY(loaded.businessName),
          ...(settings.replyTo === null ? {} : { replyTo: settings.replyTo }),
        });
      } catch (error) {
        const classified = classifySmtpError(error);
        throw new ApiError('SMTP_VERIFICATION_FAILED', { reason: classified.code });
      } finally {
        transport.close();
      }
      await inTenant(services, actor, request, (trx) =>
        writeAudit(trx, actor, requestMeta(request), {
          action: 'integrations.smtp.test_sent',
          objectType: 'integration',
          objectId: actor.tenantId,
        }),
      );
      return { sent_to: loaded.recipient };
    });
  };
}

function googleRefreshToken(stored: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const token = (parsed as Record<string, unknown>)['refresh_token'];
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

const TEST_SUBJECT = (business: string): string => `${business} – Velyric teszt e-mail`;
const TEST_BODY = (business: string): string =>
  [
    `Ez egy teszt e-mail a(z) ${business} saját e-mail rendszeréből.`,
    'Ha ezt megkapta, a vendégeknek küldött visszaigazolások is erről a címről fognak érkezni.',
    'Velyric',
  ].join('\n\n');

export { isEmailAddress };
