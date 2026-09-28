import { ROLE_PERMISSIONS } from '@velyric/contracts';
import { googleOauthSettings, tenantSmtpConfigJson } from '@velyric/notifications/smtp';
import { withTenantTransaction, type Integrations } from '@velyric/db';
import { createPkcePair, sha256Hex, signState, verifyState } from '@velyric/security';
import { sql, type Selectable } from 'kysely';
import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import { CalendarListError, type CalendarLister } from '../integrations/calendar-list.js';
import {
  buildAuthorizeUrl,
  endpointsForIntegration,
  INTEGRATION_PROVIDER,
  OAuthExchangeError,
  sealVerifier,
  unsealVerifier,
  type OAuthEndpoints,
  type OAuthIntegrationType,
  type OAuthProvider,
  type OAuthTokenClient,
} from '../integrations/oauth.js';
import type { TenantSecretReader, TenantSecretWriter } from '@velyric/tenant-secrets';
import { buildPage, newId, readCursor, writeAudit } from '../persistence.js';
import { requireTenantActor, requireUser, type TenantActor } from '../principal.js';
import { IdParams, iso, limitFromQuery, Uuid } from './common.js';

export interface IntegrationRouteDependencies {
  readonly tokenClient: OAuthTokenClient;
  readonly secrets: TenantSecretWriter & TenantSecretReader;
  readonly providers: Readonly<
    Record<
      OAuthProvider,
      { readonly endpoints: OAuthEndpoints; readonly clientId: string; readonly apiBaseUrl: string }
    >
  >;
  readonly calendarLister: CalendarLister;
  readonly publicApiOrigin: string;
  readonly webOrigin: string;
  readonly onSecretCleanupFailure?: (secretRef: string, error: unknown) => void;
}

const AUTHORIZATION_TTL_SECONDS = 600;
const LIVE_STATUSES = ['CONNECTED', 'DEGRADED', 'AUTH_EXPIRED'] as const;

