import { withTenantTransaction, type KnowledgeSources } from '@velyric/db';
import { sha256Hex } from '@velyric/security';
import { sql, type Selectable } from 'kysely';
import Type, { type Static } from 'typebox';
import type { RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import type { KnowledgeObjectStore } from '../knowledge/object-store.js';
import { appendOutbox, canonicalJson, newId, type Trx } from '../persistence.js';
import { requireServiceScope, type ServicePrincipal } from '../principal.js';
import { domainSubject, IdParams, iso, Uuid } from './common.js';
import { expectedUploadSha, MAX_KNOWLEDGE_FILE_BYTES } from './knowledge.js';
import { Address, BusinessHours, validateHours } from './locations.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
const MAX_CHUNKS_PER_VERSION = 4000;
const MAX_CHUNKS_PER_BATCH = 64;
const RRF_K = 60;
const PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
]);

export interface InternalKnowledgeDependencies {
  readonly objects: KnowledgeObjectStore;
  readonly vectorSearch: boolean;
}

const REMOTE_SOURCE_TYPES: ReadonlySet<string> = new Set(['URL', 'WEBSITE']);

async function applyExtractedLocationFacts(
  trx: Trx,
  source: Selectable<KnowledgeSources>,
  facts: ExtractedLocationFacts,
  now: () => Date,
  traceId: string,
): Promise<void> {
  if (!REMOTE_SOURCE_TYPES.has(source.source_type)) {
    return;
  }
  validateHours(facts.business_hours);
  let target;
  if (source.location_id !== null) {
    target = await trx
      .selectFrom('locations')
      .select(['id'])
      .where('id', '=', source.location_id)
      .where('status', '=', 'ACTIVE')
      .forUpdate()
      .executeTakeFirst();
  } else {
    const active = await trx
      .selectFrom('locations')
      .select(['id'])
      .where('status', '=', 'ACTIVE')
      .forUpdate()
      .execute();
    target = active.length === 1 ? active[0] : undefined;
  }
  if (target === undefined) {
    return;
  }
  await trx
    .updateTable('locations')
    .set((eb) => ({
      ...(facts.address === undefined ? {} : { address: JSON.stringify(facts.address) }),
      ...(facts.business_hours === undefined
        ? {}
        : { business_hours: JSON.stringify(facts.business_hours) }),
      version: eb('version', '+', 1),
      updated_at: now(),
    }))
    .where('id', '=', target.id)
    .execute();
  await trx
    .insertInto('audit_logs')
    .values({
      id: newId(),
      tenant_id: source.tenant_id,
      actor_type: 'SYSTEM',
      actor_id: null,
      action: 'location.auto_updated_from_source',
      object_type: 'location',
      object_id: target.id,
      diff_hash: sha256Hex(canonicalJson(facts)),
      metadata: JSON.stringify({ source_id: source.id }),
      ip: null,
      user_agent: null,
      trace_id: traceId,
    })
    .execute();
}

const VersionQuery = Type.Object(
  { source_version: Type.String({ pattern: '^[1-9][0-9]{0,8}$' }) },
  { additionalProperties: false },
);
const ErrorCode = Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' });
const Embedding = Type.Array(Type.Number({ minimum: -1, maximum: 1 }), {
  minItems: EMBEDDING_DIMENSIONS,
  maxItems: EMBEDDING_DIMENSIONS,
});

const CreateVersionBody = Type.Object(
  {
    source_version: Type.Integer({ minimum: 1 }),
    content_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    malware_scan_result: Type.Union([
      Type.Literal('CLEAN'),
      Type.Literal('INFECTED'),
      Type.Literal('ERROR'),
    ]),
    parser: Type.String({ pattern: '^[a-z0-9_.-]{2,60}$' }),
    ocr_used: Type.Boolean(),
    pii_findings: Type.Array(Type.String({ pattern: '^[A-Z_]{2,40}$' }), {
      maxItems: 20,
      uniqueItems: true,
    }),
    detected_language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
  },
  { additionalProperties: false },
);

