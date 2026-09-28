import { ActorType } from '@velyric/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const AUTH_SUBJECT_PATTERN = /^[A-Za-z0-9_|:.@-]{3,255}$/;
const ACTOR_TYPES: ReadonlySet<string> = new Set(Object.values(ActorType));

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export class DatabaseContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseContextError';
  }
}

export interface TenantContext {
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly traceId: string;
  readonly userId?: string;
}

export interface UserContext {
  readonly authSubject: string;
  readonly traceId: string;
  readonly userId?: string;
}

export interface SupportContext {
  readonly tenantId: string;
  readonly supportGrantId: string;
  readonly staffUserId: string;
  readonly traceId: string;
}

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel;
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new DatabaseContextError(`${name} must be a lowercase UUID`);
  }
}

function assertTraceId(value: string): void {
  if (!TRACE_ID_PATTERN.test(value)) {
    throw new DatabaseContextError('traceId must be a 32-character lowercase hex W3C trace id');
  }
}

export function assertTenantContext(context: TenantContext): void {
  assertUuid(context.tenantId, 'tenantId');
  assertTraceId(context.traceId);
  if (!ACTOR_TYPES.has(context.actorType)) {
    throw new DatabaseContextError('actorType is not a known ActorType');
  }
  if (context.actorId.length === 0 || context.actorId.length > 255) {
    throw new DatabaseContextError('actorId must be 1-255 characters');
  }
  if (context.userId !== undefined) {
    assertUuid(context.userId, 'userId');
  }
}

async function runInTransaction<Database, Result>(
  db: Kysely<Database>,
  options: TransactionOptions,
  apply: (trx: Transaction<Database>) => Promise<void>,
  fn: (trx: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  const builder =
    options.isolationLevel === undefined
      ? db.transaction()
      : db.transaction().setIsolationLevel(options.isolationLevel);
  return builder.execute(async (trx) => {
    await apply(trx);
    return fn(trx);
  });
}

export async function withTenantTransaction<Database, Result>(
  db: Kysely<Database>,
  context: TenantContext,
  fn: (trx: Transaction<Database>) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  assertTenantContext(context);
  return runInTransaction(
    db,
    options,
    async (trx) => {
      await sql`select
        set_config('app.tenant_id', ${context.tenantId}, true),
        set_config('app.actor_type', ${context.actorType}, true),
        set_config('app.actor_id', ${context.actorId}, true),
        set_config('app.trace_id', ${context.traceId}, true),
        set_config('app.user_id', ${context.userId ?? ''}, true),
        set_config('app.support_grant_id', '', true)`.execute(trx);
    },
    fn,
  );
}

export async function withUserTransaction<Database, Result>(
  db: Kysely<Database>,
  context: UserContext,
  fn: (trx: Transaction<Database>) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  if (!AUTH_SUBJECT_PATTERN.test(context.authSubject)) {
    throw new DatabaseContextError('authSubject has an unexpected format');
  }
  assertTraceId(context.traceId);
  if (context.userId !== undefined) {
    assertUuid(context.userId, 'userId');
  }
  return runInTransaction(
    db,
    options,
    async (trx) => {
      await sql`select
        set_config('app.tenant_id', '', true),
        set_config('app.auth_subject', ${context.authSubject}, true),
        set_config('app.user_id', ${context.userId ?? ''}, true),
        set_config('app.actor_type', ${ActorType.USER}, true),
        set_config('app.actor_id', ${context.userId ?? context.authSubject}, true),
        set_config('app.trace_id', ${context.traceId}, true)`.execute(trx);
    },
    fn,
  );
}

export async function withSupportTransaction<Database, Result>(
  db: Kysely<Database>,
  context: SupportContext,
  fn: (trx: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  assertUuid(context.tenantId, 'tenantId');
  assertUuid(context.supportGrantId, 'supportGrantId');
  assertUuid(context.staffUserId, 'staffUserId');
  assertTraceId(context.traceId);
  return runInTransaction(
    db,
    { isolationLevel: 'repeatable read' },
    async (trx) => {
      await sql`select
        set_config('app.tenant_id', ${context.tenantId}, true),
        set_config('app.support_grant_id', ${context.supportGrantId}, true),
        set_config('app.actor_type', ${ActorType.SUPPORT_STAFF}, true),
        set_config('app.actor_id', ${context.staffUserId}, true),
        set_config('app.user_id', '', true),
        set_config('app.trace_id', ${context.traceId}, true)`.execute(trx);
    },
    fn,
  );
}

export interface TenantDirectoryEntry {
  readonly id: string;
  readonly status: string;
}

export async function listTenantDirectory<Database>(
  db: Kysely<Database>,
  statuses: readonly string[],
  afterId: string | null,
  limit: number,
): Promise<readonly TenantDirectoryEntry[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
  if (afterId !== null) {
    assertUuid(afterId, 'afterId');
  }
  const result = await sql<TenantDirectoryEntry>`
    select id::text as id, status
    from app.tenant_directory
    where status = any(${statuses})
      and (${afterId}::uuid is null or id > ${afterId}::uuid)
    order by id
    limit ${limit}`.execute(db);
  return result.rows;
}
