import { PlanCode, type AddOnCode, type TenantStatus } from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import {
  billingMarketForCountry,
  buildEntitlement,
  nextTenantStatus,
  TenantTransitionError,
  type AddOnSelection,
  type TenantLifecycleEvent,
} from '@velyric/domain';
import { sha256Hex, verifyStripeSignature } from '@velyric/security';
import { sql, type Kysely } from 'kysely';
import { headerValue, type RouteModule } from '../app.js';
import type { StripeGateway, VerifiedSubscription } from '../billing/stripe-gateway.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, type Trx } from '../persistence.js';
import { domainSubject } from './common.js';

export interface StripeWebhookDependencies {
  readonly stripe: StripeGateway;
  readonly webhookSecrets: () => readonly string[];
}

interface StripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly object: Readonly<Record<string, unknown>>;
}

type Outcome = 'PROCESSED' | 'IGNORED';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_CODES: ReadonlySet<string> = new Set(Object.values(PlanCode));
const MAX_WEBHOOK_ATTEMPTS = 3;
const LIVE_SUBSCRIPTION_STATUSES = [
  'INCOMPLETE',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'PAUSED',
] as const;

function parseEvent(body: unknown): StripeEventEnvelope {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('MALFORMED_REQUEST');
  }
  const record = body as Record<string, unknown>;
  const data = record['data'];
  const object =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)['object']
      : undefined;
  if (
    typeof record['id'] !== 'string' ||
    !record['id'].startsWith('evt_') ||
    typeof record['type'] !== 'string' ||
    typeof record['created'] !== 'number' ||
    typeof record['livemode'] !== 'boolean' ||
    typeof object !== 'object' ||
    object === null
  ) {
    throw new ApiError('MALFORMED_REQUEST');
  }
  return {
    id: record['id'],
    type: record['type'],
    created: record['created'],
    livemode: record['livemode'],
    object: object as Record<string, unknown>,
  };
}

