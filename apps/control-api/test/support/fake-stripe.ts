import type {
  CheckoutSessionInput,
  StripeCustomerInput,
  StripeGateway,
  VerifiedCheckoutSession,
  VerifiedDispute,
  VerifiedInvoice,
  VerifiedSubscription,
} from '../../src/billing/stripe-gateway.js';

export class FakeStripeGateway implements StripeGateway {
  readonly mode = 'simulator' as const;
  readonly customerCalls: { input: StripeCustomerInput; key: string }[] = [];
  readonly checkoutCalls: { input: CheckoutSessionInput; key: string }[] = [];
  readonly sessions = new Map<string, VerifiedCheckoutSession>();
  readonly subscriptions = new Map<string, VerifiedSubscription>();
  readonly invoices = new Map<string, VerifiedInvoice>();
  readonly disputes = new Map<string, VerifiedDispute>();
  readonly missingCustomers = new Set<string>();
  readonly recycledCustomerIds: string[] = [];
  readonly #customersByKey = new Map<string, string>();
  readonly #sessionsByKey = new Map<string, { id: string; url: string }>();
  #counter = 0;

  #next(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_test${String(this.#counter).padStart(6, '0')}`;
  }

  createCustomer(input: StripeCustomerInput, idempotencyKey: string): Promise<{ id: string }> {
    this.customerCalls.push({ input, key: idempotencyKey });
    const existing = this.#customersByKey.get(idempotencyKey);
    const id = existing ?? this.recycledCustomerIds.shift() ?? this.#next('cus');
    this.#customersByKey.set(idempotencyKey, id);
    return Promise.resolve({ id });
  }

  customerExists(id: string): Promise<boolean> {
    return Promise.resolve(!this.missingCustomers.has(id));
  }

  createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }> {
    this.checkoutCalls.push({ input, key: idempotencyKey });
    const existing = this.#sessionsByKey.get(idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const id = this.#next('cs');
    const created = { id, url: `https://checkout.stripe.test/c/pay/${id}` };
    this.#sessionsByKey.set(idempotencyKey, created);
    this.sessions.set(id, {
      id,
      status: 'open',
      paymentStatus: 'unpaid',
      customerId: input.customerId,
      subscriptionId: null,
      invoiceId: null,
      amountTotal: null,
      amountTax: 0,
      currency: 'huf',
      metadata: {
        internal_order_id: input.orderId,
        tenant_id: input.tenantId,
        plan_code: input.planCode,
        pricing_version: input.pricingVersion,
      },
    });
    return Promise.resolve(created);
  }

  completeSession(
    sessionId: string,
    amountTotal: number,
    subscriptionId: string,
    invoiceId: string,
  ): VerifiedCheckoutSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`unknown session ${sessionId}`);
    }
    const completed: VerifiedCheckoutSession = {
      ...session,
      status: 'complete',
      paymentStatus: 'paid',
      amountTotal,
      subscriptionId,
      invoiceId,
    };
    this.sessions.set(sessionId, completed);
    return completed;
  }

  #get<T>(map: Map<string, T>, id: string): Promise<T> {
    const value = map.get(id);
    return value === undefined
      ? Promise.reject(new Error(`resource_missing ${id}`))
      : Promise.resolve(value);
  }

  retrieveCheckoutSession(id: string): Promise<VerifiedCheckoutSession> {
    return this.#get(this.sessions, id);
  }

  retrieveSubscription(id: string): Promise<VerifiedSubscription> {
    return this.#get(this.subscriptions, id);
  }

  retrieveInvoice(id: string): Promise<VerifiedInvoice> {
    return this.#get(this.invoices, id);
  }

  retrieveDispute(id: string): Promise<VerifiedDispute> {
    return this.#get(this.disputes, id);
  }
}
