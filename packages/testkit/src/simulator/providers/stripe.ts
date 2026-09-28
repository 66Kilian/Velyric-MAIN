import { createHash } from 'node:crypto';
import type { ProviderModule, SimulatorContext, StripePrice } from '../context.js';
import {
  bearer,
  escapeHtml,
  formArray,
  formBody,
  formObject,
  formString,
  header,
  html,
  json,
  jsonBody,
  redirect,
  stringRecord,
  type Router,
  type SimRequest,
  type SimResponse,
} from '../http.js';
import { addMonths, unixSeconds } from '../state.js';

type StripeObject = Record<string, unknown>;

interface LineItem {
  readonly price: StripePrice;
  readonly quantity: number | null;
}

interface CheckoutSession {
  readonly object: StripeObject;
  readonly lineItems: readonly LineItem[];
  declined: boolean;
}

interface StoredEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: string;
}

function stripeError(
  status: number,
  type: string,
  message: string,
  code?: string,
  param?: string,
): SimResponse {
  return json(status, {
    error: {
      type,
      message,
      ...(code === undefined ? {} : { code }),
      ...(param === undefined ? {} : { param }),
    },
  });
}

function missing(kind: string, id: string): SimResponse {
  return stripeError(
    404,
    'invalid_request_error',
    `No such ${kind}: '${id}'`,
    'resource_missing',
    'id',
  );
}