function stringField(object: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function metadataTenant(object: Readonly<Record<string, unknown>>): string | null {
  const metadata = object['metadata'];
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const tenantId = (metadata as Record<string, unknown>)['tenant_id'];
  return typeof tenantId === 'string' && UUID_PATTERN.test(tenantId) ? tenantId : null;
}

async function tenantExists(db: Kysely<DB>, tenantId: string): Promise<boolean> {
  const row = await db
    .selectFrom('tenant_directory')
    .select(['id'])
    .where('id', '=', tenantId)
    .executeTakeFirst();
  return row !== undefined;
}

async function tenantForCustomer(
  db: Kysely<DB>,
  customerId: string | null,
): Promise<string | null> {
  if (customerId === null) {
    return null;
  }
  const row = await db
    .selectFrom('billing_customer_directory')
    .select(['tenant_id'])
    .where('stripe_customer_id', '=', customerId)
    .executeTakeFirst();
  return row?.tenant_id ?? null;
}

async function resolveTenant(
  db: Kysely<DB>,
  stripe: StripeGateway,
  event: StripeEventEnvelope,
): Promise<string | null> {
  const fromMetadata = metadataTenant(event.object);
  if (fromMetadata !== null && (await tenantExists(db, fromMetadata))) {
    return fromMetadata;
  }
  if (event.type.startsWith('charge.dispute.')) {
    const id = stringField(event.object, 'id');
    return id === null
      ? null
      : tenantForCustomer(db, (await stripe.retrieveDispute(id)).customerId);
  }
  return tenantForCustomer(db, stringField(event.object, 'customer'));
}

async function transitionTenant(
  trx: Trx,
  tenantId: string,
  lifecycleEvent: TenantLifecycleEvent,
  reason: string,
  sourceEventId: string,
  traceId: string,
): Promise<void> {
  const tenant = await trx
    .selectFrom('tenants')
    .select(['status', 'version'])
    .where('id', '=', tenantId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const from = tenant.status as TenantStatus;
  let to: TenantStatus;
  try {
    to = nextTenantStatus(from, lifecycleEvent);
  } catch (error) {
    if (error instanceof TenantTransitionError) {
      return;
    }
    throw error;
  }
  if (to === from) {
    return;
  }
  await trx
    .updateTable('tenants')
    .set({
      status: to,
      status_reason: reason,
      status_changed_at: new Date(),
      version: tenant.version + 1,
    })
    .where('id', '=', tenantId)
    .execute();
  await trx
    .insertInto('tenant_status_history')
    .values({
      id: newId(),
      tenant_id: tenantId,
      from_status: from,
      to_status: to,
      reason,
      actor_type: 'PROVIDER_WEBHOOK',
      actor_id: 'stripe',
      source_event_id: sourceEventId,
    })
    .execute();
  await appendOutbox(trx, {
    tenantId,
    eventType: 'tenant.status_changed',
    subject: domainSubject(tenantId, 'tenant.status_changed'),
    payload: { tenant_id: tenantId, from_status: from, to_status: to, reason },
    traceId,
  });
}

async function recordPayment(
  trx: Trx,
  tenantId: string,
  event: StripeEventEnvelope,
  details: {
    objectId: string;
    orderId: string | null;
    amountMinor: number | null;
    currency: string | null;
    invoiceId: string | null;
  },
): Promise<void> {
  const currency = details.currency === null ? null : details.currency.toUpperCase();
  await trx
    .insertInto('payment_events')
    .values({
      id: newId(),
      stripe_event_id: event.id,
      tenant_id: tenantId,
      event_type: event.type,
      object_id: details.objectId,
      order_id: details.orderId,
      amount_minor: details.amountMinor,
      currency,
      livemode: event.livemode,
      stripe_created_at: new Date(event.created * 1000),
      redacted_payload: JSON.stringify({
        id: event.id,
        type: event.type,
        object_id: details.objectId,
      }),
    })
    .onConflict((conflict) => conflict.column('stripe_event_id').doNothing())
    .execute();
  if (details.amountMinor !== null && details.amountMinor > 0 && currency !== null) {
    await trx
      .insertInto('billing_ledger_entries')
      .values({
        id: newId(),
        tenant_id: tenantId,
        entry_type: 'PAYMENT',
        amount_minor: details.amountMinor,
        currency,
        order_id: details.orderId,
        stripe_invoice_id: details.invoiceId,
        stripe_object_id: details.objectId,
        description_key: 'ledger.payment_received',
        idempotency_key: `stripe:${event.id}`,
        occurred_at: new Date(event.created * 1000),
      })
      .onConflict((conflict) => conflict.columns(['tenant_id', 'idempotency_key']).doNothing())
      .execute();
  }
}

async function upsertSubscription(
  trx: Trx,
  tenantId: string,
  subscription: VerifiedSubscription,
  eventCreated: number,
): Promise<{ id: string; planCode: PlanCode; addOns: AddOnSelection[] }> {
  const prices = await trx
    .selectFrom('price_books')
    .select(['stripe_price_id', 'item_kind', 'plan_code', 'add_on_code', 'pricing_version'])
    .where('stripe_price_id', 'in', subscription.items.map((item) => item.priceId).concat(['']))
    .execute();
  const byPrice = new Map(prices.map((price) => [price.stripe_price_id, price]));
  const planItem = subscription.items.find(
    (item) => byPrice.get(item.priceId)?.item_kind === 'PLAN',
  );
  const planRow = planItem === undefined ? undefined : byPrice.get(planItem.priceId);
  const metadataPlan = subscription.metadata['plan_code'];
  const planCodeRaw = planRow?.plan_code ?? metadataPlan ?? null;
  if (planCodeRaw === null || !PLAN_CODES.has(planCodeRaw) || planItem === undefined) {
    throw new ApiError('PRICE_BOOK_UNAVAILABLE', { subscription: subscription.id });
  }
  const planCode = planCodeRaw as PlanCode;
  const addOns: AddOnSelection[] = subscription.items
    .map((item) => ({ row: byPrice.get(item.priceId), quantity: item.quantity }))
    .filter((entry) => entry.row?.item_kind === 'ADD_ON' && entry.row.add_on_code !== null)
    .map((entry) => ({ code: entry.row?.add_on_code as AddOnCode, quantity: entry.quantity }));
  const eventTime = new Date(eventCreated * 1000);
  const values = {
    stripe_customer_id: subscription.customerId,
    status: subscription.status,
    plan_code: planCode,
    pricing_version: planRow?.pricing_version ?? subscription.metadata['pricing_version'] ?? '',
    currency: subscription.currency.toUpperCase(),
    current_period_start: planItem.periodStart,
    current_period_end: planItem.periodEnd,
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    canceled_at: subscription.canceledAt,
    last_stripe_event_created_at: eventTime,
  };
  const existing = await trx
    .selectFrom('subscriptions')
    .select(['id', 'last_stripe_event_created_at'])
    .where('stripe_subscription_id', '=', subscription.id)
    .forUpdate()
    .executeTakeFirst();
  if (existing === undefined) {
    const id = newId();
    await trx
      .insertInto('subscriptions')
      .values({ id, tenant_id: tenantId, stripe_subscription_id: subscription.id, ...values })
      .execute();
    return { id, planCode, addOns };
  }
  if (
    existing.last_stripe_event_created_at === null ||
    existing.last_stripe_event_created_at.getTime() <= eventTime.getTime()
  ) {
    await trx.updateTable('subscriptions').set(values).where('id', '=', existing.id).execute();
  }
  return { id: existing.id, planCode, addOns };
}

async function createEntitlementSnapshot(
  trx: Trx,
  tenantId: string,
  subscriptionRowId: string,
  planCode: PlanCode,
  addOns: readonly AddOnSelection[],
  period: { start: Date; end: Date },
  sourceRef: string,
  traceId: string,
): Promise<void> {
  const profile = await trx
    .selectFrom('billing_profiles')
    .select(['country'])
    .executeTakeFirstOrThrow();
  const draft = buildEntitlement(
    planCode,
    billingMarketForCountry(profile.country),
    addOns,
    period,
  );
  const latest = await trx
    .selectFrom('entitlement_snapshots')
    .select((eb) => eb.fn.max('version').as('max_version'))
    .executeTakeFirst();
  const version = (latest?.max_version ?? 0) + 1;
  const inserted = await trx
    .insertInto('entitlement_snapshots')
    .values({
      id: newId(),
      tenant_id: tenantId,
      version,
      plan_code: draft.planCode,
      pricing_version: draft.pricingVersion,
      billing_period_start: period.start,
      billing_period_end: period.end,
      effective_from: new Date(),
      included_voice_seconds: draft.includedVoiceSeconds,
      overage_minor_per_minute: draft.overageMinorPerMinute,
      currency: draft.currency,
      concurrency_limit: draft.concurrencyLimit,
      burst_policy: draft.burstPolicy,
      features: JSON.stringify(draft.features),
      limits: JSON.stringify(draft.limits),
      source_kind: 'STRIPE_EVENT',
      source_ref: sourceRef,
    })
    .onConflict((conflict) =>
      conflict.columns(['tenant_id', 'source_kind', 'source_ref']).doNothing(),
    )
    .returning(['version'])
    .executeTakeFirst();
  if (inserted === undefined) {
    return;
  }
  await trx
    .updateTable('subscriptions')
    .set({ entitlement_version: version })
    .where('id', '=', subscriptionRowId)
    .execute();
  await trx
    .updateTable('tenants')
    .set({ plan_code: planCode })
    .where('id', '=', tenantId)
    .execute();
  await appendOutbox(trx, {
    tenantId,
    eventType: 'entitlement.snapshot_created',
    subject: domainSubject(tenantId, 'entitlement.snapshot_created'),
    payload: {
      tenant_id: tenantId,
      entitlement_version: version,
      plan_code: planCode,
      concurrency_limit: draft.concurrencyLimit,
    },
    traceId,
  });
}

interface HandlerContext {
  readonly trx: Trx;
  readonly tenantId: string;
  readonly event: StripeEventEnvelope;
  readonly webhookEventId: string;
  readonly stripe: StripeGateway;
  readonly traceId: string;
}

async function handleCheckoutCompleted(context: HandlerContext): Promise<Outcome> {
  const { trx, tenantId, event, stripe } = context;
  const sessionId = stringField(event.object, 'id');
  if (sessionId === null) {
    return 'IGNORED';
  }
  const session = await stripe.retrieveCheckoutSession(sessionId);
  const orderId = session.metadata['internal_order_id'];
  if (
    orderId === undefined ||
    !UUID_PATTERN.test(orderId) ||
    session.status !== 'complete' ||
    session.paymentStatus === 'unpaid'
  ) {
    return 'IGNORED';
  }
  const order = await trx
    .selectFrom('checkout_orders')
    .selectAll()
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
  if (order === undefined || order.stripe_checkout_session_id !== session.id) {
    return 'IGNORED';
  }
  if (order.status === 'PAID') {
    return 'PROCESSED';
  }
  if (
    session.currency === null ||
    session.currency.toUpperCase() !== order.currency ||
    session.amountTotal === null
  ) {
    throw new ApiError('CONFLICT', { reason: 'checkout_amount_mismatch' });
  }
  const tax = Math.max(0, session.amountTax);
  await trx
    .updateTable('checkout_orders')
    .set({
      status: 'PAID',
      paid_at: new Date(event.created * 1000),
      stripe_subscription_id: session.subscriptionId,
      stripe_invoice_id: session.invoiceId,
      subtotal_minor: session.amountTotal - tax,
      tax_minor: tax,
      total_minor: session.amountTotal,
      version: order.version + 1,
    })
    .where('id', '=', order.id)
    .execute();
  await recordPayment(trx, tenantId, event, {
    objectId: session.id,
    orderId: order.id,
    amountMinor: session.amountTotal,
    currency: session.currency,
    invoiceId: session.invoiceId,
  });
  await transitionTenant(
    trx,
    tenantId,
    'CHECKOUT_PAID',
    'checkout_paid',
    context.webhookEventId,
    context.traceId,
  );
  await trx
    .updateTable('tenants')
    .set({ plan_code: order.plan_code })
    .where('id', '=', tenantId)
    .execute();
  await appendOutbox(trx, {
    tenantId,
    eventType: 'checkout.order_paid',
    subject: domainSubject(tenantId, 'checkout.order_paid'),
    payload: {
      tenant_id: tenantId,
      order_id: order.id,
      plan_code: order.plan_code,
      stripe_subscription_id: session.subscriptionId,
      stripe_invoice_id: session.invoiceId,
    },
    traceId: context.traceId,
  });
  return 'PROCESSED';
}

async function handleInvoice(context: HandlerContext, paid: boolean): Promise<Outcome> {
  const { trx, tenantId, event, stripe } = context;
  const invoiceId = stringField(event.object, 'id');
  if (invoiceId === null) {
    return 'IGNORED';
  }
  const invoice = await stripe.retrieveInvoice(invoiceId);
  if (invoice.subscriptionId === null) {
    return 'IGNORED';
  }
  const subscription = await stripe.retrieveSubscription(invoice.subscriptionId);
  const row = await upsertSubscription(trx, tenantId, subscription, event.created);
  if (!paid) {
    await transitionTenant(
      trx,
      tenantId,
      'RENEWAL_PAYMENT_FAILED',
      `invoice_payment_failed:${invoice.id}`,
      context.webhookEventId,
      context.traceId,
    );
    await appendOutbox(trx, {
      tenantId,
      eventType: 'subscription.updated',
      subject: domainSubject(tenantId, 'subscription.updated'),
      payload: {
        tenant_id: tenantId,
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        stripe_invoice_id: invoice.id,
        payment_failed: true,
      },
      traceId: context.traceId,
    });
    return 'PROCESSED';
  }
  if (invoice.status !== 'paid') {
    return 'IGNORED';
  }
  const order = await trx
    .selectFrom('checkout_orders')
    .select(['id'])
    .where('stripe_subscription_id', '=', subscription.id)
    .executeTakeFirst();
  await recordPayment(trx, tenantId, event, {
    objectId: invoice.id,
    orderId: order?.id ?? null,
    amountMinor: invoice.amountPaid,
    currency: invoice.currency,
    invoiceId: invoice.id,
  });
  await createEntitlementSnapshot(
    trx,
    tenantId,
    row.id,
    row.planCode,
    row.addOns,
    { start: invoice.periodStart, end: invoice.periodEnd },
    invoice.id,
    context.traceId,
  );
  await transitionTenant(
    trx,
    tenantId,
    'INVOICE_PAID',
    `invoice_paid:${invoice.id}`,
    context.webhookEventId,
    context.traceId,
  );
  await appendOutbox(trx, {
    tenantId,
    eventType: 'subscription.updated',
    subject: domainSubject(tenantId, 'subscription.updated'),
    payload: {
      tenant_id: tenantId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      stripe_invoice_id: invoice.id,
      invoice_paid: true,
    },
    traceId: context.traceId,
  });
  return 'PROCESSED';
}

async function handleSubscriptionChange(
  context: HandlerContext,
  deleted: boolean,
): Promise<Outcome> {
  const { trx, tenantId, event, stripe } = context;
  const subscriptionId = stringField(event.object, 'id');
  if (subscriptionId === null) {
    return 'IGNORED';
  }
  const subscription = await stripe.retrieveSubscription(subscriptionId);
  const before = await trx
    .selectFrom('subscriptions')
    .select(['plan_code'])
    .where('stripe_subscription_id', '=', subscriptionId)
    .executeTakeFirst();
  const row = await upsertSubscription(trx, tenantId, subscription, event.created);
  if (deleted || subscription.status === 'CANCELED') {
    await transitionTenant(
      trx,
      tenantId,
      'SUBSCRIPTION_CANCELED',
      `subscription_canceled:${subscriptionId}`,
      context.webhookEventId,
      context.traceId,
    );
  } else if (
    before !== undefined &&
    before.plan_code !== row.planCode &&
    (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)
  ) {
    const planItem = subscription.items[0];
    if (planItem !== undefined) {
      await createEntitlementSnapshot(
        trx,
        tenantId,
        row.id,
        row.planCode,
        row.addOns,
        { start: planItem.periodStart, end: planItem.periodEnd },
        `${subscriptionId}:${event.id}`,
        context.traceId,
      );
    }
  }
  await appendOutbox(trx, {
    tenantId,
    eventType: 'subscription.updated',
    subject: domainSubject(tenantId, 'subscription.updated'),
    payload: {
      tenant_id: tenantId,
      stripe_subscription_id: subscriptionId,
      status: subscription.status,
      plan_code: row.planCode,
    },
    traceId: context.traceId,
  });
  return 'PROCESSED';
}

async function handleDisputeCreated(context: HandlerContext): Promise<Outcome> {
  const { trx, tenantId, event, stripe } = context;
  const disputeId = stringField(event.object, 'id');
  if (disputeId === null) {
    return 'IGNORED';
  }
  const dispute = await stripe.retrieveDispute(disputeId);
  const currency = dispute.currency.toUpperCase();
  const inserted = await trx
    .insertInto('disputes')
    .values({
      id: newId(),
      tenant_id: tenantId,
      stripe_dispute_id: dispute.id,
      stripe_charge_id: dispute.chargeId,
      amount_minor: dispute.amount,
      currency,
      reason: dispute.reason,
      status: dispute.status.toUpperCase(),
      evidence_due_by: dispute.evidenceDueBy,
    })
    .onConflict((conflict) => conflict.column('stripe_dispute_id').doNothing())
    .returning(['id'])
    .executeTakeFirst();
  if (inserted !== undefined) {
    await trx
      .insertInto('legal_holds')
      .values({
        id: newId(),
        tenant_id: tenantId,
        scope_type: 'DISPUTE',
        scope_ref: inserted.id,
        reason: `Stripe dispute ${dispute.id} evidence retention`,
        legal_basis: 'chargeback_dispute',
        created_by: 'stripe-webhook',
      })
      .execute();
    await trx
      .insertInto('billing_ledger_entries')
      .values({
        id: newId(),
        tenant_id: tenantId,
        entry_type: 'DISPUTE_HOLD',
        amount_minor: -dispute.amount,
        currency,
        stripe_object_id: dispute.id,
        description_key: 'ledger.dispute_opened',
        idempotency_key: `stripe:${event.id}`,
        occurred_at: new Date(event.created * 1000),
      })
      .onConflict((conflict) => conflict.columns(['tenant_id', 'idempotency_key']).doNothing())
      .execute();
  }
  await transitionTenant(
    trx,
    tenantId,
    'DISPUTE_OPENED',
    `dispute_opened:${dispute.id}`,
    context.webhookEventId,
    context.traceId,
  );
  return 'PROCESSED';
}

const HANDLERS: Readonly<Record<string, (context: HandlerContext) => Promise<Outcome>>> = {
  'checkout.session.completed': handleCheckoutCompleted,
  'checkout.session.async_payment_succeeded': handleCheckoutCompleted,
  'invoice.paid': (context) => handleInvoice(context, true),
  'invoice.payment_failed': (context) => handleInvoice(context, false),
  'customer.subscription.created': (context) => handleSubscriptionChange(context, false),
  'customer.subscription.updated': (context) => handleSubscriptionChange(context, false),
  'customer.subscription.deleted': (context) => handleSubscriptionChange(context, true),
  'charge.dispute.created': handleDisputeCreated,
};

export function createStripeWebhookRoutes(deps: StripeWebhookDependencies): RouteModule {
  return (app, services) => {
    app.post('/v1/webhooks/providers/stripe', async (request, reply) => {
      const raw = request.rawBody;
      if (raw === null) {
        throw new ApiError('MALFORMED_REQUEST');
      }
      verifyStripeSignature(
        raw,
        headerValue(request.headers['stripe-signature']),
        deps.webhookSecrets(),
      );
      const event = parseEvent(request.body);
      const tenantId = await resolveTenant(services.db, deps.stripe, event);
      const eventRow = {
        provider: 'stripe',
        provider_event_id: event.id,
        event_type: event.type,
        signature_verified: true,
        signature_scheme: 'stripe-v1',
        occurred_at: new Date(event.created * 1000),
        payload_sha256: sha256Hex(raw),
        redacted_payload: JSON.stringify({
          id: event.id,
          type: event.type,
          object_id: stringField(event.object, 'id'),
          livemode: event.livemode,
        }),
      };

      if (tenantId === null) {
        const duplicate = await services.db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto('provider_webhook_events')
            .values({ id: newId(), tenant_id: null, ...eventRow })
            .onConflict((conflict) =>
              conflict.columns(['provider', 'provider_event_id']).doNothing(),
            )
            .returning(['id'])
            .executeTakeFirst();
          if (inserted === undefined) {
            return true;
          }
          const handled = HANDLERS[event.type] !== undefined;
          await trx
            .insertInto('webhook_processing')
            .values({
              webhook_event_id: inserted.id,
              tenant_id: null,
              status: handled ? 'DEAD_LETTER' : 'IGNORED',
              attempts: 1,
              last_error_code: handled ? 'TENANT_UNRESOLVED' : null,
              processed_at: new Date(),
            })
            .execute();
          if (handled) {
            request.log.error(
              { stripe_event_id: event.id, event_type: event.type, trace_id: request.traceId },
              'stripe event could not be matched to a tenant',
            );
          }
          return false;
        });
        return reply.code(200).send({ received: true, duplicate });
      }

      const processEvent = (): Promise<boolean> =>
        withTenantTransaction(
          services.db,
          { tenantId, actorType: 'PROVIDER_WEBHOOK', actorId: 'stripe', traceId: request.traceId },
          async (trx) => {
            await sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-webhook:${tenantId}`}, 0))`.execute(
              trx,
            );
            const inserted = await trx
              .insertInto('provider_webhook_events')
              .values({ id: newId(), tenant_id: tenantId, ...eventRow })
              .onConflict((conflict) =>
                conflict.columns(['provider', 'provider_event_id']).doNothing(),
              )
              .returning(['id'])
              .executeTakeFirst();
            if (inserted === undefined) {
              return true;
            }
            const handler = HANDLERS[event.type];
            const outcome: Outcome =
              handler === undefined
                ? 'IGNORED'
                : await handler({
                    trx,
                    tenantId,
                    event,
                    webhookEventId: inserted.id,
                    stripe: deps.stripe,
                    traceId: request.traceId,
                  });
            await trx
              .insertInto('webhook_processing')
              .values({
                webhook_event_id: inserted.id,
                tenant_id: tenantId,
                status: outcome,
                attempts: 1,
                processed_at: new Date(),
              })
              .execute();
            return false;
          },
        );
      let duplicate: boolean | undefined;
      for (let attempt = 1; duplicate === undefined; attempt += 1) {
        try {
          duplicate = await processEvent();
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (attempt >= MAX_WEBHOOK_ATTEMPTS || (code !== '40001' && code !== '40P01')) {
            throw error;
          }
        }
      }
      return reply.code(200).send({ received: true, duplicate });
    });
  };
}
