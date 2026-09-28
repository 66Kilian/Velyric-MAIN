CREATE TABLE app.tenant_messaging_settings (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants (id),
  sms_enabled boolean NOT NULL DEFAULT false,
  sms_sender_label text CHECK (sms_sender_label IS NULL OR sms_sender_label ~ '^[A-Za-z0-9 ]{3,11}$'),
  brand_logo_bytes bytea CHECK (brand_logo_bytes IS NULL OR octet_length(brand_logo_bytes) BETWEEN 1 AND 262144),
  brand_logo_content_type text CHECK (brand_logo_content_type IS NULL OR brand_logo_content_type IN ('image/jpeg', 'image/png', 'image/svg+xml', 'image/webp')),
  brand_logo_uploaded_at timestamptz,
  brand_color text NOT NULL DEFAULT '#6D28D9' CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  brand_footer text CHECK (brand_footer IS NULL OR char_length(brand_footer) <= 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((brand_logo_bytes IS NULL) = (brand_logo_content_type IS NULL)),
  CHECK (brand_logo_bytes IS NULL OR brand_logo_uploaded_at IS NOT NULL)
);

ALTER TABLE app.tenant_messaging_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_messaging_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_messaging_settings
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TABLE app.tenant_email_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  notification_type text NOT NULL CHECK (notification_type IN ('CALLER_BOOKING_CANCELED', 'CALLER_BOOKING_CHANGED', 'CALLER_BOOKING_CONFIRMATION', 'CALLER_WAITLIST_OFFER')),
  locale text NOT NULL CHECK (locale IN ('de', 'en', 'hu')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  updated_by_user_id uuid REFERENCES app.users (id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, notification_type, locale)
);

ALTER TABLE app.tenant_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_email_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_email_templates
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

UPDATE app.tenant_secret_refs r
   SET subject_id = i.id
  FROM app.integrations i
 WHERE i.secret_ref_id = r.id
   AND r.kind = 'OAUTH_REFRESH_TOKEN'
   AND r.subject_id IS NULL;
