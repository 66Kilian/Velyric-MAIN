import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedPlatformStaff, seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
let tenant: SeededTenant;
let staff: Awaited<ReturnType<typeof seedPlatformStaff>>;

function write(user: TestUser, workspace?: string): Record<string, string> {
  return browserHeaders(user, workspace, { 'idempotency-key': `ticket-${randomUUID()}` });
}

async function openTicket(subject = 'A hívás megszakad'): Promise<string> {
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/support-tickets',
    headers: write(tenant.owner, tenant.tenantId),
    payload: { subject, body: 'Tegnap óta minden második hívás megszakad.', category: 'TECHNICAL' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
  staff = await seedPlatformStaff(harness(), 'SUPPORT_AGENT');
});

describe('customer support tickets', () => {
  it('opens a ticket, keeps the first message and queues the confirmation email', async () => {
    const id = await openTicket();
    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json<{
      reference: string;
      status: string;
      messages: { seq: number; author_kind: string; body: string }[];
      events: { kind: string }[];
    }>();
    expect(body.reference).toMatch(/^VLY-[0-9A-F]{8}$/);
    expect(body.status).toBe('PENDING_STAFF');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ seq: 1, author_kind: 'TENANT_USER' });
    expect(body.events.map((event) => event.kind)).toContain('opened');

    const outbox = await harness().admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'notification.requested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(outbox.rows[0]?.payload).toMatchObject({
      notification_type: 'SUPPORT_REQUEST_RECEIVED',
    });
  });

  it('never shows one workspace the tickets of another', async () => {
    const id = await openTicket('Csak nekünk látszik');
    const other = await seedRuntimeTenant(harness());
    const list = await harness().app.inject({
      method: 'GET',
      url: '/v1/support-tickets',
      headers: browserHeaders(other.owner, other.tenantId),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ data: { id: string }[] }>().data.map((row) => row.id)).not.toContain(id);

    const direct = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(other.owner, other.tenantId),
    });
    expect(direct.statusCode).toBe(404);
  });

  it('refuses a rank that has no ticket permission', async () => {
    const id = await openTicket();
    const analyst = harness().sessions.issue(`analyst-${randomUUID().slice(0, 6)}@example.test`);
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(analyst),
    });
    await harness().admin.query(
      `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'ANALYST', 'ACTIVE')`,
      [tenant.tenantId, me.json<{ user: { id: string } }>().user.id],
    );
    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(analyst, tenant.tenantId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('tracks unread counts per person and clears them on read', async () => {
    const id = await openTicket('Olvasottság');
    await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/messages`,
      headers: write(staff.user),
      payload: { body: 'Megnéztük, holnap javítjuk.' },
    });
    const before = await harness().app.inject({
      method: 'GET',
      url: '/v1/support-tickets',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const ticket = before
      .json<{ data: { id: string; unread: number; message_count: number }[] }>()
      .data.find((row) => row.id === id);
    expect(ticket?.unread).toBe(1);

    const unread = await harness().app.inject({
      method: 'GET',
      url: '/v1/support-tickets/unread',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(unread.json<{ unread: number }>().unread).toBeGreaterThanOrEqual(1);

    const marked = await harness().app.inject({
      method: 'POST',
      url: `/v1/support-tickets/${id}/read`,
      headers: write(tenant.owner, tenant.tenantId),
      payload: { seq: ticket?.message_count ?? 2 },
    });
    expect(marked.statusCode).toBe(204);
    const after = await harness().app.inject({
      method: 'GET',
      url: '/v1/support-tickets',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(
      after.json<{ data: { id: string; unread: number }[] }>().data.find((row) => row.id === id)
        ?.unread,
    ).toBe(0);
  });

  it('keeps the transcript after closing and refuses new messages', async () => {
    const id = await openTicket('Lezárás');
    const closed = await harness().app.inject({
      method: 'POST',
      url: `/v1/support-tickets/${id}/status`,
      headers: write(tenant.owner, tenant.tenantId),
      payload: { status: 'CLOSED' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'CLOSED' });

    const late = await harness().app.inject({
      method: 'POST',
      url: `/v1/support-tickets/${id}/messages`,
      headers: write(tenant.owner, tenant.tenantId),
      payload: { body: 'Mégis van még egy kérdésem.' },
    });
    expect(late.statusCode).toBe(409);

    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json<{ messages: unknown[] }>().messages.length).toBeGreaterThan(0);
  });

  it('cannot be rewritten: ticket messages are append only', async () => {
    const id = await openTicket('Nem szerkeszthető');
    await expect(
      harness().admin.query(
        `UPDATE app.support_ticket_messages SET body = 'x' WHERE ticket_id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      harness().admin.query(`DELETE FROM app.support_ticket_messages WHERE ticket_id = $1`, [id]),
    ).rejects.toThrow();
  });
});

