CREATE TABLE app.agents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'DRAFT',
  vertical_pack text NOT NULL DEFAULT 'GENERAL',
  production_version_id uuid,
  canary_version_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (canary_version_id IS NULL OR canary_version_id <> production_version_id)
);

CREATE TABLE app.agent_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  agent_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'DRAFT',
  config jsonb NOT NULL,
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  rollout_percent smallint NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  change_summary text,
  based_on_version_id uuid,
  simulation_run_id uuid,
  created_by_user_id uuid REFERENCES app.users (id),
  published_by_user_id uuid REFERENCES app.users (id),
  published_at timestamptz,
  superseded_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (agent_id, version_number),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES app.agents (tenant_id, id),
  FOREIGN KEY (tenant_id, based_on_version_id) REFERENCES app.agent_versions (tenant_id, id),
  CHECK (status NOT IN ('CANARY', 'PRODUCTION', 'SUPERSEDED', 'ROLLED_BACK') OR published_at IS NOT NULL),
  CHECK (status <> 'PRODUCTION' OR rollout_percent = 100),
  CHECK (status <> 'CANARY' OR rollout_percent BETWEEN 1 AND 99)
);

CREATE UNIQUE INDEX agent_versions_one_production_idx ON app.agent_versions (agent_id) WHERE status = 'PRODUCTION';
CREATE UNIQUE INDEX agent_versions_one_canary_idx ON app.agent_versions (agent_id) WHERE status = 'CANARY';

CREATE FUNCTION app.protect_published_agent_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'published agent version % cannot be deleted', OLD.id USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (
       NEW.config IS DISTINCT FROM OLD.config
    OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.version_number IS DISTINCT FROM OLD.version_number
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'published agent version % is immutable', OLD.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_versions_immutable
BEFORE UPDATE OR DELETE ON app.agent_versions
FOR EACH ROW EXECUTE FUNCTION app.protect_published_agent_version();

ALTER TABLE app.agents
  ADD CONSTRAINT agents_production_version_fk FOREIGN KEY (tenant_id, production_version_id)
    REFERENCES app.agent_versions (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT agents_canary_version_fk FOREIGN KEY (tenant_id, canary_version_id)
    REFERENCES app.agent_versions (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.agent_phone_bindings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  agent_id uuid NOT NULL,
  phone_number_id uuid NOT NULL,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, phone_number_id),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES app.agents (tenant_id, id),
  FOREIGN KEY (tenant_id, phone_number_id) REFERENCES app.phone_numbers (tenant_id, id)
);

CREATE UNIQUE INDEX agent_phone_bindings_priority_idx ON app.agent_phone_bindings (phone_number_id, priority) WHERE active;

CREATE TABLE app.caller_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  display_name text,
  display_name_verification text,
  preferred_language text,
  preferred_language_source text,
  trust_level text NOT NULL DEFAULT 'UNVERIFIED' CHECK (trust_level IN ('UNVERIFIED', 'PARTIALLY_VERIFIED', 'VERIFIED')),
  memory_enabled boolean NOT NULL DEFAULT false,
  shared_phone_suspected boolean NOT NULL DEFAULT false,
  merged_into_profile_id uuid,
  last_interaction_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_profile_id) REFERENCES app.caller_profiles (tenant_id, id),
  CHECK (merged_into_profile_id IS NULL OR merged_into_profile_id <> id)
);

CREATE TABLE app.person_identities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  person_id uuid NOT NULL,
  location_id uuid,
  identity_type text NOT NULL,
  normalized_value text NOT NULL,
  value_hash bytea NOT NULL CHECK (octet_length(value_hash) = 32),
  verification_state text NOT NULL,
  source text NOT NULL,
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verified_at timestamptz,
  last_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identity_type, normalized_value),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (identity_type <> 'PHONE' OR normalized_value ~ '^\+[1-9][0-9]{6,14}$'),
  CHECK (identity_type <> 'EMAIL' OR normalized_value = lower(normalized_value)),
  CHECK (verification_state NOT IN ('OTP_VERIFIED', 'EMAIL_VERIFIED', 'CRM_VERIFIED', 'CONNECTOR_VERIFIED', 'HUMAN_VERIFIED') OR verified_at IS NOT NULL)
);

