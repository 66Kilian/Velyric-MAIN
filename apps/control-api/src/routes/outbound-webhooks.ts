import { randomBytes } from 'node:crypto';
import {
  OUTBOUND_WEBHOOK_EVENT_TYPES,
  OUTBOUND_WEBHOOK_MAX_ENDPOINTS,
  OUTBOUND_WEBHOOK_TEST_EVENT,
  type VelyricEnvironment,
} from '@velyric/contracts';
import type { OutboundWebhooks, WebhookDeliveries } from '@velyric/db';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  resolveAllowedAddresses,
  validateEgressUrl,
  type HostResolver,
} from '@velyric/security';
import type { TenantSecretWriter } from '@velyric/tenant-secrets';
import type { Selectable } from 'kysely';
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
import { buildPage, newId, readCursor, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso, limitFromQuery } from './common.js';

const SECRET_KIND = 'OUTBOUND_WEBHOOK_SIGNING_SECRET';
const SECRET_PROVIDER = 'custom_api';
const DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER'] as const;

const EventTypes = Type.Array(Type.Enum(OUTBOUND_WEBHOOK_EVENT_TYPES), {
  minItems: 1,
  maxItems: OUTBOUND_WEBHOOK_EVENT_TYPES.length,
  uniqueItems: true,
});
const CreateBody = Type.Object(
  { url: Type.String({ minLength: 12, maxLength: 2048 }), event_types: EventTypes },
  { additionalProperties: false },
);
const UpdateBody = Type.Object(
  {
    url: Type.Optional(Type.String({ minLength: 12, maxLength: 2048 })),
    event_types: Type.Optional(EventTypes),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
const DeliveryQuery = Type.Object(
  {
    status: Type.Optional(Type.Enum(DELIVERY_STATUSES)),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

export interface OutboundWebhookRouteDependencies {
  readonly secrets: TenantSecretWriter;
  readonly resolver: HostResolver;
  readonly onSecretCleanupFailure?: (secretRef: string, error: unknown) => void;
}

interface WebhookStats {
  readonly last_delivery_at: Date | null;
  readonly last_status: string | null;
  readonly failing: number;
}

function present(row: Selectable<OutboundWebhooks>, stats?: WebhookStats): Record<string, unknown> {
  return {
    id: row.id,
    url: row.url,
    event_types: row.event_types,
    active: row.active,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...(stats === undefined
      ? {}
      : {
          last_delivery_at: iso(stats.last_delivery_at),
          last_delivery_status: stats.last_status,
          failing_deliveries: stats.failing,
        }),
  };
}

function presentDelivery(row: Selectable<WebhookDeliveries>): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempt: row.attempt,
    http_status: row.http_status,
    last_error_code: row.last_error_code,
    response_ms: row.response_ms,
    next_attempt_at: iso(row.next_attempt_at),
    delivered_at: iso(row.delivered_at),
    created_at: iso(row.created_at),
  };
}

function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

async function webhookUrl(
  raw: string,
  environment: VelyricEnvironment,
  resolver: HostResolver,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path: '/body/url', rule: 'url' }] });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/body/url', rule: 'https_without_credentials_or_fragment' }],
    });
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const policy = { ...DEFAULT_EGRESS_POLICY, allowedHosts: [host], allowHttp: false };
  try {
    const validated = validateEgressUrl(parsed, policy);
    if (environment !== 'local') {
      await resolveAllowedAddresses(validated.hostname, policy, resolver);
    }
    return validated.toString();
  } catch (error) {
    if (error instanceof ApiError || error instanceof EgressBlockedError) {
      throw error;
    }
    throw new ApiError('SSRF_BLOCKED', { reason: 'INVALID_URL' });
  }
}

