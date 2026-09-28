ALTER TABLE app.webhook_deliveries
  ADD COLUMN payload jsonb,
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN response_ms integer CHECK (response_ms IS NULL OR response_ms >= 0);

CREATE INDEX webhook_deliveries_history_idx ON app.webhook_deliveries (tenant_id, webhook_id, created_at DESC, id DESC);

CREATE TABLE app.webhook_delivery_queue (
  delivery_id uuid PRIMARY KEY REFERENCES app.webhook_deliveries (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  due_at timestamptz NOT NULL,
  claimed_by text,
  claimed_until timestamptz
);

CREATE INDEX webhook_delivery_queue_due_idx ON app.webhook_delivery_queue (due_at, delivery_id);

REVOKE ALL ON app.webhook_delivery_queue FROM PUBLIC;
REVOKE ALL ON app.webhook_delivery_queue FROM velyric_app, velyric_metering, velyric_retention, velyric_readonly, velyric_support;

CREATE FUNCTION app.sync_webhook_delivery_queue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('PENDING', 'RETRYING') AND NEW.payload IS NOT NULL THEN
    INSERT INTO app.webhook_delivery_queue (delivery_id, tenant_id, due_at)
    VALUES (NEW.id, NEW.tenant_id, coalesce(NEW.next_attempt_at, NEW.created_at))
    ON CONFLICT (delivery_id) DO UPDATE
      SET due_at = EXCLUDED.due_at, claimed_by = NULL, claimed_until = NULL;
  ELSE
    DELETE FROM app.webhook_delivery_queue WHERE delivery_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER webhook_deliveries_queue_sync
AFTER INSERT OR UPDATE OF status, next_attempt_at, payload ON app.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION app.sync_webhook_delivery_queue();

CREATE FUNCTION app.webhook_delivery_claim(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  webhook_id uuid,
  url text,
  signing_secret_ref text,
  event_id uuid,
  event_type text,
  payload jsonb,
  occurred_at timestamptz,
  attempt integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.tenant_id', true), '');
  v_lease interval := make_interval(secs => least(greatest(p_lease_seconds, 15), 600));
  q record;
  d record;
BEGIN
  FOR q IN
    SELECT w.delivery_id, w.tenant_id
    FROM app.webhook_delivery_queue w
    WHERE w.due_at <= now()
      AND (w.claimed_until IS NULL OR w.claimed_until < now())
    ORDER BY w.due_at, w.delivery_id
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('app.tenant_id', q.tenant_id::text, true);
    SELECT wd.id, wd.tenant_id, wd.webhook_id, ow.url, sr.secret_ref, wd.event_id, wd.event_type, wd.payload, wd.occurred_at
    INTO d
    FROM app.webhook_deliveries wd
    JOIN app.outbound_webhooks ow ON ow.tenant_id = wd.tenant_id AND ow.id = wd.webhook_id
    JOIN app.tenant_secret_refs sr ON sr.tenant_id = ow.tenant_id AND sr.id = ow.signing_secret_ref_id
    WHERE wd.id = q.delivery_id
      AND wd.status IN ('PENDING', 'RETRYING')
      AND wd.payload IS NOT NULL
      AND ow.active
    FOR UPDATE OF wd SKIP LOCKED;
    IF NOT FOUND THEN
      UPDATE app.webhook_delivery_queue SET due_at = now() + interval '5 minutes', claimed_by = NULL, claimed_until = NULL
      WHERE delivery_id = q.delivery_id;
      CONTINUE;
    END IF;
    UPDATE app.webhook_deliveries wd
    SET claimed_by = p_worker, claimed_until = now() + v_lease, attempt = wd.attempt + 1, updated_at = now()
    WHERE wd.id = q.delivery_id
    RETURNING wd.attempt INTO attempt;
    UPDATE app.webhook_delivery_queue SET claimed_by = p_worker, claimed_until = now() + v_lease WHERE delivery_id = q.delivery_id;
    id := d.id;
    tenant_id := d.tenant_id;
    webhook_id := d.webhook_id;
    url := d.url;
    signing_secret_ref := d.secret_ref;
    event_id := d.event_id;
    event_type := d.event_type;
    payload := d.payload;
    occurred_at := d.occurred_at;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.tenant_id', v_previous, true);
END
$$;

CREATE FUNCTION app.webhook_delivery_complete(
  p_worker text,
  p_id uuid,
  p_status text,
  p_http_status integer,
  p_error_code text,
  p_retry_after_seconds integer,
  p_response_ms integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.tenant_id', true), '');
  v_tenant uuid;
  v_updated integer;
BEGIN
  IF p_status NOT IN ('DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER') THEN
    RAISE EXCEPTION 'invalid webhook delivery status %', p_status USING ERRCODE = '22023';
  END IF;
  SELECT q.tenant_id INTO v_tenant FROM app.webhook_delivery_queue q WHERE q.delivery_id = p_id AND q.claimed_by = p_worker FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  UPDATE app.webhook_deliveries
  SET status = p_status,
      http_status = CASE WHEN p_http_status BETWEEN 100 AND 599 THEN p_http_status::smallint ELSE NULL END,
      last_error_code = left(p_error_code, 120),
      response_ms = CASE WHEN p_response_ms >= 0 THEN p_response_ms ELSE NULL END,
      delivered_at = CASE WHEN p_status = 'DELIVERED' THEN now() ELSE delivered_at END,
      next_attempt_at = CASE
        WHEN p_status = 'RETRYING' THEN now() + make_interval(secs => least(greatest(p_retry_after_seconds, 1), 86400))
        ELSE NULL
      END,
      claimed_by = NULL,
      claimed_until = NULL,
      updated_at = now()
  WHERE id = p_id
    AND claimed_by = p_worker
    AND status IN ('PENDING', 'RETRYING');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  PERFORM set_config('app.tenant_id', v_previous, true);
  RETURN v_updated = 1;
END
$$;

REVOKE ALL ON FUNCTION app.sync_webhook_delivery_queue() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_delivery_claim(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_delivery_complete(text, uuid, text, integer, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.webhook_delivery_claim(text, integer, integer),
  app.webhook_delivery_complete(text, uuid, text, integer, text, integer, integer)
TO velyric_app;
