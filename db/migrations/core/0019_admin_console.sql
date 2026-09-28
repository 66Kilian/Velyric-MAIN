CREATE FUNCTION app.current_platform_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT s.platform_role
  FROM app.platform_staff s
  WHERE s.user_id = app.current_user_id() AND s.active
$$;

REVOKE ALL ON FUNCTION app.current_platform_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_platform_role() TO velyric_app;

CREATE POLICY platform_staff_read ON app.tenants
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.users
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.memberships
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.locations
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.phone_numbers
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.agents
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.subscriptions
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.provisioning_workflows
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.audit_logs
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);

CREATE FUNCTION app.assert_platform_staff() RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := app.current_platform_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'platform staff session required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END
$$;

CREATE FUNCTION app.set_platform_staff(
  p_target_user_id uuid,
  p_platform_role text,
  p_active boolean,
  p_reason text,
  p_trace_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_actor_role text := app.current_platform_role();
BEGIN
  IF v_actor IS NULL OR v_actor_role IS NULL THEN
    RAISE EXCEPTION 'platform staff session required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor_role <> 'PLATFORM_ADMIN' THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_target_user_id = v_actor THEN
    RAISE EXCEPTION 'staff cannot change their own platform role' USING ERRCODE = 'check_violation';
  END IF;
  IF p_platform_role NOT IN
    ('SUPPORT_AGENT', 'SUPPORT_LEAD', 'PLATFORM_OPS', 'FINANCE_OPS', 'PLATFORM_ADMIN') THEN
    RAISE EXCEPTION 'unknown platform role %', p_platform_role USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(coalesce(p_reason, '')) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = p_target_user_id) THEN
    RAISE EXCEPTION 'unknown user %', p_target_user_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO app.platform_staff AS s (user_id, platform_role, active)
  VALUES (p_target_user_id, p_platform_role, p_active)
  ON CONFLICT (user_id) DO UPDATE
    SET platform_role = EXCLUDED.platform_role,
        active = EXCLUDED.active,
        updated_at = now();

  INSERT INTO app.audit_logs (
    tenant_id, actor_type, actor_id, actor_label, action, object_type, object_id, metadata, trace_id
  )
  VALUES (
    NULL,
    'SUPPORT_STAFF',
    v_actor::text,
    (SELECT u.email FROM app.users u WHERE u.id = v_actor),
    'platform.staff_updated',
    'platform_staff',
    p_target_user_id::text,
    jsonb_build_object('platform_role', p_platform_role, 'active', p_active, 'reason', p_reason),
    nullif(p_trace_id, '')
  );
END
$$;

