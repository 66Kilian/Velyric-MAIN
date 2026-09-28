import { createHash } from 'node:crypto';
import { s3 } from '@velyric/contracts';
import type { KnowledgeChunks, KnowledgeSources, KnowledgeSourceVersions } from '@velyric/db';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  resolveAllowedAddresses,
  validateEgressUrl,
  type HostResolver,
} from '@velyric/security';
import type { Selectable } from 'kysely';
import Type, { type Static } from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import type { KnowledgeObjectStore, PresignedUpload } from '../knowledge/object-store.js';
import {
  appendOutbox,
  buildPage,
  newId,
  readCursor,
  writeAudit,
  type Trx,
} from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso, limitFromQuery, Uuid } from './common.js';

export interface KnowledgeRouteDependencies {
  readonly objects: KnowledgeObjectStore;
  readonly resolver: HostResolver;
}

export const MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024;

export const FILE_SOURCE_TYPES = {
  FILE_PDF: { mime: 'application/pdf', extension: 'pdf' },
  FILE_DOCX: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  FILE_TXT: { mime: 'text/plain', extension: 'txt' },
  FILE_MARKDOWN: { mime: 'text/markdown', extension: 'md' },
  FILE_CSV: { mime: 'text/csv', extension: 'csv' },
} as const;

type FileSourceType = keyof typeof FILE_SOURCE_TYPES;

const REFRESHABLE_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'FAILED',
  'READY',
  'QUARANTINED',
]);
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
]);

const Language = Type.String({ pattern: '^[a-z]{2}$' });
const Title = Type.String({ minLength: 1, maxLength: 300 });
const Acl = Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_:-]{1,60}$' }), {
  maxItems: 20,
  uniqueItems: true,
});
const FaqEntries = Type.Array(
  Type.Object(
    {
      question: Type.String({ minLength: 3, maxLength: 1000 }),
      answer: Type.String({ minLength: 1, maxLength: 8000 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 1000 },
);

const Common = {
  title: Title,
  location_id: Type.Optional(Uuid),
  language: Type.Optional(Language),
  acl: Type.Optional(Acl),
  valid_from: Type.Optional(Type.String({ format: 'date-time' })),
  valid_to: Type.Optional(Type.String({ format: 'date-time' })),
};

const CreateBody = Type.Union([
  Type.Object(
    {
      source_type: Type.Literal('URL'),
      uri: Type.String({ minLength: 12, maxLength: 2000 }),
      freshness_ttl_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })),
      ...Common,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source_type: Type.Enum(Object.keys(FILE_SOURCE_TYPES) as FileSourceType[]),
      size_bytes: Type.Integer({ minimum: 1, maximum: MAX_KNOWLEDGE_FILE_BYTES }),
      sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
      ...Common,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source_type: Type.Union([Type.Literal('FAQ'), Type.Literal('MANUAL_QA')]),
      entries: FaqEntries,
      ...Common,
    },
    { additionalProperties: false },
  ),
]);

type CreateBody = Static<typeof CreateBody>;

const NewUploadBody = Type.Object(
  {
    size_bytes: Type.Integer({ minimum: 1, maximum: MAX_KNOWLEDGE_FILE_BYTES }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  },
  { additionalProperties: false },
);
const EntriesBody = Type.Object({ entries: FaqEntries }, { additionalProperties: false });
const UpdateBody = Type.Object(
  {
    title: Type.Optional(Title),
    acl: Type.Optional(Acl),
    freshness_ttl_hours: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 8760 }), Type.Null()]),
    ),
    valid_to: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);

const ListQuery = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    status: Type.Optional(Type.String({ pattern: '^[A-Z_]{4,20}$' })),
    source_type: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,20}$' })),
    location_id: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

