import type { ProviderMode, SubscriptionStatus } from '@velyric/contracts';
import Stripe from 'stripe';

export interface StripeCustomerInput {
  readonly tenantId: string;
  readonly billingProfileId: string;
  readonly email: string;
  readonly name: string;
  readonly locale: 'hu' | 'de' | 'en';
  readonly address: {
    readonly country: string;
    readonly postalCode: string;
    readonly city: string;
    readonly line1: string;
    readonly line2: string | null;
  };
}

export interface CheckoutSessionInput {
  readonly orderId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly planCode: string;
  readonly pricingVersion: string;
  readonly lineItems: readonly { readonly price: string; readonly quantity: number | null }[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly locale: 'hu' | 'de' | 'en';
  readonly expiresAt: Date;
}

export interface VerifiedCheckoutSession {
  readonly id: string;
  readonly status: 'open' | 'complete' | 'expired';
  readonly paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly invoiceId: string | null;
  readonly amountTotal: number | null;
  readonly amountTax: number;
  readonly currency: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface VerifiedSubscriptionItem {
  readonly id: string;
  readonly priceId: string;
  readonly quantity: number;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface VerifiedSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly status: SubscriptionStatus;
  readonly currency: string;
  readonly items: readonly VerifiedSubscriptionItem[];
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface VerifiedInvoice {
  readonly id: string;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly status: string;
  readonly amountPaid: number;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface VerifiedDispute {
  readonly id: string;
  readonly chargeId: string;
  readonly customerId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly evidenceDueBy: Date | null;
}

export interface StripeGateway {
  readonly mode: ProviderMode;
  createCustomer(
    input: StripeCustomerInput,
    idempotencyKey: string,
  ): Promise<{ readonly id: string }>;
  createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<{ readonly id: string; readonly url: string }>;
  customerExists(id: string): Promise<boolean>;
  retrieveCheckoutSession(id: string): Promise<VerifiedCheckoutSession>;
  retrieveSubscription(id: string): Promise<VerifiedSubscription>;
  retrieveInvoice(id: string): Promise<VerifiedInvoice>;
  retrieveDispute(id: string): Promise<VerifiedDispute>;
}

const SUBSCRIPTION_STATUS: Readonly<Record<string, SubscriptionStatus>> = {
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE_EXPIRED',
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  unpaid: 'UNPAID',
  paused: 'PAUSED',
  canceled: 'CANCELED',
};

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : value.id;
}

function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000);
}

export class StripeSdkGateway implements StripeGateway {
  readonly mode: ProviderMode;
  readonly #stripe: Stripe;

  constructor(secretKey: string, mode: ProviderMode, simulatorUrl: string | null) {
    this.mode = mode;
    const simulator = mode === 'simulator' && simulatorUrl !== null ? new URL(simulatorUrl) : null;
    this.#stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 10_000,
      appInfo: { name: 'velyric-control-api' },
      ...(simulator === null
        ? {}
        : {
            host: simulator.hostname,
            port: Number(simulator.port || (simulator.protocol === 'https:' ? 443 : 80)),
            protocol: simulator.protocol === 'https:' ? 'https' : 'http',
          }),
    });
  }

  async createCustomer(
    input: StripeCustomerInput,
    idempotencyKey: string,
  ): Promise<{ readonly id: string }> {
    const customer = await this.#stripe.customers.create(
      {
        email: input.email,
        name: input.name,
        preferred_locales: [input.locale],
        address: {
          country: input.address.country,
          postal_code: input.address.postalCode,
          city: input.address.city,
          line1: input.address.line1,
          ...(input.address.line2 === null ? {} : { line2: input.address.line2 }),
        },
        metadata: { tenant_id: input.tenantId, billing_profile_id: input.billingProfileId },
      },
      { idempotencyKey },
    );
    return { id: customer.id };
  }

  async createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<{ readonly id: string; readonly url: string }> {
    const metadata = {
      internal_order_id: input.orderId,
      tenant_id: input.tenantId,
      plan_code: input.planCode,
      pricing_version: input.pricingVersion,
    };
    const session = await this.#stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        client_reference_id: input.orderId,
        line_items: input.lineItems.map((item) =>
          item.quantity === null
            ? { price: item.price }
            : { price: item.price, quantity: item.quantity },
        ),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        locale: input.locale,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        metadata,
        subscription_data: { metadata },
        payment_method_collection: 'always',
        billing_address_collection: 'auto',
      },
      { idempotencyKey },
    );
    if (session.url === null) {
      throw new Error('Stripe returned a checkout session without a URL');
    }
    return { id: session.id, url: session.url };
  }

  async customerExists(id: string): Promise<boolean> {
    try {
      const customer = await this.#stripe.customers.retrieve(id);
      return customer.deleted !== true;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return false;
      }
      throw error;
    }
  }

  async retrieveCheckoutSession(id: string): Promise<VerifiedCheckoutSession> {
    const session = await this.#stripe.checkout.sessions.retrieve(id);
    return {
      id: session.id,
      status:
        session.status === 'complete'
          ? 'complete'
          : session.status === 'expired'
            ? 'expired'
            : 'open',
      paymentStatus:
        session.payment_status === 'paid'
          ? 'paid'
          : session.payment_status === 'no_payment_required'
            ? 'no_payment_required'
            : 'unpaid',
      customerId: idOf(session.customer),
      subscriptionId: idOf(session.subscription),
      invoiceId: idOf(session.invoice),
      amountTotal: session.amount_total,
      amountTax: session.total_details?.amount_tax ?? 0,
      currency: session.currency,
      metadata: session.metadata ?? {},
    };
  }

  async retrieveSubscription(id: string): Promise<VerifiedSubscription> {
    const subscription = await this.#stripe.subscriptions.retrieve(id);
    const status = SUBSCRIPTION_STATUS[subscription.status];
    if (status === undefined) {
      throw new Error(`unknown Stripe subscription status ${subscription.status}`);
    }
    return {
      id: subscription.id,
      customerId: idOf(subscription.customer) ?? '',
      status,
      currency: subscription.currency,
      items: subscription.items.data.map((item) => ({
        id: item.id,
        priceId: item.price.id,
        quantity: item.quantity ?? 1,
        periodStart: fromUnix(item.current_period_start),
        periodEnd: fromUnix(item.current_period_end),
      })),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: subscription.canceled_at === null ? null : fromUnix(subscription.canceled_at),
      metadata: subscription.metadata,
    };
  }

  async retrieveInvoice(id: string): Promise<VerifiedInvoice> {
    const invoice = await this.#stripe.invoices.retrieve(id);
    const line = invoice.lines.data[0];
    const subscriptionRef = invoice.parent?.subscription_details?.subscription;
    return {
      id: invoice.id,
      customerId: idOf(invoice.customer) ?? '',
      subscriptionId: idOf(subscriptionRef),
      status: invoice.status ?? 'draft',
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      periodStart: fromUnix(line?.period.start ?? invoice.period_start),
      periodEnd: fromUnix(line?.period.end ?? invoice.period_end),
    };
  }

  async retrieveDispute(id: string): Promise<VerifiedDispute> {
    const dispute = await this.#stripe.disputes.retrieve(id, { expand: ['charge'] });
    const charge = typeof dispute.charge === 'string' ? null : dispute.charge;
    return {
      id: dispute.id,
      chargeId: idOf(dispute.charge) ?? '',
      customerId: charge === null ? null : idOf(charge.customer),
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      evidenceDueBy:
        dispute.evidence_details.due_by === null ? null : fromUnix(dispute.evidence_details.due_by),
    };
  }
}