const ListQuery = Type.Object(
  {
    integration_type: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,40}$' })),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

const StartAuthorizationBody = Type.Object(
  {
    integration_type: Type.Union([
      Type.Literal('GOOGLE_CALENDAR'),
      Type.Literal('MICROSOFT_365'),
      Type.Literal('CUSTOM_SMTP'),
    ]),
    integration_id: Type.Optional(Uuid),
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    location_id: Type.Optional(Uuid),
    return_to: Type.Optional(Type.Literal('setup')),
  },
  { additionalProperties: false },
);

const CallbackQuery = Type.Object(
  {
    state: Type.String({ minLength: 20, maxLength: 2048 }),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    error_description: Type.Optional(Type.String({ maxLength: 2000 })),
    scope: Type.Optional(Type.String({ maxLength: 4096 })),
    session_state: Type.Optional(Type.String({ maxLength: 512 })),
    iss: Type.Optional(Type.String({ maxLength: 512 })),
    authuser: Type.Optional(Type.String({ maxLength: 16 })),
    hd: Type.Optional(Type.String({ maxLength: 255 })),
    prompt: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

export function presentIntegration(row: Selectable<Integrations>): Record<string, unknown> {
  return {
    id: row.id,
    integration_type: row.integration_type,
    provider: row.provider,
    display_name: row.display_name,
    status: row.status,
    location_id: row.location_id,
    granted_scopes: row.granted_scopes,
    external_account_ref: row.external_account_ref,
    last_error_code: row.last_error_code,
    last_health_check_at: iso(row.last_health_check_at),
    disconnected_at: iso(row.disconnected_at),
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const DISPLAY_NAMES: Readonly<Record<OAuthIntegrationType, string>> = {
  GOOGLE_CALENDAR: 'Google Calendar',
  MICROSOFT_365: 'Microsoft 365',
  CUSTOM_SMTP: 'Gmail',
};

function defaultDisplayName(integrationType: OAuthIntegrationType): string {
  return DISPLAY_NAMES[integrationType];
}

function safeErrorCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64);
  return normalized === '' ? 'authorization_failed' : normalized;
}

export function createIntegrationRoutes(deps: IntegrationRouteDependencies): RouteModule {
  const redirectUri = `${deps.publicApiOrigin.replace(/\/$/, '')}/v1/integrations/oauth/callback`;
  const webRedirect = (
    tenantId: string,
    integrationId: string | null,
    status: string,
    errorCode?: string,
    returnTo?: unknown,
  ): string => {
    const url = new URL(
      returnTo === 'setup' ? `/app/setup/${tenantId}` : `/app/${tenantId}/integrations`,
      deps.webOrigin,
    );
    if (returnTo === 'setup') {
      url.searchParams.set('step', 'bookings');
    }
    if (integrationId !== null) {
      url.searchParams.set('integration_id', integrationId);
    }
    url.searchParams.set('status', status);
    if (errorCode !== undefined) {
      url.searchParams.set('error', errorCode);
    }
    return url.toString();
  };
  const cleanup = (secretRef: string): void => {
    deps.secrets
      .scheduleDeletion(secretRef)
      .catch((error: unknown) => deps.onSecretCleanupFailure?.(secretRef, error));
  };

  return (app, services) => {
    app.get('/v1/integrations', { schema: { querystring: ListQuery } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'integrations:read');
      const limit = limitFromQuery(request.query.limit);
      const cursor = readCursor(request.query.cursor, services.cursorKey);
      const rows = await inTenant(services, actor, request, (trx) => {
        let query = trx
          .selectFrom('integrations')
          .selectAll()
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1);
        if (request.query.integration_type !== undefined) {
          query = query.where('integration_type', '=', request.query.integration_type);
        }
        if (cursor !== null) {
          query = query.where((eb) =>
            eb(
              eb.refTuple('created_at', 'id'),
              '<',
              eb.tuple(new Date(String(cursor.k[0])), cursor.id),
            ),
          );
        }
        return query.execute();
      });
      return buildPage(
        rows,
        limit,
        services.cursorKey,
        (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
        presentIntegration,
      );
    });

    app.get('/v1/integrations/:id', { schema: { params: IdParams } }, async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'integrations:read');
      const row = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('integrations')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (row === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return reply.header('etag', weakEtag(row.version)).send(presentIntegration(row));
    });

    app.get('/v1/integrations/:id/calendars', { schema: { params: IdParams } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'integrations:read');
      const row = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('integrations')
          .leftJoin('tenant_secret_refs', 'tenant_secret_refs.id', 'integrations.secret_ref_id')
          .select([
            'integrations.integration_type',
            'integrations.status',
            'tenant_secret_refs.secret_ref',
            'tenant_secret_refs.status as secret_status',
          ])
          .where('integrations.id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (
        row === undefined ||
        (row.integration_type !== 'GOOGLE_CALENDAR' && row.integration_type !== 'MICROSOFT_365')
      ) {
        throw new ApiError('NOT_FOUND');
      }
      if (
        (row.status !== 'CONNECTED' && row.status !== 'DEGRADED') ||
        row.secret_ref === null ||
        row.secret_status !== 'ACTIVE'
      ) {
        throw new ApiError('INTEGRATION_AUTH_EXPIRED');
      }
      const provider = INTEGRATION_PROVIDER[row.integration_type];
      let refreshToken: string;
      try {
        const stored = await deps.secrets.read(row.secret_ref);
        const parsed = JSON.parse(stored) as Record<string, unknown>;
        const value = parsed['refresh_token'];
        if (typeof value !== 'string' || value === '') {
          throw new Error('no refresh token');
        }
        refreshToken = value;
      } catch {
        throw new ApiError('INTEGRATION_AUTH_EXPIRED');
      }
      try {
        const { accessToken } = await deps.tokenClient.refresh(provider, refreshToken);
        const calendars = await deps.calendarLister.list(
          provider,
          deps.providers[provider].apiBaseUrl,
          accessToken,
        );
        return {
          data: calendars.map((calendar) => ({
            id: calendar.id,
            name: calendar.name,
            primary: calendar.primary,
          })),
        };
      } catch (error) {
        if (
          error instanceof OAuthExchangeError ||
          (error instanceof CalendarListError && error.code === 'auth_expired')
        ) {
          throw new ApiError('INTEGRATION_AUTH_EXPIRED');
        }
        if (error instanceof CalendarListError) {
          throw new ApiError('PROVIDER_UNAVAILABLE');
        }
        throw error;
      }
    });

    app.post(
      '/v1/integrations/oauth/authorizations',
      { schema: { body: StartAuthorizationBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const body = request.body;
        const actor = requireTenantActor(
          request.principal,
          'integrations:manage',
          body.location_id,
        );
        const provider = INTEGRATION_PROVIDER[body.integration_type];
        const providerConfig = deps.providers[provider];
        const endpoints = endpointsForIntegration(body.integration_type, providerConfig.endpoints);
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'integrations.oauth.start',
          async (trx) => {
            if (body.location_id !== undefined) {
              const location = await trx
                .selectFrom('locations')
                .select(['id'])
                .where('id', '=', body.location_id)
                .executeTakeFirst();
              if (location === undefined) {
                throw new ApiError('VALIDATION_FAILED', {
                  issues: [{ path: '/body/location_id', rule: 'exists' }],
                });
              }
            }
            let integration: Selectable<Integrations> | undefined;
            if (body.integration_id !== undefined) {
              integration = await trx
                .selectFrom('integrations')
                .selectAll()
                .where('id', '=', body.integration_id)
                .forUpdate()
                .executeTakeFirst();
              if (integration === undefined) {
                throw new ApiError('NOT_FOUND');
              }
              if (integration.integration_type !== body.integration_type) {
                throw new ApiError('VALIDATION_FAILED', {
                  issues: [{ path: '/body/integration_type', rule: 'matches_integration' }],
                });
              }
            } else {
              const existing = await trx
                .selectFrom('integrations')
                .selectAll()
                .where('integration_type', '=', body.integration_type)
                .where('status', 'in', [...LIVE_STATUSES, 'PENDING_AUTHORIZATION', 'ERROR'])
                .orderBy('created_at', 'desc')
                .forUpdate()
                .execute();
              const live = existing.find((row) =>
                (LIVE_STATUSES as readonly string[]).includes(row.status),
              );
              if (live !== undefined) {
                throw new ApiError('CONFLICT', {
                  reason: 'integration_already_connected',
                  integration_id: live.id,
                });
              }
              integration = existing[0];
            }
            if (integration === undefined) {
              integration = await trx
                .insertInto('integrations')
                .values({
                  id: newId(),
                  tenant_id: actor.tenantId,
                  integration_type: body.integration_type,
                  provider,
                  display_name: body.display_name ?? defaultDisplayName(body.integration_type),
                  location_id: body.location_id ?? null,
                  status: 'PENDING_AUTHORIZATION',
                  connected_by_user_id: user.userId,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            }
            const authorizationId = newId();
            const now = services.now();
            const state = signState(
              {
                t: actor.tenantId,
                a: authorizationId,
                u: user.userId,
                ...(body.return_to === undefined ? {} : { r: body.return_to }),
              },
              services.stateKey,
              AUTHORIZATION_TTL_SECONDS,
              now,
            );
            const pkce = createPkcePair();
            const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_SECONDS * 1000);
            await trx
              .insertInto('oauth_authorizations')
              .values({
                id: authorizationId,
                tenant_id: actor.tenantId,
                integration_id: integration.id,
                provider,
                state_hash: Buffer.from(sha256Hex(state), 'hex'),
                pkce_verifier_ciphertext: sealVerifier(
                  services.stateKey,
                  pkce.verifier,
                  authorizationId,
                ),
                redirect_uri: redirectUri,
                requested_scopes: [...endpoints.scopes],
                created_by_user_id: user.userId,
                expires_at: expiresAt,
              })
              .execute();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'integration.authorization_started',
              objectType: 'integration',
              objectId: integration.id,
              diff: { integration_type: body.integration_type, provider },
            });
            return {
              status: 201,
              body: {
                integration_id: integration.id,
                authorization_url: buildAuthorizeUrl(endpoints, providerConfig.clientId, {
                  state,
                  codeChallenge: pkce.challenge,
                  redirectUri,
                }),
                expires_at: expiresAt.toISOString(),
              },
              resource: { type: 'integration', id: integration.id },
            };
          },
        );
      },
    );

    app.get(
      '/v1/integrations/oauth/callback',
      { schema: { querystring: CallbackQuery } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const claims = verifyState(request.query.state, services.stateKey, services.now());
        const tenantId = claims?.['t'];
        const authorizationId = claims?.['a'];
        if (
          claims === null ||
          typeof tenantId !== 'string' ||
          typeof authorizationId !== 'string' ||
          claims['u'] !== user.userId
        ) {
          throw new ApiError('OAUTH_STATE_INVALID');
        }
        const actor: TenantActor = {
          tenantId,
          actorType: 'USER',
          actorId: user.userId,
          userId: user.userId,
          role: null,
          locationScope: [],
        };
        const context = {
          tenantId,
          actorType: 'USER' as const,
          actorId: user.userId,
          userId: user.userId,
          traceId: request.traceId,
        };
        const stateHash = Buffer.from(sha256Hex(request.query.state), 'hex');
        const pending = await withTenantTransaction(services.db, context, async (trx) => {
          const membership = await trx
            .selectFrom('memberships')
            .select(['role'])
            .where('tenant_id', '=', context.tenantId)
            .where('user_id', '=', user.userId)
            .where('status', '=', 'ACTIVE')
            .executeTakeFirst();
          if (
            membership === undefined ||
            !(
              (ROLE_PERMISSIONS as Partial<Record<string, readonly string[]>>)[membership.role] ??
              []
            ).includes('integrations:manage')
          ) {
            throw new ApiError('FORBIDDEN', { required_permission: 'integrations:manage' });
          }
          const authorization = await trx
            .selectFrom('oauth_authorizations')
            .selectAll()
            .where('id', '=', authorizationId)
            .where('state_hash', '=', stateHash)
            .forUpdate()
            .executeTakeFirst();
          if (
            authorization === undefined ||
            authorization.consumed_at !== null ||
            authorization.expires_at.getTime() <= services.now().getTime() ||
            authorization.created_by_user_id !== user.userId
          ) {
            throw new ApiError('OAUTH_STATE_INVALID');
          }
          await trx
            .updateTable('oauth_authorizations')
            .set({ consumed_at: services.now() })
            .where('id', '=', authorization.id)
            .execute();
          const verifier = unsealVerifier(
            services.stateKey,
            authorization.pkce_verifier_ciphertext,
            authorization.id,
          );
          if (verifier === null) {
            throw new ApiError('OAUTH_STATE_INVALID');
          }
          const target = await trx
            .selectFrom('integrations')
            .select(['integration_type', 'display_name'])
            .where('id', '=', authorization.integration_id)
            .executeTakeFirst();
          const tenant = await trx
            .selectFrom('tenants')
            .select(['display_name'])
            .where('id', '=', tenantId)
            .executeTakeFirst();
          return {
            integrationId: authorization.integration_id,
            integrationType: (target?.integration_type ??
              'GOOGLE_CALENDAR') as OAuthIntegrationType,
            provider: authorization.provider as OAuthProvider,
            redirectUri: authorization.redirect_uri,
            businessName: tenant?.display_name ?? target?.display_name ?? 'Velyric',
            verifier,
          };
        });

        const fail = async (errorCode: string, status: 'denied' | 'failed'): Promise<string> => {
          await withTenantTransaction(services.db, context, async (trx) => {
            await trx
              .updateTable('integrations')
              .set((eb) => ({
                status: sql<string>`case when status = 'PENDING_AUTHORIZATION' then 'ERROR' else status end`,
                last_error_code: errorCode,
                version: eb('version', '+', 1),
              }))
              .where('id', '=', pending.integrationId)
              .execute();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'integration.authorization_failed',
              objectType: 'integration',
              objectId: pending.integrationId,
              diff: { error: errorCode },
            });
          });
          return webRedirect(tenantId, pending.integrationId, status, errorCode, claims['r']);
        };

        if (request.query.error !== undefined || request.query.code === undefined) {
          const code = safeErrorCode(request.query.error ?? 'missing_code');
          return reply.redirect(
            await fail(code, code === 'access_denied' ? 'denied' : 'failed'),
            302,
          );
        }

        let exchanged;
        try {
          exchanged = await deps.tokenClient.exchange({
            provider: pending.provider,
            code: request.query.code,
            codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri,
          });
        } catch (error) {
          const code =
            error instanceof OAuthExchangeError
              ? safeErrorCode(error.code)
              : 'token_exchange_failed';
          request.log.warn(
            { integration_id: pending.integrationId, code },
            'oauth token exchange failed',
          );
          return reply.redirect(await fail(code, 'failed'), 302);
        }

        const secretRefId = newId();
        const version = await withTenantTransaction(services.db, context, async (trx) => {
          const current = await trx
            .selectFrom('tenant_secret_refs')
            .select((eb) => eb.fn.max('secret_version').as('version'))
            .where('kind', '=', 'OAUTH_REFRESH_TOKEN')
            .where('provider', '=', pending.provider)
            .where('subject_id', '=', pending.integrationId)
            .executeTakeFirst();
          return (current?.version ?? 0) + 1;
        });
        const secretRef = await deps.secrets.store({
          tenantId,
          kind: 'OAUTH_REFRESH_TOKEN',
          secretRefId,
          version,
          value: JSON.stringify({
            refresh_token: exchanged.refreshToken,
            scopes: exchanged.scopes,
            account: exchanged.accountRef,
            obtained_at: services.now().toISOString(),
          }),
        });

        let revoked: string[];
        try {
          revoked = await withTenantTransaction(services.db, context, async (trx) => {
            const previous = await trx
              .updateTable('tenant_secret_refs')
              .set({ status: 'REVOKED', revoked_at: services.now() })
              .where('kind', '=', 'OAUTH_REFRESH_TOKEN')
              .where('provider', '=', pending.provider)
              .where('subject_id', '=', pending.integrationId)
              .where('status', '=', 'ACTIVE')
              .returning(['secret_ref'])
              .execute();
            await trx
              .insertInto('tenant_secret_refs')
              .values({
                id: secretRefId,
                tenant_id: tenantId,
                kind: 'OAUTH_REFRESH_TOKEN',
                provider: pending.provider,
                subject_id: pending.integrationId,
                secret_ref: secretRef,
                secret_version: version,
                status: 'ACTIVE',
                activated_at: services.now(),
              })
              .execute();
            await trx
              .updateTable('integrations')
              .set((eb) => ({
                status: 'CONNECTED',
                secret_ref_id: secretRefId,
                granted_scopes: [...exchanged.scopes],
                external_account_ref: exchanged.accountRef,
                last_error_code: null,
                disconnected_at: null,
                connected_by_user_id: user.userId,
                last_health_check_at: services.now(),
                version: eb('version', '+', 1),
                ...(pending.integrationType === 'CUSTOM_SMTP' && exchanged.accountRef !== null
                  ? {
                      display_name: pending.businessName,
                      config: JSON.stringify(
                        tenantSmtpConfigJson(
                          googleOauthSettings(exchanged.accountRef, pending.businessName, null),
                        ),
                      ),
                    }
                  : {}),
              }))
              .where('id', '=', pending.integrationId)
              .execute();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'integration.connected',
              objectType: 'integration',
              objectId: pending.integrationId,
              diff: {
                provider: pending.provider,
                scopes: exchanged.scopes,
                secret_version: version,
              },
            });
            return previous.map((row) => row.secret_ref);
          });
        } catch (error) {
          cleanup(secretRef);
          throw error;
        }
        revoked.forEach(cleanup);
        return reply.redirect(
          webRedirect(tenantId, pending.integrationId, 'connected', undefined, claims['r']),
          302,
        );
      },
    );

    app.post(
      '/v1/integrations/:id/disconnect',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'integrations:manage');
        const toDelete: string[] = [];
        const response = await idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: null },
          'integrations.disconnect',
          async (trx) => {
            const current = await trx
              .selectFrom('integrations')
              .selectAll()
              .where('id', '=', request.params.id)
              .forUpdate()
              .executeTakeFirst();
            if (current === undefined) {
              throw new ApiError('NOT_FOUND');
            }
            if (current.status === 'DISCONNECTED') {
              return {
                status: 200,
                body: presentIntegration(current),
                resource: { type: 'integration', id: current.id },
                headers: { etag: weakEtag(current.version) },
              };
            }
            if (current.secret_ref_id !== null) {
              const revokedRef = await trx
                .updateTable('tenant_secret_refs')
                .set({ status: 'REVOKED', revoked_at: services.now() })
                .where('id', '=', current.secret_ref_id)
                .where('status', '<>', 'REVOKED')
                .returning(['secret_ref'])
                .executeTakeFirst();
              if (revokedRef) {
                toDelete.push(revokedRef.secret_ref);
              }
            }
            await trx
              .updateTable('resources')
              .set((eb) => ({
                calendar_integration_id: null,
                external_calendar_ref: null,
                version: eb('version', '+', 1),
              }))
              .where('calendar_integration_id', '=', current.id)
              .execute();
            const row = await trx
              .updateTable('integrations')
              .set((eb) => ({
                status: 'DISCONNECTED',
                disconnected_at: services.now(),
                secret_ref_id: null,
                version: eb('version', '+', 1),
              }))
              .where('id', '=', current.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'integration.disconnected',
              objectType: 'integration',
              objectId: current.id,
              diff: {},
            });
            return {
              status: 200,
              body: presentIntegration(row),
              resource: { type: 'integration', id: current.id },
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
        toDelete.forEach(cleanup);
        return response;
      },
    );
  };
}
