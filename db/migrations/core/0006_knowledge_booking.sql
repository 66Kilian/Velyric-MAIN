CREATE TABLE app.knowledge_sources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  source_type text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  uri text CHECK (uri IS NULL OR uri ~ '^https://'),
  storage_key text CHECK (storage_key IS NULL OR storage_key ~ '^tenants/[0-9a-f-]{36}/knowledge/'),
  mime_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 104857600),
  language text,
  status text NOT NULL DEFAULT 'PENDING_UPLOAD',
  freshness text NOT NULL DEFAULT 'UNKNOWN',
  freshness_ttl_hours integer CHECK (freshness_ttl_hours IS NULL OR freshness_ttl_hours > 0),
  sync_schedule text,
  active_version_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  acl text[] NOT NULL DEFAULT '{}',
  last_synced_at timestamptz,
  last_error_code text,
  created_by_user_id uuid REFERENCES app.users (id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (num_nonnulls(uri, storage_key) >= 1 OR source_type IN ('FAQ', 'MANUAL_QA')),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE app.knowledge_source_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  source_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'QUEUED',
  malware_scan_result text CHECK (malware_scan_result IS NULL OR malware_scan_result IN ('CLEAN', 'INFECTED', 'ERROR')),
  pii_findings text[] NOT NULL DEFAULT '{}',
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  parser text,
  ocr_used boolean NOT NULL DEFAULT false,
  error_code text,
  parsed_at timestamptz,
  activated_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (source_id, version_number),
  FOREIGN KEY (tenant_id, source_id) REFERENCES app.knowledge_sources (tenant_id, id),
  CHECK (status <> 'ACTIVE' OR malware_scan_result = 'CLEAN')
);

CREATE UNIQUE INDEX knowledge_source_versions_one_active_idx ON app.knowledge_source_versions (source_id) WHERE status = 'ACTIVE';

ALTER TABLE app.knowledge_sources
  ADD CONSTRAINT knowledge_sources_active_version_fk FOREIGN KEY (tenant_id, active_version_id)
    REFERENCES app.knowledge_source_versions (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  source_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 16000),
  token_count integer NOT NULL CHECK (token_count > 0),
  language text,
  heading_path text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  pii_flags text[] NOT NULL DEFAULT '{}',
  acl text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT false,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (source_version_id, chunk_index),
  FOREIGN KEY (tenant_id, source_id) REFERENCES app.knowledge_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, source_version_id) REFERENCES app.knowledge_source_versions (tenant_id, id)
);

CREATE INDEX knowledge_chunks_active_idx ON app.knowledge_chunks (tenant_id, source_id) WHERE is_active;
CREATE INDEX knowledge_chunks_tsv_idx ON app.knowledge_chunks USING gin (content_tsv);

CREATE FUNCTION app.activate_knowledge_version(p_version_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_id uuid;
  v_tenant_id uuid;
BEGIN
  SELECT source_id, tenant_id INTO v_source_id, v_tenant_id
  FROM app.knowledge_source_versions
  WHERE id = p_version_id AND status = 'READY'
  FOR UPDATE;
  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'knowledge version % is not READY', p_version_id USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM app.knowledge_sources WHERE id = v_source_id FOR UPDATE;
  UPDATE app.knowledge_chunks SET is_active = false WHERE source_id = v_source_id AND is_active AND source_version_id <> p_version_id;
  UPDATE app.knowledge_source_versions
    SET status = 'SUPERSEDED', deactivated_at = now()
    WHERE source_id = v_source_id AND status = 'ACTIVE';
  UPDATE app.knowledge_chunks SET is_active = true WHERE source_version_id = p_version_id;
  UPDATE app.knowledge_source_versions SET status = 'ACTIVE', activated_at = now() WHERE id = p_version_id;
  UPDATE app.knowledge_sources
    SET active_version_id = p_version_id, status = 'ACTIVE', freshness = 'FRESH', last_synced_at = now()
    WHERE id = v_source_id;
END
$$;

CREATE TABLE app.knowledge_gaps (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid,
  language text NOT NULL,
  question_normalized text NOT NULL,
  question_example text NOT NULL,
  intent text,
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWER_SUGGESTED', 'ANSWERED', 'DISMISSED')),
  suggested_answer text,
  resolved_source_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, language, question_normalized),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_source_id) REFERENCES app.knowledge_sources (tenant_id, id)
);

CREATE TABLE app.knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  field_key text NOT NULL,
  source_a_id uuid NOT NULL,
  source_b_id uuid NOT NULL,
  value_a text NOT NULL,
  value_b text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolved_by_user_id uuid REFERENCES app.users (id),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_a_id) REFERENCES app.knowledge_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, source_b_id) REFERENCES app.knowledge_sources (tenant_id, id),
  CHECK (source_a_id <> source_b_id)
);

CREATE TABLE app.services (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  required_resource_types text[] NOT NULL CONSTRAINT services_required_resource_types_nonempty CHECK (cardinality(required_resource_types) > 0),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency IN ('HUF', 'EUR', 'USD')),
  deposit_required boolean NOT NULL DEFAULT false,
  deposit_minor bigint CHECK (deposit_minor IS NULL OR deposit_minor > 0),
  cancellation_window_minutes integer NOT NULL DEFAULT 0 CHECK (cancellation_window_minutes >= 0),
  no_show_policy text,
  min_party_size integer NOT NULL DEFAULT 1 CHECK (min_party_size >= 1),
  max_party_size integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  CHECK (max_party_size >= min_party_size),
  CHECK ((price_minor IS NULL) = (currency IS NULL)),
  CHECK (NOT deposit_required OR (deposit_minor IS NOT NULL AND currency IS NOT NULL))
);

