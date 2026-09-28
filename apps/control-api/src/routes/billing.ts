import { PlanCode, PRICING_VERSION, type AddOnCode } from '@velyric/contracts';
import type { BillingProfiles, CheckoutOrders } from '@velyric/db';
import {
  billingMarketForCountry,
  buildEntitlement,
  EntitlementError,
  type AddOnSelection,
} from '@velyric/domain';
import { sql, type Selectable } from 'kysely';
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
import type { StripeCustomerInput, StripeGateway } from '../billing/stripe-gateway.js';
import { ApiError } from '../errors.js';
import { newId, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor } from '../principal.js';
import { IdParams, iso } from './common.js';

const PLAN_CODES: ReadonlySet<string> = new Set(Object.values(PlanCode));

async function linkPaymentCustomer(
  trx: Trx,
  profileId: string,
  customerId: string,
): Promise<boolean> {
  await sql`savepoint link_payment_customer`.execute(trx);
  try {
    await trx
      .updateTable('billing_profiles')
      .set({ stripe_customer_id: customerId })
      .where('id', '=', profileId)
      .execute();
  } catch (error) {
    const failure = error as { code?: unknown; constraint?: unknown };
    if (
      failure.code !== '23505' ||
      failure.constraint !== 'billing_profiles_stripe_customer_id_key'
    ) {
      throw error;
    }
    await sql`rollback to savepoint link_payment_customer`.execute(trx);
    return false;
  }
  await sql`release savepoint link_payment_customer`.execute(trx);
  return true;
}

const ProfileBody = Type.Object(
  {
    customer_type: Type.Union([Type.Literal('BUSINESS'), Type.Literal('INDIVIDUAL')]),
    legal_name: Type.String({ minLength: 1, maxLength: 300 }),
    country: Type.String({ pattern: '^[A-Z]{2}$' }),
    postal_code: Type.String({ minLength: 2, maxLength: 16 }),
    city: Type.String({ minLength: 1, maxLength: 120 }),
    address_line1: Type.String({ minLength: 1, maxLength: 200 }),
    address_line2: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    billing_email: Type.String({
      pattern: '^[^@\\s]{1,64}@[^@\\s]{1,255}\\.[^@\\s]{2,63}$',
      maxLength: 320,
    }),
    hu_tax_number: Type.Optional(Type.String({ pattern: '^[0-9]{8}-[1-5]-[0-9]{2}$' })),
    eu_vat_id: Type.Optional(Type.String({ pattern: '^[A-Z]{2}[0-9A-Za-z+*.]{2,13}$' })),
  },
  { additionalProperties: false },
);

