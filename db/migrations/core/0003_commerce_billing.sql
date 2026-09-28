CREATE TABLE app.price_books (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  pricing_version text NOT NULL CHECK (pricing_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.v[0-9]+$'),
  market text NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  item_kind text NOT NULL CHECK (item_kind IN ('PLAN', 'ADD_ON', 'OVERAGE')),
  plan_code text,
  add_on_code text,
  billing_interval text NOT NULL CHECK (billing_interval IN ('MONTH', 'YEAR', 'ONE_TIME', 'METERED')),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  stripe_price_id text UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((item_kind = 'ADD_ON') = (add_on_code IS NOT NULL)),
  CHECK (item_kind = 'ADD_ON' OR plan_code IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (pricing_version, market, currency, item_kind, plan_code, add_on_code, billing_interval)
);

CREATE TABLE app.billing_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  customer_type text NOT NULL CHECK (customer_type IN ('BUSINESS', 'INDIVIDUAL')),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 300),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  postal_code text NOT NULL,
  city text NOT NULL,
  address_line1 text NOT NULL,
  address_line2 text,
  billing_email citext NOT NULL,
  hu_tax_number text CHECK (hu_tax_number IS NULL OR hu_tax_number ~ '^[0-9]{8}-[1-5]-[0-9]{2}$'),
  eu_vat_id text CHECK (eu_vat_id IS NULL OR eu_vat_id ~ '^[A-Z]{2}[0-9A-Za-z+*.]{2,13}$'),
  vat_id_validated_at timestamptz,
  vat_validation_ref text,
  tax_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_customer_id text UNIQUE,
  billingo_partner_id bigint UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (customer_type = 'INDIVIDUAL' OR country <> 'HU' OR hu_tax_number IS NOT NULL)
);

CREATE TABLE app.checkout_orders (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  billing_profile_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES app.users (id),
  status text NOT NULL DEFAULT 'DRAFT',
  plan_code text NOT NULL,
  add_ons jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_version text NOT NULL,
  market text NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  selected_phone_number jsonb,
  terms_version text NOT NULL,
  client_ip inet,
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  stripe_subscription_id text,
  stripe_invoice_id text,
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, billing_profile_id) REFERENCES app.billing_profiles (tenant_id, id),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (status <> 'PAID' OR paid_at IS NOT NULL)
);

CREATE TABLE app.subscriptions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  status text NOT NULL,
  plan_code text NOT NULL,
  pricing_version text NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  pending_plan_code text,
  pending_change_effective_at timestamptz,
  canceled_at timestamptz,
  entitlement_version integer NOT NULL DEFAULT 0 CHECK (entitlement_version >= 0),
  last_stripe_event_created_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (current_period_end > current_period_start)
);

CREATE UNIQUE INDEX subscriptions_one_live_per_tenant_idx
  ON app.subscriptions (tenant_id)
  WHERE status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'PAUSED');

CREATE TABLE app.subscription_add_ons (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  subscription_id uuid NOT NULL,
  add_on_code text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  stripe_subscription_item_id text UNIQUE,
  retention_state text NOT NULL DEFAULT 'ENABLED',
  activated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES app.subscriptions (tenant_id, id)
);

CREATE UNIQUE INDEX subscription_add_ons_active_idx
  ON app.subscription_add_ons (subscription_id, add_on_code)
  WHERE retention_state = 'ENABLED';

CREATE TABLE app.entitlement_snapshots (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  version integer NOT NULL CHECK (version > 0),
  plan_code text NOT NULL,
  pricing_version text NOT NULL,
  billing_period_start timestamptz NOT NULL,
  billing_period_end timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  included_voice_seconds bigint NOT NULL CHECK (included_voice_seconds >= 0),
  overage_minor_per_minute bigint NOT NULL CHECK (overage_minor_per_minute >= 0),
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  concurrency_limit integer NOT NULL CHECK (concurrency_limit > 0),
  burst_policy text NOT NULL,
  features jsonb NOT NULL,
  limits jsonb NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('STRIPE_EVENT', 'CONTRACT', 'ADMIN_OVERRIDE', 'DUNNING')),
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, source_kind, source_ref),
  CHECK (billing_period_end > billing_period_start)
);

CREATE TABLE app.payment_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  stripe_event_id text NOT NULL UNIQUE CHECK (stripe_event_id ~ '^evt_'),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  event_type text NOT NULL,
  object_id text NOT NULL,
  order_id uuid,
  amount_minor bigint,
  currency char(3) CHECK (currency IS NULL OR currency IN ('HUF', 'EUR', 'USD')),
  livemode boolean NOT NULL,
  stripe_created_at timestamptz NOT NULL,
  redacted_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id)
);

