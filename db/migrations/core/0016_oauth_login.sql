ALTER TABLE app.credentials ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE app.credentials ADD CONSTRAINT credentials_password_or_verified_email_check
  CHECK (password_hash IS NOT NULL OR email_verified_at IS NOT NULL);
