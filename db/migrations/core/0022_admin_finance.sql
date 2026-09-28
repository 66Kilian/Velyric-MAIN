CREATE TABLE app.balance_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  kind text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('HUF', 'EUR', 'USD')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  external_ref text,
  staff_user_id uuid REFERENCES app.users (id),
  staff_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (amount_minor <> 0)
);

CREATE INDEX balance_entries_tenant_idx ON app.balance_entries (tenant_id, created_at DESC);

CREATE TABLE app.billing_balances (
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  currency char(3) NOT NULL,
  balance_minor bigint NOT NULL DEFAULT 0,
  entry_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, currency)
);

CREATE TABLE app.usage_adjustments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  billing_period_start timestamptz NOT NULL,
  metric text NOT NULL,
  delta_quantity bigint NOT NULL,
  delta_cost_usd_micros bigint NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  staff_user_id uuid REFERENCES app.users (id),
  staff_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX usage_adjustments_period_idx
  ON app.usage_adjustments (tenant_id, billing_period_start, metric);

ALTER TABLE app.balance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.balance_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.balance_entries
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.billing_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.billing_balances
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.usage_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.usage_adjustments
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY platform_staff_read ON app.balance_entries
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.billing_balances
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.usage_adjustments
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.usage_aggregates
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.cost_budgets
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.entitlement_snapshots
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.billing_documents
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.billing_profiles
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.tenant_secret_refs
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.phone_orders
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.agent_phone_bindings
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.tenant_status_history
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);

CREATE TRIGGER balance_entries_append_only
BEFORE UPDATE OR DELETE ON app.balance_entries
FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TRIGGER usage_adjustments_append_only
BEFORE UPDATE OR DELETE ON app.usage_adjustments
FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $guard$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['balance_entries', 'usage_adjustments'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()',
      r || '_no_truncate', r);
  END LOOP;
END
$guard$;

REVOKE UPDATE, DELETE ON app.balance_entries FROM velyric_app;
REVOKE UPDATE, DELETE ON app.usage_adjustments FROM velyric_app;

CREATE FUNCTION app.sync_billing_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  INSERT INTO app.billing_balances (tenant_id, currency, balance_minor, entry_count, updated_at)
  VALUES (NEW.tenant_id, NEW.currency, NEW.amount_minor, 1, now())
  ON CONFLICT (tenant_id, currency) DO UPDATE
    SET balance_minor = app.billing_balances.balance_minor + EXCLUDED.balance_minor,
        entry_count = app.billing_balances.entry_count + 1,
        updated_at = now();
  RETURN NEW;
END
$$;

CREATE TRIGGER balance_entries_projection
AFTER INSERT ON app.balance_entries
FOR EACH ROW EXECUTE FUNCTION app.sync_billing_balance();

CREATE FUNCTION app.admin_tenant_usage(p_tenant uuid, p_period timestamptz)
RETURNS TABLE (
  billing_period_start timestamptz,
  metric text,
  quantity bigint,
  adjusted_quantity bigint,
  cost_usd_micros bigint,
  adjusted_cost_usd_micros bigint,
  event_count bigint,
  last_event_occurred_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_period timestamptz := p_period;
BEGIN
  PERFORM app.assert_platform_staff();
  IF v_period IS NULL THEN
    SELECT max(a.billing_period_start) INTO v_period
    FROM app.usage_aggregates a WHERE a.tenant_id = p_tenant;
  END IF;
  RETURN QUERY
    SELECT
      a.billing_period_start,
      a.metric,
      a.quantity,
      (a.quantity + coalesce(adj.delta_quantity, 0))::bigint,
      a.cost_usd_micros,
      (a.cost_usd_micros + coalesce(adj.delta_cost, 0))::bigint,
      a.event_count,
      a.last_event_occurred_at
    FROM app.usage_aggregates a
    LEFT JOIN (
      SELECT u.metric AS metric,
             sum(u.delta_quantity) AS delta_quantity,
             sum(u.delta_cost_usd_micros) AS delta_cost
      FROM app.usage_adjustments u
      WHERE u.tenant_id = p_tenant AND u.billing_period_start = v_period
      GROUP BY u.metric
    ) adj ON adj.metric = a.metric
    WHERE a.tenant_id = p_tenant AND a.billing_period_start = v_period
    ORDER BY a.metric;
END
$$;

CREATE FUNCTION app.admin_tenant_periods(p_tenant uuid)
RETURNS TABLE (billing_period_start timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT DISTINCT a.billing_period_start
    FROM app.usage_aggregates a
    WHERE a.tenant_id = p_tenant
    ORDER BY 1 DESC
    LIMIT 24;
END
$$;

CREATE FUNCTION app.admin_platform_usage(p_days integer)
RETURNS TABLE (metric text, quantity bigint, cost_usd_micros bigint, tenants bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT a.metric, sum(a.quantity)::bigint, sum(a.cost_usd_micros)::bigint, count(DISTINCT a.tenant_id)
    FROM app.usage_aggregates a
    WHERE a.billing_period_start > now() - make_interval(days => v_days)
    GROUP BY a.metric
    ORDER BY 3 DESC;
END
$$;

CREATE FUNCTION app.admin_platform_revenue(p_days integer)
RETURNS TABLE (
  currency char(3),
  issued_documents bigint,
  issued_total_minor bigint,
  pending_documents bigint,
  balance_minor bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      d.currency,
      count(*) FILTER (WHERE d.issued_at IS NOT NULL),
      coalesce(sum(d.total_minor) FILTER (WHERE d.issued_at IS NOT NULL), 0)::bigint,
      count(*) FILTER (WHERE d.issued_at IS NULL),
      coalesce(
        (SELECT sum(b.balance_minor) FROM app.billing_balances b WHERE b.currency = d.currency),
        0)::bigint
    FROM app.billing_documents d
    WHERE d.created_at > now() - make_interval(days => v_days)
    GROUP BY d.currency;
END
$$;

REVOKE ALL ON FUNCTION app.admin_tenant_usage(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_tenant_periods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_platform_usage(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_platform_revenue(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_tenant_usage(uuid, timestamptz) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_tenant_periods(uuid) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_platform_usage(integer) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_platform_revenue(integer) TO velyric_app;