export class StripeSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #customers = new Map<string, StripeObject>();
  readonly #sessions = new Map<string, CheckoutSession>();
  readonly #subscriptions = new Map<string, StripeObject>();
  readonly #invoices = new Map<string, StripeObject>();
  readonly #disputes = new Map<string, StripeObject>();
  readonly #charges = new Map<string, StripeObject>();
  readonly #events = new Map<string, StoredEvent>();
  readonly #idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly response: SimResponse }
  >();

  constructor(context: SimulatorContext) {
    this.#context = context;
  }

  snapshot(): Record<string, number> {
    return {
      customers: this.#customers.size,
      checkout_sessions: this.#sessions.size,
      subscriptions: this.#subscriptions.size,
      invoices: this.#invoices.size,
      events: this.#events.size,
    };
  }

  register(api: Router, control: Router): void {
    for (const prefix of ['', '/stripe']) {
      api.add('POST', `${prefix}/v1/customers`, (request) =>
        this.#authorized(request, () =>
          this.#idempotent(request, () => this.#createCustomer(request)),
        ),
      );
      api.add('GET', `${prefix}/v1/customers/:id`, (request) =>
        this.#authorized(request, () => this.#get(this.#customers, 'customer', request)),
      );
      api.add('POST', `${prefix}/v1/checkout/sessions`, (request) =>
        this.#authorized(request, () =>
          this.#idempotent(request, () => this.#createSession(request)),
        ),
      );
      api.add('GET', `${prefix}/v1/checkout/sessions/:id`, (request) =>
        this.#authorized(request, () => {
          const session = this.#sessions.get(request.params['id'] ?? '');
          return session === undefined
            ? missing('checkout.session', request.params['id'] ?? '')
            : json(200, this.#refreshSession(session).object);
        }),
      );
      api.add('GET', `${prefix}/v1/subscriptions/:id`, (request) =>
        this.#authorized(request, () => this.#get(this.#subscriptions, 'subscription', request)),
      );
      api.add('GET', `${prefix}/v1/invoices/:id`, (request) =>
        this.#authorized(request, () => this.#get(this.#invoices, 'invoice', request)),
      );
      api.add('GET', `${prefix}/v1/invoices/:id/lines`, (request) =>
        this.#authorized(request, () => {
          const invoice = this.#invoices.get(request.params['id'] ?? '');
          return invoice === undefined
            ? missing('invoice', request.params['id'] ?? '')
            : json(200, invoice['lines']);
        }),
      );
      api.add('GET', `${prefix}/v1/disputes/:id`, (request) =>
        this.#authorized(request, () => {
          const dispute = this.#disputes.get(request.params['id'] ?? '');
          if (dispute === undefined) {
            return missing('dispute', request.params['id'] ?? '');
          }
          const expand = [...request.query.entries()]
            .filter(([key]) => key.startsWith('expand'))
            .map(([, value]) => value);
          const chargeId = String(dispute['charge']);
          return json(
            200,
            expand.includes('charge')
              ? { ...dispute, charge: this.#charges.get(chargeId) ?? chargeId }
              : dispute,
          );
        }),
      );
    }
    api.add('GET', '/stripe/checkout/:id', (request) => this.#checkoutPage(request));
    api.add('POST', '/stripe/checkout/:id/pay', (request) => this.#pay(request));
    api.add('POST', '/stripe/checkout/:id/decline', (request) => this.#decline(request));

    control.add('POST', '/_control/stripe/subscriptions/:id/renew', (request) =>
      this.#renew(request),
    );
    control.add('POST', '/_control/stripe/subscriptions/:id/cancel', (request) =>
      this.#cancel(request),
    );
    control.add('POST', '/_control/stripe/invoices/:id/dispute', (request) =>
      this.#dispute(request),
    );
    control.add('POST', '/_control/stripe/events/:id/redeliver', (request) => {
      const event = this.#events.get(request.params['id'] ?? '');
      if (event === undefined) {
        return json(404, { error: 'event_not_found' });
      }
      const body = jsonBody(request);
      const times =
        typeof body['times'] === 'number' && body['times'] >= 1 && body['times'] <= 10
          ? Math.floor(body['times'])
          : 1;
      const delayMs =
        typeof body['delay_ms'] === 'number' && body['delay_ms'] >= 0
          ? Math.min(body['delay_ms'], 60_000)
          : 0;
      for (let attempt = 0; attempt < times; attempt += 1) {
        this.#context.webhooks.send('stripe', this.#context.config.stripeWebhook, event, {
          delayMs: delayMs * (attempt + 1),
          attempt: attempt + 2,
        });
      }
      return json(202, { id: event.id, redeliveries: times });
    });
    control.add('GET', '/_control/stripe/events', () =>
      json(200, {
        data: [...this.#events.values()].map((event) => ({ id: event.id, type: event.type })),
      }),
    );
  }

  #authorized(request: SimRequest, next: () => SimResponse): SimResponse {
    if (bearer(request) !== this.#context.config.credentials.stripeSecretKey) {
      return stripeError(401, 'invalid_request_error', 'Invalid API Key provided');
    }
    return next();
  }

  #idempotent(request: SimRequest, create: () => SimResponse): SimResponse {
    const key = header(request, 'idempotency-key');
    if (key === undefined) {
      return create();
    }
    const fingerprint = createHash('sha256')
      .update(`${request.path}\n`)
      .update(request.rawBody)
      .digest('hex');
    const stored = this.#idempotency.get(key);
    if (stored !== undefined) {
      return stored.fingerprint === fingerprint
        ? {
            ...stored.response,
            headers: { ...stored.response.headers, 'idempotent-replayed': 'true' },
          }
        : stripeError(
            400,
            'idempotency_error',
            'Keys for idempotent requests can only be used with the same parameters they were first used with.',
          );
    }
    const response = create();
    if (response.status < 500) {
      this.#idempotency.set(key, { fingerprint, response });
    }
    return response;
  }

  #get(store: Map<string, StripeObject>, kind: string, request: SimRequest): SimResponse {
    const found = store.get(request.params['id'] ?? '');
    return found === undefined ? missing(kind, request.params['id'] ?? '') : json(200, found);
  }

  #now(): number {
    return unixSeconds(this.#context.now());
  }

  #emit(type: string, object: StripeObject): void {
    const event = {
      id: this.#context.ids.id('evt', '_', 24),
      object: 'event',
      api_version: '2025-08-27.basil',
      created: this.#now(),
      data: { object },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
    };
    const stored = { id: event.id, type, payload: JSON.stringify(event) };
    this.#events.set(event.id, stored);
    this.#context.webhooks.send('stripe', this.#context.config.stripeWebhook, stored);
  }

  #createCustomer(request: SimRequest): SimResponse {
    const form = formBody(request);
    const address = stringRecord(form['address']);
    const customer: StripeObject = {
      id: this.#context.ids.id('cus', '_', 14),
      object: 'customer',
      email: formString(form, 'email'),
      name: formString(form, 'name'),
      address: Object.keys(address).length === 0 ? null : { line2: null, state: null, ...address },
      preferred_locales: formArray(form['preferred_locales']).filter(
        (value) => typeof value === 'string',
      ),
      metadata: stringRecord(form['metadata']),
      created: this.#now(),
      livemode: false,
    };
    this.#customers.set(String(customer['id']), customer);
    return json(200, customer);
  }

  #createSession(request: SimRequest): SimResponse {
    const form = formBody(request);
    const mode = formString(form, 'mode');
    if (mode !== 'subscription') {
      return stripeError(
        400,
        'invalid_request_error',
        'The simulator supports subscription checkout sessions only.',
        'parameter_invalid_string',
        'mode',
      );
    }
    const customerId = formString(form, 'customer');
    if (customerId === null || !this.#customers.has(customerId)) {
      return stripeError(
        400,
        'invalid_request_error',
        `No such customer: '${customerId ?? ''}'`,
        'resource_missing',
        'customer',
      );
    }
    const lineItems: LineItem[] = [];
    for (const [index, raw] of formArray(form['line_items']).entries()) {
      const item = formObject(raw);
      const priceId = formString(item, 'price');
      const price = this.#context.config.stripePrices.find((candidate) => candidate.id === priceId);
      if (price === undefined) {
        return stripeError(
          400,
          'invalid_request_error',
          `No such price: '${priceId ?? ''}'`,
          'resource_missing',
          `line_items[${String(index)}][price]`,
        );
      }
      const quantityText = formString(item, 'quantity');
      if (price.usageType === 'metered' && quantityText !== null) {
        return stripeError(
          400,
          'invalid_request_error',
          'Quantity should not be specified where usage_type is `metered`.',
          'parameter_unknown',
          `line_items[${String(index)}][quantity]`,
        );
      }
      lineItems.push({
        price,
        quantity: price.usageType === 'metered' ? null : Number(quantityText ?? '1'),
      });
    }
    if (lineItems.length === 0) {
      return stripeError(
        400,
        'invalid_request_error',
        'line_items is required in subscription mode.',
        'parameter_missing',
        'line_items',
      );
    }
    const currencies = new Set(lineItems.map((item) => item.price.currency));
    if (currencies.size !== 1) {
      return stripeError(
        400,
        'invalid_request_error',
        'All prices must use the same currency.',
        'parameter_invalid_string',
        'line_items',
      );
    }
    const successUrl = formString(form, 'success_url');
    const cancelUrl = formString(form, 'cancel_url');
    if (
      successUrl === null ||
      !URL.canParse(successUrl.replace('{CHECKOUT_SESSION_ID}', 'x')) ||
      (cancelUrl !== null && !URL.canParse(cancelUrl))
    ) {
      return stripeError(
        400,
        'invalid_request_error',
        'success_url must be a valid URL.',
        'url_invalid',
        'success_url',
      );
    }
    const subtotal = lineItems.reduce(
      (sum, item) => sum + item.price.unitAmount * (item.quantity ?? 0),
      0,
    );
    const id = this.#context.ids.id('cs_test', '_', 58);
    const expiresAt = Number(formString(form, 'expires_at') ?? String(this.#now() + 86_400));
    const object: StripeObject = {
      id,
      object: 'checkout.session',
      mode,
      status: 'open',
      payment_status: 'unpaid',
      customer: customerId,
      client_reference_id: formString(form, 'client_reference_id'),
      currency: [...currencies][0] ?? 'huf',
      amount_subtotal: subtotal,
      amount_total: subtotal,
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
      metadata: stringRecord(form['metadata']),
      subscription: null,
      invoice: null,
      locale: formString(form, 'locale'),
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: expiresAt,
      url: `${this.#context.config.publicUrl}/stripe/checkout/${id}`,
      created: this.#now(),
      livemode: false,
      subscription_data_metadata: stringRecord(formObject(form['subscription_data'])['metadata']),
    };
    this.#sessions.set(id, { object, lineItems, declined: false });
    return json(200, this.#public(object));
  }

  #public(object: StripeObject): StripeObject {
    return Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== 'subscription_data_metadata'),
    );
  }

  #refreshSession(session: CheckoutSession): CheckoutSession {
    const object = session.object as Record<string, unknown>;
    if (object['status'] === 'open' && Number(object['expires_at']) <= this.#now()) {
      object['status'] = 'expired';
      object['url'] = null;
      this.#emit('checkout.session.expired', this.#public(object));
    }
    return { ...session, object: this.#public(object) };
  }

  #checkoutPage(request: SimRequest): SimResponse {
    const session = this.#sessions.get(request.params['id'] ?? '');
    if (session === undefined) {
      return html(
        404,
        '<!doctype html><html lang="en"><body><p>Checkout session not found.</p></body></html>',
      );
    }
    const object = this.#refreshSession(session).object;
    const total = new Intl.NumberFormat('hu-HU', {
      style: 'currency',
      currency: String(object['currency']).toUpperCase(),
    }).format(Number(object['amount_total']) / 100);
    const lines = session.lineItems
      .map(
        (item) =>
          `<li>${escapeHtml(item.price.id)} — ${item.price.usageType === 'metered' ? 'usage based' : `${String(item.quantity ?? 1)} × ${String(item.price.unitAmount / 100)}`}</li>`,
      )
      .join('');
    const status = String(object['status']);
    const actions =
      status === 'open'
        ? `<form method="post" action="/stripe/checkout/${escapeHtml(String(object['id']))}/pay"><button type="submit">Pay ${escapeHtml(total)}</button></form><form method="post" action="/stripe/checkout/${escapeHtml(String(object['id']))}/decline"><button type="submit">Simulate declined card</button></form>${typeof object['cancel_url'] === 'string' ? `<a href="${escapeHtml(object['cancel_url'])}">Cancel</a>` : ''}`
        : `<p>This checkout session is ${escapeHtml(status)}.</p>`;
    return html(
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stripe Checkout simulator</title></head><body><main><h1>Stripe Checkout simulator</h1>${session.declined ? '<p role="alert">Your card was declined.</p>' : ''}<ul>${lines}</ul><p>Total due today: ${escapeHtml(total)}</p>${actions}</main></body></html>`,
    );
  }

  #decline(request: SimRequest): SimResponse {
    const session = this.#sessions.get(request.params['id'] ?? '');
    if (session === undefined) {
      return html(
        404,
        '<!doctype html><html lang="en"><body><p>Checkout session not found.</p></body></html>',
      );
    }
    session.declined = true;
    return redirect(`/stripe/checkout/${String(session.object['id'])}`, 303);
  }

  #invoiceFor(
    subscription: StripeObject,
    periodStart: Date,
    periodEnd: Date,
    amount: number,
    paid: boolean,
  ): StripeObject {
    const invoiceId = this.#context.ids.id('in', '_', 24);
    const chargeId = this.#context.ids.id('ch', '_', 24);
    const items = (subscription['items'] as { data: StripeObject[] }).data;
    const created = this.#now();
    const invoice: StripeObject = {
      id: invoiceId,
      object: 'invoice',
      number: `SIM-${String(this.#context.ids.sequence('stripe_invoice_number')).padStart(6, '0')}`,
      customer: subscription['customer'],
      currency: subscription['currency'],
      status: paid ? 'paid' : 'open',
      subtotal: amount,
      subtotal_excluding_tax: amount,
      total: amount,
      total_excluding_tax: amount,
      status_transitions: {
        finalized_at: created,
        paid_at: paid ? created : null,
        marked_uncollectible_at: null,
        voided_at: null,
      },
      amount_due: amount,
      amount_paid: paid ? amount : 0,
      amount_remaining: paid ? 0 : amount,
      attempt_count: 1,
      billing_reason: 'subscription_cycle',
      period_start: unixSeconds(periodStart),
      period_end: unixSeconds(periodEnd),
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: subscription['id'],
          metadata: subscription['metadata'],
        },
      },
      lines: {
        object: 'list',
        has_more: false,
        url: `/v1/invoices/${invoiceId}/lines`,
        data: items.map((item) => ({
          id: this.#context.ids.id('il', '_', 24),
          object: 'line_item',
          description: `${typeof item['quantity'] === 'number' ? String(item['quantity']) : 'Usage'} × ${String((item['price'] as StripeObject)['id'])}`,
          amount:
            Number((item['price'] as StripeObject)['unit_amount'] ?? 0) *
            Number(item['quantity'] ?? 0),
          currency: subscription['currency'],
          quantity: item['quantity'] ?? null,
          period: { start: unixSeconds(periodStart), end: unixSeconds(periodEnd) },
          pricing: {
            type: 'price_details',
            price_details: { price: (item['price'] as StripeObject)['id'] },
          },
        })),
      },
      charge: chargeId,
      created,
      livemode: false,
    };
    this.#invoices.set(invoiceId, invoice);
    this.#charges.set(chargeId, {
      id: chargeId,
      object: 'charge',
      amount,
      currency: subscription['currency'],
      customer: subscription['customer'],
      invoice: invoiceId,
      paid,
    });
    return invoice;
  }

  #pay(request: SimRequest): SimResponse {
    const stored = this.#sessions.get(request.params['id'] ?? '');
    if (stored === undefined) {
      return html(
        404,
        '<!doctype html><html lang="en"><body><p>Checkout session not found.</p></body></html>',
      );
    }
    const session = stored.object as Record<string, unknown>;
    if (this.#refreshSession(stored).object['status'] !== 'open') {
      return redirect(`/stripe/checkout/${String(session['id'])}`, 303);
    }
    const now = this.#context.now();
    const periodEnd = addMonths(now, 1);
    const subscriptionId = this.#context.ids.id('sub', '_', 24);
    const metadata = session['subscription_data_metadata'] as Record<string, string>;
    const subscription: StripeObject = {
      id: subscriptionId,
      object: 'subscription',
      customer: session['customer'],
      currency: session['currency'],
      status: 'active',
      cancel_at_period_end: false,
      canceled_at: null,
      metadata,
      items: {
        object: 'list',
        has_more: false,
        data: stored.lineItems.map((item) => ({
          id: this.#context.ids.id('si', '_', 14),
          object: 'subscription_item',
          quantity: item.quantity ?? undefined,
          current_period_start: unixSeconds(now),
          current_period_end: unixSeconds(periodEnd),
          price: {
            id: item.price.id,
            object: 'price',
            currency: item.price.currency,
            unit_amount: item.price.unitAmount,
            recurring: { interval: 'month', usage_type: item.price.usageType },
          },
        })),
      },
      created: unixSeconds(now),
      livemode: false,
    };
    this.#subscriptions.set(subscriptionId, subscription);
    const invoice = this.#invoiceFor(
      subscription,
      now,
      periodEnd,
      Number(session['amount_total']),
      true,
    );
    invoice['billing_reason'] = 'subscription_create';
    session['status'] = 'complete';
    session['payment_status'] = 'paid';
    session['subscription'] = subscriptionId;
    session['invoice'] = invoice['id'];
    session['url'] = null;
    this.#emit('customer.subscription.created', subscription);
    this.#emit('invoice.paid', invoice);
    this.#emit('checkout.session.completed', this.#public(session));
    const successUrl = String(session['success_url']).replace(
      '{CHECKOUT_SESSION_ID}',
      String(session['id']),
    );
    return redirect(successUrl, 303);
  }

  #renew(request: SimRequest): SimResponse {
    const subscription = this.#subscriptions.get(request.params['id'] ?? '');
    if (subscription === undefined) {
      return json(404, { error: 'subscription_not_found' });
    }
    const paid = jsonBody(request)['paid'] !== false;
    const items = (subscription['items'] as { data: Record<string, unknown>[] }).data;
    const start = new Date(Number(items[0]?.['current_period_end'] ?? this.#now()) * 1000);
    const end = addMonths(start, 1);
    for (const item of items) {
      item['current_period_start'] = unixSeconds(start);
      item['current_period_end'] = unixSeconds(end);
    }
    const amount = items.reduce(
      (sum, item) =>
        sum +
        Number((item['price'] as StripeObject)['unit_amount'] ?? 0) * Number(item['quantity'] ?? 0),
      0,
    );
    const invoice = this.#invoiceFor(subscription, start, end, amount, paid);
    (subscription as Record<string, unknown>)['status'] = paid ? 'active' : 'past_due';
    this.#emit('customer.subscription.updated', subscription);
    this.#emit(paid ? 'invoice.paid' : 'invoice.payment_failed', invoice);
    return json(201, { invoice: invoice['id'], status: invoice['status'] });
  }

  #cancel(request: SimRequest): SimResponse {
    const subscription = this.#subscriptions.get(request.params['id'] ?? '') as
      Record<string, unknown> | undefined;
    if (subscription === undefined) {
      return json(404, { error: 'subscription_not_found' });
    }
    subscription['status'] = 'canceled';
    subscription['canceled_at'] = this.#now();
    this.#emit('customer.subscription.deleted', subscription);
    return json(200, { id: subscription['id'], status: 'canceled' });
  }

  #dispute(request: SimRequest): SimResponse {
    const invoice = this.#invoices.get(request.params['id'] ?? '');
    if (invoice === undefined) {
      return json(404, { error: 'invoice_not_found' });
    }
    const body = jsonBody(request);
    const dispute: StripeObject = {
      id: this.#context.ids.id('dp', '_', 24),
      object: 'dispute',
      amount: invoice['amount_paid'],
      currency: invoice['currency'],
      charge: invoice['charge'],
      reason: typeof body['reason'] === 'string' ? body['reason'] : 'fraudulent',
      status: 'needs_response',
      evidence_details: {
        due_by: this.#now() + 7 * 86_400,
        has_evidence: false,
        past_due: false,
        submission_count: 0,
      },
      created: this.#now(),
      livemode: false,
    };
    this.#disputes.set(String(dispute['id']), dispute);
    this.#emit('charge.dispute.created', dispute);
    return json(201, { id: dispute['id'] });
  }
}
