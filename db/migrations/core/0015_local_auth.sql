CREATE TABLE app.credentials (
  auth_subject text PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER credentials_touch_updated_at
BEFORE UPDATE ON app.credentials
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.user_sessions (
  id text PRIMARY KEY,
  auth_subject text NOT NULL REFERENCES app.credentials (auth_subject) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip inet
);

CREATE INDEX user_sessions_auth_subject_idx ON app.user_sessions (auth_subject);
CREATE INDEX user_sessions_expires_at_idx ON app.user_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE app.password_reset_tokens (
  token_hash text PRIMARY KEY,
  auth_subject text NOT NULL REFERENCES app.credentials (auth_subject) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX password_reset_tokens_auth_subject_idx ON app.password_reset_tokens (auth_subject);

REVOKE ALL ON app.credentials, app.password_reset_tokens FROM velyric_retention;
GRANT SELECT, DELETE ON app.user_sessions TO velyric_retention;
