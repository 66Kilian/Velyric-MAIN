CREATE TABLE app.integrations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  integration_type text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_AUTHORIZATION',
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  external_account_ref text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  secret_ref_id uuid,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_health_check_at timestamptz,
  last_error_code text,
  connected_by_user_id uuid REFERENCES app.users (id),
  disconnected_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, secret_ref_id) REFERENCES app.tenant_secret_refs (tenant_id, id),
  CHECK (status <> 'CONNECTED' OR secret_ref_id IS NOT NULL OR integration_type = 'OUTBOUND_WEBHOOK'),
  CHECK (NOT (config ?| ARRAY['password', 'client_secret', 'access_token', 'refresh_token', 'api_key', 'secret', 'private_key']))
);

ALTER TABLE app.resources
  ADD CONSTRAINT resources_calendar_integration_fk FOREIGN KEY (tenant_id, calendar_integration_id)
    REFERENCES app.integrations (tenant_id, id);

CREATE TABLE app.oauth_authorizations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  integration_id uuid NOT NULL,
  provider text NOT NULL,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  pkce_verifier_ciphertext bytea NOT NULL,
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https?://'),
  requested_scopes text[] NOT NULL CHECK (cardinality(requested_scopes) > 0),
  created_by_user_id uuid NOT NULL REFERENCES app.users (id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES app.integrations (tenant_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);

CREATE TABLE app.connector_manifests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  manifest_version text NOT NULL CHECK (manifest_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  visibility text NOT NULL CHECK (visibility IN ('VERIFIED_PUBLIC', 'PRIVATE_TENANT')),
  owner_tenant_id uuid REFERENCES app.tenants (id),
  auth_type text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  signature text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'DEPRECATED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_key, manifest_version),
  CHECK ((visibility = 'PRIVATE_TENANT') = (owner_tenant_id IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR signature IS NOT NULL)
);

CREATE TABLE app.outbound_webhooks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  url text NOT NULL CHECK (url ~ '^https://[^/?#@]+'),
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0),
  signing_secret_ref_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES app.users (id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, signing_secret_ref_id) REFERENCES app.tenant_secret_refs (tenant_id, id)
);

CREATE TABLE app.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  webhook_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  http_status smallint,
  next_attempt_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, event_id),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES app.outbound_webhooks (tenant_id, id)
);

CREATE TABLE app.notification_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  notification_type text NOT NULL,
  channel text NOT NULL,
  locale text NOT NULL,
  recipient_user_id uuid REFERENCES app.users (id),
  recipient_person_id uuid,
  destination_hash bytea NOT NULL CHECK (octet_length(destination_hash) = 32),
  destination_masked text NOT NULL,
  template_key text NOT NULL,
  template_version text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 8 AND 300),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, recipient_person_id) REFERENCES app.caller_profiles (tenant_id, id)
);

CREATE TABLE app.notification_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  notification_event_id uuid NOT NULL,
  status text NOT NULL,
  provider text,
  provider_message_id text,
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id, status),
  FOREIGN KEY (tenant_id, notification_event_id) REFERENCES app.notification_events (tenant_id, id)
);

CREATE TABLE app.notification_preferences (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  user_id uuid REFERENCES app.users (id),
  notification_type text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, notification_type, channel)
);

CREATE TABLE app.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid REFERENCES app.tenants (id),
  user_id uuid REFERENCES app.users (id),
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 3 AND 120),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 255),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL,
  response_status smallint CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, scope, idempotency_key),
  CHECK (num_nonnulls(tenant_id, user_id) >= 1),
  CHECK (state <> 'COMPLETED' OR response_status IS NOT NULL),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expiry_idx ON app.idempotency_keys (expires_at);

CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid REFERENCES app.tenants (id),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  subject text NOT NULL,
  payload jsonb NOT NULL,
  trace_id text,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_until timestamptz,
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_pending_idx ON app.outbox_events (available_at, id) WHERE published_at IS NULL;