const ChunksBody = Type.Object(
  {
    embedding_model: Type.Literal(EMBEDDING_MODEL),
    chunks: Type.Array(
      Type.Object(
        {
          chunk_index: Type.Integer({ minimum: 0, maximum: MAX_CHUNKS_PER_VERSION - 1 }),
          content: Type.String({ minLength: 1, maxLength: 16_000 }),
          token_count: Type.Integer({ minimum: 1, maximum: 8192 }),
          language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
          heading_path: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 }),
          metadata: Type.Record(
            Type.String({ pattern: '^[a-z][a-z0-9_]{0,40}$' }),
            Type.Union([
              Type.String({ maxLength: 500 }),
              Type.Number(),
              Type.Boolean(),
              Type.Null(),
            ]),
          ),
          pii_flags: Type.Array(Type.String({ pattern: '^[A-Z_]{2,40}$' }), {
            maxItems: 10,
            uniqueItems: true,
          }),
          embedding: Type.Optional(Embedding),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_CHUNKS_PER_BATCH },
    ),
  },
  { additionalProperties: false },
);

const ExtractedLocationFacts = Type.Object(
  {
    address: Type.Optional(Address),
    business_hours: Type.Optional(BusinessHours),
  },
  { additionalProperties: false, minProperties: 1 },
);
type ExtractedLocationFacts = Static<typeof ExtractedLocationFacts>;

const CompleteBody = Type.Object(
  {
    chunk_count: Type.Integer({ minimum: 1, maximum: MAX_CHUNKS_PER_VERSION }),
    extracted_location_facts: Type.Optional(ExtractedLocationFacts),
  },
  { additionalProperties: false },
);
const FailureBody = Type.Object(
  {
    source_version: Type.Integer({ minimum: 1 }),
    error_code: ErrorCode,
    version_id: Type.Optional(Uuid),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SearchBody = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 500 }),
    language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
    location_id: Type.Optional(Uuid),
    acl: Type.Optional(
      Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_:-]{1,60}$' }), { maxItems: 20 }),
    ),
    embedding: Type.Optional(Embedding),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

function context(service: ServicePrincipal, traceId: string) {
  if (service.tenantId === null) {
    throw new ApiError('FORBIDDEN', { reason: 'tenant_claim_required' });
  }
  return {
    tenantId: service.tenantId,
    actorType: 'SERVICE' as const,
    actorId: service.issuer,
    traceId,
  };
}