async function loadWebhook(
  trx: Trx,
  id: string,
  lock = false,
): Promise<Selectable<OutboundWebhooks>> {
  let query = trx.selectFrom('outbound_webhooks').selectAll().where('id', '=', id);
  if (lock) {
    query = query.forUpdate();
  }
  const row = await query.executeTakeFirst();
  if (row === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export function createOutboundWebhookRoutes(deps: OutboundWebhookRouteDependencies): RouteModule {
  const cleanup = (secretRef: string): void => {
    deps.secrets
      .scheduleDeletion(secretRef)
      .catch((error: unknown) => deps.onSecretCleanupFailure?.(secretRef, error));
  };

  const storeSecret = async (
    trx: Trx,
    actor: TenantActor,
    webhookId: string,
    secret: string,
  ): Promise<{ readonly refId: string; readonly previous: readonly string[] }> => {
    const current = await trx
      .selectFrom('tenant_secret_refs')
      .select((eb) => eb.fn.max('secret_version').as('version'))
      .where('kind', '=', SECRET_KIND)
      .where('subject_id', '=', webhookId)
      .executeTakeFirst();
    const version = (current?.version ?? 0) + 1;
    const refId = newId();
    const secretRef = await deps.secrets.store({
      tenantId: actor.tenantId,
      kind: SECRET_KIND,
      secretRefId: refId,
      version,
      value: secret,
    });
    try {
      const previous = await trx
        .updateTable('tenant_secret_refs')
        .set({ status: 'REVOKED', revoked_at: new Date(), updated_at: new Date() })
        .where('kind', '=', SECRET_KIND)
        .where('subject_id', '=', webhookId)
        .where('status', '=', 'ACTIVE')
        .returning(['secret_ref'])
        .execute();
      await trx
        .insertInto('tenant_secret_refs')
        .values({
          id: refId,
          tenant_id: actor.tenantId,
          kind: SECRET_KIND,
          provider: SECRET_PROVIDER,
          subject_id: webhookId,
          secret_ref: secretRef,
          secret_version: version,
          status: 'ACTIVE',
          activated_at: new Date(),
        })
        .execute();
      return { refId, previous: previous.map((row) => row.secret_ref) };
    } catch (error) {
      cleanup(secretRef);
      throw error;
    }
  };

  return (app, services) => {
    app.get('/v1/outbound-webhooks', async (request) => {
      const actor = requireTenantActor(request.principal, 'settings:read');
      const { rows, stats } = await inTenant(services, actor, request, async (trx) => {
        const webhooks = await trx
          .selectFrom('outbound_webhooks')
          .selectAll()
          .orderBy('created_at')
          .execute();
        const ids = webhooks.map((row) => row.id);
        const summary =
          ids.length === 0
            ? []
            : await trx
                .selectFrom('webhook_deliveries')
                .select((eb) => [
                  'webhook_id',
                  eb.fn.max('created_at').as('last_delivery_at'),
                  eb.fn
                    .count<string>('id')
                    .filterWhere('status', 'in', ['FAILED', 'DEAD_LETTER', 'RETRYING'])
                    .as('failing'),
                ])
                .where('webhook_id', 'in', ids)
                .where('created_at', '>', new Date(services.now().getTime() - 7 * 86_400_000))
                .groupBy('webhook_id')
                .execute();
        const latest =
          ids.length === 0
            ? []
            : await trx
                .selectFrom('webhook_deliveries')
                .distinctOn('webhook_id')
                .select(['webhook_id', 'status'])
                .where('webhook_id', 'in', ids)
                .orderBy('webhook_id')
                .orderBy('created_at', 'desc')
                .execute();
        return {
          rows: webhooks,
          stats: new Map(
            ids.map((id) => {
              const aggregate = summary.find((entry) => entry.webhook_id === id);
              return [
                id,
                {
                  last_delivery_at:
                    aggregate === undefined ? null : new Date(aggregate.last_delivery_at),
                  last_status: latest.find((entry) => entry.webhook_id === id)?.status ?? null,
                  failing: Number(aggregate?.failing ?? 0),
                },
              ];
            }),
          ),
        };
      });
      return {
        data: rows.map((row) => present(row, stats.get(row.id))),
        event_types: OUTBOUND_WEBHOOK_EVENT_TYPES,
        max_endpoints: OUTBOUND_WEBHOOK_MAX_ENDPOINTS,
      };
    });

    app.post('/v1/outbound-webhooks', { schema: { body: CreateBody } }, async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'webhooks:manage');
      const url = await webhookUrl(request.body.url, services.environment, deps.resolver);
      const eventTypes = [...request.body.event_types].sort();
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'outbound_webhooks.create',
        async (trx) => {
          await requireFeature(trx, 'outbound_webhooks', services.now());
          const existing = await trx
            .selectFrom('outbound_webhooks')
            .select(['id', 'url'])
            .forUpdate()
            .execute();
          if (existing.length >= OUTBOUND_WEBHOOK_MAX_ENDPOINTS) {
            throw new ApiError('PLAN_LIMIT_EXCEEDED', {
              limit: 'outbound_webhooks',
              max: OUTBOUND_WEBHOOK_MAX_ENDPOINTS,
            });
          }
          if (existing.some((row) => row.url === url)) {
            throw new ApiError('CONFLICT', { reason: 'webhook_url_exists' });
          }
          const webhookId = newId();
          const secret = newSigningSecret();
          const stored = await storeSecret(trx, actor, webhookId, secret);
          const row = await trx
            .insertInto('outbound_webhooks')
            .values({
              id: webhookId,
              tenant_id: actor.tenantId,
              url,
              event_types: eventTypes,
              signing_secret_ref_id: stored.refId,
              created_by_user_id: actor.userId ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'outbound_webhook.created',
            objectType: 'outbound_webhook',
            objectId: row.id,
            metadata: { host: new URL(url).host, event_types: eventTypes },
          });
          return {
            status: 201,
            body: { ...present(row), signing_secret: secret },
            storedBody: { ...present(row), signing_secret: null, signing_secret_redacted: true },
            resource: { type: 'outbound_webhook', id: row.id },
            headers: { 'cache-control': 'no-store', etag: weakEtag(row.version) },
          };
        },
      );
    });

    app.patch(
      '/v1/outbound-webhooks/:id',
      { schema: { params: IdParams, body: UpdateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'webhooks:manage');
        const expected = requireIfMatch(request);
        const body = request.body;
        const url =
          body.url === undefined
            ? undefined
            : await webhookUrl(body.url, services.environment, deps.resolver);
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'outbound_webhooks.update',
          async (trx) => {
            const current = await loadWebhook(trx, request.params.id, true);
            if (current.version !== expected) {
              throw new ApiError('VERSION_CONFLICT', { current_version: current.version });
            }
            if (body.active === true && !current.active) {
              await requireFeature(trx, 'outbound_webhooks', services.now());
            }
            if (url !== undefined && url !== current.url) {
              const duplicate = await trx
                .selectFrom('outbound_webhooks')
                .select(['id'])
                .where('url', '=', url)
                .where('id', '<>', current.id)
                .executeTakeFirst();
              if (duplicate !== undefined) {
                throw new ApiError('CONFLICT', { reason: 'webhook_url_exists' });
              }
            }
            const row = await trx
              .updateTable('outbound_webhooks')
              .set({
                ...(url === undefined ? {} : { url }),
                ...(body.event_types === undefined
                  ? {}
                  : { event_types: [...body.event_types].sort() }),
                ...(body.active === undefined ? {} : { active: body.active }),
                version: current.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', current.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            if (body.active === false || (body.event_types !== undefined && url === undefined)) {
              await trx
                .updateTable('webhook_deliveries')
                .set({
                  status: 'FAILED',
                  last_error_code:
                    body.active === false ? 'ENDPOINT_DISABLED' : 'SUBSCRIPTION_CHANGED',
                  next_attempt_at: null,
                  updated_at: new Date(),
                })
                .where('webhook_id', '=', current.id)
                .where('status', 'in', ['PENDING', 'RETRYING'])
                .$if(body.active !== false, (query) =>
                  query.where('event_type', 'not in', [
                    ...(body.event_types ?? []),
                    OUTBOUND_WEBHOOK_TEST_EVENT,
                  ]),
                )
                .execute();
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'outbound_webhook.updated',
              objectType: 'outbound_webhook',
              objectId: row.id,
              metadata: { fields: Object.keys(body) },
            });
            return {
              status: 200,
              body: present(row),
              resource: { type: 'outbound_webhook', id: row.id },
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.post(
      '/v1/outbound-webhooks/:id/rotate-secret',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'webhooks:manage');
        const revoked: string[] = [];
        const response = await idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'outbound_webhooks.rotate_secret',
          async (trx) => {
            const current = await loadWebhook(trx, request.params.id, true);
            const secret = newSigningSecret();
            const stored = await storeSecret(trx, actor, current.id, secret);
            revoked.push(...stored.previous);
            const row = await trx
              .updateTable('outbound_webhooks')
              .set({
                signing_secret_ref_id: stored.refId,
                version: current.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', current.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'outbound_webhook.secret_rotated',
              objectType: 'outbound_webhook',
              objectId: row.id,
              metadata: {},
            });
            return {
              status: 200,
              body: { ...present(row), signing_secret: secret },
              storedBody: { ...present(row), signing_secret: null, signing_secret_redacted: true },
              resource: { type: 'outbound_webhook', id: row.id },
              headers: { 'cache-control': 'no-store', etag: weakEtag(row.version) },
            };
          },
        );
        revoked.forEach(cleanup);
        return response;
      },
    );

    app.delete(
      '/v1/outbound-webhooks/:id',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'webhooks:manage');
        const secrets: string[] = [];
        const response = await idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'outbound_webhooks.delete',
          async (trx) => {
            const current = await loadWebhook(trx, request.params.id, true);
            await trx
              .deleteFrom('webhook_deliveries')
              .where('webhook_id', '=', current.id)
              .execute();
            await trx.deleteFrom('outbound_webhooks').where('id', '=', current.id).execute();
            const refs = await trx
              .updateTable('tenant_secret_refs')
              .set({ status: 'REVOKED', revoked_at: new Date(), updated_at: new Date() })
              .where('kind', '=', SECRET_KIND)
              .where('subject_id', '=', current.id)
              .where('status', '=', 'ACTIVE')
              .returning(['secret_ref'])
              .execute();
            secrets.push(...refs.map((ref) => ref.secret_ref));
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'outbound_webhook.deleted',
              objectType: 'outbound_webhook',
              objectId: current.id,
              metadata: { host: new URL(current.url).host },
            });
            return {
              status: 200,
              body: { id: current.id, deleted: true },
              resource: { type: 'outbound_webhook', id: current.id },
            };
          },
        );
        secrets.forEach(cleanup);
        return response;
      },
    );

    app.post(
      '/v1/outbound-webhooks/:id/test',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'webhooks:manage');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'outbound_webhooks.test',
          async (trx) => {
            const current = await loadWebhook(trx, request.params.id);
            if (!current.active) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'webhook_inactive' });
            }
            const now = services.now();
            const eventId = newId();
            const row = await trx
              .insertInto('webhook_deliveries')
              .values({
                tenant_id: actor.tenantId,
                webhook_id: current.id,
                event_id: eventId,
                event_type: OUTBOUND_WEBHOOK_TEST_EVENT,
                status: 'PENDING',
                next_attempt_at: now,
                occurred_at: now,
                payload: JSON.stringify({ webhook_id: current.id, message: 'Velyric test event' }),
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'outbound_webhook.test_sent',
              objectType: 'outbound_webhook',
              objectId: current.id,
              metadata: { delivery_id: row.id },
            });
            return {
              status: 202,
              body: presentDelivery(row),
              resource: { type: 'webhook_delivery', id: row.id },
            };
          },
        );
      },
    );

    app.get(
      '/v1/outbound-webhooks/:id/deliveries',
      { schema: { params: IdParams, querystring: DeliveryQuery } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'settings:read');
        const limit = limitFromQuery(request.query.limit);
        const cursor = readCursor(request.query.cursor, services.cursorKey);
        const rows = await inTenant(services, actor, request, async (trx) => {
          await loadWebhook(trx, request.params.id);
          let query = trx
            .selectFrom('webhook_deliveries')
            .selectAll()
            .where('webhook_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1);
          if (request.query.status !== undefined) {
            query = query.where('status', '=', request.query.status);
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
          presentDelivery,
        );
      },
    );

    app.post(
      '/v1/outbound-webhooks/:id/deliveries/:deliveryId/retry',
      {
        schema: {
          params: Type.Object(
            { id: IdParams.properties.id, deliveryId: IdParams.properties.id },
            { additionalProperties: false },
          ),
        },
      },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'webhooks:manage');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'outbound_webhooks.retry_delivery',
          async (trx) => {
            const webhook = await loadWebhook(trx, request.params.id);
            if (!webhook.active) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'webhook_inactive' });
            }
            const row = await trx
              .updateTable('webhook_deliveries')
              .set({
                status: 'RETRYING',
                next_attempt_at: services.now(),
                last_error_code: null,
                claimed_by: null,
                claimed_until: null,
                updated_at: new Date(),
              })
              .where('id', '=', request.params.deliveryId)
              .where('webhook_id', '=', webhook.id)
              .where('status', 'in', ['FAILED', 'DEAD_LETTER'])
              .where('payload', 'is not', null)
              .returningAll()
              .executeTakeFirst();
            if (row === undefined) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'delivery_not_retryable' });
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'outbound_webhook.delivery_retried',
              objectType: 'webhook_delivery',
              objectId: row.id,
              metadata: { webhook_id: webhook.id },
            });
            return {
              status: 202,
              body: presentDelivery(row),
              resource: { type: 'webhook_delivery', id: row.id },
            };
          },
        );
      },
    );
  };
}
