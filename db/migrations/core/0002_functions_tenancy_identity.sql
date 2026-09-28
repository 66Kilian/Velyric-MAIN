CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.current_auth_subject() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.auth_subject', true), '') $$;

CREATE FUNCTION app.current_support_grant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.support_grant_id', true), '')::uuid $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'velyric_retention' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table app.% rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END
$$;

CREATE TABLE app.tenants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 300),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'PROVISIONING',
  default_locale text NOT NULL DEFAULT 'hu',
  timezone text NOT NULL DEFAULT 'Europe/Budapest',
  billing_market text NOT NULL DEFAULT 'HU',
  plan_code text,
  trust_tier text NOT NULL DEFAULT 'NEW',
  vertical_pack text NOT NULL DEFAULT 'GENERAL',
  status_reason text,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.tenant_directory (
  id uuid PRIMARY KEY REFERENCES app.tenants (id),
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app.sync_tenant_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  INSERT INTO app.tenant_directory (id, status, updated_at)
  VALUES (NEW.id, NEW.status, now())
  ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_sync_directory
AFTER INSERT OR UPDATE OF status ON app.tenants
FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_directory();

CREATE TABLE app.tenant_status_history (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  source_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_event_id)
);

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  auth_subject text NOT NULL UNIQUE,
  email citext NOT NULL,
  display_name text,
  locale text NOT NULL DEFAULT 'en',
  theme_preference text NOT NULL DEFAULT 'system',
  mfa_enrolled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_email_idx ON app.users (email);

CREATE TABLE app.platform_staff (
  user_id uuid PRIMARY KEY REFERENCES app.users (id),
  platform_role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.locations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'ACTIVE',
  timezone text NOT NULL,
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_hours jsonb NOT NULL DEFAULT '[]'::jsonb,
  holiday_calendar jsonb NOT NULL DEFAULT '[]'::jsonb,
  config_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE UNIQUE INDEX locations_one_primary_idx ON app.locations (tenant_id) WHERE is_primary;

CREATE TABLE app.memberships (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  user_id uuid REFERENCES app.users (id),
  invited_email citext,
  role text NOT NULL,
  location_scope uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'INVITED',
  invited_by_user_id uuid REFERENCES app.users (id),
  invitation_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, invited_email),
  CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL),
  CHECK (status <> 'ACTIVE' OR user_id IS NOT NULL)
);

CREATE INDEX memberships_user_idx ON app.memberships (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE app.api_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^vk_(live|test)_[A-Za-z0-9]{8,16}$'),
  key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by_user_id uuid NOT NULL REFERENCES app.users (id),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE app.identity_provider_configs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  kind text NOT NULL CHECK (kind IN ('SSO', 'SCIM')),
  workos_organization_id text NOT NULL,
  workos_connection_ref text,
  verified_domains text[] NOT NULL DEFAULT '{}',
  retention_state text NOT NULL DEFAULT 'ENABLED',
  enforce_sso boolean NOT NULL DEFAULT false,
  disabled_at timestamptz,
  purge_after timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind),
  CHECK (retention_state <> 'DISABLED_RETAINED' OR purge_after IS NOT NULL)
);

CREATE TABLE app.support_access_grants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  staff_user_id uuid NOT NULL REFERENCES app.platform_staff (user_id),
  access_level text NOT NULL DEFAULT 'REDACTED',
  status text NOT NULL DEFAULT 'REQUESTED',
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  incident_ref text,
  approved_by_user_id uuid REFERENCES app.users (id),
  starts_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (status <> 'ACTIVE' OR (starts_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR (expires_at > starts_at AND expires_at <= starts_at + interval '8 hours'))
);

CREATE INDEX support_access_grants_active_idx ON app.support_access_grants (tenant_id, staff_user_id) WHERE status = 'ACTIVE';

CREATE FUNCTION app.support_grant_active(required_level text) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.support_access_grants g
    WHERE g.id = app.current_support_grant_id()
      AND g.tenant_id = app.current_tenant_id()
      AND g.status = 'ACTIVE'
      AND now() >= g.starts_at
      AND now() < g.expires_at
      AND (required_level = 'REDACTED' OR g.access_level = 'SENSITIVE')
  )
$$;