async function lockCurrentSource(
  trx: Trx,
  id: string,
  sourceVersion: number,
): Promise<Selectable<KnowledgeSources>> {
  const source = await trx
    .selectFrom('knowledge_sources')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (source === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  if (source.version !== sourceVersion || !PIPELINE_STATUSES.has(source.status)) {
    throw new ApiError('CONFLICT', {
      reason: 'superseded',
      current_version: source.version,
      status: source.status,
    });
  }
  return source;
}

async function failSource(
  trx: Trx,
  tenantId: string,
  source: Selectable<KnowledgeSources>,
  errorCode: string,
  status: 'FAILED' | 'QUARANTINED',
  traceId: string,
  retryable: boolean,
): Promise<void> {
  await trx
    .updateTable('knowledge_sources')
    .set({ status, last_error_code: errorCode, updated_at: new Date() })
    .where('id', '=', source.id)
    .execute();
  await appendOutbox(trx, {
    tenantId,
    eventType: 'knowledge.ingestion_failed',
    subject: domainSubject(tenantId, 'knowledge.ingestion_failed'),
    payload: {
      tenant_id: tenantId,
      source_id: source.id,
      source_version: source.version,
      error_code: errorCode,
      status,
      retryable,
      still_serving_version_id: source.active_version_id,
    },
    traceId,
  });
}

export function createInternalKnowledgeRoutes(deps: InternalKnowledgeDependencies): RouteModule {
  return (app, services) => {
    app.get(
      '/internal/v1/knowledge/ingestions/:id',
      { schema: { params: IdParams, querystring: VersionQuery } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'knowledge.ingest');
        const tenant = context(service, request.traceId);
        const sourceVersion = Number(request.query.source_version);
        const { source, activeSha, credential } = await withTenantTransaction(
          services.db,
          tenant,
          async (trx) => {
            const row = await lockCurrentSource(trx, request.params.id, sourceVersion);
            if (row.status === 'QUEUED') {
              await trx
                .updateTable('knowledge_sources')
                .set({ status: 'SCANNING', updated_at: new Date() })
                .where('id', '=', row.id)
                .execute();
            }
            const active =
              row.active_version_id === null
                ? undefined
                : await trx
                    .selectFrom('knowledge_source_versions')
                    .select(['content_sha256'])
                    .where('id', '=', row.active_version_id)
                    .executeTakeFirst();
            const key = await trx
              .selectFrom('tenant_secret_refs')
              .select(['secret_ref', 'secret_version'])
              .where('provider', '=', 'openai')
              .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
              .where('status', '=', 'ACTIVE')
              .executeTakeFirst();
            return {
              source: row,
              activeSha: active?.content_sha256 ?? null,
              credential: key ?? null,
            };
          },
        );
        const fetch =
          source.storage_key !== null
            ? await deps.objects.presignUploadDownload(source.storage_key).then((download) => ({
                kind: 'OBJECT',
                url: download.url,
                expires_at: download.expiresAt.toISOString(),
                expected_sha256: expectedUploadSha(source.storage_key ?? ''),
                size_bytes: source.size_bytes === null ? null : Number(source.size_bytes),
              }))
            : { kind: 'URL', uri: source.uri, max_bytes: MAX_KNOWLEDGE_FILE_BYTES };
        return {
          source: {
            id: source.id,
            tenant_id: source.tenant_id,
            source_type: source.source_type,
            source_version: source.version,
            title: source.title,
            mime_type: source.mime_type,
            language: source.language,
            location_id: source.location_id,
          },
          fetch,
          active_content_sha256: activeSha,
          embedding: {
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
            required: deps.vectorSearch,
            api_key:
              credential === null
                ? null
                : { secret_ref: credential.secret_ref, secret_version: credential.secret_version },
          },
          limits: {
            max_chunks: MAX_CHUNKS_PER_VERSION,
            max_chunks_per_batch: MAX_CHUNKS_PER_BATCH,
            max_chunk_chars: 16_000,
          },
        };
      },
    );

    app.post(
      '/internal/v1/knowledge/ingestions/:id/versions',
      { schema: { params: IdParams, body: CreateVersionBody } },
      async (request, reply) => {
        const service = requireServiceScope(request.principal, 'knowledge.ingest');
        const tenant = context(service, request.traceId);
        const body = request.body;
        const peek = await withTenantTransaction(services.db, tenant, (trx) =>
          lockCurrentSource(trx, request.params.id, body.source_version),
        );
        if (body.malware_scan_result === 'CLEAN' && peek.storage_key !== null) {
          await deps.objects.promote(peek.storage_key);
        }
        const outcome = await withTenantTransaction(services.db, tenant, async (trx) => {
          const source = await lockCurrentSource(trx, request.params.id, body.source_version);
          const numbers = await trx
            .selectFrom('knowledge_source_versions')
            .select((eb) => eb.fn.max('version_number').as('max'))
            .where('source_id', '=', source.id)
            .executeTakeFirst();
          const nextNumber = (numbers?.max ?? 0) + 1;
          if (body.malware_scan_result !== 'CLEAN') {
            const quarantined = body.malware_scan_result === 'INFECTED';
            const versionId = newId();
            await trx
              .insertInto('knowledge_source_versions')
              .values({
                id: versionId,
                tenant_id: tenant.tenantId,
                source_id: source.id,
                version_number: nextNumber,
                content_sha256: body.content_sha256,
                status: quarantined ? 'QUARANTINED' : 'FAILED',
                malware_scan_result: body.malware_scan_result,
                parser: body.parser,
                error_code: quarantined ? 'malware_detected' : 'malware_scan_error',
              })
              .execute();
            await failSource(
              trx,
              tenant.tenantId,
              source,
              quarantined ? 'malware_detected' : 'malware_scan_error',
              quarantined ? 'QUARANTINED' : 'FAILED',
              request.traceId,
              !quarantined,
            );
            return {
              status: 200,
              body: { outcome: quarantined ? 'QUARANTINED' : 'FAILED', version_id: versionId },
            };
          }
          if (source.active_version_id !== null) {
            const active = await trx
              .selectFrom('knowledge_source_versions')
              .select(['id', 'content_sha256'])
              .where('id', '=', source.active_version_id)
              .executeTakeFirstOrThrow();
            if (active.content_sha256 === body.content_sha256) {
              await trx
                .updateTable('knowledge_sources')
                .set({
                  status: 'ACTIVE',
                  freshness: 'FRESH',
                  last_synced_at: new Date(),
                  last_error_code: null,
                  updated_at: new Date(),
                })
                .where('id', '=', source.id)
                .execute();
              return { status: 200, body: { outcome: 'UNCHANGED', version_id: active.id } };
            }
          }
          const pending = await trx
            .selectFrom('knowledge_source_versions')
            .select(['id', 'version_number'])
            .where('source_id', '=', source.id)
            .where('content_sha256', '=', body.content_sha256)
            .where('status', '=', 'CHUNKING')
            .executeTakeFirst();
          if (pending !== undefined) {
            return {
              status: 200,
              body: {
                outcome: 'RESUMED',
                version_id: pending.id,
                version_number: pending.version_number,
              },
            };
          }
          await trx
            .updateTable('knowledge_source_versions')
            .set({
              status: 'FAILED',
              error_code: 'superseded_by_newer_content',
              updated_at: new Date(),
            })
            .where('source_id', '=', source.id)
            .where('status', '=', 'CHUNKING')
            .execute();
          const version = await trx
            .insertInto('knowledge_source_versions')
            .values({
              id: newId(),
              tenant_id: tenant.tenantId,
              source_id: source.id,
              version_number: nextNumber,
              content_sha256: body.content_sha256,
              status: 'CHUNKING',
              malware_scan_result: 'CLEAN',
              pii_findings: body.pii_findings,
              parser: body.parser,
              ocr_used: body.ocr_used,
              parsed_at: new Date(),
            })
            .returning(['id', 'version_number'])
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('knowledge_sources')
            .set({
              status: 'EMBEDDING',
              ...(source.language === null && body.detected_language !== undefined
                ? { language: body.detected_language }
                : {}),
              updated_at: new Date(),
            })
            .where('id', '=', source.id)
            .execute();
          return {
            status: 201,
            body: {
              outcome: 'CREATED',
              version_id: version.id,
              version_number: version.version_number,
            },
          };
        });
        return reply.code(outcome.status).send(outcome.body);
      },
    );

    app.post(
      '/internal/v1/knowledge/versions/:id/chunks',
      { bodyLimit: 8 * 1024 * 1024, schema: { params: IdParams, body: ChunksBody } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'knowledge.ingest');
        const tenant = context(service, request.traceId);
        const chunks = request.body.chunks;
        const missingEmbedding = chunks.find((chunk) => chunk.embedding === undefined);
        if (deps.vectorSearch && missingEmbedding !== undefined) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [
              {
                path: `/body/chunks/${String(missingEmbedding.chunk_index)}/embedding`,
                rule: 'required',
              },
            ],
          });
        }
        return withTenantTransaction(services.db, tenant, async (trx) => {
          const version = await trx
            .selectFrom('knowledge_source_versions')
            .innerJoin(
              'knowledge_sources',
              'knowledge_sources.id',
              'knowledge_source_versions.source_id',
            )
            .select([
              'knowledge_source_versions.id',
              'knowledge_source_versions.status',
              'knowledge_source_versions.source_id',
              'knowledge_sources.acl',
              'knowledge_sources.language',
            ])
            .where('knowledge_source_versions.id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (version === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (version.status !== 'CHUNKING') {
            throw new ApiError('CONFLICT', {
              reason: 'version_not_accepting_chunks',
              status: version.status,
            });
          }
          const inserted = await trx
            .insertInto('knowledge_chunks')
            .values(
              chunks.map((chunk) => ({
                id: newId(),
                tenant_id: tenant.tenantId,
                source_id: version.source_id,
                source_version_id: version.id,
                chunk_index: chunk.chunk_index,
                content: chunk.content,
                token_count: chunk.token_count,
                language: chunk.language ?? version.language,
                heading_path: chunk.heading_path,
                metadata: JSON.stringify(chunk.metadata),
                pii_flags: chunk.pii_flags,
                acl: version.acl,
                is_active: false,
              })),
            )
            .onConflict((conflict) =>
              conflict.columns(['source_version_id', 'chunk_index']).doNothing(),
            )
            .returning(['id', 'chunk_index'])
            .execute();
          if (deps.vectorSearch && inserted.length > 0) {
            const byIndex = new Map(chunks.map((chunk) => [chunk.chunk_index, chunk]));
            for (const row of inserted) {
              const embedding = byIndex.get(row.chunk_index)?.embedding ?? [];
              await sql`
              insert into app.knowledge_chunk_embeddings (chunk_id, tenant_id, source_id, embedding_model, embedding, acl)
              values (${row.id}::uuid, ${tenant.tenantId}::uuid, ${version.source_id}::uuid, ${EMBEDDING_MODEL}, ${`[${embedding.join(',')}]`}::vector, ${version.acl}::text[])
              on conflict (chunk_id) do nothing`.execute(trx);
            }
          }
          return {
            accepted: chunks.length,
            inserted: inserted.length,
            embeddings_stored: deps.vectorSearch,
          };
        });
      },
    );

    app.post(
      '/internal/v1/knowledge/versions/:id/complete',
      { schema: { params: IdParams, body: CompleteBody } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'knowledge.ingest');
        const tenant = context(service, request.traceId);
        return withTenantTransaction(services.db, tenant, async (trx) => {
          const version = await trx
            .selectFrom('knowledge_source_versions')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (version === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (version.status === 'ACTIVE') {
            return { outcome: 'ALREADY_ACTIVE', version_id: version.id };
          }
          if (version.status !== 'CHUNKING') {
            throw new ApiError('CONFLICT', {
              reason: 'version_not_completable',
              status: version.status,
            });
          }
          const source = await trx
            .selectFrom('knowledge_sources')
            .selectAll()
            .where('id', '=', version.source_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (!PIPELINE_STATUSES.has(source.status)) {
            throw new ApiError('CONFLICT', { reason: 'superseded', status: source.status });
          }
          const counted = await trx
            .selectFrom('knowledge_chunks')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('source_version_id', '=', version.id)
            .executeTakeFirstOrThrow();
          const stored = Number(counted.count);
          if (stored !== request.body.chunk_count) {
            throw new ApiError('CONFLICT', {
              reason: 'chunk_count_mismatch',
              stored,
              expected: request.body.chunk_count,
            });
          }
          if (deps.vectorSearch) {
            const embedded = await sql<{
              count: string;
            }>`select count(*)::text as count from app.knowledge_chunk_embeddings e join app.knowledge_chunks c on c.id = e.chunk_id where c.source_version_id = ${version.id}::uuid`.execute(
              trx,
            );
            if (Number(embedded.rows[0]?.count ?? 0) !== stored) {
              throw new ApiError('CONFLICT', { reason: 'embedding_count_mismatch' });
            }
          }
          await trx
            .updateTable('knowledge_source_versions')
            .set({ status: 'READY', chunk_count: stored, updated_at: new Date() })
            .where('id', '=', version.id)
            .execute();
          await sql`select app.activate_knowledge_version(${version.id}::uuid)`.execute(trx);
          await trx
            .updateTable('knowledge_sources')
            .set({ last_error_code: null })
            .where('id', '=', source.id)
            .execute();
          if (request.body.extracted_location_facts !== undefined) {
            await sql`savepoint location_facts`.execute(trx);
            try {
              await applyExtractedLocationFacts(
                trx,
                source,
                request.body.extracted_location_facts,
                services.now,
                request.traceId,
              );
              await sql`release savepoint location_facts`.execute(trx);
            } catch (error) {
              await sql`rollback to savepoint location_facts`.execute(trx);
              request.log.warn(
                { error, sourceId: source.id },
                'failed to apply extracted location facts; continuing without them',
              );
            }
          }
          await trx
            .updateTable('knowledge_gaps')
            .set({
              status: 'ANSWER_SUGGESTED',
              resolved_source_id: source.id,
              updated_at: new Date(),
            })
            .where('status', '=', 'OPEN')
            .where(
              sql<boolean>`exists (select 1 from app.knowledge_chunks c where c.source_version_id = ${version.id}::uuid and c.content_tsv @@ plainto_tsquery('simple', knowledge_gaps.question_normalized))`,
            )
            .execute();
          for (const eventType of [
            'knowledge.ingestion_completed',
            'knowledge.source_activated',
          ] as const) {
            await appendOutbox(trx, {
              tenantId: tenant.tenantId,
              eventType,
              subject: domainSubject(tenant.tenantId, eventType),
              payload: {
                tenant_id: tenant.tenantId,
                source_id: source.id,
                version_id: version.id,
                version_number: version.version_number,
                chunk_count: stored,
              },
              traceId: request.traceId,
            });
          }
          return { outcome: 'ACTIVATED', version_id: version.id, chunk_count: stored };
        });
      },
    );

    app.post(
      '/internal/v1/knowledge/ingestions/:id/failures',
      { schema: { params: IdParams, body: FailureBody } },
      async (request) => {
        const service = requireServiceScope(request.principal, 'knowledge.ingest');
        const tenant = context(service, request.traceId);
        const body = request.body;
        return withTenantTransaction(services.db, tenant, async (trx) => {
          const source = await lockCurrentSource(trx, request.params.id, body.source_version);
          if (body.version_id !== undefined) {
            await trx
              .updateTable('knowledge_source_versions')
              .set({ status: 'FAILED', error_code: body.error_code, updated_at: new Date() })
              .where('id', '=', body.version_id)
              .where('source_id', '=', source.id)
              .where('status', '=', 'CHUNKING')
              .execute();
          }
          await failSource(
            trx,
            tenant.tenantId,
            source,
            body.error_code,
            'FAILED',
            request.traceId,
            body.retryable,
          );
          return { outcome: 'FAILED', still_serving_version_id: source.active_version_id };
        });
      },
    );

    app.post('/internal/v1/knowledge/search', { schema: { body: SearchBody } }, async (request) => {
      const service = requireServiceScope(request.principal, 'knowledge.retrieve');
      const tenant = context(service, request.traceId);
      const body = request.body;
      const limit = body.limit ?? 5;
      const acl = body.acl ?? [];
      const locationId = body.location_id ?? null;
      const hybrid = deps.vectorSearch && body.embedding !== undefined;
      return withTenantTransaction(services.db, tenant, async (trx) => {
        const lexical = await sql<{ id: string; rank: number }>`
          select c.id, ts_rank_cd(c.content_tsv, q.query) as rank
          from app.knowledge_chunks c
          join app.knowledge_sources s on s.id = c.source_id,
               websearch_to_tsquery('simple', ${body.query}) as q(query)
          where c.is_active
            and c.content_tsv @@ q.query
            and s.status <> 'ARCHIVED'
            and (s.valid_from is null or s.valid_from <= now())
            and (s.valid_to is null or s.valid_to > now())
            and (s.location_id is null or s.location_id = ${locationId}::uuid)
            and (cardinality(c.acl) = 0 or c.acl && ${acl}::text[])
          order by rank desc, c.id
          limit 30`.execute(trx);
        const vector = hybrid
          ? await sql<{ id: string; distance: number }>`
              select e.chunk_id as id, e.embedding <=> ${`[${(body.embedding ?? []).join(',')}]`}::vector as distance
              from app.knowledge_chunk_embeddings e
              join app.knowledge_sources s on s.id = e.source_id
              where e.is_active
                and s.status <> 'ARCHIVED'
                and (s.valid_from is null or s.valid_from <= now())
                and (s.valid_to is null or s.valid_to > now())
                and (s.location_id is null or s.location_id = ${locationId}::uuid)
                and (cardinality(e.acl) = 0 or e.acl && ${acl}::text[])
              order by distance
              limit 30`.execute(trx)
          : { rows: [] };
        const scores = new Map<string, number>();
        lexical.rows.forEach((row, index) =>
          scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + index + 1)),
        );
        vector.rows.forEach((row, index) =>
          scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + index + 1)),
        );
        const ranked = [...scores.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, limit);
        if (ranked.length === 0) {
          return { mode: hybrid ? 'HYBRID' : 'LEXICAL', results: [] };
        }
        const rows = await trx
          .selectFrom('knowledge_chunks')
          .innerJoin('knowledge_sources', 'knowledge_sources.id', 'knowledge_chunks.source_id')
          .select([
            'knowledge_chunks.id',
            'knowledge_chunks.content',
            'knowledge_chunks.heading_path',
            'knowledge_chunks.language',
            'knowledge_chunks.source_id',
            'knowledge_sources.title',
            'knowledge_sources.source_type',
            'knowledge_sources.freshness',
            'knowledge_sources.last_synced_at',
          ])
          .where(
            'knowledge_chunks.id',
            'in',
            ranked.map(([id]) => id),
          )
          .execute();
        const byId = new Map(rows.map((row) => [row.id, row]));
        return {
          mode: hybrid ? 'HYBRID' : 'LEXICAL',
          results: ranked.flatMap(([id, score]) => {
            const row = byId.get(id);
            return row === undefined
              ? []
              : [
                  {
                    chunk_id: row.id,
                    source_id: row.source_id,
                    source_title: row.title,
                    source_type: row.source_type,
                    content: row.content,
                    heading_path: row.heading_path,
                    language: row.language,
                    freshness: row.freshness,
                    last_synced_at: iso(row.last_synced_at),
                    score: Number(score.toFixed(6)),
                  },
                ];
          }),
        };
      });
    });
  };
}
