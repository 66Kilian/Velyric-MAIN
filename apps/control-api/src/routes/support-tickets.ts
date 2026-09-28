import Type from 'typebox';
import { idempotentWrite, inTenant, requestMeta, tenantContext, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, requireUser } from '../principal.js';
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
  ticketReference,
  type TicketRow,
} from '../tickets.js';
import { domainSubject, IdParams, iso } from './common.js';

export interface SupportTicketRouteDependencies {
  readonly webOrigin: string;
}

const CreateBody = Type.Object(
  {
    subject: Type.String({ minLength: 3, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 20000 }),
    category: Type.Optional(
      Type.Union([
        Type.Literal('BILLING'),
        Type.Literal('TECHNICAL'),
        Type.Literal('PHONE_NUMBERS'),
        Type.Literal('ACCOUNT'),
        Type.Literal('OTHER'),
      ]),
    ),
    priority: Type.Optional(
      Type.Union([Type.Literal('LOW'), Type.Literal('NORMAL'), Type.Literal('HIGH')]),
    ),
  },
  { additionalProperties: false },
);

const MessageBody = Type.Object(
  { body: Type.String({ minLength: 1, maxLength: 20000 }) },
  { additionalProperties: false },
);

const ReadBody = Type.Object(
  { seq: Type.Integer({ minimum: 0, maximum: 100000 }) },
  { additionalProperties: false },
);

const StatusBody = Type.Object(
  {
    status: Type.Union([Type.Literal('OPEN'), Type.Literal('RESOLVED'), Type.Literal('CLOSED')]),
  },
  { additionalProperties: false },
);

