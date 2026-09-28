CREATE TABLE app.api_key_directory (
  prefix text PRIMARY KEY,
  api_key_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.phone_number_directory (
  provider text NOT NULL,
  e164 text NOT NULL,
  phone_number_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, e164)
);

CREATE TABLE app.billing_customer_directory (
  stripe_customer_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  billing_profile_id uuid NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app.sync_api_key_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  INSERT INTO app.api_key_directory (prefix, api_key_id, tenant_id, active, updated_at)
  VALUES (NEW.prefix, NEW.id, NEW.tenant_id, NEW.revoked_at IS NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > now()), now())
  ON CONFLICT (api_key_id) DO UPDATE SET active = EXCLUDED.active, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;

CREATE TRIGGER api_keys_directory
AFTER INSERT OR UPDATE OF revoked_at, expires_at ON app.api_keys
FOR EACH ROW EXECUTE FUNCTION app.sync_api_key_directory();

CREATE FUNCTION app.sync_phone_number_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.status = 'RELEASED' THEN
    DELETE FROM app.phone_number_directory WHERE phone_number_id = NEW.id;
    RETURN NEW;
  END IF;
  DELETE FROM app.phone_number_directory
    WHERE phone_number_id = NEW.id AND (provider, e164) IS DISTINCT FROM (NEW.provider, NEW.e164);
  INSERT INTO app.phone_number_directory (provider, e164, phone_number_id, tenant_id, status, updated_at)
  VALUES (NEW.provider, NEW.e164, NEW.id, NEW.tenant_id, NEW.status, now())
  ON CONFLICT (phone_number_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;

CREATE TRIGGER phone_numbers_directory
AFTER INSERT OR UPDATE OF provider, e164, status ON app.phone_numbers
FOR EACH ROW EXECUTE FUNCTION app.sync_phone_number_directory();

CREATE FUNCTION app.sync_billing_customer_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  DELETE FROM app.billing_customer_directory
    WHERE billing_profile_id = NEW.id AND stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id;
  IF NEW.stripe_customer_id IS NOT NULL THEN
    INSERT INTO app.billing_customer_directory (stripe_customer_id, tenant_id, billing_profile_id, updated_at)
    VALUES (NEW.stripe_customer_id, NEW.tenant_id, NEW.id, now())
    ON CONFLICT (billing_profile_id) DO UPDATE SET updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER billing_profiles_customer_directory
AFTER INSERT OR UPDATE OF stripe_customer_id ON app.billing_profiles
FOR EACH ROW EXECUTE FUNCTION app.sync_billing_customer_directory();

REVOKE ALL ON app.api_key_directory, app.phone_number_directory, app.billing_customer_directory FROM velyric_app;
GRANT SELECT ON app.api_key_directory, app.phone_number_directory, app.billing_customer_directory TO velyric_app;
