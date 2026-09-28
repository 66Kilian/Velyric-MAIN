import { sql } from 'kysely';
import { ApiError } from './errors.js';
import type { Trx } from './persistence.js';

export type TicketAuthorKind = 'TENANT_USER' | 'STAFF' | 'SYSTEM';
export type TicketVisibility = 'PUBLIC' | 'INTERNAL_NOTE';
export type TicketStatus = 'OPEN' | 'PENDING_CUSTOMER' | 'PENDING_STAFF' | 'RESOLVED' | 'CLOSED';

export interface TicketRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly reference: string;
  readonly subject: string;
  readonly category: string;
  readonly priority: string;
  readonly status: string;
  readonly opened_by_user_id: string | null;
  readonly assigned_staff_user_id: string | null;
  readonly message_count: number;
  readonly public_message_count: number;
  readonly last_message_at: Date | null;
  readonly last_tenant_message_at: Date | null;
  readonly last_staff_message_at: Date | null;
  readonly first_response_at: Date | null;
  readonly resolved_at: Date | null;
  readonly closed_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface TicketMessageRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly seq: number;
  readonly author_kind: string;
  readonly author_user_id: string | null;
  readonly author_label: string | null;
  readonly visibility: string;
  readonly body: string;
  readonly created_at: Date;
}

export function ticketReference(id: string): string {
  return `VLY-${id.replaceAll('-', '').slice(-8).toUpperCase()}`;
}

export async function loadTicket(trx: Trx, ticketId: string): Promise<TicketRow> {
  const row = await trx
    .selectFrom('support_tickets')
    .selectAll()
    .where('id', '=', ticketId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export async function ticketMessages(
  trx: Trx,
  ticketId: string,
  includeInternal: boolean,
): Promise<readonly TicketMessageRow[]> {
  let query = trx
    .selectFrom('support_ticket_messages')
    .select([
      'id',
      'ticket_id',
      'seq',
      'author_kind',
      'author_user_id',
      'author_label',
      'visibility',
      'body',
      'created_at',
    ])
    .where('ticket_id', '=', ticketId);
  if (!includeInternal) {
    query = query.where('visibility', '=', 'PUBLIC');
  }
  const rows = await query.orderBy('seq').limit(500).execute();
  return rows;
}

export async function ticketEvents(
  trx: Trx,
  ticketId: string,
): Promise<readonly { kind: string; actor_label: string | null; created_at: Date }[]> {
  const rows = await trx
    .selectFrom('support_ticket_events')
    .select(['kind', 'actor_label', 'created_at'])
    .where('ticket_id', '=', ticketId)
    .orderBy('created_at')
    .limit(200)
    .execute();
  return rows;
}

export async function recordTicketEvent(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly ticketId: string;
    readonly kind: string;
    readonly actorKind: TicketAuthorKind;
    readonly actorUserId: string | null;
    readonly actorLabel: string | null;
    readonly detail?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await trx
    .insertInto('support_ticket_events')
    .values({
      tenant_id: input.tenantId,
      ticket_id: input.ticketId,
      kind: input.kind,
      actor_kind: input.actorKind,
      actor_user_id: input.actorUserId,
      actor_label: input.actorLabel,
      detail: JSON.stringify(input.detail ?? {}),
    })
    .execute();
}

export async function appendTicketMessage(
  trx: Trx,
  now: Date,
  input: {
    readonly tenantId: string;
    readonly ticketId: string;
    readonly authorKind: TicketAuthorKind;
    readonly authorUserId: string | null;
    readonly authorLabel: string | null;
    readonly visibility: TicketVisibility;
    readonly body: string;
  },
): Promise<TicketMessageRow> {
  const next = await sql<{ seq: number }>`
    select coalesce(max(seq), 0) + 1 as seq
    from app.support_ticket_messages where ticket_id = ${input.ticketId}::uuid`.execute(trx);
  const seq = next.rows[0]?.seq ?? 1;
  const inserted = await trx
    .insertInto('support_ticket_messages')
    .values({
      tenant_id: input.tenantId,
      ticket_id: input.ticketId,
      seq,
      author_kind: input.authorKind,
      author_user_id: input.authorUserId,
      author_label: input.authorLabel,
      visibility: input.visibility,
      body: input.body,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const isPublic = input.visibility === 'PUBLIC';
  const fromTenant = input.authorKind === 'TENANT_USER';
  const fromStaff = input.authorKind === 'STAFF';
  await trx
    .updateTable('support_tickets')
    .set((eb) => ({
      message_count: eb('message_count', '+', 1),
      ...(isPublic ? { public_message_count: eb('public_message_count', '+', 1) } : {}),
      ...(isPublic ? { last_message_at: now } : {}),
      ...(isPublic && fromTenant ? { last_tenant_message_at: now } : {}),
      ...(isPublic && fromStaff ? { last_staff_message_at: now } : {}),
      version: eb('version', '+', 1),
      updated_at: now,
    }))
    .where('id', '=', input.ticketId)
    .execute();

  if (isPublic) {
    await trx
      .updateTable('support_tickets')
      .set({ status: fromTenant ? 'PENDING_STAFF' : 'PENDING_CUSTOMER' })
      .where('id', '=', input.ticketId)
      .where('status', 'in', ['OPEN', 'PENDING_CUSTOMER', 'PENDING_STAFF'])
      .execute();
    if (fromStaff) {
      await trx
        .updateTable('support_tickets')
        .set({ first_response_at: now })
        .where('id', '=', input.ticketId)
        .where('first_response_at', 'is', null)
        .execute();
    }
  }
  return inserted;
}

export async function markTicketRead(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly ticketId: string;
    readonly participantKind: TicketAuthorKind;
    readonly userId: string;
    readonly seq: number;
  },
): Promise<void> {
  await sql`
    insert into app.support_ticket_participants
      (tenant_id, ticket_id, participant_kind, user_id, last_read_seq)
    values (${input.tenantId}::uuid, ${input.ticketId}::uuid, ${input.participantKind},
            ${input.userId}::uuid, ${input.seq})
    on conflict (ticket_id, participant_kind, user_id) do update
      set last_read_seq = greatest(app.support_ticket_participants.last_read_seq, excluded.last_read_seq),
          updated_at = now()`.execute(trx);
}

export async function readState(
  trx: Trx,
  userId: string,
  participantKind: TicketAuthorKind,
): Promise<ReadonlyMap<string, number>> {
  const rows = await trx
    .selectFrom('support_ticket_participants')
    .select(['ticket_id', 'last_read_seq'])
    .where('user_id', '=', userId)
    .where('participant_kind', '=', participantKind)
    .execute();
  return new Map(rows.map((row) => [row.ticket_id, row.last_read_seq]));
}

export function presentTicket(
  row: TicketRow,
  options: { readonly unread?: number; readonly assignedEmail?: string | null } = {},
): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    message_count: row.public_message_count,
    last_message_at: row.last_message_at?.toISOString() ?? null,
    first_response_at: row.first_response_at?.toISOString() ?? null,
    resolved_at: row.resolved_at?.toISOString() ?? null,
    closed_at: row.closed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    version: row.version,
    assigned_staff_user_id: row.assigned_staff_user_id,
    ...(options.assignedEmail === undefined ? {} : { assigned_staff_email: options.assignedEmail }),
    ...(options.unread === undefined ? {} : { unread: options.unread }),
  };
}

export function presentMessage(row: TicketMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    seq: row.seq,
    author_kind: row.author_kind,
    author_label: row.author_label,
    visibility: row.visibility,
    body: row.body,
    created_at: row.created_at.toISOString(),
  };
}