async function notifyOpener(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly ticket: TicketRow;
    readonly type: 'SUPPORT_REQUEST_RECEIVED' | 'SUPPORT_REQUEST_UPDATED';
    readonly dedupeKey: string;
    readonly webOrigin: string;
    readonly traceId: string;
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
      notification_type: input.type,
      dedupe_key: input.dedupeKey,
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

export function createSupportTicketRoutes(deps: SupportTicketRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/support-tickets', async (request) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'support_tickets:read');
      const result = await inTenant(services, actor, request, async (trx) => {
        const rows = await trx
          .selectFrom('support_tickets')
          .selectAll()
          .orderBy('last_message_at', 'desc')
          .orderBy('created_at', 'desc')
          .limit(200)
          .execute();
        const seen = await readState(trx, user.userId, 'TENANT_USER');
        return { rows: rows as unknown as TicketRow[], seen };
      });
      return {
        data: result.rows.map((row) =>
          presentTicket(row, {
            unread: Math.max(row.public_message_count - (result.seen.get(row.id) ?? 0), 0),
          }),
        ),
      };
    });

    app.post('/v1/support-tickets', { schema: { body: CreateBody } }, async (request, reply) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'support_tickets:write');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: user.userId },
        'support_tickets.create',
        async (trx) => {
          const now = services.now();
          const ticketId = newId();
          const created = await trx
            .insertInto('support_tickets')
            .values({
              id: ticketId,
              tenant_id: actor.tenantId,
              reference: ticketReference(ticketId),
              subject: body.subject.trim(),
              category: body.category ?? 'OTHER',
              priority: body.priority ?? 'NORMAL',
              status: 'PENDING_STAFF',
              opened_by_user_id: user.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendTicketMessage(trx, now, {
            tenantId: actor.tenantId,
            ticketId: created.id,
            authorKind: 'TENANT_USER',
            authorUserId: user.userId,
            authorLabel: user.email,
            visibility: 'PUBLIC',
            body: body.body,
          });
          await recordTicketEvent(trx, {
            tenantId: actor.tenantId,
            ticketId: created.id,
            kind: 'opened',
            actorKind: 'TENANT_USER',
            actorUserId: user.userId,
            actorLabel: user.email,
          });
          await markTicketRead(trx, {
            tenantId: actor.tenantId,
            ticketId: created.id,
            participantKind: 'TENANT_USER',
            userId: user.userId,
            seq: 1,
          });
          const ticket = await loadTicket(trx, created.id);
          await notifyOpener(trx, {
            tenantId: actor.tenantId,
            ticket,
            type: 'SUPPORT_REQUEST_RECEIVED',
            dedupeKey: `ticket-opened:${ticket.id}`,
            webOrigin: deps.webOrigin,
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'support_ticket.opened',
            objectType: 'support_ticket',
            objectId: ticket.id,
            metadata: { reference: ticket.reference, category: ticket.category },
          });
          return {
            status: 201,
            body: presentTicket(ticket, { unread: 0 }),
            resource: { type: 'support_ticket', id: ticket.id },
          };
        },
      );
    });

    app.get('/v1/support-tickets/:id', { schema: { params: IdParams } }, async (request) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'support_tickets:read');
      return inTenant(services, actor, request, async (trx) => {
        const ticket = await loadTicket(trx, request.params.id);
        const [messages, events, seen] = await Promise.all([
          ticketMessages(trx, ticket.id, false),
          ticketEvents(trx, ticket.id),
          readState(trx, user.userId, 'TENANT_USER'),
        ]);
        return {
          ...presentTicket(ticket, {
            unread: Math.max(ticket.public_message_count - (seen.get(ticket.id) ?? 0), 0),
          }),
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
      '/v1/support-tickets/:id/messages',
      { schema: { params: IdParams, body: MessageBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'support_tickets:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'support_tickets.reply',
          async (trx) => {
            const ticket = await loadTicket(trx, request.params.id);
            if (ticket.status === 'CLOSED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'ticket_closed' });
            }
            const message = await appendTicketMessage(trx, services.now(), {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              authorKind: 'TENANT_USER',
              authorUserId: user.userId,
              authorLabel: user.email,
              visibility: 'PUBLIC',
              body: request.body.body,
            });
            await markTicketRead(trx, {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              participantKind: 'TENANT_USER',
              userId: user.userId,
              seq: message.seq,
            });
            return {
              status: 201,
              body: presentMessage(message),
              resource: { type: 'support_ticket_message', id: message.id },
            };
          },
        );
      },
    );

    app.post(
      '/v1/support-tickets/:id/read',
      { schema: { params: IdParams, body: ReadBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'support_tickets:read');
        await inTenant(services, actor, request, async (trx) => {
          await loadTicket(trx, request.params.id);
          await markTicketRead(trx, {
            tenantId: actor.tenantId,
            ticketId: request.params.id,
            participantKind: 'TENANT_USER',
            userId: user.userId,
            seq: request.body.seq,
          });
        });
        return reply.code(204).send();
      },
    );

    app.post(
      '/v1/support-tickets/:id/status',
      { schema: { params: IdParams, body: StatusBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'support_tickets:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'support_tickets.status',
          async (trx) => {
            const ticket = await loadTicket(trx, request.params.id);
            const now = services.now();
            const status = request.body.status;
            await trx
              .updateTable('support_tickets')
              .set((eb) => ({
                status,
                resolved_at: status === 'RESOLVED' ? now : ticket.resolved_at,
                closed_at: status === 'CLOSED' ? now : null,
                version: eb('version', '+', 1),
                updated_at: now,
              }))
              .where('id', '=', ticket.id)
              .execute();
            await recordTicketEvent(trx, {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              kind: status === 'OPEN' ? 'reopened' : status.toLowerCase(),
              actorKind: 'TENANT_USER',
              actorUserId: user.userId,
              actorLabel: user.email,
            });
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'support_ticket.status_changed',
              objectType: 'support_ticket',
              objectId: ticket.id,
              metadata: { from: ticket.status, to: status },
            });
            const updated = await loadTicket(trx, ticket.id);
            return { status: 200, body: presentTicket(updated) };
          },
        );
      },
    );

    app.get('/v1/support-tickets/unread', async (request) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'support_tickets:read');
      const total = await inTenant(services, actor, request, async (trx) => {
        const rows = await trx
          .selectFrom('support_tickets')
          .select(['id', 'public_message_count'])
          .where('status', '<>', 'CLOSED')
          .execute();
        const seen = await readState(trx, user.userId, 'TENANT_USER');
        return rows.reduce(
          (sum, row) => sum + Math.max(row.public_message_count - (seen.get(row.id) ?? 0), 0),
          0,
        );
      });
      return { unread: total };
    });
  };
}
