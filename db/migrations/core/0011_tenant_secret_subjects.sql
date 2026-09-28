ALTER TABLE app.tenant_secret_refs ADD COLUMN subject_id uuid;

CREATE UNIQUE INDEX tenant_secret_refs_subject_version_idx
  ON app.tenant_secret_refs (tenant_id, kind, provider, (COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)), secret_version);

CREATE UNIQUE INDEX tenant_secret_refs_one_active_subject_idx
  ON app.tenant_secret_refs (tenant_id, kind, provider, (COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE status = 'ACTIVE';

DROP INDEX app.tenant_secret_refs_one_active_idx;

ALTER TABLE app.tenant_secret_refs DROP CONSTRAINT tenant_secret_refs_tenant_id_kind_provider_secret_version_key;