CREATE TABLE app.billing_ledger_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  entry_type text NOT NULL CHECK (entry_type IN ('SUBSCRIPTION_CHARGE', 'ADD_ON_CHARGE', 'OVERAGE_CHARGE', 'PAYMENT', 'REFUND', 'CREDIT', 'ADJUSTMENT', 'DISPUTE_HOLD', 'DISPUTE_RELEASE')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  order_id uuid,
  stripe_invoice_id text,
  stripe_object_id text,
  usage_period_start timestamptz,
  usage_period_end timestamptz,
  description_key text NOT NULL,
  compensates_entry_id uuid REFERENCES app.billing_ledger_entries (id),
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id)
);

CREATE TABLE app.billing_documents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  order_id uuid,
  billing_profile_id uuid NOT NULL,
  stripe_invoice_id text,
  document_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  billingo_partner_id bigint,
  billingo_document_id bigint UNIQUE,
  invoice_number text UNIQUE,
  correction_of_document_id uuid REFERENCES app.billing_documents (id),
  correction_reason text,
  total_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  line_items jsonb NOT NULL,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code text,
  issued_at timestamptz,
  sent_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, billing_profile_id) REFERENCES app.billing_profiles (tenant_id, id),
  CHECK ((document_type = 'INVOICE') = (correction_of_document_id IS NULL)),
  CHECK (document_type = 'INVOICE' OR correction_reason IS NOT NULL),
  CHECK (status NOT IN ('CREATED', 'SENT') OR billingo_document_id IS NOT NULL)
);

CREATE UNIQUE INDEX billing_documents_one_invoice_per_stripe_invoice_idx
  ON app.billing_documents (stripe_invoice_id)
  WHERE document_type = 'INVOICE' AND stripe_invoice_id IS NOT NULL;

CREATE TABLE app.refunds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  order_id uuid,
  stripe_refund_id text NOT NULL UNIQUE,
  stripe_charge_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REQUIRES_ACTION')),
  correction_document_id uuid,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, correction_document_id) REFERENCES app.billing_documents (tenant_id, id)
);

CREATE TABLE app.disputes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  stripe_dispute_id text NOT NULL UNIQUE CHECK (stripe_dispute_id ~ '^(dp|du)_'),
  stripe_charge_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  reason text NOT NULL,
  status text NOT NULL,
  evidence_package_key text,
  evidence_due_by timestamptz,
  submitted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.fraud_signals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  order_id uuid,
  stripe_payment_intent_id text,
  signal_type text NOT NULL,
  score numeric(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id),
  CHECK (NOT jsonb_path_exists(evidence, '$.** ? (@.type() == "string" && @ like_regex "[0-9]{13,19}")'))
);

CREATE TABLE app.fraud_reviews (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants (id),
  status text NOT NULL DEFAULT 'CLEAR',
  aggregate_score numeric(5, 2) NOT NULL DEFAULT 0 CHECK (aggregate_score BETWEEN 0 AND 100),
  reason text,
  reviewed_by_user_id uuid REFERENCES app.users (id),
  reviewed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.cost_budgets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  billing_period_start timestamptz NOT NULL,
  billing_period_end timestamptz NOT NULL,
  period_budget_usd_micros bigint NOT NULL CHECK (period_budget_usd_micros >= 0),
  unlocked_quarters smallint NOT NULL DEFAULT 1 CHECK (unlocked_quarters BETWEEN 1 AND 4),
  consumed_usd_micros bigint NOT NULL DEFAULT 0 CHECK (consumed_usd_micros >= 0),
  daily_cap_usd_micros bigint NOT NULL CHECK (daily_cap_usd_micros > 0),
  monthly_cap_usd_micros bigint NOT NULL CHECK (monthly_cap_usd_micros > 0),
  soft_warning_sent_at timestamptz,
  hard_cap_reached_at timestamptz,
  released_to_margin_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, billing_period_start),
  CHECK (billing_period_end > billing_period_start),
  CHECK (daily_cap_usd_micros <= monthly_cap_usd_micros)
);

CREATE TABLE app.payment_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid,
  provider text NOT NULL,
  provider_session_ref text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  status text NOT NULL CHECK (status IN ('CREATED', 'COLLECTING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  token_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_session_ref),
  CHECK (token_reference IS NULL OR token_reference !~ '[0-9]{13,19}')
);
