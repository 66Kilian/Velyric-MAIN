DO $roles$
DECLARE
  role_spec record;
BEGIN
  FOR role_spec IN
    SELECT *
    FROM (
      VALUES
        ('velyric_owner', false),
        ('velyric_migrator', true),
        ('velyric_app', true),
        ('velyric_metering', true),
        ('velyric_readonly', true),
        ('velyric_support', true),
        ('velyric_retention', false)
    ) AS t (role_name, can_login)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_spec.role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
        role_spec.role_name,
        CASE WHEN role_spec.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;
  END LOOP;
END
$roles$;

GRANT velyric_owner TO velyric_migrator;
GRANT velyric_retention TO velyric_owner;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION velyric_owner;
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION velyric_owner;
CREATE SCHEMA IF NOT EXISTS support AUTHORIZATION velyric_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO velyric_owner, velyric_app, velyric_metering, velyric_readonly, velyric_support, velyric_retention;

ALTER ROLE velyric_owner SET search_path = app, public;
ALTER ROLE velyric_migrator SET search_path = app, public;
ALTER ROLE velyric_app SET search_path = app, public;
ALTER ROLE velyric_metering SET search_path = app, public;
ALTER ROLE velyric_readonly SET search_path = analytics, public;
ALTER ROLE velyric_support SET search_path = support, public;
ALTER ROLE velyric_retention SET search_path = app, public;
