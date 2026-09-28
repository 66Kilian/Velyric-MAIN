import type { DB } from '@velyric/db';
import { decodeCursor, encodeCursor, sha256Hex, type CursorPayload } from '@velyric/security';
import { sql, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { ApiError } from './errors.js';
import type { TenantActor } from './principal.js';

export type Trx = Transaction<DB>;

export function newId(): string {
  return uuidv7();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export interface RequestMeta {
  readonly traceId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditEntry {
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly diff?: unknown;
  readonly actorLabel?: string | null;
  readonly supportGrantId?: string | null;
}

export async function writeAudit(
  trx: Trx,
  actor: TenantActor,
  meta: RequestMeta,
  entry: AuditEntry,
): Promise<void> {
  await trx
    .insertInto('audit_logs')
    .values({
      id: newId(),
      tenant_id: actor.tenantId,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      actor_label: entry.actorLabel ?? actor.actorLabel ?? null,
      support_grant_id: entry.supportGrantId ?? null,
      action: entry.action,
      object_type: entry.objectType,
      object_id: entry.objectId ?? null,
      diff_hash: entry.diff === undefined ? null : sha256Hex(canonicalJson(entry.diff)),
      metadata: JSON.stringify(entry.metadata ?? {}),
      ip: meta.ip,
      user_agent: meta.userAgent === null ? null : meta.userAgent.slice(0, 512),
      trace_id: meta.traceId,
    })
    .execute();
}

export interface IdempotencyRequest {
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
}

export type IdempotencyStart =
  | { readonly kind: 'new'; readonly recordId: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/headers/idempotency-key', rule: 'pattern' }],
    });
  }
  return value;
}

export function requestFingerprint(method: string, route: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()} ${route}\n${canonicalJson(body ?? null)}`);
}

export async function beginIdempotent(
  trx: Trx,
  request: IdempotencyRequest,
  ttlHours = 24,
): Promise<IdempotencyStart> {
  const keyHash = sha256Hex(request.key);
  const recordId = newId();
  const inserted = await sql<{ id: string }>`
    insert into app.idempotency_keys (id, tenant_id, user_id, scope, idempotency_key, request_fingerprint, state, locked_until, expires_at)
    values (${recordId}, ${request.tenantId}, ${request.userId}, ${request.scope}, ${keyHash}, ${request.fingerprint},
            'IN_PROGRESS', now() + interval '60 seconds', now() + make_interval(hours => ${ttlHours}))
    on conflict do nothing
    returning id`.execute(trx);
  if (inserted.rows.length === 1) {
    return { kind: 'new', recordId };
  }
  const existing = await sql<{
    id: string;
    request_fingerprint: string;
    state: string;
    response_status: number | null;
    response_body: unknown;
    expired: boolean;
  }>`
    select id, request_fingerprint, state, response_status, response_body, expires_at < now() as expired
    from app.idempotency_keys
    where tenant_id is not distinct from ${request.tenantId}
      and user_id is not distinct from ${request.userId}
      and scope = ${request.scope}
      and idempotency_key = ${keyHash}
    for update`.execute(trx);
  const row = existing.rows[0];
  if (row === undefined) {
    throw new ApiError('IDEMPOTENCY_KEY_IN_PROGRESS', undefined, {
      headers: { 'retry-after': '1' },
    });
  }
  if (row.expired) {
    await sql`
      update app.idempotency_keys
      set request_fingerprint = ${request.fingerprint}, state = 'IN_PROGRESS', response_status = null, response_body = null,
          locked_until = now() + interval '60 seconds', expires_at = now() + make_interval(hours => ${ttlHours})
      where id = ${row.id}`.execute(trx);
    return { kind: 'new', recordId: row.id };
  }
  if (row.request_fingerprint !== request.fingerprint) {
    throw new ApiError('IDEMPOTENCY_KEY_REUSED');
  }
  if (row.state !== 'COMPLETED' || row.response_status === null) {
    throw new ApiError('IDEMPOTENCY_KEY_IN_PROGRESS', undefined, {
      headers: { 'retry-after': '1' },
    });
  }
  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

export async function completeIdempotent(
  trx: Trx,
  recordId: string,
  status: number,
  body: unknown,
  resource?: { readonly type: string; readonly id: string },
): Promise<void> {
  await sql`
    update app.idempotency_keys
    set state = 'COMPLETED', response_status = ${status}, response_body = ${JSON.stringify(body)}::jsonb,
        resource_type = ${resource?.type ?? null}, resource_id = ${resource?.id ?? null}, locked_until = null
    where id = ${recordId}`.execute(trx);
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly next_cursor: string | null; readonly limit: number };
}

export function pageLimit(raw: number | undefined): number {
  if (raw === undefined) {
    return PAGE_LIMIT_DEFAULT;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > PAGE_LIMIT_MAX) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path: '/query/limit', rule: 'range' }] });
  }
  return raw;
}

export function readCursor(cursor: string | undefined, key: Uint8Array): CursorPayload | null {
  if (cursor === undefined || cursor === '') {
    return null;
  }
  const decoded = decodeCursor(cursor, key);
  if (decoded === null) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/query/cursor', rule: 'signature' }],
    });
  }
  return decoded;
}

export function buildPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  key: Uint8Array,
  cursorOf: (row: Row) => CursorPayload,
  present: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    data: visible.map(present),
    page: {
      next_cursor:
        rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last), key) : null,
      limit,
    },
  };
}

export async function appendOutbox(
  trx: Trx,
  event: {
    readonly tenantId: string | null;
    readonly eventType: string;
    readonly subject: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly traceId: string;
    readonly schemaVersion?: number;
  },
): Promise<string> {
  const eventId = newId();
  await sql`
    insert into app.outbox_events (id, tenant_id, event_id, event_type, schema_version, subject, payload, trace_id, occurred_at)
    values (${newId()}, ${event.tenantId}, ${eventId}, ${event.eventType}, ${event.schemaVersion ?? 1}, ${event.subject},
            ${JSON.stringify(event.payload)}::jsonb, ${event.traceId}, now())`.execute(trx);
  return eventId;
}
