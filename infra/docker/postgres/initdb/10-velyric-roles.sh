#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set app_password="$VELYRIC_LOCAL_APP_PASSWORD" \
  --set readonly_password="$VELYRIC_LOCAL_READONLY_PASSWORD" <<'SQL'
DO $roles$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT *
    FROM (
      VALUES
        ('velyric_owner', false),
        ('velyric_migrator', true),
        ('velyric_app', true),
        ('velyric_metering', true),
        ('velyric_readonly', true),
        ('velyric_support', true),
        ('velyric_retention', false),
        ('velyric_local', true)
    ) AS t (role_name, can_login)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec.role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
        spec.role_name,
        CASE WHEN spec.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;
  END LOOP;
END
$roles$;

ALTER ROLE velyric_local WITH PASSWORD :'app_password' NOINHERIT;
ALTER ROLE velyric_readonly WITH PASSWORD :'readonly_password';
GRANT velyric_app, velyric_metering, velyric_support TO velyric_local;
GRANT CONNECT ON DATABASE velyric TO velyric_local, velyric_readonly;
SQL