CREATE INDEX person_identities_hash_idx ON app.person_identities (tenant_id, identity_type, value_hash);

CREATE TABLE app.identity_merge_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  source_person_id uuid NOT NULL,
  target_person_id uuid NOT NULL,
  merge_kind text NOT NULL CHECK (merge_kind IN ('AUTOMATIC_DETERMINISTIC', 'MANUAL', 'UNDO')),
  matched_keys text[] NOT NULL,
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  actor_type text NOT NULL,
  actor_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_person_id) REFERENCES app.caller_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, target_person_id) REFERENCES app.caller_profiles (tenant_id, id),
  CHECK (source_person_id <> target_person_id),
  CHECK (merge_kind <> 'AUTOMATIC_DETERMINISTIC' OR confidence >= 0.99)
);

CREATE TABLE app.calls (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  phone_number_id uuid,
  agent_id uuid,
  agent_version_id uuid,
  person_id uuid,
  provider text NOT NULL,
  provider_call_id text NOT NULL,
  realtime_session_ref text,
  channel text NOT NULL,
  direction text NOT NULL,
  caller_e164 text CHECK (caller_e164 IS NULL OR caller_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  language text,
  status text NOT NULL DEFAULT 'INITIATED',
  conversation_state text NOT NULL DEFAULT 'GREETING',
  admission_decision text,
  admission_reject_reason text,
  intent text,
  outcome text,
  end_reason text,
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz,
  connected_seconds integer CHECK (connected_seconds IS NULL OR connected_seconds >= 0),
  billable_seconds integer CHECK (billable_seconds IS NULL OR billable_seconds >= 0),
  cost_usd_micros bigint CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0),
  quality_score numeric(5, 2),
  summary text,
  summary_redaction_state text NOT NULL DEFAULT 'REDACTED' CHECK (summary_redaction_state IN ('RAW', 'REDACTED', 'PURGED')),
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  runtime_instance_id text,
  recording_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_call_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, phone_number_id) REFERENCES app.phone_numbers (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES app.agents (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_version_id) REFERENCES app.agent_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (answered_at IS NULL OR answered_at >= started_at),
  CHECK (status NOT IN ('COMPLETED', 'FAILED', 'REJECTED', 'ABANDONED', 'TRANSFERRED') OR ended_at IS NOT NULL)
);

CREATE INDEX calls_tenant_started_idx ON app.calls (tenant_id, started_at DESC, id DESC);
CREATE INDEX calls_tenant_status_idx ON app.calls (tenant_id, status) WHERE status IN ('INITIATED', 'QUEUED', 'IN_PROGRESS', 'TRANSFERRING');
CREATE INDEX calls_person_idx ON app.calls (tenant_id, person_id, started_at DESC) WHERE person_id IS NOT NULL;

CREATE TABLE app.call_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id)
);

CREATE TABLE app.transcript_segments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  speaker text NOT NULL CHECK (speaker IN ('CALLER', 'AGENT', 'HUMAN_AGENT', 'SYSTEM')),
  language text,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL,
  content text NOT NULL,
  redaction_state text NOT NULL DEFAULT 'RAW' CHECK (redaction_state IN ('RAW', 'REDACTED', 'PURGED')),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  CHECK (end_ms >= start_ms),
  CHECK (redaction_state <> 'PURGED' OR content = '')
);

CREATE TABLE app.call_recordings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid NOT NULL UNIQUE,
  storage_key text NOT NULL CHECK (storage_key ~ '^tenants/[0-9a-f-]{36}/recordings/'),
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  consent_ledger_id uuid NOT NULL,
  retention_until timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id)
);