describe('staff ticket queue', () => {
  it('lists tickets across workspaces and opens one with workspace context', async () => {
    const id = await openTicket('Sorban áll');
    const queue = await harness().app.inject({
      method: 'GET',
      url: '/v1/admin/tickets',
      headers: browserHeaders(staff.user),
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const row = queue
      .json<{ data: { id: string; workspace_name: string; reference: string }[] }>()
      .data.find((entry) => entry.id === id);
    expect(row).toBeDefined();
    expect(row?.workspace_name.length).toBeGreaterThan(0);

    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tickets/${id}`,
      headers: browserHeaders(staff.user),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ workspace_status: string | null }>().workspace_status).not.toBeNull();
    expect(detail.json<{ opened_by: string | null }>().opened_by).toBe(tenant.owner.session.email);

    const counts = await harness().app.inject({
      method: 'GET',
      url: '/v1/admin/tickets/counts',
      headers: browserHeaders(staff.user),
    });
    expect(
      counts.json<{ data: { status: string; total: number }[] }>().data.length,
    ).toBeGreaterThan(0);
  });

  it('hides internal notes from the customer but keeps them for staff', async () => {
    const id = await openTicket('Belső jegyzet');
    const note = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/messages`,
      headers: write(staff.user),
      payload: { body: 'Belső: a szám Telnyx oldalon akadt el.', internal: true },
    });
    expect(note.statusCode, note.body).toBe(201);

    const customerView = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    const customerBody = customerView.json<{
      messages: { body: string }[];
      message_count: number;
      status: string;
    }>();
    expect(customerBody.messages.every((message) => !message.body.startsWith('Belső'))).toBe(true);
    expect(customerBody.message_count).toBe(1);
    expect(customerBody.status).toBe('PENDING_STAFF');

    const staffView = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tickets/${id}`,
      headers: browserHeaders(staff.user),
    });
    expect(
      staffView
        .json<{ messages: { visibility: string }[] }>()
        .messages.some((message) => message.visibility === 'INTERNAL_NOTE'),
    ).toBe(true);
  });

  it('replies, flips the status to the customer and notifies them', async () => {
    const id = await openTicket('Válasz');
    const reply = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/messages`,
      headers: write(staff.user),
      payload: { body: 'Megjavítottuk, kérlek próbáld újra.' },
    });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(reply.json()).toMatchObject({ author_kind: 'STAFF', author_label: 'Velyric' });

    const customerView = await harness().app.inject({
      method: 'GET',
      url: `/v1/support-tickets/${id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(customerView.json()).toMatchObject({ status: 'PENDING_CUSTOMER' });

    const outbox = await harness().admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'notification.requested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(outbox.rows[0]?.payload).toMatchObject({ notification_type: 'SUPPORT_REQUEST_UPDATED' });

    const audit = await harness().admin.query<{ action: string; actor_label: string | null }>(
      `SELECT action, actor_label FROM app.audit_logs WHERE tenant_id = $1 AND action = 'support_ticket.replied' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(audit.rows[0]).toMatchObject({ actor_label: staff.email });
  });

  it('assigns and reprioritises a ticket', async () => {
    const id = await openTicket('Kiosztás');
    const assigned = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/assign`,
      headers: write(staff.user),
      payload: { staff_user_id: staff.userId },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toMatchObject({ assigned_staff_user_id: staff.userId });

    const prioritised = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/status`,
      headers: write(staff.user),
      payload: { priority: 'URGENT' },
    });
    expect(prioritised.statusCode, prioritised.body).toBe(200);
    expect(prioritised.json()).toMatchObject({ priority: 'URGENT' });

    const mine = await harness().app.inject({
      method: 'GET',
      url: `/v1/admin/tickets?assigned_to=${staff.userId}`,
      headers: browserHeaders(staff.user),
    });
    expect(mine.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toContain(id);
  });

  it('keeps the queue away from customers and from staff without the permission', async () => {
    const customer = await harness().app.inject({
      method: 'GET',
      url: '/v1/admin/tickets',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(customer.statusCode).toBe(403);

    const finance = await seedPlatformStaff(harness(), 'FINANCE_OPS');
    const id = await openTicket('Pénzügyes nem válaszolhat');
    const reply = await harness().app.inject({
      method: 'POST',
      url: `/v1/admin/tickets/${id}/messages`,
      headers: write(finance.user),
      payload: { body: 'Nem lenne szabad' },
    });
    expect(reply.statusCode).toBe(403);
  });
});
