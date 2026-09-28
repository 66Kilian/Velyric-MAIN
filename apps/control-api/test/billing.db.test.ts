import { randomUUID } from 'node:crypto';
import { PRICING_VERSION } from '@velyric/contracts';
import { stripeSignatureHeader } from '@velyric/security';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  browserHeaders,
  STRIPE_WEBHOOK_SECRET,
  TERMS_VERSION,
  useApiHarness,
  type TestUser,
} from './support/harness.js';

const harness = useApiHarness();

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

interface Tenant {
  readonly user: TestUser;
  readonly workspaceId: string;
}

const HU_PROFILE = {
  customer_type: 'BUSINESS',
  legal_name: 'Példa Étterem Kft.',
  country: 'HU',
  postal_code: '1051',
  city: 'Budapest',
  address_line1: 'Nádor utca 1.',
  billing_email: 'szamla@pelda.test',
  hu_tax_number: '12345678-2-41',
};

beforeAll(async () => {
  await harness().admin.query(
    `INSERT INTO app.price_books (pricing_version, market, currency, item_kind, plan_code, add_on_code, billing_interval, unit_amount_minor, stripe_price_id)
     VALUES ($1, 'HU', 'HUF', 'PLAN', 'START', NULL, 'MONTH', 3990000, 'price_start_hu'),
            ($1, 'HU', 'HUF', 'OVERAGE', 'START', NULL, 'METERED', 14900, 'price_start_hu_overage'),
            ($1, 'HU', 'HUF', 'ADD_ON', NULL, 'EXTRA_PHONE_NUMBER', 'MONTH', 250000, 'price_extra_number_hu')
     ON CONFLICT DO NOTHING`,
    [PRICING_VERSION],
  );
});

async function onboard(
  email: string,
  profile: Record<string, unknown> | null = HU_PROFILE,
): Promise<Tenant> {
  const user = harness().sessions.issue(email);
  const slug = `bill-${randomUUID().slice(0, 8)}`;
  const created = await harness().app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: browserHeaders(user, undefined, { 'idempotency-key': `ws-${randomUUID()}` }),
    payload: {
      legal_name: `${slug} Kft.`,
      display_name: slug,
      slug,
      default_locale: 'hu',
      timezone: 'Europe/Budapest',
      billing_market: 'HU',
      primary_location: { name: 'Budapest', country: 'HU', timezone: 'Europe/Budapest' },
    },
  });
  const workspaceId = created.json<{ id: string }>().id;
  if (profile !== null) {
    const saved = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(user, workspaceId),
      payload: profile,
    });
    expect(saved.statusCode, saved.body).toBe(201);
  }
  return { user, workspaceId };
}

async function checkout(
  tenant: Tenant,
  planCode = 'START',
  key = `checkout-${randomUUID()}`,
): Promise<LightMyRequestResponse> {
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/billing/checkout',
    headers: browserHeaders(tenant.user, tenant.workspaceId, { 'idempotency-key': key }),
    payload: { plan_code: planCode, terms_version: TERMS_VERSION, locale: 'hu' },
  });
  return response;
}

