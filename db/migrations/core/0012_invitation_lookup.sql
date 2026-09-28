CREATE TABLE app.invitation_directory (
  membership_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  tenant_display_name text NOT NULL,
  invited_email citext NOT NULL,
  role text NOT NULL,
  invitation_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invitation_directory_email_idx ON app.invitation_directory (invited_email);

REVOKE ALL ON app.invitation_directory FROM PUBLIC;
REVOKE ALL ON app.invitation_directory FROM velyric_app;
REVOKE ALL ON app.invitation_directory FROM velyric_readonly;
REVOKE ALL ON app.invitation_directory FROM velyric_retention;

CREATE FUNCTION app.sync_invitation_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.status = 'INVITED' AND NEW.user_id IS NULL AND NEW.invited_email IS NOT NULL THEN
    INSERT INTO app.invitation_directory (membership_id, tenant_id, tenant_display_name, invited_email, role, invitation_expires_at, updated_at)
    SELECT NEW.id, NEW.tenant_id, t.display_name, NEW.invited_email, NEW.role, NEW.invitation_expires_at, now()
    FROM app.tenants t
    WHERE t.id = NEW.tenant_id
    ON CONFLICT (membership_id) DO UPDATE
      SET invited_email = EXCLUDED.invited_email,
          role = EXCLUDED.role,
          invitation_expires_at = EXCLUDED.invitation_expires_at,
          tenant_display_name = EXCLUDED.tenant_display_name,
          updated_at = EXCLUDED.updated_at;
  ELSE
    DELETE FROM app.invitation_directory WHERE membership_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memberships_invitation_directory
AFTER INSERT OR UPDATE OF status, user_id, invited_email, role, invitation_expires_at ON app.memberships
FOR EACH ROW EXECUTE FUNCTION app.sync_invitation_directory();

CREATE FUNCTION app.pending_invitations_for_email(p_email citext)
RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_display_name text, role text, invitation_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT i.membership_id, i.tenant_id, i.tenant_display_name, i.role, i.invitation_expires_at
  FROM app.invitation_directory i
  JOIN app.tenant_directory d ON d.id = i.tenant_id
  WHERE i.invited_email = p_email
    AND (i.invitation_expires_at IS NULL OR i.invitation_expires_at > now())
    AND d.status NOT IN ('DATA_RETENTION', 'DELETION', 'DELETED')
  ORDER BY i.updated_at
  LIMIT 50
$$;

REVOKE ALL ON FUNCTION app.pending_invitations_for_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_invitations_for_email(citext) TO velyric_app;