const CheckoutBody = Type.Object(
  {
    plan_code: Type.String({ pattern: '^[A-Z]{3,12}$' }),
    add_ons: Type.Optional(
      Type.Array(
        Type.Object(
          {
            code: Type.String({ pattern: '^[A-Z_]{3,40}$' }),
            quantity: Type.Integer({ minimum: 1, maximum: 100 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    terms_version: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
    locale: Type.Union([Type.Literal('hu'), Type.Literal('de'), Type.Literal('en')]),
  },
  { additionalProperties: false },
);

export interface BillingRouteDependencies {
  readonly stripe: StripeGateway;
  readonly webOrigin: string;
  readonly currentTermsVersion: string;
}

function presentProfile(row: Selectable<BillingProfiles>): Record<string, unknown> {
  return {
    id: row.id,
    customer_type: row.customer_type,
    legal_name: row.legal_name,
    country: row.country,
    postal_code: row.postal_code,
    city: row.city,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    billing_email: row.billing_email,
    hu_tax_number: row.hu_tax_number,
    eu_vat_id: row.eu_vat_id,
    billing_market: billingMarketForCountry(row.country),
    has_payment_customer: row.stripe_customer_id !== null,
    version: row.version,
    updated_at: iso(row.updated_at),
  };
}

function presentOrder(row: Selectable<CheckoutOrders>): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    plan_code: row.plan_code,
    add_ons: row.add_ons,
    pricing_version: row.pricing_version,
    market: row.market,
    subtotal: { amount_minor: Number(row.subtotal_minor), currency: row.currency },
    tax: { amount_minor: Number(row.tax_minor), currency: row.currency },
    total: { amount_minor: Number(row.total_minor), currency: row.currency },
    expires_at: iso(row.expires_at),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at),
  };
}

function assertProfileCompleteness(body: {
  customer_type: string;
  country: string;
  hu_tax_number?: string | undefined;
  eu_vat_id?: string | undefined;
}): void {
  if (
    body.customer_type === 'BUSINESS' &&
    body.country === 'HU' &&
    body.hu_tax_number === undefined
  ) {
    throw new ApiError('BILLING_PROFILE_INCOMPLETE', { missing: ['hu_tax_number'] });
  }
  if (
    body.eu_vat_id !== undefined &&
    body.country !== 'GR' &&
    !body.eu_vat_id.startsWith(body.country)
  ) {
    throw new ApiError('VAT_ID_INVALID', { reason: 'country_prefix_mismatch' });
  }
}

function mapEntitlementError(error: unknown): never {
  if (error instanceof EntitlementError) {
    if (error.reason === 'PRICE_BOOK_UNAVAILABLE') {
      throw new ApiError('PRICE_BOOK_UNAVAILABLE');
    }
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/body', rule: error.reason.toLowerCase() }],
    });
  }
  throw error;
}

async function priceIdFor(
  trx: Trx,
  query: {
    market: string;
    currency: string;
    kind: 'PLAN' | 'OVERAGE' | 'ADD_ON';
    planCode: string | null;
    addOnCode: string | null;
    interval: 'MONTH' | 'METERED';
  },
): Promise<{ stripePriceId: string; unitAmountMinor: number }> {
  let builder = trx
    .selectFrom('price_books')
    .select(['stripe_price_id', 'unit_amount_minor'])
    .where('pricing_version', '=', PRICING_VERSION)
    .where('market', '=', query.market)
    .where('currency', '=', query.currency)
    .where('item_kind', '=', query.kind)
    .where('billing_interval', '=', query.interval)
    .where('active', '=', true);
  builder =
    query.planCode === null
      ? builder.where('plan_code', 'is', null)
      : builder.where('plan_code', '=', query.planCode);
  builder =
    query.addOnCode === null
      ? builder.where('add_on_code', 'is', null)
      : builder.where('add_on_code', '=', query.addOnCode);
  const row = await builder.executeTakeFirst();
  if (row === undefined || row.stripe_price_id === null) {
    throw new ApiError('PRICE_BOOK_UNAVAILABLE', {
      item: query.addOnCode ?? query.planCode ?? query.kind,
    });
  }
  return { stripePriceId: row.stripe_price_id, unitAmountMinor: Number(row.unit_amount_minor) };
}

export function createBillingRoutes(deps: BillingRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/billing/profile', async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'billing:read');
      const profile = await inTenant(services, actor, request, (trx) =>
        trx.selectFrom('billing_profiles').selectAll().executeTakeFirst(),
      );
      if (profile === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return reply.header('etag', weakEtag(profile.version)).send(presentProfile(profile));
    });

    app.put('/v1/billing/profile', { schema: { body: ProfileBody } }, async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'billing:manage');
      const body = request.body;
      assertProfileCompleteness(body);
      const values = {
        customer_type: body.customer_type,
        legal_name: body.legal_name,
        country: body.country,
        postal_code: body.postal_code,
        city: body.city,
        address_line1: body.address_line1,
        address_line2: body.address_line2 ?? null,
        billing_email: body.billing_email.toLowerCase(),
        hu_tax_number: body.hu_tax_number ?? null,
        eu_vat_id: body.eu_vat_id ?? null,
      };
      const result = await inTenant(services, actor, request, async (trx) => {
        const existing = await trx
          .selectFrom('billing_profiles')
          .select(['id', 'version', 'country'])
          .forUpdate()
          .executeTakeFirst();
        if (existing === undefined) {
          const created = await trx
            .insertInto('billing_profiles')
            .values({ id: newId(), tenant_id: actor.tenantId, ...values })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'billing_profile.created',
            objectType: 'billing_profile',
            objectId: created.id,
            diff: values,
          });
          return { status: 201, row: created };
        }
        const expected = requireIfMatch(request);
        if (existing.version !== expected) {
          throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });
        }
        const live = await trx
          .selectFrom('subscriptions')
          .select(['id'])
          .where('status', 'in', [
            'INCOMPLETE',
            'TRIALING',
            'ACTIVE',
            'PAST_DUE',
            'UNPAID',
            'PAUSED',
          ])
          .executeTakeFirst();
        if (
          live !== undefined &&
          billingMarketForCountry(existing.country) !== billingMarketForCountry(body.country)
        ) {
          throw new ApiError('CONFLICT', {
            reason: 'billing_market_change_requires_new_subscription',
          });
        }
        const updated = await trx
          .updateTable('billing_profiles')
          .set({ ...values, version: existing.version + 1, vat_id_validated_at: null })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'billing_profile.updated',
          objectType: 'billing_profile',
          objectId: existing.id,
          diff: values,
        });
        return { status: 200, row: updated };
      });
      return reply
        .code(result.status)
        .header('etag', weakEtag(result.row.version))
        .send(presentProfile(result.row));
    });

    app.get('/v1/billing/subscription', async (request) => {
      const actor = requireTenantActor(request.principal, 'billing:read');
      return inTenant(services, actor, request, async (trx) => {
        const subscription = await trx
          .selectFrom('subscriptions')
          .selectAll()
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        const entitlement = await trx
          .selectFrom('entitlement_snapshots')
          .selectAll()
          .orderBy('version', 'desc')
          .executeTakeFirst();
        const usage =
          entitlement === undefined
            ? []
            : await trx
                .selectFrom('usage_aggregates')
                .select(['metric', 'quantity', 'cost_usd_micros'])
                .where('billing_period_start', '=', entitlement.billing_period_start)
                .execute();
        return {
          subscription:
            subscription === undefined
              ? null
              : {
                  id: subscription.id,
                  status: subscription.status,
                  plan_code: subscription.plan_code,
                  current_period_start: iso(subscription.current_period_start),
                  current_period_end: iso(subscription.current_period_end),
                  cancel_at_period_end: subscription.cancel_at_period_end,
                  pending_plan_code: subscription.pending_plan_code,
                },
          entitlement:
            entitlement === undefined
              ? null
              : {
                  version: entitlement.version,
                  plan_code: entitlement.plan_code,
                  included_voice_seconds: Number(entitlement.included_voice_seconds),
                  overage_per_minute: {
                    amount_minor: Number(entitlement.overage_minor_per_minute),
                    currency: entitlement.currency,
                  },
                  concurrency_limit: entitlement.concurrency_limit,
                  features: entitlement.features,
                  limits: entitlement.limits,
                  billing_period_start: iso(entitlement.billing_period_start),
                  billing_period_end: iso(entitlement.billing_period_end),
                },
          usage: usage.map((row) => ({ metric: row.metric, quantity: Number(row.quantity) })),
        };
      });
    });

    app.post('/v1/billing/checkout', { schema: { body: CheckoutBody } }, async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'billing:manage');
      const body = request.body;
      if (actor.userId === undefined) {
        throw new ApiError('FORBIDDEN', { reason: 'user_session_required' });
      }
      const buyerId = actor.userId;
      if (!PLAN_CODES.has(body.plan_code)) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/plan_code', rule: 'enum' }],
        });
      }
      if (body.terms_version !== deps.currentTermsVersion) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/terms_version', rule: 'current_terms_required' }],
        });
      }
      const planCode = body.plan_code as PlanCode;
      const addOns: AddOnSelection[] = (body.add_ons ?? []).map((item) => ({
        code: item.code as AddOnCode,
        quantity: item.quantity,
      }));
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'billing.checkout',
        async (trx) => {
          const profile = await trx
            .selectFrom('billing_profiles')
            .selectAll()
            .forUpdate()
            .executeTakeFirst();
          if (profile === undefined) {
            throw new ApiError('BILLING_PROFILE_INCOMPLETE', { missing: ['billing_profile'] });
          }
          const fraud = await trx.selectFrom('fraud_reviews').select(['status']).executeTakeFirst();
          if (fraud?.status === 'BLOCKED' || fraud?.status === 'REVIEW_REQUIRED') {
            throw new ApiError('FRAUD_REVIEW_REQUIRED');
          }
          const live = await trx
            .selectFrom('subscriptions')
            .select(['id'])
            .where('status', 'in', [
              'INCOMPLETE',
              'TRIALING',
              'ACTIVE',
              'PAST_DUE',
              'UNPAID',
              'PAUSED',
            ])
            .executeTakeFirst();
          if (live !== undefined) {
            throw new ApiError('CONFLICT', { reason: 'subscription_exists' });
          }
          const market = billingMarketForCountry(profile.country);
          const now = services.now();
          let entitlement;
          try {
            entitlement = buildEntitlement(planCode, market, addOns, {
              start: now,
              end: new Date(now.getTime() + 31 * 86_400_000),
            });
          } catch (error) {
            mapEntitlementError(error);
          }
          const plan = await priceIdFor(trx, {
            market,
            currency: entitlement.currency,
            kind: 'PLAN',
            planCode,
            addOnCode: null,
            interval: 'MONTH',
          });
          const overage = await priceIdFor(trx, {
            market,
            currency: entitlement.currency,
            kind: 'OVERAGE',
            planCode,
            addOnCode: null,
            interval: 'METERED',
          });
          const addOnPrices = await Promise.all(
            addOns.map(async (selection) => ({
              selection,
              price: await priceIdFor(trx, {
                market,
                currency: entitlement.currency,
                kind: 'ADD_ON',
                planCode: null,
                addOnCode: selection.code,
                interval: 'MONTH',
              }),
            })),
          );
          const subtotal =
            plan.unitAmountMinor +
            addOnPrices.reduce(
              (sum, item) => sum + item.price.unitAmountMinor * item.selection.quantity,
              0,
            );

          const staleCustomerId =
            profile.stripe_customer_id !== null &&
            !(await deps.stripe.customerExists(profile.stripe_customer_id))
              ? profile.stripe_customer_id
              : null;
          let customerId = staleCustomerId === null ? profile.stripe_customer_id : null;
          if (customerId === null) {
            const tenant = await trx
              .selectFrom('tenants')
              .select(['default_locale'])
              .executeTakeFirstOrThrow();
            const customerInput: StripeCustomerInput = {
              tenantId: actor.tenantId,
              billingProfileId: profile.id,
              email: profile.billing_email,
              name: profile.legal_name,
              locale:
                tenant.default_locale === 'de' || tenant.default_locale === 'en'
                  ? tenant.default_locale
                  : 'hu',
              address: {
                country: profile.country,
                postalCode: profile.postal_code,
                city: profile.city,
                line1: profile.address_line1,
                line2: profile.address_line2,
              },
            };
            let customer = await deps.stripe.createCustomer(
              customerInput,
              staleCustomerId === null
                ? `customer:${profile.id}`
                : `customer:${profile.id}:${staleCustomerId}`,
            );
            if (!(await linkPaymentCustomer(trx, profile.id, customer.id))) {
              customer = await deps.stripe.createCustomer(
                customerInput,
                `customer:${profile.id}:${customer.id}`,
              );
              if (!(await linkPaymentCustomer(trx, profile.id, customer.id))) {
                throw new ApiError('CONFLICT', { reason: 'payment_customer_conflict' });
              }
            }
            customerId = customer.id;
          }

          const orderId = newId();
          const expiresAt = new Date(now.getTime() + 23 * 3_600_000);
          await trx
            .insertInto('checkout_orders')
            .values({
              id: orderId,
              tenant_id: actor.tenantId,
              billing_profile_id: profile.id,
              created_by_user_id: buyerId,
              status: 'AWAITING_PAYMENT',
              plan_code: planCode,
              add_ons: JSON.stringify(addOns),
              pricing_version: PRICING_VERSION,
              market,
              currency: entitlement.currency,
              subtotal_minor: subtotal,
              tax_minor: 0,
              total_minor: subtotal,
              terms_version: body.terms_version,
              client_ip: request.ip === '' ? null : request.ip,
              idempotency_key: `checkout:${orderId}`,
              expires_at: expiresAt,
            })
            .execute();
          const session = await deps.stripe.createCheckoutSession(
            {
              orderId,
              tenantId: actor.tenantId,
              customerId,
              planCode,
              pricingVersion: PRICING_VERSION,
              lineItems: [
                { price: plan.stripePriceId, quantity: 1 },
                { price: overage.stripePriceId, quantity: null },
                ...addOnPrices.map((item) => ({
                  price: item.price.stripePriceId,
                  quantity: item.selection.quantity,
                })),
              ],
              successUrl: `${deps.webOrigin}/app/onboarding/checkout/return?workspace=${actor.tenantId}&order=${orderId}`,
              cancelUrl: `${deps.webOrigin}/app/onboarding?workspace=${actor.tenantId}&step=plan&checkout=canceled`,
              locale: body.locale,
              expiresAt,
            },
            `checkout:${orderId}`,
          );
          const order = await trx
            .updateTable('checkout_orders')
            .set({ stripe_checkout_session_id: session.id })
            .where('id', '=', orderId)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'checkout.started',
            objectType: 'checkout_order',
            objectId: orderId,
            metadata: {
              plan_code: planCode,
              market,
              subtotal_minor: subtotal,
              currency: entitlement.currency,
            },
          });
          return {
            status: 201,
            body: { order: presentOrder(order), checkout_url: session.url },
            resource: { type: 'checkout_order', id: orderId },
          };
        },
      );
    });

    app.get('/v1/billing/orders/:id', { schema: { params: IdParams } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'billing:read');
      const order = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('checkout_orders')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (order === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return presentOrder(order);
    });
  };
}
