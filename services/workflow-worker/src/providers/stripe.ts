import Stripe from 'stripe';
import { ProviderCallError } from './errors.js';

export interface PaidInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly totalExcludingTaxMinor: number;
  readonly paidAt: Date | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly subscriptionId: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly amountMinor: number;
    readonly quantity: number;
  }[];
}

export interface SubscriptionState {
  readonly id: string;
  readonly status: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
}

export interface BillingGateway {
  retrieveInvoice(invoiceId: string): Promise<PaidInvoice>;
  retrieveSubscription(subscriptionId: string): Promise<SubscriptionState>;
}

function wrap(error: unknown, operation: string): ProviderCallError {
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode ?? 0;
    return new ProviderCallError(
      'stripe',
      error.code ?? `stripe_http_${String(status)}`,
      `${operation} failed`,
      {
        retryable: status === 0 || status === 429 || status >= 500,
        httpStatus: status === 0 ? null : status,
        cause: error,
      },
    );
  }
  return new ProviderCallError('stripe', 'network_error', `${operation} failed`, {
    retryable: true,
    cause: error,
  });
}

export class StripeSdkBillingGateway implements BillingGateway {
  readonly #stripe: Stripe;

  constructor(secretKey: string, simulatorUrl: string | null) {
    const simulator = simulatorUrl === null ? null : new URL(simulatorUrl);
    this.#stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: 'velyric-workflow-worker' },
      ...(simulator === null
        ? {}
        : {
            host: simulator.hostname,
            port: Number(simulator.port || (simulator.protocol === 'https:' ? 443 : 80)),
            protocol: simulator.protocol === 'https:' ? 'https' : 'http',
          }),
    });
  }

  async retrieveInvoice(invoiceId: string): Promise<PaidInvoice> {
    let invoice: Stripe.Invoice;
    try {
      invoice = await this.#stripe.invoices.retrieve(invoiceId, { expand: ['lines'] });
    } catch (error) {
      throw wrap(error, 'invoice retrieval');
    }
    let lines: Stripe.InvoiceLineItem[] = [...invoice.lines.data];
    if (invoice.lines.has_more) {
      lines = [];
      try {
        for await (const line of this.#stripe.invoices.listLineItems(invoiceId, { limit: 100 })) {
          lines.push(line);
        }
      } catch (error) {
        throw wrap(error, 'invoice line retrieval');
      }
    }
    const subscription = invoice.parent?.subscription_details?.subscription;
    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status ?? 'draft',
      currency: invoice.currency.toUpperCase(),
      totalMinor: invoice.total,
      totalExcludingTaxMinor: invoice.total_excluding_tax ?? invoice.total,
      paidAt:
        typeof invoice.status_transitions.paid_at === 'number'
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : null,
      periodStart: new Date(invoice.period_start * 1000),
      periodEnd: new Date(invoice.period_end * 1000),
      subscriptionId: typeof subscription === 'string' ? subscription : (subscription?.id ?? null),
      lines: lines.map((line) => ({
        description: line.description ?? 'Velyric',
        amountMinor: line.amount,
        quantity: line.quantity ?? 1,
      })),
    };
  }

  async retrieveSubscription(subscriptionId: string): Promise<SubscriptionState> {
    try {
      const subscription = await this.#stripe.subscriptions.retrieve(subscriptionId);
      const periodEnd = subscription.items.data.reduce<number | null>(
        (latest, item) =>
          latest === null || item.current_period_end > latest ? item.current_period_end : latest,
        null,
      );
      return {
        id: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
      };
    } catch (error) {
      throw wrap(error, 'subscription retrieval');
    }
  }
}