CREATE TABLE app.resources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  resource_type text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  seat_capacity integer NOT NULL DEFAULT 1 CHECK (seat_capacity >= 1),
  parallel_slots smallint NOT NULL DEFAULT 1 CHECK (parallel_slots BETWEEN 1 AND 100),
  calendar_integration_id uuid,
  external_calendar_ref text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);

CREATE TABLE app.availability_rules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  resource_id uuid NOT NULL,
  timezone text NOT NULL,
  iso_weekday smallint NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  start_local time NOT NULL,
  end_local time NOT NULL,
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES app.resources (tenant_id, id),
  CHECK (end_local > start_local),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE app.availability_exceptions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  resource_id uuid,
  exception_kind text NOT NULL CHECK (exception_kind IN ('CLOSED', 'EXTRA_OPENING')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES app.resources (tenant_id, id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE app.booking_holds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  service_id uuid,
  call_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES app.services (tenant_id, id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);

CREATE TABLE app.bookings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  service_id uuid,
  person_id uuid,
  call_id uuid,
  hold_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  status text NOT NULL DEFAULT 'CONFIRMED',
  source text NOT NULL,
  idempotency_key text NOT NULL,
  external_sync_status text NOT NULL DEFAULT 'NOT_REQUIRED',
  external_event_ref text,
  customer_note text,
  deposit_status text CHECK (deposit_status IS NULL OR deposit_status IN ('REQUIRED', 'PAID', 'WAIVED', 'REFUNDED')),
  canceled_at timestamptz,
  cancellation_reason text,
  rescheduled_from_booking_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (hold_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES app.services (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES app.calls (tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES app.booking_holds (tenant_id, id),
  FOREIGN KEY (tenant_id, rescheduled_from_booking_id) REFERENCES app.bookings (tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'CANCELED' OR canceled_at IS NOT NULL)
);

CREATE INDEX bookings_tenant_start_idx ON app.bookings (tenant_id, starts_at);

CREATE TABLE app.resource_allocations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  resource_id uuid NOT NULL,
  slot_index smallint NOT NULL CHECK (slot_index >= 0),
  during tstzrange NOT NULL CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)),
  hold_id uuid,
  booking_id uuid,
  hold_expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES app.resources (tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES app.booking_holds (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES app.bookings (tenant_id, id),
  CHECK (num_nonnulls(hold_id, booking_id) = 1),
  CHECK ((hold_id IS NOT NULL) = (hold_expires_at IS NOT NULL)),
  CHECK (is_active OR released_at IS NOT NULL),
  CONSTRAINT resource_allocations_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    slot_index WITH =,
    during WITH &&
  ) WHERE (is_active)
);

CREATE FUNCTION app.enforce_allocation_slot_bounds() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_slots smallint;
BEGIN
  SELECT parallel_slots INTO v_slots FROM app.resources WHERE id = NEW.resource_id;
  IF v_slots IS NULL OR NEW.slot_index >= v_slots THEN
    RAISE EXCEPTION 'slot_index % out of range for resource %', NEW.slot_index, NEW.resource_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER resource_allocations_slot_bounds
BEFORE INSERT OR UPDATE OF slot_index, resource_id ON app.resource_allocations
FOR EACH ROW EXECUTE FUNCTION app.enforce_allocation_slot_bounds();

CREATE FUNCTION app.release_expired_allocations(p_resource_id uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE app.resource_allocations
    SET is_active = false, released_at = now()
    WHERE resource_id = p_resource_id
      AND is_active
      AND hold_id IS NOT NULL
      AND hold_expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE app.booking_holds h
    SET status = 'EXPIRED'
    WHERE h.status = 'ACTIVE'
      AND h.expires_at <= now()
      AND EXISTS (SELECT 1 FROM app.resource_allocations a WHERE a.hold_id = h.id AND a.resource_id = p_resource_id);
  RETURN v_count;
END
$$;

CREATE TABLE app.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  location_id uuid NOT NULL,
  person_id uuid NOT NULL,
  service_id uuid,
  resource_type text,
  desired_window tstzrange NOT NULL CHECK (NOT isempty(desired_window)),
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  priority integer NOT NULL DEFAULT 0,
  priority_rule text NOT NULL DEFAULT 'FIFO' CHECK (priority_rule IN ('FIFO', 'WINDOW_FIT', 'PARTY_SIZE_FIT', 'LOYALTY_PROGRAM')),
  contact_consent boolean NOT NULL CHECK (contact_consent),
  contact_channel text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  contact_attempts smallint NOT NULL DEFAULT 0 CHECK (contact_attempts BETWEEN 0 AND 10),
  max_contact_attempts smallint NOT NULL DEFAULT 3 CHECK (max_contact_attempts BETWEEN 1 AND 10),
  last_contacted_at timestamptz,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES app.caller_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES app.services (tenant_id, id),
  CHECK (contact_attempts <= max_contact_attempts)
);

CREATE TABLE app.waitlist_offers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  entry_id uuid NOT NULL,
  hold_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES app.waitlist_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES app.booking_holds (tenant_id, id),
  CHECK (expires_at > offered_at)
);

CREATE UNIQUE INDEX waitlist_offers_one_open_idx ON app.waitlist_offers (entry_id) WHERE status = 'OFFERED';
