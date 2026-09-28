CREATE EXTENSION IF NOT EXISTS vector;

SET LOCAL ROLE velyric_owner;

CREATE TABLE app.knowledge_chunk_embeddings (
  chunk_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  source_id uuid NOT NULL,
  embedding_model text NOT NULL,
  embedding vector(1536) NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  acl text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES app.knowledge_chunks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES app.knowledge_sources (tenant_id, id)
);

CREATE INDEX knowledge_chunk_embeddings_hnsw_idx
  ON app.knowledge_chunk_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE is_active;

CREATE INDEX knowledge_chunk_embeddings_tenant_idx
  ON app.knowledge_chunk_embeddings (tenant_id, source_id)
  WHERE is_active;

ALTER TABLE app.knowledge_chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge_chunk_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.knowledge_chunk_embeddings
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE FUNCTION app.sync_embedding_activation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE app.knowledge_chunk_embeddings
    SET is_active = NEW.is_active, acl = NEW.acl
    WHERE chunk_id = NEW.id AND (is_active IS DISTINCT FROM NEW.is_active OR acl IS DISTINCT FROM NEW.acl);
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_chunks_sync_embedding_activation
AFTER UPDATE OF is_active, acl ON app.knowledge_chunks
FOR EACH ROW EXECUTE FUNCTION app.sync_embedding_activation();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.knowledge_chunk_embeddings TO velyric_app;
GRANT SELECT ON app.knowledge_chunk_embeddings TO velyric_retention;