async function sendStripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: { id?: string; secret?: string; timestamp?: number; raw?: string } = {},
) {
  const id = options.id ?? `evt_${randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  const payload =
    options.raw ??
    JSON.stringify({
      id,
      object: 'event',
      type,
      created,
      livemode: false,
      api_version: '2026-08-26.dahlia',
      data: { object },
    });
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/webhooks/providers/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripeSignatureHeader(
        payload,
        options.secret ?? STRIPE_WEBHOOK_SECRET,
        options.timestamp ?? created,
      ),
    },
    payload,
  });
  return { id, response };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await harness().admin.query<{ n: number }>(sql, params);
  return result.rows[0]?.n ?? -1;
}

async function paidTenant(
  email: string,
): Promise<{ tenant: Tenant; customerId: string; subscriptionId: string; orderId: string }> {
  const tenant = await onboard(email);
  const started = await checkout(tenant);
  expect(started.statusCode, started.body).toBe(201);
  const orderId = started.json<{ order: { id: string } }>().order.id;
  const call = harness().stripe.checkoutCalls.find((entry) => entry.input.orderId === orderId);
  const session = [...harness().stripe.sessions.values()].find(
    (candidate) => candidate.metadata['internal_order_id'] === orderId,
  );
  if (call === undefined || session === undefined) {
    throw new Error('checkout session was not created');
  }
  const subscriptionId = `sub_${randomUUID().slice(0, 12)}`;
  harness().stripe.completeSession(
    session.id,
    3_990_000,
    subscriptionId,
    `in_${randomUUID().slice(0, 12)}`,
  );
  const completed = await sendStripeEvent('checkout.session.completed', {
    id: session.id,
    object: 'checkout.session',
    metadata: session.metadata,
  });
  expect(completed.response.statusCode, completed.response.body).toBe(200);
  return { tenant, customerId: call.input.customerId, subscriptionId, orderId };
}

function registerSubscription(
  subscriptionId: string,
  customerId: string,
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED',
): { start: Date; end: Date } {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-11-01T00:00:00Z');
  harness().stripe.subscriptions.set(subscriptionId, {
    id: subscriptionId,
    customerId,
    status,
    currency: 'huf',
    items: [
      {
        id: `si_${randomUUID().slice(0, 8)}`,
        priceId: 'price_start_hu',
        quantity: 1,
        periodStart: start,
        periodEnd: end,
      },
      {
        id: `si_${randomUUID().slice(0, 8)}`,
        priceId: 'price_start_hu_overage',
        quantity: 1,
        periodStart: start,
        periodEnd: end,
      },
    ],
    cancelAtPeriodEnd: false,
    canceledAt: status === 'CANCELED' ? new Date() : null,
    metadata: { plan_code: 'START', pricing_version: PRICING_VERSION },
  });
  return { start, end };
}

describe('billing profile', () => {
  it('requires Hungarian tax numbers, matching VAT prefixes and If-Match on updates', async () => {
    const tenant = await onboard('profile@example.test', null);
    const missingTax = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(tenant.user, tenant.workspaceId),
      payload: { ...HU_PROFILE, hu_tax_number: undefined },
    });
    expect(missingTax.json<Envelope>()).toMatchObject({
      code: 'BILLING_PROFILE_INCOMPLETE',
      details: { missing: ['hu_tax_number'] },
    });
    const badVat = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(tenant.user, tenant.workspaceId),
      payload: { ...HU_PROFILE, eu_vat_id: 'DE123456789' },
    });
    expect(badVat.json<Envelope>().code).toBe('VAT_ID_INVALID');
    const created = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(tenant.user, tenant.workspaceId),
      payload: HU_PROFILE,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('W/"1"');
    const noIfMatch = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(tenant.user, tenant.workspaceId),
      payload: HU_PROFILE,
    });
    expect(noIfMatch.json<Envelope>().code).toBe('PRECONDITION_REQUIRED');
    const updated = await harness().app.inject({
      method: 'PUT',
      url: '/v1/billing/profile',
      headers: browserHeaders(tenant.user, tenant.workspaceId, { 'if-match': 'W/"1"' }),
      payload: { ...HU_PROFILE, city: 'Szeged' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ city: string; billing_market: string }>()).toMatchObject({
      city: 'Szeged',
      billing_market: 'HU',
    });
  });
});

describe('checkout', () => {
  it('requires a billing profile, a self-serve plan, current terms and a configured price book', async () => {
    const noProfile = await onboard('noprofile@example.test', null);
    expect((await checkout(noProfile)).json<{ code: string }>().code).toBe(
      'BILLING_PROFILE_INCOMPLETE',
    );

    const hungarian = await onboard('enterprise@example.test');
    expect(JSON.parse((await checkout(hungarian, 'ENTERPRISE')).body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ rule: 'plan_not_self_serve' }] },
    });
    const staleTerms = await harness().app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: browserHeaders(hungarian.user, hungarian.workspaceId, {
        'idempotency-key': `terms-${randomUUID()}`,
      }),
      payload: { plan_code: 'START', terms_version: '2020-01-01', locale: 'hu' },
    });
    expect(staleTerms.json<Envelope>().code).toBe('VALIDATION_FAILED');

    const german = await onboard('de@example.test', {
      ...HU_PROFILE,
      country: 'DE',
      hu_tax_number: undefined,
      eu_vat_id: 'DE123456789',
      postal_code: '10115',
      city: 'Berlin',
    });
    expect((await checkout(german)).json<{ code: string }>().code).toBe('PRICE_BOOK_UNAVAILABLE');
  });

  it('creates one Stripe customer and session per order and never activates from the success redirect', async () => {
    const tenant = await onboard('checkout@example.test');
    const key = `checkout-${randomUUID()}`;
    const first = await checkout(tenant, 'START', key);
    expect(first.statusCode, first.body).toBe(201);
    const body = JSON.parse(first.body) as {
      order: { id: string; status: string; total: { amount_minor: number; currency: string } };
      checkout_url: string;
    };
    expect(body.order).toMatchObject({
      status: 'AWAITING_PAYMENT',
      total: { amount_minor: 3_990_000, currency: 'HUF' },
    });
    expect(body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const replay = await checkout(tenant, 'START', key);
    expect(replay.json<{ checkout_url: string }>().checkout_url).toBe(body.checkout_url);
    const calls = harness().stripe.checkoutCalls.filter(
      (call) => call.input.orderId === body.order.id,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.lineItems).toEqual([
      { price: 'price_start_hu', quantity: 1 },
      { price: 'price_start_hu_overage', quantity: null },
    ]);
    expect(calls[0]?.input.successUrl).toContain(`/app/onboarding/checkout/return?workspace=`);
    expect(calls[0]?.input.successUrl).toContain(`&order=${body.order.id}`);
    expect(
      harness().stripe.customerCalls.filter((call) => call.input.tenantId === tenant.workspaceId),
    ).toHaveLength(1);
    const polled = await harness().app.inject({
      method: 'GET',
      url: `/v1/billing/orders/${body.order.id}`,
      headers: browserHeaders(tenant.user, tenant.workspaceId),
    });
    expect(polled.json<{ status: string }>().status).toBe('AWAITING_PAYMENT');
    const second = await checkout(tenant);
    expect(second.statusCode).toBe(201);
  });

  it('replaces payment customers that the provider lost or handed out again', async () => {
    const storedCustomer = async (workspaceId: string): Promise<string | null> => {
      const result = await harness().admin.query<{ stripe_customer_id: string | null }>(
        'SELECT stripe_customer_id FROM app.billing_profiles WHERE tenant_id = $1',
        [workspaceId],
      );
      return result.rows[0]?.stripe_customer_id ?? null;
    };
    const existing = await onboard('customer-existing@example.test');
    expect((await checkout(existing)).statusCode).toBe(201);
    const taken = await storedCustomer(existing.workspaceId);
    expect(taken).not.toBeNull();

    const recycled = await onboard('customer-recycled@example.test');
    harness().stripe.recycledCustomerIds.push(taken ?? '');
    const afterRecycle = await checkout(recycled);
    expect(afterRecycle.statusCode, afterRecycle.body).toBe(201);
    const assigned = await storedCustomer(recycled.workspaceId);
    expect(assigned).not.toBeNull();
    expect(assigned).not.toBe(taken);

    harness().stripe.missingCustomers.add(assigned ?? '');
    const afterLoss = await checkout(recycled);
    expect(afterLoss.statusCode, afterLoss.body).toBe(201);
    const replaced = await storedCustomer(recycled.workspaceId);
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(assigned);
    expect(await storedCustomer(existing.workspaceId)).toBe(taken);
  });
});

describe('Stripe webhooks', () => {
  it('rejects forged, stale and malformed deliveries', async () => {
    const forged = await sendStripeEvent(
      'invoice.paid',
      { id: 'in_forged' },
      { secret: 'whsec_attacker' },
    );
    expect(forged.response.json<Envelope>().code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const stale = await sendStripeEvent(
      'invoice.paid',
      { id: 'in_stale' },
      { timestamp: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(stale.response.json<Envelope>().code).toBe('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE');
    const malformed = await sendStripeEvent('invoice.paid', {}, { raw: '{"id":"not-an-event"}' });
    expect(malformed.response.json<Envelope>().code).toBe('MALFORMED_REQUEST');
  });

  it('marks orders paid only from verified checkout events and deduplicates redeliveries', async () => {
    const { tenant, orderId } = await paidTenant('paid@example.test');
    const order = await harness().app.inject({
      method: 'GET',
      url: `/v1/billing/orders/${orderId}`,
      headers: browserHeaders(tenant.user, tenant.workspaceId),
    });
    expect(order.json<{ status: string }>().status).toBe('PAID');
    expect(
      await count('SELECT count(*)::int AS n FROM app.payment_events WHERE tenant_id = $1', [
        tenant.workspaceId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.billing_ledger_entries WHERE tenant_id = $1 AND entry_type = 'PAYMENT'`,
        [tenant.workspaceId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.outbox_events WHERE tenant_id = $1 AND event_type = 'checkout.order_paid'`,
        [tenant.workspaceId],
      ),
    ).toBe(1);

    const eventRow = await harness().admin.query<{ provider_event_id: string }>(
      `SELECT provider_event_id FROM app.provider_webhook_events WHERE tenant_id = $1 AND event_type = 'checkout.session.completed'`,
      [tenant.workspaceId],
    );
    const session = [...harness().stripe.sessions.values()].find(
      (candidate) => candidate.metadata['internal_order_id'] === orderId,
    );
    const redelivery = await sendStripeEvent(
      'checkout.session.completed',
      { id: session?.id, metadata: session?.metadata },
      { id: eventRow.rows[0]?.provider_event_id ?? '' },
    );
    expect(redelivery.response.json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect(
      await count('SELECT count(*)::int AS n FROM app.payment_events WHERE tenant_id = $1', [
        tenant.workspaceId,
      ]),
    ).toBe(1);
    const tenantRow = await harness().admin.query<{ status: string; plan_code: string }>(
      'SELECT status, plan_code FROM app.tenants WHERE id = $1',
      [tenant.workspaceId],
    );
    expect(tenantRow.rows[0]).toEqual({ status: 'PROVISIONING', plan_code: 'START' });
  });

  it('processes concurrent checkout, subscription and invoice events for one tenant', async () => {
    const tenant = await onboard('concurrent@example.test');
    const started = await checkout(tenant);
    expect(started.statusCode, started.body).toBe(201);
    const orderId = started.json<{ order: { id: string } }>().order.id;
    const call = harness().stripe.checkoutCalls.find((entry) => entry.input.orderId === orderId);
    const session = [...harness().stripe.sessions.values()].find(
      (candidate) => candidate.metadata['internal_order_id'] === orderId,
    );
    if (call === undefined || session === undefined) {
      throw new Error('checkout session was not created');
    }
    const customerId = call.input.customerId;
    const subscriptionId = `sub_${randomUUID().slice(0, 12)}`;
    const invoiceId = `in_${randomUUID().slice(0, 12)}`;
    harness().stripe.completeSession(session.id, 3_990_000, subscriptionId, invoiceId);
    const period = registerSubscription(subscriptionId, customerId, 'ACTIVE');
    harness().stripe.invoices.set(invoiceId, {
      id: invoiceId,
      customerId,
      subscriptionId,
      status: 'paid',
      amountPaid: 3_990_000,
      currency: 'huf',
      periodStart: period.start,
      periodEnd: period.end,
    });

    const responses = await Promise.all([
      sendStripeEvent('checkout.session.completed', {
        id: session.id,
        object: 'checkout.session',
        metadata: session.metadata,
      }),
      sendStripeEvent('customer.subscription.created', {
        id: subscriptionId,
        customer: customerId,
      }),
      sendStripeEvent('invoice.paid', { id: invoiceId, customer: customerId }),
    ]);
    for (const { response } of responses) {
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.checkout_orders WHERE id = $1 AND status = 'PAID'`,
        [orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.webhook_processing WHERE tenant_id = $1 AND status = 'PROCESSED'`,
        [tenant.workspaceId],
      ),
    ).toBe(3);
  });

  it('creates entitlements on invoice.paid, enters grace on failure and suspends on disputes without deleting configuration', async () => {
    const { tenant, customerId, subscriptionId } = await paidTenant('lifecycle@example.test');
    const period = registerSubscription(subscriptionId, customerId, 'ACTIVE');
    const invoiceId = `in_${randomUUID().slice(0, 12)}`;
    harness().stripe.invoices.set(invoiceId, {
      id: invoiceId,
      customerId,
      subscriptionId,
      status: 'paid',
      amountPaid: 3_990_000,
      currency: 'huf',
      periodStart: period.start,
      periodEnd: period.end,
    });
    const paid = await sendStripeEvent('invoice.paid', { id: invoiceId, customer: customerId });
    expect(paid.response.statusCode, paid.response.body).toBe(200);
    await sendStripeEvent('invoice.paid', { id: invoiceId, customer: customerId });
    const snapshots = await harness().admin.query<{
      version: number;
      concurrency_limit: number;
      included_voice_seconds: string;
      plan_code: string;
    }>(
      'SELECT version, concurrency_limit, included_voice_seconds, plan_code FROM app.entitlement_snapshots WHERE tenant_id = $1',
      [tenant.workspaceId],
    );
    expect(snapshots.rows).toEqual([
      { version: 1, concurrency_limit: 2, included_voice_seconds: '9000', plan_code: 'START' },
    ]);

    await harness().admin.query(`UPDATE app.tenants SET status = 'ACTIVE' WHERE id = $1`, [
      tenant.workspaceId,
    ]);
    await harness().app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: browserHeaders(tenant.user, tenant.workspaceId, {
        'idempotency-key': `agent-${randomUUID()}`,
      }),
      payload: { name: 'Recepció' },
    });

    registerSubscription(subscriptionId, customerId, 'PAST_DUE');
    const failedInvoice = `in_${randomUUID().slice(0, 12)}`;
    harness().stripe.invoices.set(failedInvoice, {
      id: failedInvoice,
      customerId,
      subscriptionId,
      status: 'open',
      amountPaid: 0,
      currency: 'huf',
      periodStart: period.end,
      periodEnd: new Date('2026-12-01T00:00:00Z'),
    });
    await sendStripeEvent('invoice.payment_failed', { id: failedInvoice, customer: customerId });
    const graced = await harness().admin.query<{ status: string }>(
      'SELECT status FROM app.tenants WHERE id = $1',
      [tenant.workspaceId],
    );
    expect(graced.rows[0]?.status).toBe('GRACE_PERIOD');
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.tenant_status_history WHERE tenant_id = $1 AND to_status = 'GRACE_PERIOD'`,
        [tenant.workspaceId],
      ),
    ).toBe(1);

    const subscription = await harness().app.inject({
      method: 'GET',
      url: '/v1/billing/subscription',
      headers: browserHeaders(tenant.user, tenant.workspaceId),
    });
    expect(subscription.json()).toMatchObject({
      subscription: { status: 'PAST_DUE', plan_code: 'START' },
      entitlement: { version: 1, concurrency_limit: 2 },
    });

    const disputeId = `dp_${randomUUID().slice(0, 12)}`;
    harness().stripe.disputes.set(disputeId, {
      id: disputeId,
      chargeId: 'ch_test',
      customerId,
      amount: 3_990_000,
      currency: 'huf',
      reason: 'fraudulent',
      status: 'needs_response',
      evidenceDueBy: new Date('2026-10-20T00:00:00Z'),
    });
    await sendStripeEvent('charge.dispute.created', { id: disputeId, charge: 'ch_test' });
    const disputed = await harness().admin.query<{ status: string }>(
      'SELECT status FROM app.tenants WHERE id = $1',
      [tenant.workspaceId],
    );
    expect(disputed.rows[0]?.status).toBe('SUSPENDED_DISPUTE');
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.legal_holds WHERE tenant_id = $1 AND scope_type = 'DISPUTE' AND released_at IS NULL`,
        [tenant.workspaceId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.disputes WHERE tenant_id = $1 AND status = 'NEEDS_RESPONSE'`,
        [tenant.workspaceId],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::int AS n FROM app.agents WHERE tenant_id = $1', [
        tenant.workspaceId,
      ]),
    ).toBe(1);
  });

  it('moves canceled subscriptions into cancellation grace and dead-letters unmatched events', async () => {
    const { tenant, customerId, subscriptionId } = await paidTenant('cancel@example.test');
    await harness().admin.query(`UPDATE app.tenants SET status = 'ACTIVE' WHERE id = $1`, [
      tenant.workspaceId,
    ]);
    registerSubscription(subscriptionId, customerId, 'CANCELED');
    const deleted = await sendStripeEvent('customer.subscription.deleted', {
      id: subscriptionId,
      customer: customerId,
      metadata: { tenant_id: tenant.workspaceId },
    });
    expect(deleted.response.statusCode, deleted.response.body).toBe(200);
    const canceled = await harness().admin.query<{ status: string }>(
      'SELECT status FROM app.tenants WHERE id = $1',
      [tenant.workspaceId],
    );
    expect(canceled.rows[0]?.status).toBe('CANCELED_GRACE');

    const orphan = await sendStripeEvent('checkout.session.completed', {
      id: 'cs_orphan',
      metadata: { tenant_id: randomUUID() },
    });
    expect(orphan.response.statusCode).toBe(200);
    const processing = await harness().admin.query<{ status: string; last_error_code: string }>(
      `SELECT p.status, p.last_error_code FROM app.webhook_processing p JOIN app.provider_webhook_events e ON e.id = p.webhook_event_id WHERE e.provider_event_id = $1`,
      [orphan.id],
    );
    expect(processing.rows[0]).toEqual({
      status: 'DEAD_LETTER',
      last_error_code: 'TENANT_UNRESOLVED',
    });
  });
});
