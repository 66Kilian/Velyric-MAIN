export interface Money {
  readonly amount_minor: number;
  readonly currency: string;
}

export interface BillingProfile {
  readonly id: string;
  readonly customer_type: 'BUSINESS' | 'INDIVIDUAL';
  readonly legal_name: string;
  readonly country: string;
  readonly postal_code: string;
  readonly city: string;
  readonly address_line1: string;
  readonly address_line2: string | null;
  readonly billing_email: string;
  readonly hu_tax_number: string | null;
  readonly eu_vat_id: string | null;
  readonly billing_market: string;
  readonly has_payment_customer: boolean;
  readonly version: number;
  readonly updated_at: string;
}

export interface CheckoutOrder {
  readonly id: string;
  readonly status: string;
  readonly plan_code: string;
  readonly add_ons: readonly { readonly code: string; readonly quantity: number }[];
  readonly pricing_version: string;
  readonly market: string;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly expires_at: string | null;
  readonly paid_at: string | null;
  readonly created_at: string;
}

export interface SubscriptionOverview {
  readonly subscription: {
    readonly id: string;
    readonly status: string;
    readonly plan_code: string;
    readonly current_period_start: string | null;
    readonly current_period_end: string | null;
    readonly cancel_at_period_end: boolean;
    readonly pending_plan_code: string | null;
  } | null;
  readonly entitlement: {
    readonly version: number;
    readonly plan_code: string;
    readonly included_voice_seconds: number;
    readonly overage_per_minute: Money;
    readonly concurrency_limit: number;
    readonly features: readonly string[];
    readonly limits: Readonly<Record<string, unknown>>;
    readonly billing_period_start: string | null;
    readonly billing_period_end: string | null;
  } | null;
  readonly usage: readonly { readonly metric: string; readonly quantity: number }[];
}

export interface PendingInvitation {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_name: string;
  readonly role: string;
  readonly expires_at: string | null;
}