CREATE FUNCTION app.outbox_claim(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF app.outbox_events
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  UPDATE app.outbox_events o
  SET claimed_by = p_worker,
      claimed_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
      publish_attempts = o.publish_attempts + 1
  WHERE o.id IN (
    SELECT c.id
    FROM app.outbox_events c
    WHERE c.published_at IS NULL
      AND c.available_at <= now()
      AND (c.claimed_until IS NULL OR c.claimed_until < now())
    ORDER BY c.available_at, c.id
    LIMIT least(greatest(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.*
$$;

CREATE FUNCTION app.outbox_mark_published(p_worker text, p_ids uuid[]) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH updated AS (
    UPDATE app.outbox_events
    SET published_at = now(), claimed_until = NULL, last_error = NULL
    WHERE id = ANY (p_ids) AND claimed_by = p_worker AND published_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated
$$;

CREATE FUNCTION app.outbox_mark_failed(p_worker text, p_id uuid, p_error text, p_retry_after_seconds integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  UPDATE app.outbox_events
  SET claimed_until = NULL,
      last_error = left(p_error, 2000),
      available_at = now() + make_interval(secs => least(greatest(p_retry_after_seconds, 1), 3600))
  WHERE id = p_id AND claimed_by = p_worker AND published_at IS NULL
$$;

CREATE TABLE app.feature_flags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  flag_key text NOT NULL,
  scope_type text NOT NULL,
  scope_ref text,
  flag_value jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) >= 3),
  expires_at timestamptz,
  changed_by text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (flag_key, scope_type, scope_ref),
  CHECK ((scope_type = 'GLOBAL') = (scope_ref IS NULL))
);

CREATE TABLE app.kill_switches (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  switch_key text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL', 'REGION', 'TENANT', 'LOCATION', 'AGENT', 'PROVIDER', 'MODEL', 'TOOL')),
  scope_ref text,
  engaged boolean NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) >= 3),
  engaged_by text,
  engaged_at timestamptz,
  released_by text,
  released_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (switch_key, scope_type, scope_ref),
  CHECK ((scope_type = 'GLOBAL') = (scope_ref IS NULL)),
  CHECK (NOT engaged OR (engaged_by IS NOT NULL AND engaged_at IS NOT NULL))
);

CREATE TABLE app.provider_health (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider text NOT NULL,
  region text NOT NULL,
  capability text NOT NULL,
  status text NOT NULL,
  circuit_state text NOT NULL,
  latency_p95_ms integer CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0),
  error_rate numeric(6, 5) NOT NULL CHECK (error_rate BETWEEN 0 AND 1),
  timeout_rate numeric(6, 5) NOT NULL CHECK (timeout_rate BETWEEN 0 AND 1),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_health_latest_idx ON app.provider_health (provider, capability, region, observed_at DESC);

CREATE TABLE app.provider_webhook_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  tenant_id uuid REFERENCES app.tenants (id),
  signature_verified boolean NOT NULL CHECK (signature_verified),
  signature_scheme text NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb NOT NULL,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE app.webhook_processing (
  webhook_event_id uuid PRIMARY KEY REFERENCES app.provider_webhook_events (id),
  tenant_id uuid REFERENCES app.tenants (id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED', 'DEAD_LETTER')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  next_attempt_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_processing_backlog_idx ON app.webhook_processing (status, next_attempt_at) WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE app.audit_logs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid REFERENCES app.tenants (id),
  actor_type text NOT NULL,
  actor_id text,
  actor_label text,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  object_type text NOT NULL,
  object_id text,
  diff_hash text CHECK (diff_hash IS NULL OR diff_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  trace_id text,
  support_grant_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_tenant_time_idx ON app.audit_logs (tenant_id, occurred_at DESC, id DESC);

CREATE TABLE app.retention_policies (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  retention_class text NOT NULL,
  retain_days integer NOT NULL CHECK (retain_days >= 0),
  platform_max_days integer NOT NULL CHECK (platform_max_days > 0),
  updated_by_user_id uuid REFERENCES app.users (id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, retention_class),
  CHECK (retain_days <= platform_max_days)
);

CREATE TABLE app.legal_holds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  scope_type text NOT NULL CHECK (scope_type IN ('TENANT', 'PERSON', 'CALL', 'DISPUTE', 'BILLING')),
  scope_ref uuid,
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  legal_basis text NOT NULL,
  created_by text NOT NULL,
  released_by text,
  released_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((scope_type = 'TENANT') = (scope_ref IS NULL)),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX legal_holds_active_idx ON app.legal_holds (tenant_id, scope_type, scope_ref) WHERE released_at IS NULL;

CREATE TABLE app.dsar_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  person_id uuid,
  request_type text NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED',
  received_via text NOT NULL,
  verification_method text,
  verified_at timestamptz,
  export_storage_key text CHECK (export_storage_key IS NULL OR export_storage_key ~ '^tenants/[0-9a-f-]{36}/exports/'),
  legal_hold_id uuid,
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  rejection_reason text,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_hold_id) REFERENCES app.legal_holds (tenant_id, id),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'ON_LEGAL_HOLD' OR legal_hold_id IS NOT NULL)
);

CREATE TABLE app.simulation_suites (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  agent_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text,
  is_release_gate boolean NOT NULL DEFAULT false,
  min_pass_ratio numeric(4, 3) NOT NULL DEFAULT 1 CHECK (min_pass_ratio BETWEEN 0 AND 1),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agent_id, name),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES app.agents (tenant_id, id)
);

