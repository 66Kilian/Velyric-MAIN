import { Permission, type Permission as PermissionValue } from '@velyric/contracts';
import { generateApiKey } from '@velyric/security';
import Type from 'typebox';
import { idempotentWrite, inTenant, requestMeta, tenantContext, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, writeAudit } from '../persistence.js';
import { permissionsOf, requireTenantActor, requireUser } from '../principal.js';
import { domainSubject, IdParams, iso } from './common.js';

export interface ApiKeyRouteDependencies {
  readonly apiKeyPepper: Uint8Array;
  readonly webOrigin: string;
}

const MAX_ACTIVE_KEYS = 25;
const MAX_LIFETIME_DAYS = 365;
const NON_DELEGABLE: ReadonlySet<string> = new Set([
  'members:manage',
  'api_keys:manage',
  'security:manage',
  'support_access:grant',
  'billing:manage',
]);
const TENANT_PERMISSIONS = Object.values(Permission).filter(
  (permission) => !permission.startsWith('platform.'),
) as PermissionValue[];

const CreateBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    scopes: Type.Array(Type.Enum(TENANT_PERMISSIONS), {
      minItems: 1,
      maxItems: 40,
      uniqueItems: true,
    }),
    expires_in_days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIFETIME_DAYS })),
  },
  { additionalProperties: false },
);

interface KeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: string[];
  readonly created_by_user_id: string;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

function presentKey(row: KeyRow, now: Date): Record<string, unknown> {
  const expired = row.expires_at !== null && row.expires_at.getTime() <= now.getTime();
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    status: row.revoked_at !== null ? 'REVOKED' : expired ? 'EXPIRED' : 'ACTIVE',
    created_by_user_id: row.created_by_user_id,
    expires_at: iso(row.expires_at),
    last_used_at: iso(row.last_used_at),
    revoked_at: iso(row.revoked_at),
    created_at: iso(row.created_at),
  };
}

export function createApiKeyRoutes(deps: ApiKeyRouteDependencies): RouteModule {
  return (app, services) => {
    const keyEnvironment = services.environment === 'production' ? 'live' : 'test';

    app.get('/v1/api-keys', async (request) => {
      const actor = requireTenantActor(request.principal, 'api_keys:manage');
      const rows = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('api_keys')
          .select([
            'id',
            'name',
            'prefix',
            'scopes',
            'created_by_user_id',
            'expires_at',
            'last_used_at',
            'revoked_at',
            'created_at',
          ])
          .orderBy('created_at', 'desc')
          .limit(200)
          .execute(),
      );
      const now = services.now();
      return { data: rows.map((row) => presentKey(row, now)) };
    });

    app.post('/v1/api-keys', { schema: { body: CreateBody } }, async (request, reply) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'api_keys:manage');
      const body = request.body;
      const granted = permissionsOf(request.principal ?? user);
      const refused = body.scopes.filter(
        (scope) => NON_DELEGABLE.has(scope) || !granted.has(scope),
      );
      if (refused.length > 0) {
        throw new ApiError('FORBIDDEN', { reason: 'scope_not_delegable', scopes: refused });
      }
      const key = generateApiKey(keyEnvironment, deps.apiKeyPepper);
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: user.userId },
        'api_keys.create',
        async (trx) => {
          const active = await trx
            .selectFrom('api_keys')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('revoked_at', 'is', null)
            .where((eb) =>
              eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', services.now())]),
            )
            .executeTakeFirstOrThrow();
          if (Number(active.count) >= MAX_ACTIVE_KEYS) {
            throw new ApiError('PLAN_LIMIT_EXCEEDED', {
              limit: 'active_api_keys',
              max: MAX_ACTIVE_KEYS,
            });
          }
          const now = services.now();
          const row = await trx
            .insertInto('api_keys')
            .values({
              id: newId(),
              tenant_id: actor.tenantId,
              name: body.name,
              prefix: key.prefix,
              key_hash: Buffer.from(key.hash),
              scopes: body.scopes,
              created_by_user_id: user.userId,
              expires_at:
                body.expires_in_days === undefined
                  ? null
                  : new Date(now.getTime() + body.expires_in_days * 86_400_000),
            })
            .returning([
              'id',
              'name',
              'prefix',
              'scopes',
              'created_by_user_id',
              'expires_at',
              'last_used_at',
              'revoked_at',
              'created_at',
            ])
            .executeTakeFirstOrThrow();
          const tenant = await trx
            .selectFrom('tenants')
            .select(['display_name'])
            .where('id', '=', actor.tenantId)
            .executeTakeFirstOrThrow();
          const creator = await trx
            .selectFrom('users')
            .select(['display_name', 'email'])
            .where('id', '=', user.userId)
            .executeTakeFirst();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'notification.requested',
            subject: domainSubject(actor.tenantId, 'notification.requested'),
            payload: {
              notification_type: 'SECURITY_API_KEY_CREATED',
              dedupe_key: `api_key:${row.id}`,
              template_payload: {
                workspace_name: tenant.display_name,
                actor_name: creator?.display_name ?? creator?.email ?? 'Velyric',
                key_name: row.name,
                key_prefix: row.prefix,
                action_url: new URL(
                  `/app/${actor.tenantId}/security/api-keys`,
                  deps.webOrigin,
                ).toString(),
              },
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'api_key.created',
            objectType: 'api_key',
            objectId: row.id,
            metadata: { prefix: row.prefix, scopes: row.scopes, expires_at: iso(row.expires_at) },
          });
          return {
            status: 201,
            body: { ...presentKey(row, now), secret: key.plaintext },
            storedBody: { ...presentKey(row, now), secret: null, secret_redacted: true },
            resource: { type: 'api_key', id: row.id },
            headers: { 'cache-control': 'no-store' },
          };
        },
      );
    });

    app.post(
      '/v1/api-keys/:id/revoke',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'api_keys:manage');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'api_keys.revoke',
          async (trx) => {
            const existing = await trx
              .selectFrom('api_keys')
              .select(['id', 'revoked_at'])
              .where('id', '=', request.params.id)
              .forUpdate()
              .executeTakeFirst();
            if (existing === undefined) {
              throw new ApiError('NOT_FOUND');
            }
            if (existing.revoked_at !== null) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'already_revoked' });
            }
            const row = await trx
              .updateTable('api_keys')
              .set({ revoked_at: services.now(), revoked_by_user_id: user.userId })
              .where('id', '=', existing.id)
              .returning([
                'id',
                'name',
                'prefix',
                'scopes',
                'created_by_user_id',
                'expires_at',
                'last_used_at',
                'revoked_at',
                'created_at',
              ])
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'api_key.revoked',
              objectType: 'api_key',
              objectId: row.id,
              metadata: { prefix: row.prefix },
            });
            return { status: 200, body: presentKey(row, services.now()) };
          },
        );
      },
    );
  };
}