export function presentKnowledgeSource(
  row: Selectable<KnowledgeSources>,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: row.id,
    source_type: row.source_type,
    title: row.title,
    uri: row.uri,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    language: row.language,
    location_id: row.location_id,
    status: row.status,
    freshness: row.freshness,
    freshness_ttl_hours: row.freshness_ttl_hours,
    active_version_id: row.active_version_id,
    acl: row.acl,
    valid_from: iso(row.valid_from),
    valid_to: iso(row.valid_to),
    last_synced_at: iso(row.last_synced_at),
    last_error_code: row.last_error_code,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...extra,
  };
}

function presentVersion(row: Selectable<KnowledgeSourceVersions>): Record<string, unknown> {
  return {
    id: row.id,
    version_number: row.version_number,
    status: row.status,
    content_sha256: row.content_sha256,
    malware_scan_result: row.malware_scan_result,
    pii_findings: row.pii_findings,
    chunk_count: row.chunk_count,
    parser: row.parser,
    ocr_used: row.ocr_used,
    error_code: row.error_code,
    parsed_at: iso(row.parsed_at),
    activated_at: iso(row.activated_at),
    created_at: iso(row.created_at),
  };
}

const VersionChunksParams = Type.Object(
  { id: Uuid, versionId: Uuid },
  { additionalProperties: false },
);

const MAX_CHUNKS_RETURNED = 500;

function presentChunk(row: Selectable<KnowledgeChunks>): Record<string, unknown> {
  return {
    id: row.id,
    chunk_index: row.chunk_index,
    heading_path: row.heading_path,
    content: row.content,
    token_count: row.token_count,
    pii_flags: row.pii_flags,
  };
}

function presentUpload(upload: PresignedUpload): Record<string, unknown> {
  return {
    url: upload.url,
    method: upload.method,
    headers: upload.headers,
    expires_at: upload.expiresAt.toISOString(),
  };
}

export function uploadKey(
  tenantId: string,
  sourceId: string,
  revision: number,
  sha256: string,
  extension: string,
): string {
  return s3.tenantObjectKey(
    tenantId,
    'knowledge',
    sourceId,
    revision,
    `upload-${sha256}.${extension}`,
  );
}

export function expectedUploadSha(storageKey: string): string | null {
  return /\/upload-([0-9a-f]{64})\.[a-z]+$/.exec(storageKey)?.[1] ?? null;
}

function faqDocument(entries: Static<typeof FaqEntries>, language: string | null): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'velyric.faq.v1',
      language,
      entries: entries.map((entry) => ({
        question: entry.question.trim(),
        answer: entry.answer.trim(),
      })),
    }),
  );
}

function validityWindow(
  from: string | undefined,
  to: string | undefined,
): { validFrom: Date | null; validTo: Date | null } {
  const validFrom = from === undefined ? null : new Date(from);
  const validTo = to === undefined ? null : new Date(to);
  if (validFrom !== null && validTo !== null && validTo.getTime() <= validFrom.getTime()) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/body/valid_to', rule: 'after_valid_from' }],
    });
  }
  return { validFrom, validTo };
}

async function queueIngestion(
  trx: Trx,
  actor: TenantActor,
  source: Selectable<KnowledgeSources>,
  traceId: string,
  reason: string,
): Promise<void> {
  await appendOutbox(trx, {
    tenantId: actor.tenantId,
    eventType: 'knowledge.ingestion_requested',
    subject: domainSubject(actor.tenantId, 'knowledge.ingestion_requested'),
    payload: {
      tenant_id: actor.tenantId,
      source_id: source.id,
      source_version: source.version,
      source_type: source.source_type,
      reason,
    },
    traceId,
  });
}

