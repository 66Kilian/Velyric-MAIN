DO $touch$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
      )
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      r.relname || '_touch_updated_at',
      r.relname
    );
  END LOOP;
END
$touch$;

DO $append_only$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_logs', 'consent_ledger', 'usage_events', 'provider_cost_events', 'payment_events',
    'billing_ledger_entries', 'provider_webhook_events', 'call_events', 'notification_events',
    'notification_attempts', 'tenant_status_history', 'identity_merge_events', 'entitlement_snapshots',
    'fraud_signals'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()',
      t || '_append_only',
      t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()',
      t || '_no_truncate',
      t
    );
  END LOOP;
END
$append_only$;

DO $rls$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      )
      AND c.relname NOT IN (
        'memberships', 'audit_logs', 'idempotency_keys', 'outbox_events',
        'provider_webhook_events', 'webhook_processing', 'tenant_search_index'
      )
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      r.relname
    );
  END LOOP;
END
$rls$;

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON app.tenants
  USING (
    id = app.current_tenant_id()
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id() AND m.status = 'ACTIVE'
    )
  )
  WITH CHECK (id = app.current_tenant_id());

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_visibility ON app.memberships
  USING (tenant_id = app.current_tenant_id() OR (user_id IS NOT NULL AND user_id = app.current_user_id()))
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_visibility ON app.users
  USING (
    id = app.current_user_id()
    OR auth_subject = app.current_auth_subject()
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()
    )
  )
  WITH CHECK (id = app.current_user_id() OR auth_subject = app.current_auth_subject());

ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON app.audit_logs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = app.current_tenant_id());

ALTER TABLE app.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_owner ON app.idempotency_keys
  USING (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR (tenant_id IS NULL AND user_id = app.current_user_id())
  )
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR (tenant_id IS NULL AND user_id = app.current_user_id())
  );

