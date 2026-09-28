import { PlatformPermission } from '@velyric/contracts';
import { sql } from 'kysely';
import Type from 'typebox';
import type { FastifyRequest } from 'fastify';
import { requestMeta, type AppServices, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, writeAudit, type Trx } from '../persistence.js';
import { inPlatform, inTenantAsStaff, requireStaff, type StaffActor } from '../staff.js';
import {
  appendTicketMessage,
  loadTicket,
  markTicketRead,
  presentMessage,
  presentTicket,
  readState,
  recordTicketEvent,
  ticketEvents,
  ticketMessages,
  type TicketRow,
} from '../tickets.js';
import { domainSubject, IdParams, iso, Uuid } from './common.js';

export interface AdminTicketRouteDependencies {
  readonly webOrigin: string;
}

const QueueQuery = Type.Object(
  {
    status: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z_]{2,31}$' })),
    tenant_id: Type.Optional(Uuid),
    assigned_to: Type.Optional(Uuid),
    unassigned: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    offset: Type.Optional(Type.String({ pattern: '^[0-9]{1,6}$' })),
  },
  { additionalProperties: false },
);

const ReplyBody = Type.Object(
  {
    body: Type.String({ minLength: 1, maxLength: 20000 }),
    internal: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const AssignBody = Type.Object(
  { staff_user_id: Type.Union([Uuid, Type.Null()]) },
  { additionalProperties: false },
);

const StatusBody = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal('OPEN'),
        Type.Literal('PENDING_CUSTOMER'),
        Type.Literal('PENDING_STAFF'),
        Type.Literal('RESOLVED'),
        Type.Literal('CLOSED'),
      ]),
    ),
    priority: Type.Optional(
      Type.Union([
        Type.Literal('LOW'),
        Type.Literal('NORMAL'),
        Type.Literal('HIGH'),
        Type.Literal('URGENT'),
      ]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

interface QueueRow {
  readonly ticket_id: string;
  readonly tenant_id: string;
  readonly tenant_display_name: string;
  readonly reference: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly category: string;
  readonly assigned_staff_user_id: string | null;
  readonly assigned_staff_email: string | null;
  readonly message_count: number;
  readonly last_message_at: Date | null;
  readonly last_tenant_message_at: Date | null;
  readonly last_staff_message_at: Date | null;
  readonly created_at: Date;
  readonly total_rows: string;
}

async function ticketTenant(
  services: AppServices,
  staff: StaffActor,
  request: FastifyRequest,
  ticketId: string,
): Promise<string> {
  const result = await inPlatform(services, staff, request, (trx) =>
    sql<{ admin_ticket_tenant: string | null }>`
      select app.admin_ticket_tenant(${ticketId}::uuid) as admin_ticket_tenant`.execute(trx),
  );
  const tenantId = result.rows[0]?.admin_ticket_tenant ?? null;
  if (tenantId === null) {
    throw new ApiError('NOT_FOUND');
  }
  return tenantId;
}

async function notifyOpener(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly ticket: TicketRow;
    readonly webOrigin: string;
    readonly traceId: string;
    readonly seq: number;
  },
): Promise<void> {
  if (input.ticket.opened_by_user_id === null) {
    return;
  }
  const membership = await trx
    .selectFrom('memberships')
    .select(['id'])
    .where('tenant_id', '=', input.tenantId)
    .where('user_id', '=', input.ticket.opened_by_user_id)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (membership === undefined) {
    return;
  }
  await appendOutbox(trx, {
    tenantId: input.tenantId,
    eventType: 'notification.requested',
    subject: domainSubject(input.tenantId, 'notification.requested'),
    payload: {
      notification_type: 'SUPPORT_REQUEST_UPDATED',
      dedupe_key: `ticket-reply:${input.ticket.id}:${String(input.seq)}`,
      recipient_membership_id: membership.id,
      template_payload: {
        ticket_reference: input.ticket.reference,
        ticket_subject: input.ticket.subject,
        ticket_url: new URL(
          `/app/${input.tenantId}/support/${input.ticket.id}`,
          input.webOrigin,
        ).toString(),
      },
    },
    traceId: input.traceId,
  });
}

export function createAdminTicketRoutes(deps: AdminTicketRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/admin/tickets', { schema: { querystring: QueueQuery } }, async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TICKETS_READ);
      const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      const result = await inPlatform(services, staff, request, (trx) =>
        sql<QueueRow>`select * from app.admin_ticket_queue(
          ${request.query.status ?? null},
          ${request.query.tenant_id ?? null},
          ${request.query.assigned_to ?? null},
          ${request.query.unassigned === 'true'},
          ${limit}::integer,
          ${offset}::integer)`.execute(trx),
      );
      return {
        data: result.rows.map((row) => ({
          id: row.ticket_id,
          tenant_id: row.tenant_id,
          workspace_name: row.tenant_display_name,
          reference: row.reference,
          subject: row.subject,
          status: row.status,
          priority: row.priority,
          category: row.category,
          assigned_staff_user_id: row.assigned_staff_user_id,
          assigned_staff_email: row.assigned_staff_email,
          message_count: row.message_count,
          last_message_at: iso(row.last_message_at),
          last_tenant_message_at: iso(row.last_tenant_message_at),
          last_staff_message_at: iso(row.last_staff_message_at),
          created_at: iso(row.created_at),
        })),
        total: Number(result.rows[0]?.total_rows ?? 0),
        limit,
        offset,
      };
    });

    app.get('/v1/admin/tickets/counts', async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TICKETS_READ);
      const result = await inPlatform(services, staff, request, (trx) =>
        sql<{ status: string; total: string }>`select * from app.admin_ticket_counts()`.execute(
          trx,
        ),
      );
      return {
        data: result.rows.map((row) => ({ status: row.status, total: Number(row.total) })),
      };
    });

    app.get('/v1/admin/tickets/:id', { schema: { params: IdParams } }, async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TICKETS_READ);
      const tenantId = await ticketTenant(services, staff, request, request.params.id);
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const ticket = await loadTicket(trx, request.params.id);
        const [messages, events, seen] = await Promise.all([
          ticketMessages(trx, ticket.id, true),
          ticketEvents(trx, ticket.id),
          readState(trx, staff.userId, 'STAFF'),
        ]);
        const workspace = await trx
          .selectFrom('tenants')
          .select(['display_name', 'status', 'plan_code'])
          .where('id', '=', tenantId)
          .executeTakeFirst();
        const opener =
          ticket.opened_by_user_id === null
            ? undefined
            : await trx
                .selectFrom('users')
                .select(['email', 'display_name'])
                .where('id', '=', ticket.opened_by_user_id)
                .executeTakeFirst();
        return {
          ...presentTicket(ticket, {
            unread: Math.max(ticket.public_message_count - (seen.get(ticket.id) ?? 0), 0),
          }),
          workspace_name: workspace?.display_name ?? null,
          workspace_status: workspace?.status ?? null,
          workspace_plan: workspace?.plan_code ?? null,
          opened_by: opener?.display_name ?? opener?.email ?? null,
          messages: messages.map(presentMessage),
          events: events.map((event) => ({
            kind: event.kind,
            actor_label: event.actor_label,
            created_at: iso(event.created_at),
          })),
        };
      });
    });

    app.post(
      '/v1/admin/tickets/:id/messages',
      { schema: { params: IdParams, body: ReplyBody } },
      async (request, reply) => {
        const staff = requireStaff(request.principal, PlatformPermission.TICKETS_MANAGE);
        const tenantId = await ticketTenant(services, staff, request, request.params.id);
        const internal = request.body.internal === true;
        const message = await inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
          const ticket = await loadTicket(trx, request.params.id);
          const posted = await appendTicketMessage(trx, services.now(), {
            tenantId,
            ticketId: ticket.id,
            authorKind: 'STAFF',
            authorUserId: staff.userId,
            authorLabel: internal ? staff.email : 'Velyric',
            visibility: internal ? 'INTERNAL_NOTE' : 'PUBLIC',
            body: request.body.body,
          });
          await markTicketRead(trx, {
            tenantId,
            ticketId: ticket.id,
            participantKind: 'STAFF',
            userId: staff.userId,
            seq: posted.seq,
          });
          if (!internal) {
            const updated = await loadTicket(trx, ticket.id);
            await notifyOpener(trx, {
              tenantId,
              ticket: updated,
              webOrigin: deps.webOrigin,
              traceId: request.traceId,
              seq: posted.seq,
            });
          }
          await writeAudit(
            trx,
            {
              tenantId,
              actorType: 'SUPPORT_STAFF',
              actorId: staff.userId,
              role: null,
              locationScope: [],
            },
            requestMeta(request),
            {
              action: internal ? 'support_ticket.note_added' : 'support_ticket.replied',
              objectType: 'support_ticket',
              objectId: ticket.id,
              actorLabel: staff.email,
              metadata: { reference: ticket.reference },
            },
          );
          return posted;
        });
        return reply.code(201).send(presentMessage(message));
      },
    );

    app.post(
      '/v1/admin/tickets/:id/assign',
      { schema: { params: IdParams, body: AssignBody } },
      async (request) => {
        const staff = requireStaff(request.principal, PlatformPermission.TICKETS_MANAGE);
        const tenantId = await ticketTenant(services, staff, request, request.params.id);
        const target = request.body.staff_user_id;
        return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
          const ticket = await loadTicket(trx, request.params.id);
          await trx
            .updateTable('support_tickets')
            .set((eb) => ({
              assigned_staff_user_id: target,
              version: eb('version', '+', 1),
              updated_at: services.now(),
            }))
            .where('id', '=', ticket.id)
            .execute();
          await recordTicketEvent(trx, {
            tenantId,
            ticketId: ticket.id,
            kind: target === null ? 'unassigned' : 'assigned',
            actorKind: 'STAFF',
            actorUserId: staff.userId,
            actorLabel: staff.email,
            detail: target === null ? {} : { staff_user_id: target },
          });
          await writeAudit(
            trx,
            {
              tenantId,
              actorType: 'SUPPORT_STAFF',
              actorId: staff.userId,
              role: null,
              locationScope: [],
            },
            requestMeta(request),
            {
              action: 'support_ticket.assigned',
              objectType: 'support_ticket',
              objectId: ticket.id,
              actorLabel: staff.email,
              metadata: { assigned_to: target },
            },
          );
          return presentTicket(await loadTicket(trx, ticket.id));
        });
      },
    );

    app.post(
      '/v1/admin/tickets/:id/status',
      { schema: { params: IdParams, body: StatusBody } },
      async (request) => {
        const staff = requireStaff(request.principal, PlatformPermission.TICKETS_MANAGE);
        const tenantId = await ticketTenant(services, staff, request, request.params.id);
        const body = request.body;
        return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
          const ticket = await loadTicket(trx, request.params.id);
          const now = services.now();
          await trx
            .updateTable('support_tickets')
            .set((eb) => ({
              ...(body.status === undefined ? {} : { status: body.status }),
              ...(body.priority === undefined ? {} : { priority: body.priority }),
              ...(body.status === 'RESOLVED' ? { resolved_at: now } : {}),
              ...(body.status === 'CLOSED' ? { closed_at: now } : {}),
              ...(body.status === 'OPEN' || body.status === 'PENDING_STAFF'
                ? { closed_at: null }
                : {}),
              version: eb('version', '+', 1),
              updated_at: now,
            }))
            .where('id', '=', ticket.id)
            .execute();
          await recordTicketEvent(trx, {
            tenantId,
            ticketId: ticket.id,
            kind: body.status === undefined ? 'prioritised' : body.status.toLowerCase(),
            actorKind: 'STAFF',
            actorUserId: staff.userId,
            actorLabel: staff.email,
            detail: {
              ...(body.status === undefined ? {} : { status: body.status }),
              ...(body.priority === undefined ? {} : { priority: body.priority }),
            },
          });
          await writeAudit(
            trx,
            {
              tenantId,
              actorType: 'SUPPORT_STAFF',
              actorId: staff.userId,
              role: null,
              locationScope: [],
            },
            requestMeta(request),
            {
              action: 'support_ticket.status_changed',
              objectType: 'support_ticket',
              objectId: ticket.id,
              actorLabel: staff.email,
              metadata: { from: ticket.status, to: body.status ?? ticket.status },
            },
          );
          return presentTicket(await loadTicket(trx, ticket.id));
        });
      },
    );
  };
}