CREATE TABLE app.tool_definitions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,63}$'),
  description text NOT NULL,
  kind text NOT NULL,
  connector_key text,
  http_method text CHECK (http_method IS NULL OR http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  base_url text CHECK (base_url IS NULL OR base_url ~ '^https?://[^/?#@]+$'),
  path_template text CHECK (path_template IS NULL OR (path_template ~ '^/' AND path_template !~ '\.\.')),
  allowed_hosts text[] NOT NULL DEFAULT '{}',
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  auth_type text NOT NULL DEFAULT 'NONE',
  auth_secret_ref_id uuid,
  side_effect_class text NOT NULL,
  confirmation_policy text NOT NULL,
  timeout_ms integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 500 AND 10000),
  max_retries smallint NOT NULL DEFAULT 0 CHECK (max_retries BETWEEN 0 AND 5),
  idempotency_supported boolean NOT NULL DEFAULT false,
  response_max_bytes integer NOT NULL DEFAULT 262144 CHECK (response_max_bytes BETWEEN 1024 AND 1048576),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'KILLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, auth_secret_ref_id) REFERENCES app.tenant_secret_refs (tenant_id, id),
  CHECK (kind <> 'CUSTOM_API' OR (base_url IS NOT NULL AND http_method IS NOT NULL AND cardinality(allowed_hosts) > 0)),
  CHECK (auth_type = 'NONE' OR auth_secret_ref_id IS NOT NULL),
  CHECK (side_effect_class = 'READ' OR confirmation_policy <> 'NONE' OR idempotency_supported),
  CHECK (side_effect_class <> 'HIGH_RISK_WRITE' OR confirmation_policy IN ('CALLER_CONFIRMATION_WITH_VERIFICATION', 'HUMAN_APPROVAL'))
);

CREATE TABLE app.tool_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid,
  tool_definition_id uuid NOT NULL,
  specialist text,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING',
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  confirmation_event_id uuid,
  http_status smallint,
  error_code text,
  response_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  trace_id text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tool_definition_id, idempotency_key),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  FOREIGN KEY (tenant_id, tool_definition_id) REFERENCES app.tool_definitions (tenant_id, id)
);

CREATE INDEX tool_runs_call_idx ON app.tool_runs (tenant_id, call_id) WHERE call_id IS NOT NULL;
CREATE INDEX tool_runs_failed_idx ON app.tool_runs (tenant_id, created_at) WHERE status IN ('FAILED', 'TIMED_OUT');

CREATE TABLE app.transfer_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid NOT NULL,
  transfer_type text NOT NULL,
  trigger text NOT NULL,
  state text NOT NULL DEFAULT 'PREPARING',
  destination_e164 text CHECK (destination_e164 IS NULL OR destination_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  destination_sip_uri text CHECK (destination_sip_uri IS NULL OR destination_sip_uri ~ '^sips?:'),
  destination_label text,
  whisper_summary jsonb,
  failure_reason text,
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  bridged_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  CHECK (num_nonnulls(destination_e164, destination_sip_uri) = 1),
  CHECK (state NOT IN ('FAILED', 'RETURNED_TO_AI') OR failure_reason IS NOT NULL)
);

CREATE TABLE app.consent_ledger (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid,
  person_id uuid,
  channel text NOT NULL,
  disclosure_version text NOT NULL,
  disclosure_language text NOT NULL,
  disclosure_delivered_at timestamptz NOT NULL,
  recording_consent text NOT NULL,
  contact_consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_event_id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  CHECK (num_nonnulls(call_id, person_id) >= 1)
);

ALTER TABLE app.call_recordings
  ADD CONSTRAINT call_recordings_consent_fk FOREIGN KEY (consent_ledger_id) REFERENCES app.consent_ledger (id);

CREATE TABLE app.quality_scores (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  call_id uuid NOT NULL,
  rubric_version text NOT NULL,
  evaluator_model text,
  deterministic_metrics jsonb NOT NULL,
  model_metrics jsonb,
  overall_score numeric(5, 2) NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  flags text[] NOT NULL DEFAULT '{}',
  human_review_status text NOT NULL DEFAULT 'NOT_SAMPLED' CHECK (human_review_status IN ('NOT_SAMPLED', 'SAMPLED', 'REVIEWED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, rubric_version),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id)
);

CREATE INDEX quality_scores_flags_idx ON app.quality_scores USING gin (flags);
