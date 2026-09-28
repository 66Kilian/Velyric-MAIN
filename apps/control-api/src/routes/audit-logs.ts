import type { AuditLogs } from '@velyric/db';
import type { Selectable } from 'kysely';
import Type from 'typebox';
import { inTenant, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { buildPage, readCursor, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso, limitFromQuery } from './common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FULL_NETWORK_DETAIL_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN']);

const ListQuery = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    action: Type.Optional(
      Type.String({
        pattern: '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*\\.?(,[a-z][a-z_]*(\\.[a-z][a-z_]*)*\\.?){0,19}$',
        maxLength: 800,
      }),
    ),
    object_type: Type.Optional(Type.String({ pattern: '^[a-z][a-z_]{1,60}$' })),
    object_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    actor_type: Type.Optional(
      Type.Union([
        Type.Literal('USER'),
        Type.Literal('API_KEY'),
        Type.Literal('SERVICE'),
        Type.Literal('SUPPORT_STAFF'),
        Type.Literal('PROVIDER_WEBHOOK'),
        Type.Literal('SYSTEM'),
      ]),
    ),
    actor_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    from: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
    to: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
  },
  { additionalProperties: false },
);

function maskIp(ip: string | null): string | null {
  if (ip === null) {
    return null;
  }
  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.0/24` : null;
}

function instant(value: string | undefined, path: string): Date | null {
  if (value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'rfc3339' }] });
  }
  return parsed;
}

type ActorNames = ReadonlyMap<
  string,
  { readonly name: string | null; readonly email: string | null }
>;

async function actorNames(trx: Trx, rows: readonly Selectable<AuditLogs>[]): Promise<ActorNames> {
  const ids = (type: string): string[] => [
    ...new Set(
      rows
        .filter((row) => row.actor_type === type)
        .map((row) => row.actor_id ?? '')
        .filter((id) => UUID.test(id)),
    ),
  ];
  const userIds = ids('USER');
  const keyIds = ids('API_KEY');
  const names = new Map<string, { name: string | null; email: string | null }>();
  if (userIds.length > 0) {
    const users = await trx
      .selectFrom('users')
      .select(['id', 'display_name', 'email'])
      .where('id', 'in', userIds)
      .execute();
    for (const user of users) {
      names.set(`USER:${user.id}`, { name: user.display_name, email: user.email });
    }
  }
  if (keyIds.length > 0) {
    const keys = await trx
      .selectFrom('api_keys')
      .select(['id', 'name'])
      .where('id', 'in', keyIds)
      .execute();
    for (const key of keys) {
      names.set(`API_KEY:${key.id}`, { name: key.name, email: null });
    }
  }
  return names;
}

export function presentAuditLog(
  row: Selectable<AuditLogs>,
  actor: TenantActor,
  names: ActorNames = new Map(),
): Record<string, unknown> {
  const full = actor.role !== null && FULL_NETWORK_DETAIL_ROLES.has(actor.role);
  const known = names.get(`${row.actor_type}:${row.actor_id ?? ''}`);
  return {
    id: row.id,
    occurred_at: iso(row.occurred_at),
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      label: row.actor_label,
      name: known?.name ?? null,
      email: known?.email ?? null,
    },
    action: row.action,
    object: { type: row.object_type, id: row.object_id },
    metadata: row.metadata,
    diff_hash: row.diff_hash,
    ip: full ? row.ip : maskIp(row.ip),
    user_agent: full ? row.user_agent : null,
    trace_id: row.trace_id,
    support_grant_id: row.support_grant_id,
  };
}

export const registerAuditLogRoutes: RouteModule = (app, services) => {
  app.get('/v1/audit-logs', { schema: { querystring: ListQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'audit_logs:read');
    const query = request.query;
    const limit = limitFromQuery(query.limit);
    const cursor = readCursor(query.cursor, services.cursorKey);
    const from = instant(query.from, '/querystring/from');
    const to = instant(query.to, '/querystring/to');
    if (from !== null && to !== null && from.getTime() > to.getTime()) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: '/querystring/from', rule: 'before_to' }],
      });
    }
    const rows = await inTenant(services, actor, request, async (trx) => {
      let select = trx
        .selectFrom('audit_logs')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (query.action !== undefined) {
        const patterns = query.action.split(',');
        select = select.where((eb) =>
          eb.or(
            patterns.map((pattern) =>
              pattern.endsWith('.')
                ? eb('action', 'like', `${pattern.replaceAll('_', '\\_')}%`)
                : eb('action', '=', pattern),
            ),
          ),
        );
      }
      if (query.object_type !== undefined) {
        select = select.where('object_type', '=', query.object_type);
      }
      if (query.object_id !== undefined) {
        select = select.where('object_id', '=', query.object_id);
      }
      if (query.actor_type !== undefined) {
        select = select.where('actor_type', '=', query.actor_type);
      }
      if (query.actor_id !== undefined) {
        select = select.where('actor_id', '=', query.actor_id);
      }
      if (from !== null) {
        select = select.where('occurred_at', '>=', from);
      }
      if (to !== null) {
        select = select.where('occurred_at', '<', to);
      }
      if (cursor !== null) {
        select = select.where((eb) =>
          eb(
            eb.refTuple('occurred_at', 'id'),
            '<',
            eb.tuple(new Date(String(cursor.k[0])), cursor.id),
          ),
        );
      }
      const found = await select.execute();
      return { found, names: await actorNames(trx, found) };
    });
    return buildPage(
      rows.found,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.occurred_at.toISOString()], id: row.id }),
      (row) => presentAuditLog(row, actor, rows.names),
    );
  });

  app.get('/v1/audit-logs/:id', { schema: { params: IdParams } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'audit_logs:read');
    const loaded = await inTenant(services, actor, request, async (trx) => {
      const row = await trx
        .selectFrom('audit_logs')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      return row === undefined ? null : { row, names: await actorNames(trx, [row]) };
    });
    if (loaded === null) {
      throw new ApiError('NOT_FOUND');
    }
    return presentAuditLog(loaded.row, actor, loaded.names);
  });
};
