CREATE TABLE app.support_tickets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  reference text NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 200),
  category text NOT NULL DEFAULT 'OTHER',
  priority text NOT NULL DEFAULT 'NORMAL',
  status text NOT NULL DEFAULT 'OPEN',
  opened_by_user_id uuid REFERENCES app.users (id),
  assigned_staff_user_id uuid REFERENCES app.platform_staff (user_id),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  public_message_count integer NOT NULL DEFAULT 0 CHECK (public_message_count >= 0),
  last_message_at timestamptz,
  last_tenant_message_at timestamptz,
  last_staff_message_at timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (reference)
);

CREATE INDEX support_tickets_tenant_idx
  ON app.support_tickets (tenant_id, last_message_at DESC NULLS LAST, id DESC);

CREATE TABLE app.support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  ticket_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  author_kind text NOT NULL,
  author_user_id uuid REFERENCES app.users (id),
  author_label text,
  visibility text NOT NULL DEFAULT 'PUBLIC',
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (ticket_id, seq),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.support_tickets (tenant_id, id),
  CHECK (visibility <> 'INTERNAL_NOTE' OR author_kind = 'STAFF')
);

CREATE INDEX support_ticket_messages_thread_idx
  ON app.support_ticket_messages (ticket_id, seq);

CREATE TABLE app.support_ticket_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  ticket_id uuid NOT NULL,
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 3 AND 40),
  actor_kind text NOT NULL,
  actor_user_id uuid REFERENCES app.users (id),
  actor_label text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.support_tickets (tenant_id, id)
);

CREATE INDEX support_ticket_events_thread_idx
  ON app.support_ticket_events (ticket_id, created_at);

CREATE TABLE app.support_ticket_participants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  ticket_id uuid NOT NULL,
  participant_kind text NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users (id),
  last_read_seq integer NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, participant_kind, user_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.support_tickets (tenant_id, id)
);