CREATE FUNCTION app.refresh_tenant_search_index(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  INSERT INTO app.tenant_search_index (tenant_id, legal_name, slug, stripe_customer_ids, phone_e164s, updated_at)
  SELECT
    t.id,
    t.legal_name,
    t.slug,
    coalesce((SELECT array_agg(DISTINCT b.stripe_customer_id) FROM app.billing_profiles b WHERE b.tenant_id = t.id AND b.stripe_customer_id IS NOT NULL), '{}'),
    coalesce((SELECT array_agg(DISTINCT p.e164) FROM app.phone_numbers p WHERE p.tenant_id = t.id AND p.status <> 'RELEASED'), '{}'),
    now()
  FROM app.tenants t
  WHERE t.id = p_tenant_id
  ON CONFLICT (tenant_id) DO UPDATE
    SET legal_name = EXCLUDED.legal_name,
        slug = EXCLUDED.slug,
        stripe_customer_ids = EXCLUDED.stripe_customer_ids,
        phone_e164s = EXCLUDED.phone_e164s,
        updated_at = EXCLUDED.updated_at;
  PERFORM set_config('app.tenant_id', coalesce(v_previous, ''), true);
END
$$;

CREATE FUNCTION app.tenant_search_index_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    PERFORM app.refresh_tenant_search_index(NEW.id);
  ELSE
    PERFORM app.refresh_tenant_search_index(NEW.tenant_id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_search_index AFTER INSERT OR UPDATE OF legal_name, slug ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.tenant_search_index_trigger();
CREATE TRIGGER billing_profiles_search_index AFTER INSERT OR UPDATE OF stripe_customer_id ON app.billing_profiles
  FOR EACH ROW EXECUTE FUNCTION app.tenant_search_index_trigger();
CREATE TRIGGER phone_numbers_search_index AFTER INSERT OR UPDATE OF e164, status ON app.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION app.tenant_search_index_trigger();

GRANT USAGE, CREATE ON SCHEMA app TO velyric_retention;

CREATE FUNCTION app.apply_retention(p_tenant_id uuid, p_retention_class text, p_cutoff timestamptz, p_job_run_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_cutoff > now() THEN
    RAISE EXCEPTION 'retention cutoff % is in the future', p_cutoff USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  PERFORM set_config('app.actor_type', 'SYSTEM', true);

  IF EXISTS (
    SELECT 1 FROM app.legal_holds h
    WHERE h.tenant_id = p_tenant_id AND h.scope_type = 'TENANT' AND h.released_at IS NULL
  ) THEN
    INSERT INTO app.audit_logs (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata)
    VALUES (p_tenant_id, 'SYSTEM', 'retention', 'retention.skipped_legal_hold', 'retention_class', p_retention_class,
            jsonb_build_object('cutoff', p_cutoff, 'job_run_id', p_job_run_id));
    RETURN 0;
  END IF;

  CASE p_retention_class
    WHEN 'TRANSCRIPT' THEN
      UPDATE app.transcript_segments s
        SET content = '', redaction_state = 'PURGED'
        WHERE s.tenant_id = p_tenant_id
          AND s.created_at < p_cutoff
          AND s.redaction_state <> 'PURGED'
          AND NOT EXISTS (
            SELECT 1 FROM app.legal_holds h
            WHERE h.tenant_id = p_tenant_id AND h.released_at IS NULL AND h.scope_type = 'CALL' AND h.scope_ref = s.call_id
          );
      GET DIAGNOSTICS v_count = ROW_COUNT;
      UPDATE app.calls c
        SET summary = NULL, summary_redaction_state = 'PURGED'
        WHERE c.tenant_id = p_tenant_id
          AND c.started_at < p_cutoff
          AND c.summary_redaction_state <> 'PURGED'
          AND NOT EXISTS (
            SELECT 1 FROM app.legal_holds h
            WHERE h.tenant_id = p_tenant_id AND h.released_at IS NULL AND h.scope_type = 'CALL' AND h.scope_ref = c.id
          );
    WHEN 'CALL_EVENTS' THEN
      DELETE FROM app.call_events e
        WHERE e.tenant_id = p_tenant_id
          AND e.occurred_at < p_cutoff
          AND NOT EXISTS (
            SELECT 1 FROM app.legal_holds h
            WHERE h.tenant_id = p_tenant_id AND h.released_at IS NULL AND h.scope_type = 'CALL' AND h.scope_ref = e.call_id
          );
      GET DIAGNOSTICS v_count = ROW_COUNT;
    WHEN 'TOOL_PAYLOAD' THEN
      UPDATE app.tool_runs r
        SET response_meta = '{}'::jsonb
        WHERE r.tenant_id = p_tenant_id
          AND r.created_at < p_cutoff
          AND r.response_meta <> '{}'::jsonb;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    WHEN 'RAW_AUDIO' THEN
      UPDATE app.call_recordings r
        SET deleted_at = now()
        WHERE r.tenant_id = p_tenant_id
          AND r.retention_until <= greatest(p_cutoff, now())
          AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM app.legal_holds h
            WHERE h.tenant_id = p_tenant_id AND h.released_at IS NULL AND h.scope_type = 'CALL' AND h.scope_ref = r.call_id
          );
      GET DIAGNOSTICS v_count = ROW_COUNT;
    WHEN 'CALLER_PROFILE' THEN
      WITH expired AS (
        SELECT p.id
        FROM app.caller_profiles p
        WHERE p.tenant_id = p_tenant_id
          AND coalesce(p.last_interaction_at, p.created_at) < p_cutoff
          AND NOT EXISTS (
            SELECT 1 FROM app.legal_holds h
            WHERE h.tenant_id = p_tenant_id AND h.released_at IS NULL AND h.scope_type = 'PERSON' AND h.scope_ref = p.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM app.bookings b
            WHERE b.tenant_id = p_tenant_id AND b.person_id = p.id AND b.ends_at > now() AND b.status IN ('PENDING_DEPOSIT', 'CONFIRMED')
          )
      ), removed_identities AS (
        DELETE FROM app.person_identities i USING expired e WHERE i.person_id = e.id RETURNING i.person_id
      )
      UPDATE app.caller_profiles p
        SET display_name = NULL, display_name_verification = NULL, preferred_language = NULL,
            preferred_language_source = NULL, memory_enabled = false, trust_level = 'UNVERIFIED'
        FROM expired e
        WHERE p.id = e.id AND (p.display_name IS NOT NULL OR p.preferred_language IS NOT NULL OR p.memory_enabled);
      GET DIAGNOSTICS v_count = ROW_COUNT;
    ELSE
      RAISE EXCEPTION 'retention class % is not handled by apply_retention', p_retention_class USING ERRCODE = '22023';
  END CASE;

  INSERT INTO app.audit_logs (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata)
  VALUES (p_tenant_id, 'SYSTEM', 'retention', 'retention.applied', 'retention_class', p_retention_class,
          jsonb_build_object('cutoff', p_cutoff, 'affected_rows', v_count, 'job_run_id', p_job_run_id));
  RETURN v_count;
END
$$;

ALTER FUNCTION app.apply_retention(uuid, text, timestamptz, uuid) OWNER TO velyric_retention;

CREATE FUNCTION app.apply_webhook_payload_retention(p_cutoff timestamptz, p_job_run_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_cutoff > now() THEN
    RAISE EXCEPTION 'retention cutoff % is in the future', p_cutoff USING ERRCODE = '22023';
  END IF;
  WITH expired AS (
    SELECT e.id
    FROM app.provider_webhook_events e
    JOIN app.webhook_processing w ON w.webhook_event_id = e.id
    WHERE e.received_at < p_cutoff
      AND w.status IN ('PROCESSED', 'IGNORED', 'DEAD_LETTER')
      AND NOT EXISTS (
        SELECT 1 FROM app.disputes d
        WHERE e.tenant_id IS NOT NULL AND d.tenant_id = e.tenant_id AND d.closed_at IS NULL
      )
  ), removed_processing AS (
    DELETE FROM app.webhook_processing w USING expired x WHERE w.webhook_event_id = x.id RETURNING w.webhook_event_id
  )
  DELETE FROM app.provider_webhook_events e USING removed_processing r WHERE e.id = r.webhook_event_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO app.audit_logs (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata)
  VALUES (NULL, 'SYSTEM', 'retention', 'retention.applied', 'retention_class', 'RAW_PROVIDER_PAYLOAD',
          jsonb_build_object('cutoff', p_cutoff, 'affected_rows', v_count, 'job_run_id', p_job_run_id));
  RETURN v_count;
END
$$;

ALTER FUNCTION app.apply_webhook_payload_retention(timestamptz, uuid) OWNER TO velyric_retention;

REVOKE CREATE ON SCHEMA app FROM velyric_retention;

GRANT USAGE ON SCHEMA app TO velyric_app, velyric_metering, velyric_retention, velyric_readonly, velyric_support;
GRANT USAGE ON SCHEMA analytics TO velyric_readonly, velyric_app;
GRANT USAGE ON SCHEMA support TO velyric_support;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_tenant_id(),
  app.current_user_id(),
  app.current_auth_subject(),
  app.current_support_grant_id(),
  app.support_grant_active(text)
TO velyric_app, velyric_metering, velyric_retention, velyric_readonly, velyric_support;
GRANT EXECUTE ON FUNCTION
  app.activate_knowledge_version(uuid),
  app.release_expired_allocations(uuid),
  app.outbox_claim(text, integer, integer),
  app.outbox_mark_published(text, uuid[]),
  app.outbox_mark_failed(text, uuid, text, integer),
  app.apply_retention(uuid, text, timestamptz, uuid),
  app.apply_webhook_payload_retention(timestamptz, uuid)
TO velyric_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO velyric_app;

REVOKE UPDATE, DELETE ON
  app.audit_logs, app.consent_ledger, app.usage_events, app.provider_cost_events, app.payment_events,
  app.billing_ledger_entries, app.provider_webhook_events, app.call_events, app.notification_events,
  app.notification_attempts, app.tenant_status_history, app.identity_merge_events, app.entitlement_snapshots,
  app.fraud_signals
FROM velyric_app;

REVOKE INSERT, UPDATE, DELETE ON
  app.tenant_directory, app.price_books, app.connector_manifests, app.vertical_policy_packs,
  app.platform_staff, app.reconciliation_runs
FROM velyric_app;

REVOKE ALL ON app.tenant_search_index FROM velyric_app;
REVOKE SELECT, UPDATE, DELETE ON app.outbox_events FROM velyric_app;
REVOKE INSERT, UPDATE, DELETE ON app.usage_events, app.usage_aggregates, app.provider_cost_events FROM velyric_app;

GRANT SELECT ON app.tenant_directory, app.calls, app.entitlement_snapshots, app.cost_budgets,
  app.usage_events, app.usage_aggregates, app.provider_cost_events, app.reconciliation_runs, app.tenants
TO velyric_metering;
GRANT INSERT ON app.usage_events, app.provider_cost_events TO velyric_metering;
GRANT INSERT, UPDATE ON app.usage_aggregates, app.reconciliation_runs TO velyric_metering;
GRANT UPDATE (consumed_usd_micros, unlocked_quarters, soft_warning_sent_at, hard_cap_reached_at, updated_at, version)
  ON app.cost_budgets TO velyric_metering;

GRANT SELECT ON ALL TABLES IN SCHEMA app TO velyric_retention;
GRANT UPDATE ON app.transcript_segments, app.calls, app.tool_runs, app.call_recordings, app.caller_profiles TO velyric_retention;
GRANT DELETE ON app.call_events, app.person_identities, app.webhook_processing, app.provider_webhook_events TO velyric_retention;
GRANT INSERT ON app.audit_logs TO velyric_retention;

ALTER DEFAULT PRIVILEGES FOR ROLE velyric_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velyric_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velyric_owner IN SCHEMA app
  GRANT SELECT ON TABLES TO velyric_retention;

CREATE VIEW support.tenant_overview WITH (security_barrier = true) AS
SELECT t.id, t.legal_name, t.display_name, t.slug, t.status, t.plan_code, t.trust_tier, t.billing_market,
       t.default_locale, t.timezone, t.status_reason, t.status_changed_at, t.created_at
FROM app.tenants t
WHERE t.id = app.current_tenant_id() AND app.support_grant_active('REDACTED');

CREATE VIEW support.calls_redacted WITH (security_barrier = true) AS
SELECT c.id, c.tenant_id, c.location_id, c.agent_id, c.agent_version_id, c.provider, c.provider_call_id,
       c.channel, c.direction,
       CASE WHEN c.caller_e164 IS NULL THEN NULL ELSE left(c.caller_e164, 4) || '*****' || right(c.caller_e164, 2) END AS caller_e164_masked,
       c.language, c.status, c.conversation_state, c.admission_decision, c.admission_reject_reason, c.intent,
       c.outcome, c.end_reason, c.started_at, c.answered_at, c.ended_at, c.connected_seconds, c.billable_seconds,
       c.cost_usd_micros, c.quality_score, c.trace_id, c.runtime_instance_id
FROM app.calls c
WHERE app.support_grant_active('REDACTED');

CREATE VIEW support.call_transcripts_sensitive WITH (security_barrier = true) AS
SELECT s.call_id, s.seq, s.speaker, s.language, s.start_ms, s.end_ms, s.content, s.redaction_state
FROM app.transcript_segments s
WHERE app.support_grant_active('SENSITIVE');

CREATE VIEW support.call_events_redacted WITH (security_barrier = true) AS
SELECT e.call_id, e.seq, e.event_id, e.event_type, e.schema_version, e.occurred_at
FROM app.call_events e
WHERE app.support_grant_active('REDACTED');

CREATE VIEW support.tool_runs_redacted WITH (security_barrier = true) AS
SELECT r.id, r.call_id, r.tool_definition_id, d.name AS tool_name, d.side_effect_class, r.specialist, r.status,
       r.attempt, r.http_status, r.error_code, r.latency_ms, r.trace_id, r.started_at, r.finished_at, r.created_at
FROM app.tool_runs r
JOIN app.tool_definitions d ON d.id = r.tool_definition_id
WHERE app.support_grant_active('REDACTED');

CREATE VIEW support.provisioning_timeline WITH (security_barrier = true) AS
SELECT 'PROVISIONING_STEP'::text AS entry_kind, s.id AS entry_id, s.step AS label, s.status, s.error_code,
       s.external_ref, s.started_at AS occurred_at
FROM app.provisioning_step_runs s
WHERE app.support_grant_active('REDACTED')
UNION ALL
SELECT 'PAYMENT_EVENT', p.id, p.event_type, NULL, NULL, p.stripe_event_id, p.received_at
FROM app.payment_events p
WHERE app.support_grant_active('REDACTED')
UNION ALL
SELECT 'BILLING_DOCUMENT', b.id, b.document_type, b.status, b.last_error_code, b.invoice_number, b.created_at
FROM app.billing_documents b
WHERE app.support_grant_active('REDACTED')
UNION ALL
SELECT 'PHONE_ORDER', o.id, o.status, o.requirements_status, o.decline_reason, o.provider_order_id, o.updated_at
FROM app.phone_orders o
WHERE app.support_grant_active('REDACTED')
UNION ALL
SELECT 'PROVIDER_RESOURCE', r.id, r.provider || ':' || r.resource_type, r.state, NULL, r.external_id, r.updated_at
FROM app.provider_resources r
WHERE app.support_grant_active('REDACTED')
UNION ALL
SELECT 'NOTIFICATION', n.id, n.notification_type, NULL, NULL, n.destination_masked, n.created_at
FROM app.notification_events n
WHERE app.support_grant_active('REDACTED');

CREATE VIEW support.integrations_health WITH (security_barrier = true) AS
SELECT i.id, i.integration_type, i.provider, i.status, i.display_name, i.granted_scopes, i.last_health_check_at,
       i.last_error_code, i.updated_at
FROM app.integrations i
WHERE app.support_grant_active('REDACTED');

CREATE VIEW support.knowledge_sync WITH (security_barrier = true) AS
SELECT k.id, k.source_type, k.title, k.status, k.freshness, k.last_synced_at, k.last_error_code, k.updated_at
FROM app.knowledge_sources k
WHERE app.support_grant_active('REDACTED');

CREATE FUNCTION support.search_tenants(p_query text, p_limit integer)
RETURNS TABLE (tenant_id uuid, legal_name text, slug citext, status text, match_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT
    i.tenant_id,
    i.legal_name,
    i.slug,
    d.status,
    CASE
      WHEN i.tenant_id::text = p_query THEN 'WORKSPACE_ID'
      WHEN p_query = ANY (i.stripe_customer_ids) THEN 'STRIPE_CUSTOMER'
      WHEN p_query = ANY (i.phone_e164s) THEN 'PHONE_NUMBER'
      WHEN i.slug = p_query THEN 'SLUG'
      ELSE 'LEGAL_NAME'
    END
  FROM app.tenant_search_index i
  JOIN app.tenant_directory d ON d.id = i.tenant_id
  WHERE char_length(p_query) >= 3
    AND (
      i.tenant_id::text = p_query
      OR p_query = ANY (i.stripe_customer_ids)
      OR p_query = ANY (i.phone_e164s)
      OR i.slug = p_query
      OR i.legal_name ILIKE '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  ORDER BY i.legal_name
  LIMIT least(greatest(p_limit, 1), 50)
$$;

GRANT SELECT ON ALL TABLES IN SCHEMA support TO velyric_support;
REVOKE ALL ON FUNCTION support.search_tenants(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support.search_tenants(text, integer) TO velyric_support;

CREATE VIEW analytics.call_daily_metrics WITH (security_barrier = true) AS
SELECT
  c.tenant_id,
  c.location_id,
  c.agent_id,
  c.language,
  date_trunc('day', c.started_at) AS day,
  count(*) AS calls_total,
  count(*) FILTER (WHERE c.outcome IN ('RESOLVED', 'INFORMATION_PROVIDED', 'BOOKING_CREATED', 'BOOKING_CHANGED', 'BOOKING_CANCELED', 'WAITLISTED', 'LEAD_CAPTURED', 'CALLBACK_REQUESTED', 'MESSAGE_TAKEN')) AS calls_resolved_by_ai,
  count(*) FILTER (WHERE c.outcome = 'TRANSFERRED_TO_HUMAN') AS calls_transferred,
  count(*) FILTER (WHERE c.outcome = 'BOOKING_CREATED') AS bookings_created,
  count(*) FILTER (WHERE c.outcome = 'LEAD_CAPTURED') AS leads_captured,
  count(*) FILTER (WHERE c.outcome = 'ABANDONED') AS calls_abandoned,
  coalesce(sum(c.connected_seconds), 0)::bigint AS connected_seconds,
  coalesce(round(avg(c.connected_seconds), 2), 0) AS avg_connected_seconds,
  coalesce(sum(c.cost_usd_micros), 0)::bigint AS cost_usd_micros,
  round(avg(c.quality_score), 2) AS avg_quality_score
FROM app.calls c
WHERE c.tenant_id = app.current_tenant_id()
  AND c.status IN ('COMPLETED', 'FAILED', 'REJECTED', 'ABANDONED', 'TRANSFERRED')
GROUP BY c.tenant_id, c.location_id, c.agent_id, c.language, date_trunc('day', c.started_at);

CREATE VIEW analytics.tool_daily_metrics WITH (security_barrier = true) AS
SELECT
  r.tenant_id,
  r.tool_definition_id,
  date_trunc('day', r.created_at) AS day,
  count(*) AS runs_total,
  count(*) FILTER (WHERE r.status = 'SUCCEEDED') AS runs_succeeded,
  count(*) FILTER (WHERE r.status IN ('FAILED', 'TIMED_OUT')) AS runs_failed,
  count(*) FILTER (WHERE r.status = 'DEDUPLICATED') AS runs_deduplicated,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) AS latency_p95_ms
FROM app.tool_runs r
WHERE r.tenant_id = app.current_tenant_id()
GROUP BY r.tenant_id, r.tool_definition_id, date_trunc('day', r.created_at);

GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO velyric_readonly, velyric_app;