REVOKE ALL ON FUNCTION app.set_platform_staff(uuid, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_platform_staff(uuid, text, boolean, text, text) TO velyric_app;

CREATE FUNCTION app.admin_staff_list()
RETURNS TABLE (
  user_id uuid,
  email citext,
  display_name text,
  platform_role text,
  active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT s.user_id, u.email, u.display_name, s.platform_role, s.active, s.created_at, s.updated_at
    FROM app.platform_staff s
    JOIN app.users u ON u.id = s.user_id
    ORDER BY s.platform_role, u.email;
END
$$;

CREATE FUNCTION app.admin_user_by_email(p_email citext)
RETURNS TABLE (user_id uuid, email citext, display_name text, platform_role text, active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT u.id, u.email, u.display_name, s.platform_role, s.active
    FROM app.users u
    LEFT JOIN app.platform_staff s ON s.user_id = u.id
    WHERE u.email = p_email AND u.deactivated_at IS NULL;
END
$$;

CREATE FUNCTION app.admin_tenants_page(p_query text, p_status text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid,
  display_name text,
  legal_name text,
  slug citext,
  status text,
  status_reason text,
  plan_code text,
  billing_market text,
  trust_tier text,
  default_locale text,
  created_at timestamptz,
  member_count bigint,
  location_count bigint,
  phone_number_count bigint,
  total_rows bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    WITH matched AS (
      SELECT t.*
      FROM app.tenants t
      WHERE (p_status IS NULL OR t.status = p_status)
        AND (
          v_query IS NULL
          OR t.display_name ILIKE '%' || v_query || '%'
          OR t.legal_name ILIKE '%' || v_query || '%'
          OR t.slug::text ILIKE '%' || v_query || '%'
          OR t.id::text = lower(v_query)
        )
    ),
    counted AS (SELECT count(*) AS total FROM matched)
    SELECT
      m.id,
      m.display_name,
      m.legal_name,
      m.slug,
      m.status,
      m.status_reason,
      m.plan_code,
      m.billing_market,
      m.trust_tier,
      m.default_locale,
      m.created_at,
      (SELECT count(*) FROM app.memberships ms
        WHERE ms.tenant_id = m.id AND ms.status = 'ACTIVE'),
      (SELECT count(*) FROM app.locations l WHERE l.tenant_id = m.id),
      (SELECT count(*) FROM app.phone_numbers p
        WHERE p.tenant_id = m.id AND p.status <> 'RELEASED'),
      (SELECT total FROM counted)
    FROM matched m
    ORDER BY m.created_at DESC
    LIMIT v_limit OFFSET v_offset;
END
$$;

CREATE FUNCTION app.admin_tenant_overview(p_tenant uuid)
RETURNS TABLE (
  id uuid,
  display_name text,
  legal_name text,
  slug citext,
  status text,
  status_reason text,
  status_changed_at timestamptz,
  plan_code text,
  billing_market text,
  trust_tier text,
  vertical_pack text,
  default_locale text,
  timezone text,
  created_at timestamptz,
  owner_email citext,
  member_count bigint,
  location_count bigint,
  agent_count bigint,
  phone_numbers jsonb,
  provisioning_state text,
  subscription_status text,
  subscription_period_end timestamptz,
  published_agent_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      t.id,
      t.display_name,
      t.legal_name,
      t.slug,
      t.status,
      t.status_reason,
      t.status_changed_at,
      t.plan_code,
      t.billing_market,
      t.trust_tier,
      t.vertical_pack,
      t.default_locale,
      t.timezone,
      t.created_at,
      (SELECT u.email
         FROM app.memberships ms
         JOIN app.users u ON u.id = ms.user_id
        WHERE ms.tenant_id = t.id AND ms.role = 'OWNER' AND ms.status = 'ACTIVE'
        ORDER BY ms.created_at
        LIMIT 1),
      (SELECT count(*) FROM app.memberships ms
        WHERE ms.tenant_id = t.id AND ms.status = 'ACTIVE'),
      (SELECT count(*) FROM app.locations l WHERE l.tenant_id = t.id),
      (SELECT count(*) FROM app.agents a WHERE a.tenant_id = t.id),
      (SELECT coalesce(
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'e164', p.e164, 'status', p.status, 'provider', p.provider
          ) ORDER BY p.created_at),
          '[]'::jsonb)
         FROM app.phone_numbers p
        WHERE p.tenant_id = t.id AND p.status <> 'RELEASED'),
      (SELECT w.state
         FROM app.provisioning_workflows w
        WHERE w.tenant_id = t.id
        ORDER BY w.created_at DESC
        LIMIT 1),
      (SELECT s.status
         FROM app.subscriptions s
        WHERE s.tenant_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1),
      (SELECT s.current_period_end
         FROM app.subscriptions s
        WHERE s.tenant_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1),
      (SELECT count(*) FROM app.agents a WHERE a.tenant_id = t.id AND a.status = 'PUBLISHED')
    FROM app.tenants t
    WHERE t.id = p_tenant;
END
$$;

CREATE FUNCTION app.admin_audit_feed(
  p_tenant uuid,
  p_actor_type text,
  p_action_prefix text,
  p_before timestamptz,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  tenant_display_name text,
  occurred_at timestamptz,
  actor_type text,
  actor_id text,
  actor_label text,
  action text,
  object_type text,
  object_id text,
  metadata jsonb,
  support_grant_id uuid,
  trace_id text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      a.id,
      a.tenant_id,
      t.display_name,
      a.occurred_at,
      a.actor_type,
      a.actor_id,
      a.actor_label,
      a.action,
      a.object_type,
      a.object_id,
      a.metadata,
      a.support_grant_id,
      a.trace_id
    FROM app.audit_logs a
    LEFT JOIN app.tenants t ON t.id = a.tenant_id
    WHERE (p_tenant IS NULL OR a.tenant_id = p_tenant)
      AND (p_actor_type IS NULL OR a.actor_type = p_actor_type)
      AND (p_action_prefix IS NULL OR a.action LIKE p_action_prefix || '%')
      AND (p_before IS NULL OR a.occurred_at < p_before)
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT v_limit;
END
$$;

CREATE FUNCTION app.admin_platform_stats()
RETURNS TABLE (
  tenants_total bigint,
  tenants_active bigint,
  tenants_provisioning bigint,
  tenants_suspended bigint,
  tenants_new_30d bigint,
  phone_numbers_active bigint,
  staff_active bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      (SELECT count(*) FROM app.tenants),
      (SELECT count(*) FROM app.tenants WHERE status = 'ACTIVE'),
      (SELECT count(*) FROM app.tenants WHERE status = 'PROVISIONING'),
      (SELECT count(*) FROM app.tenants WHERE status LIKE 'SUSPENDED%'),
      (SELECT count(*) FROM app.tenants WHERE created_at > now() - interval '30 days'),
      (SELECT count(*) FROM app.phone_numbers WHERE status = 'ACTIVE'),
      (SELECT count(*) FROM app.platform_staff WHERE active);
END
$$;

REVOKE ALL ON FUNCTION app.assert_platform_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_staff_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_user_by_email(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_tenants_page(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_tenant_overview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_audit_feed(uuid, text, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_platform_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_platform_staff() TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_staff_list() TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_user_by_email(citext) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_tenants_page(text, text, integer, integer) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_tenant_overview(uuid) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_audit_feed(uuid, text, text, timestamptz, integer) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_platform_stats() TO velyric_app;

CREATE INDEX audit_logs_occurred_at_idx ON app.audit_logs (occurred_at DESC, id DESC);
