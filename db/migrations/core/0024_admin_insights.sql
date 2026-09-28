CREATE FUNCTION app.admin_tenant_status_breakdown()
RETURNS TABLE (status text, total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT t.status, count(*)
    FROM app.tenants t
    GROUP BY t.status
    ORDER BY 2 DESC;
END
$$;

CREATE FUNCTION app.admin_signup_trend(p_weeks integer)
RETURNS TABLE (bucket_start timestamptz, tenants bigint, active bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 52);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      b.bucket,
      count(t.id),
      count(t.id) FILTER (WHERE t.status = 'ACTIVE')
    FROM generate_series(
           date_trunc('week', now()) - make_interval(weeks => v_weeks - 1),
           date_trunc('week', now()),
           interval '1 week') AS b(bucket)
    LEFT JOIN app.tenants t
      ON date_trunc('week', t.created_at) = b.bucket
    GROUP BY b.bucket
    ORDER BY b.bucket;
END
$$;

CREATE FUNCTION app.admin_ticket_trend(p_weeks integer)
RETURNS TABLE (bucket_start timestamptz, opened bigint, closed bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 52);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT
      b.bucket,
      count(d.ticket_id),
      count(d.ticket_id) FILTER (WHERE d.status IN ('RESOLVED', 'CLOSED'))
    FROM generate_series(
           date_trunc('week', now()) - make_interval(weeks => v_weeks - 1),
           date_trunc('week', now()),
           interval '1 week') AS b(bucket)
    LEFT JOIN app.support_ticket_directory d
      ON date_trunc('week', d.created_at) = b.bucket
    GROUP BY b.bucket
    ORDER BY b.bucket;
END
$$;

REVOKE ALL ON FUNCTION app.admin_tenant_status_breakdown() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_signup_trend(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_ticket_trend(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_tenant_status_breakdown() TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_signup_trend(integer) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_ticket_trend(integer) TO velyric_app;
