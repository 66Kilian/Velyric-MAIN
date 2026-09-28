-- Lookup behind the invitation link in the email. The recipient has no session
-- yet, so the landing page must be able to name the workspace and tell whether
-- the address already has a Velyric account before anyone signs in.
CREATE FUNCTION app.invitation_link(p_membership uuid)
RETURNS TABLE (
  membership_id uuid,
  tenant_id uuid,
  tenant_display_name text,
  role text,
  invitation_expires_at timestamptz,
  invited_email citext,
  has_account boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT
    i.membership_id,
    i.tenant_id,
    i.tenant_display_name,
    i.role,
    i.invitation_expires_at,
    i.invited_email,
    EXISTS (SELECT 1 FROM app.credentials c WHERE c.email = i.invited_email) AS has_account
  FROM app.invitation_directory i
  JOIN app.tenant_directory d ON d.id = i.tenant_id
  WHERE i.membership_id = p_membership
    AND (i.invitation_expires_at IS NULL OR i.invitation_expires_at > now())
    AND d.status NOT IN ('DATA_RETENTION', 'DELETION', 'DELETED')
$$;

REVOKE ALL ON FUNCTION app.invitation_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_link(uuid) TO velyric_app;
