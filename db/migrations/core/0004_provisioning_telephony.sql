CREATE TABLE app.tenant_secret_refs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  kind text NOT NULL,
  provider text NOT NULL,
  secret_ref text NOT NULL CHECK (secret_ref ~ '^(aws-sm|local-vault)://[A-Za-z0-9/_+=.@-]+$'),
  secret_version integer NOT NULL CHECK (secret_version > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ROTATING', 'REVOKED', 'FAILED')),
  external_key_id text,
  expires_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, provider, secret_version)
);

CREATE UNIQUE INDEX tenant_secret_refs_one_active_idx
  ON app.tenant_secret_refs (tenant_id, kind, provider)
  WHERE status = 'ACTIVE';

CREATE TABLE app.provisioning_workflows (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  order_id uuid NOT NULL,
  temporal_workflow_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'ORDER_CREATED',
  blocking_reason text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code text,
  last_error_message text,
  next_retry_at timestamptz,
  manual_review_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.checkout_orders (tenant_id, id),
  CHECK (state <> 'MANUAL_REVIEW_REQUIRED' OR manual_review_reason IS NOT NULL)
);

CREATE INDEX provisioning_workflows_state_idx ON app.provisioning_workflows (state, updated_at);

CREATE TABLE app.provisioning_step_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  workflow_id uuid NOT NULL,
  step text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  idempotency_key text NOT NULL,
  external_ref text,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key, attempt),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES app.provisioning_workflows (tenant_id, id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE app.provider_resources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  provider text NOT NULL,
  resource_type text NOT NULL,
  external_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('CREATING', 'ACTIVE', 'SUSPENDED', 'RELEASING', 'RELEASED', 'ORPHANED', 'FAILED')),
  created_by_step_run_id uuid REFERENCES app.provisioning_step_runs (id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, resource_type, external_id)
);

CREATE TABLE app.phone_numbers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  provider text NOT NULL,
  e164 text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  number_type text NOT NULL,
  status text NOT NULL DEFAULT 'PROVISIONING',
  provider_number_ref text,
  sip_connection_ref text,
  fallback_provider text,
  fallback_number_ref text,
  max_concurrent_calls integer CHECK (max_concurrent_calls IS NULL OR max_concurrent_calls > 0),
  retention_until timestamptz,
  released_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, e164),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (status <> 'RETENTION_HOLD' OR retention_until IS NOT NULL),
  CHECK (status <> 'RELEASED' OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX phone_numbers_live_e164_idx ON app.phone_numbers (e164) WHERE status <> 'RELEASED';

CREATE TABLE app.phone_orders (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  workflow_id uuid,
  provider text NOT NULL,
  provider_order_id text UNIQUE,
  provider_reservation_id text UNIQUE,
  e164 text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  number_type text NOT NULL,
  status text NOT NULL DEFAULT 'NUMBER_SELECTED',
  requirements_status text NOT NULL DEFAULT 'NOT_REQUIRED',
  requirement_group_ref text,
  decline_reason text,
  inventory_checked_at timestamptz NOT NULL,
  reserved_until timestamptz,
  phone_number_id uuid,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES app.provisioning_workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, phone_number_id) REFERENCES app.phone_numbers (tenant_id, id),
  CHECK (status <> 'ORDER_SUBMITTED' OR provider_order_id IS NOT NULL),
  CHECK (status <> 'DECLINED' OR decline_reason IS NOT NULL)
);

CREATE TABLE app.kyc_requirements (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  phone_order_id uuid NOT NULL,
  provider_requirement_id text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('TEXTUAL', 'DOCUMENT', 'ADDRESS', 'ACTION')),
  label_key text NOT NULL,
  status text NOT NULL DEFAULT 'REQUIRED',
  provider_document_ref text,
  submitted_value_hash bytea,
  decline_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone_order_id, provider_requirement_id),
  FOREIGN KEY (tenant_id, phone_order_id) REFERENCES app.phone_orders (tenant_id, id)
);