CREATE TABLE app.simulation_scenarios (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  suite_id uuid NOT NULL,
  scenario_key text NOT NULL CHECK (scenario_key ~ '^[a-z0-9][a-z0-9_.-]{2,119}$'),
  scenario_class text NOT NULL,
  language text NOT NULL,
  definition jsonb NOT NULL,
  deterministic_assertions jsonb NOT NULL DEFAULT '[]'::jsonb,
  seed bigint NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id, scenario_key),
  FOREIGN KEY (tenant_id, suite_id) REFERENCES app.simulation_suites (tenant_id, id)
);

CREATE TABLE app.simulation_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  suite_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  seed bigint NOT NULL,
  model_versions jsonb NOT NULL,
  rubric_version text NOT NULL,
  tool_fixture_version text NOT NULL,
  requested_by text NOT NULL,
  passed_count integer NOT NULL DEFAULT 0 CHECK (passed_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  errored_count integer NOT NULL DEFAULT 0 CHECK (errored_count >= 0),
  scores jsonb,
  gate_passed boolean,
  artifacts_prefix text CHECK (artifacts_prefix IS NULL OR artifacts_prefix ~ '^tenants/[0-9a-f-]{36}/simulations/'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, suite_id) REFERENCES app.simulation_suites (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_version_id) REFERENCES app.agent_versions (tenant_id, id),
  CHECK (status NOT IN ('PASSED', 'FAILED') OR (finished_at IS NOT NULL AND gate_passed IS NOT NULL)),
  CHECK (status <> 'PASSED' OR gate_passed)
);

ALTER TABLE app.agent_versions
  ADD CONSTRAINT agent_versions_simulation_run_fk FOREIGN KEY (tenant_id, simulation_run_id)
    REFERENCES app.simulation_runs (tenant_id, id);

CREATE TABLE app.recommendation_change_sets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  agent_id uuid NOT NULL,
  recommendation_kind text NOT NULL,
  title_key text NOT NULL,
  evidence jsonb NOT NULL,
  affected_call_count integer NOT NULL CHECK (affected_call_count >= 0),
  metric_name text NOT NULL,
  metric_delta numeric(12, 4) NOT NULL,
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  touches_compliance boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  draft_version_id uuid,
  decided_by_user_id uuid REFERENCES app.users (id),
  decided_at timestamptz,
  rejection_feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES app.agents (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_version_id) REFERENCES app.agent_versions (tenant_id, id),
  CHECK (status IN ('PROPOSED', 'SUPERSEDED') OR (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE TABLE app.usage_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid,
  metric text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  provider text,
  model text,
  source_event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_event_id, metric),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id)
);

CREATE INDEX usage_events_period_idx ON app.usage_events (tenant_id, occurred_at);

CREATE TABLE app.usage_aggregates (
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  billing_period_start timestamptz NOT NULL,
  metric text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  last_event_occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, billing_period_start, metric)
);

CREATE TABLE app.provider_cost_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  provider text NOT NULL,
  external_ref text NOT NULL,
  cost_kind text NOT NULL,
  call_id uuid,
  amount_usd_micros bigint NOT NULL,
  original_amount_minor bigint,
  original_currency char(3),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_ref),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL))
);

CREATE TABLE app.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_date date NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'MATCHED', 'MISMATCH', 'FAILED')),
  ledger_usd_micros bigint,
  provider_usd_micros bigint,
  deviation_ratio numeric(10, 6),
  tolerance_ratio numeric(10, 6) NOT NULL CHECK (tolerance_ratio >= 0),
  alert_raised boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_date, provider),
  CHECK (status <> 'MISMATCH' OR alert_raised)
);

CREATE TABLE app.vertical_policy_packs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  pack text NOT NULL,
  pack_version text NOT NULL CHECK (pack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  definition jsonb NOT NULL,
  definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RELEASED', 'DEPRECATED')),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack, pack_version),
  CHECK (status <> 'RELEASED' OR released_at IS NOT NULL)
);

CREATE TABLE app.tenant_policy_packs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  pack text NOT NULL,
  pack_version text NOT NULL,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_custom_fields text[] NOT NULL DEFAULT '{}',
  applied_by_user_id uuid REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, location_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (pack, pack_version) REFERENCES app.vertical_policy_packs (pack, pack_version)
);

CREATE TABLE app.tenant_search_index (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants (id),
  legal_name text NOT NULL,
  slug citext NOT NULL,
  stripe_customer_ids text[] NOT NULL DEFAULT '{}',
  phone_e164s text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_search_index_stripe_idx ON app.tenant_search_index USING gin (stripe_customer_ids);
CREATE INDEX tenant_search_index_phone_idx ON app.tenant_search_index USING gin (phone_e164s);