async function loadSource(
  trx: Trx,
  actor: TenantActor,
  id: string,
  lock = false,
): Promise<Selectable<KnowledgeSources>> {
  let query = trx.selectFrom('knowledge_sources').selectAll().where('id', '=', id);
  if (lock) {
    query = query.forUpdate();
  }
  const row = await query.executeTakeFirst();
  if (
    row === undefined ||
    (actor.locationScope.length > 0 &&
      row.location_id !== null &&
      !actor.locationScope.includes(row.location_id))
  ) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export function createKnowledgeRoutes(deps: KnowledgeRouteDependencies): RouteModule {
  return (app, services) => {
    const verifyUrl = async (uri: string): Promise<string> => {
      try {
        const parsed = new URL(uri);
        const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
        const policy = { ...DEFAULT_EGRESS_POLICY, allowedHosts: [host] };
        const url = validateEgressUrl(parsed, policy);
        await resolveAllowedAddresses(url.hostname, policy, deps.resolver);
        url.hash = '';
        return url.toString();
      } catch (error) {
        if (error instanceof EgressBlockedError) {
          throw error;
        }
        throw new ApiError('SSRF_BLOCKED', { reason: 'INVALID_URL' });
      }
    };

    app.get('/v1/knowledge-sources', { schema: { querystring: ListQuery } }, async (request) => {
      const actor = requireTenantActor(request.principal, 'knowledge:read');
      const limit = limitFromQuery(request.query.limit);
      const cursor = readCursor(request.query.cursor, services.cursorKey);
      const rows = await inTenant(services, actor, request, (trx) => {
        let query = trx
          .selectFrom('knowledge_sources')
          .selectAll()
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1);
        if (request.query.status !== undefined) {
          query = query.where('status', '=', request.query.status);
        }
        if (request.query.source_type !== undefined) {
          query = query.where('source_type', '=', request.query.source_type);
        }
        if (request.query.location_id !== undefined) {
          query = query.where('location_id', '=', request.query.location_id);
        }
        if (actor.locationScope.length > 0) {
          query = query.where((eb) =>
            eb.or([eb('location_id', 'is', null), eb('location_id', 'in', actor.locationScope)]),
          );
        }
        if (cursor !== null) {
          query = query.where((eb) =>
            eb(
              eb.refTuple('created_at', 'id'),
              '<',
              eb.tuple(new Date(String(cursor.k[0])), cursor.id),
            ),
          );
        }
        return query.execute();
      });
      return buildPage(
        rows,
        limit,
        services.cursorKey,
        (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
        (row) => presentKnowledgeSource(row),
      );
    });

    app.get(
      '/v1/knowledge-sources/:id',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:read');
        const { source, versions } = await inTenant(services, actor, request, async (trx) => {
          const row = await loadSource(trx, actor, request.params.id);
          const history = await trx
            .selectFrom('knowledge_source_versions')
            .selectAll()
            .where('source_id', '=', row.id)
            .orderBy('version_number', 'desc')
            .limit(20)
            .execute();
          return { source: row, versions: history };
        });
        return reply
          .header('etag', weakEtag(source.version))
          .send(presentKnowledgeSource(source, { versions: versions.map(presentVersion) }));
      },
    );

    app.get(
      '/v1/knowledge-sources/:id/versions/:versionId/chunks',
      { schema: { params: VersionChunksParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:read');
        const chunks = await inTenant(services, actor, request, async (trx) => {
          await loadSource(trx, actor, request.params.id);
          const version = await trx
            .selectFrom('knowledge_source_versions')
            .select(['id'])
            .where('id', '=', request.params.versionId)
            .where('source_id', '=', request.params.id)
            .executeTakeFirst();
          if (version === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          return trx
            .selectFrom('knowledge_chunks')
            .selectAll()
            .where('source_version_id', '=', version.id)
            .where('is_active', '=', true)
            .orderBy('chunk_index', 'asc')
            .limit(MAX_CHUNKS_RETURNED)
            .execute();
        });
        return reply
          .header('cache-control', 'private, no-store')
          .send({ chunks: chunks.map(presentChunk) });
      },
    );

    app.post(
      '/v1/knowledge-sources',
      { bodyLimit: 4 * 1024 * 1024, schema: { body: CreateBody } },
      async (request, reply) => {
        const body: CreateBody = request.body;
        const actor = requireTenantActor(
          request.principal,
          'knowledge:write',
          body.location_id ?? null,
        );
        const { validFrom, validTo } = validityWindow(body.valid_from, body.valid_to);
        const uri = body.source_type === 'URL' ? await verifyUrl(body.uri) : null;
        const sourceId = newId();
        const faq =
          body.source_type === 'FAQ' || body.source_type === 'MANUAL_QA'
            ? faqDocument(body.entries, body.language ?? null)
            : null;
        const faqKey =
          faq === null
            ? null
            : s3.tenantObjectKey(
                actor.tenantId,
                'knowledge',
                sourceId,
                1,
                `faq-${createHash('sha256').update(faq).digest('hex')}.json`,
              );
        if (faq !== null && faqKey !== null) {
          await deps.objects.putUpload(faqKey, faq, 'application/json');
        }
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.create',
          async (trx) => {
            if (body.location_id !== undefined) {
              const location = await trx
                .selectFrom('locations')
                .select(['id'])
                .where('id', '=', body.location_id)
                .executeTakeFirst();
              if (location === undefined) {
                throw new ApiError('VALIDATION_FAILED', {
                  issues: [{ path: '/body/location_id', rule: 'exists' }],
                });
              }
            }
            const file =
              body.source_type in FILE_SOURCE_TYPES && 'sha256' in body
                ? {
                    ...FILE_SOURCE_TYPES[body.source_type],
                    sha256: body.sha256,
                    size: body.size_bytes,
                  }
                : null;
            const storageKey =
              file !== null
                ? uploadKey(actor.tenantId, sourceId, 1, file.sha256, file.extension)
                : faqKey;
            const row = await trx
              .insertInto('knowledge_sources')
              .values({
                id: sourceId,
                tenant_id: actor.tenantId,
                location_id: body.location_id ?? null,
                source_type: body.source_type,
                title: body.title,
                uri,
                storage_key: storageKey,
                mime_type: file?.mime ?? (faq === null ? null : 'application/json'),
                size_bytes:
                  file === null ? (faq === null ? null : String(faq.length)) : String(file.size),
                language: body.language ?? null,
                status: file === null ? 'QUEUED' : 'PENDING_UPLOAD',
                freshness_ttl_hours:
                  body.source_type === 'URL' ? (body.freshness_ttl_hours ?? 168) : null,
                acl: body.acl ?? [],
                valid_from: validFrom,
                valid_to: validTo,
                created_by_user_id: actor.userId ?? null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            if (file === null) {
              await queueIngestion(trx, actor, row, request.traceId, 'created');
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.created',
              objectType: 'knowledge_source',
              objectId: row.id,
              metadata: {
                source_type: row.source_type,
                host: uri === null ? null : new URL(uri).hostname,
                size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
              },
            });
            const upload =
              file === null || storageKey === null
                ? null
                : await deps.objects.presignUpload({
                    key: storageKey,
                    contentType: file.mime,
                    sizeBytes: file.size,
                    sha256Hex: file.sha256,
                  });
            return {
              status: 201,
              body: presentKnowledgeSource(
                row,
                upload === null ? {} : { upload: presentUpload(upload) },
              ),
              headers: { etag: weakEtag(row.version), location: `/v1/knowledge-sources/${row.id}` },
              resource: { type: 'knowledge_source', id: row.id },
            };
          },
        );
      },
    );

    app.post(
      '/v1/knowledge-sources/:id/uploads',
      { schema: { params: IdParams, body: NewUploadBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.new_upload',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            const file = FILE_SOURCE_TYPES[source.source_type as FileSourceType] as
              (typeof FILE_SOURCE_TYPES)[FileSourceType] | undefined;
            if (file === undefined) {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'not_a_file_source' });
            }
            if (IN_FLIGHT_STATUSES.has(source.status) || source.status === 'ARCHIVED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: source.status });
            }
            const revision = source.version + 1;
            const key = uploadKey(
              actor.tenantId,
              source.id,
              revision,
              request.body.sha256,
              file.extension,
            );
            const row = await trx
              .updateTable('knowledge_sources')
              .set({
                storage_key: key,
                size_bytes: String(request.body.size_bytes),
                status: 'PENDING_UPLOAD',
                last_error_code: null,
                version: revision,
                updated_at: new Date(),
              })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.upload_requested',
              objectType: 'knowledge_source',
              objectId: source.id,
              metadata: { revision },
            });
            const upload = await deps.objects.presignUpload({
              key,
              contentType: file.mime,
              sizeBytes: request.body.size_bytes,
              sha256Hex: request.body.sha256,
            });
            return {
              status: 201,
              body: presentKnowledgeSource(row, { upload: presentUpload(upload) }),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.post(
      '/v1/knowledge-sources/:id/upload-complete',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.upload_complete',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            if (source.status !== 'PENDING_UPLOAD' || source.storage_key === null) {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: source.status });
            }
            const stored = await deps.objects.headUpload(source.storage_key);
            if (stored === null) {
              throw new ApiError('PRECONDITION_REQUIRED', { reason: 'upload_missing' });
            }
            const expectedSha = expectedUploadSha(source.storage_key);
            if (
              stored.sizeBytes !== Number(source.size_bytes) ||
              stored.sha256Hex === null ||
              stored.sha256Hex !== expectedSha
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/upload', rule: 'size_and_checksum_match' }],
              });
            }
            const row = await trx
              .updateTable('knowledge_sources')
              .set({ status: 'QUEUED', updated_at: new Date() })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await queueIngestion(trx, actor, row, request.traceId, 'uploaded');
            return {
              status: 202,
              body: presentKnowledgeSource(row),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.get(
      '/v1/knowledge-sources/:id/entries',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:read');
        const source = await inTenant(services, actor, request, (trx) =>
          loadSource(trx, actor, request.params.id),
        );
        if (
          (source.source_type !== 'FAQ' && source.source_type !== 'MANUAL_QA') ||
          source.storage_key === null
        ) {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'not_a_faq_source' });
        }
        const document = await deps.objects.readDocument(source.storage_key, 4 * 1024 * 1024);
        if (document === null) {
          throw new ApiError('NOT_FOUND', { reason: 'document_missing' });
        }
        const parsed: unknown = JSON.parse(document.toString('utf8'));
        const entries =
          typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { entries?: unknown }).entries)
            ? (parsed as { entries: unknown[] }).entries
            : [];
        return reply
          .header('etag', weakEtag(source.version))
          .header('cache-control', 'private, no-store')
          .send({
            entries: entries.flatMap((entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as { question?: unknown }).question === 'string' &&
              typeof (entry as { answer?: unknown }).answer === 'string'
                ? [
                    {
                      question: (entry as { question: string }).question,
                      answer: (entry as { answer: string }).answer,
                    },
                  ]
                : [],
            ),
          });
      },
    );

    app.put(
      '/v1/knowledge-sources/:id/entries',
      { bodyLimit: 4 * 1024 * 1024, schema: { params: IdParams, body: EntriesBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        const expected = requireIfMatch(request);
        const current = await inTenant(services, actor, request, (trx) =>
          loadSource(trx, actor, request.params.id),
        );
        if (current.source_type !== 'FAQ' && current.source_type !== 'MANUAL_QA') {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'not_an_faq_source' });
        }
        const document = faqDocument(request.body.entries, current.language);
        const key = s3.tenantObjectKey(
          actor.tenantId,
          'knowledge',
          current.id,
          expected + 1,
          `faq-${createHash('sha256').update(document).digest('hex')}.json`,
        );
        await deps.objects.putUpload(key, document, 'application/json');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.replace_entries',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            if (source.version !== expected) {
              throw new ApiError('VERSION_CONFLICT', { current_version: source.version });
            }
            if (source.status === 'ARCHIVED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: source.status });
            }
            const row = await trx
              .updateTable('knowledge_sources')
              .set({
                storage_key: key,
                size_bytes: String(document.length),
                status: 'QUEUED',
                last_error_code: null,
                version: source.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await queueIngestion(trx, actor, row, request.traceId, 'entries_replaced');
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.entries_replaced',
              objectType: 'knowledge_source',
              objectId: row.id,
              metadata: { entries: request.body.entries.length },
            });
            return {
              status: 202,
              body: presentKnowledgeSource(row),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.post(
      '/v1/knowledge-sources/:id/sync',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.sync',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            if (source.source_type !== 'URL' && source.source_type !== 'WEBSITE') {
              throw new ApiError('INVALID_STATE_TRANSITION', {
                reason: 'only_remote_sources_sync',
              });
            }
            if (!REFRESHABLE_STATUSES.has(source.status)) {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: source.status });
            }
            const row = await trx
              .updateTable('knowledge_sources')
              .set({
                status: 'QUEUED',
                last_error_code: null,
                version: source.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await queueIngestion(trx, actor, row, request.traceId, 'manual_sync');
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.sync_requested',
              objectType: 'knowledge_source',
              objectId: row.id,
            });
            return {
              status: 202,
              body: presentKnowledgeSource(row),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.patch(
      '/v1/knowledge-sources/:id',
      { schema: { params: IdParams, body: UpdateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        const expected = requireIfMatch(request);
        const body = request.body;
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.update',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            if (source.version !== expected) {
              throw new ApiError('VERSION_CONFLICT', { current_version: source.version });
            }
            const validTo =
              body.valid_to === undefined
                ? source.valid_to
                : body.valid_to === null
                  ? null
                  : new Date(body.valid_to);
            if (
              validTo !== null &&
              source.valid_from !== null &&
              validTo.getTime() <= source.valid_from.getTime()
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/valid_to', rule: 'after_valid_from' }],
              });
            }
            const row = await trx
              .updateTable('knowledge_sources')
              .set({
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.acl === undefined ? {} : { acl: body.acl }),
                ...(body.freshness_ttl_hours === undefined
                  ? {}
                  : { freshness_ttl_hours: body.freshness_ttl_hours }),
                valid_to: validTo,
                version: source.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            if (body.acl !== undefined) {
              await trx
                .updateTable('knowledge_chunks')
                .set({ acl: body.acl })
                .where('source_id', '=', source.id)
                .execute();
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.updated',
              objectType: 'knowledge_source',
              objectId: row.id,
              diff: body,
              metadata: { fields: Object.keys(body) },
            });
            return {
              status: 200,
              body: presentKnowledgeSource(row),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.post(
      '/v1/knowledge-sources/:id/archive',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'knowledge:write');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'knowledge_sources.archive',
          async (trx) => {
            const source = await loadSource(trx, actor, request.params.id, true);
            if (source.status === 'ARCHIVED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { status: source.status });
            }
            await trx
              .updateTable('knowledge_chunks')
              .set({ is_active: false })
              .where('source_id', '=', source.id)
              .where('is_active', '=', true)
              .execute();
            await trx
              .updateTable('knowledge_source_versions')
              .set({ status: 'ARCHIVED', deactivated_at: new Date(), updated_at: new Date() })
              .where('source_id', '=', source.id)
              .where('status', 'not in', ['ARCHIVED', 'FAILED', 'QUARANTINED', 'SUPERSEDED'])
              .execute();
            const row = await trx
              .updateTable('knowledge_sources')
              .set({
                status: 'ARCHIVED',
                active_version_id: null,
                version: source.version + 1,
                updated_at: new Date(),
              })
              .where('id', '=', source.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'knowledge_source.archived',
              objectType: 'knowledge_source',
              objectId: row.id,
            });
            return {
              status: 200,
              body: presentKnowledgeSource(row),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );
  };
}