CREATE TABLE app.support_ticket_directory (
  ticket_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  tenant_display_name text NOT NULL,
  reference text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL,
  priority text NOT NULL,
  category text NOT NULL,
  assigned_staff_user_id uuid,
  message_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  last_tenant_message_at timestamptz,
  last_staff_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_ticket_directory_queue_idx
  ON app.support_ticket_directory (status, last_message_at DESC NULLS LAST);

REVOKE ALL ON app.support_ticket_directory FROM PUBLIC;
REVOKE ALL ON app.support_ticket_directory FROM velyric_app;
REVOKE ALL ON app.support_ticket_directory FROM velyric_readonly;
REVOKE ALL ON app.support_ticket_directory FROM velyric_retention;

ALTER TABLE app.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.support_tickets
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_ticket_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.support_ticket_messages
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.support_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_ticket_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.support_ticket_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.support_ticket_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_ticket_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.support_ticket_participants
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER support_tickets_touch_updated_at
BEFORE UPDATE ON app.support_tickets
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER support_ticket_participants_touch_updated_at
BEFORE UPDATE ON app.support_ticket_participants
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER support_ticket_messages_append_only
BEFORE UPDATE OR DELETE ON app.support_ticket_messages
FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $guard$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['support_ticket_messages', 'support_ticket_events'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()',
      r || '_no_truncate', r);
  END LOOP;
END
$guard$;

CREATE TRIGGER support_ticket_events_append_only
BEFORE UPDATE OR DELETE ON app.support_ticket_events
FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();


REVOKE UPDATE, DELETE ON app.support_ticket_messages FROM velyric_app;
REVOKE UPDATE, DELETE ON app.support_ticket_events FROM velyric_app;

CREATE FUNCTION app.sync_support_ticket_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  INSERT INTO app.support_ticket_directory (
    ticket_id, tenant_id, tenant_display_name, reference, subject, status, priority, category,
    assigned_staff_user_id, message_count, last_message_at, last_tenant_message_at,
    last_staff_message_at, created_at, updated_at
  )
  SELECT
    NEW.id, NEW.tenant_id, t.display_name, NEW.reference, NEW.subject, NEW.status, NEW.priority,
    NEW.category, NEW.assigned_staff_user_id, NEW.public_message_count, NEW.last_message_at,
    NEW.last_tenant_message_at, NEW.last_staff_message_at, NEW.created_at, now()
  FROM app.tenants t
  WHERE t.id = NEW.tenant_id
  ON CONFLICT (ticket_id) DO UPDATE
    SET subject = EXCLUDED.subject,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        category = EXCLUDED.category,
        assigned_staff_user_id = EXCLUDED.assigned_staff_user_id,
        message_count = EXCLUDED.message_count,
        last_message_at = EXCLUDED.last_message_at,
        last_tenant_message_at = EXCLUDED.last_tenant_message_at,
        last_staff_message_at = EXCLUDED.last_staff_message_at,
        tenant_display_name = EXCLUDED.tenant_display_name,
        updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;

CREATE TRIGGER support_tickets_directory
AFTER INSERT OR UPDATE ON app.support_tickets
FOR EACH ROW EXECUTE FUNCTION app.sync_support_ticket_directory();

CREATE FUNCTION app.admin_ticket_queue(
  p_status text,
  p_tenant uuid,
  p_assigned uuid,
  p_unassigned boolean,
  p_limit integer,
  p_offset integer
)
RETURNS TABLE (
  ticket_id uuid,
  tenant_id uuid,
  tenant_display_name text,
  reference text,
  subject text,
  status text,
  priority text,
  category text,
  assigned_staff_user_id uuid,
  assigned_staff_email citext,
  message_count integer,
  last_message_at timestamptz,
  last_tenant_message_at timestamptz,
  last_staff_message_at timestamptz,
  created_at timestamptz,
  total_rows bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    WITH matched AS (
      SELECT d.*
      FROM app.support_ticket_directory d
      WHERE (p_status IS NULL OR d.status = p_status)
        AND (p_tenant IS NULL OR d.tenant_id = p_tenant)
        AND (p_assigned IS NULL OR d.assigned_staff_user_id = p_assigned)
        AND (coalesce(p_unassigned, false) = false OR d.assigned_staff_user_id IS NULL)
    ),
    counted AS (SELECT count(*) AS total FROM matched)
    SELECT
      m.ticket_id,
      m.tenant_id,
      m.tenant_display_name,
      m.reference,
      m.subject,
      m.status,
      m.priority,
      m.category,
      m.assigned_staff_user_id,
      (SELECT u.email FROM app.users u WHERE u.id = m.assigned_staff_user_id),
      m.message_count,
      m.last_message_at,
      m.last_tenant_message_at,
      m.last_staff_message_at,
      m.created_at,
      (SELECT total FROM counted)
    FROM matched m
    ORDER BY
      CASE m.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
      m.last_message_at DESC NULLS LAST
    LIMIT v_limit OFFSET v_offset;
END
$$;

CREATE FUNCTION app.admin_ticket_tenant(p_ticket uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  PERFORM app.assert_platform_staff();
  SELECT d.tenant_id INTO v_tenant FROM app.support_ticket_directory d WHERE d.ticket_id = p_ticket;
  RETURN v_tenant;
END
$$;

CREATE FUNCTION app.admin_ticket_counts()
RETURNS TABLE (status text, total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  PERFORM app.assert_platform_staff();
  RETURN QUERY
    SELECT d.status, count(*) FROM app.support_ticket_directory d GROUP BY d.status;
END
$$;

CREATE POLICY platform_staff_read ON app.support_tickets
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.support_ticket_messages
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.support_ticket_events
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);
CREATE POLICY platform_staff_read ON app.support_ticket_participants
  FOR SELECT USING (app.current_platform_role() IS NOT NULL);

REVOKE ALL ON FUNCTION app.admin_ticket_queue(text, uuid, uuid, boolean, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_ticket_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_ticket_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_ticket_queue(text, uuid, uuid, boolean, integer, integer) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_ticket_tenant(uuid) TO velyric_app;
GRANT EXECUTE ON FUNCTION app.admin_ticket_counts() TO velyric_app;
