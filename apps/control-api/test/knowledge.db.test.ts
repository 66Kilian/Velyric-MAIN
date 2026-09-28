import { createHash, randomUUID } from 'node:crypto';
import type { ServiceScope } from '@velyric/security';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();

let tenant: SeededTenant;

interface Source {
  id: string;
  status: string;
  version: number;
  storage_key?: string;
  active_version_id: string | null;
  upload?: { url: string; method: string; headers: Record<string, string> };
  versions?: { id: string; status: string; chunk_count: number }[];
}

function headers(
  user: TestUser = tenant.owner,
  extra: Record<string, string> = {},
): Record<string, string> {
  return browserHeaders(user, tenant.tenantId, {
    'idempotency-key': `kn-${randomUUID()}`,
    ...extra,
  });
}

async function internal(
  method: 'GET' | 'POST',
  url: string,
  scopes: readonly ServiceScope[],
  payload?: unknown,
  tenantId: string = tenant.tenantId,
) {
  const token = await harness().serviceToken(scopes, tenantId);
  return harness().internal.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function embedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, index) =>
    Number((Math.sin(seed * (index + 1)) / 2).toFixed(6)),
  );
}

function chunk(
  index: number,
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chunk_index: index,
    content,
    token_count: Math.max(1, Math.ceil(content.length / 4)),
    language: 'hu',
    heading_path: ['Rendelési idő'],
    metadata: { page: index + 1 },
    pii_flags: [],
    ...(harness().vectorSearch ? { embedding: embedding(index + 1) } : {}),
    ...extra,
  };
}

async function outboxTypes(sourceId: string): Promise<string[]> {
  const rows = await harness().admin.query<{ event_type: string }>(
    `SELECT event_type FROM app.outbox_events WHERE tenant_id = $1 AND payload->>'source_id' = $2 ORDER BY occurred_at, id`,
    [tenant.tenantId, sourceId],
  );
  return rows.rows.map((row) => row.event_type);
}

async function sourceRow(id: string): Promise<{
  status: string;
  version: number;
  active_version_id: string | null;
  storage_key: string | null;
  last_error_code: string | null;
}> {
  const rows = await harness().admin.query(
    'SELECT status, version, active_version_id, storage_key, last_error_code FROM app.knowledge_sources WHERE id = $1',
    [id],
  );
  return rows.rows[0] as {
    status: string;
    version: number;
    active_version_id: string | null;
    storage_key: string | null;
    last_error_code: string | null;
  };
}

async function ingest(
  sourceId: string,
  sourceVersion: number,
  contentSha: string,
  chunks: Record<string, unknown>[],
  extractedLocationFacts?: Record<string, unknown>,
): Promise<string> {
  const context = await internal(
    'GET',
    `/internal/v1/knowledge/ingestions/${sourceId}?source_version=${String(sourceVersion)}`,
    ['knowledge.ingest'],
  );
  expect(context.statusCode, context.body).toBe(200);
  const version = await internal(
    'POST',
    `/internal/v1/knowledge/ingestions/${sourceId}/versions`,
    ['knowledge.ingest'],
    {
      source_version: sourceVersion,
      content_sha256: contentSha,
      malware_scan_result: 'CLEAN',
      parser: 'pdfplumber',
      ocr_used: false,
      pii_findings: [],
    },
  );
  expect(version.statusCode, version.body).toBe(201);
  const versionId = version.json<{ version_id: string }>().version_id;
  const stored = await internal(
    'POST',
    `/internal/v1/knowledge/versions/${versionId}/chunks`,
    ['knowledge.ingest'],
    { embedding_model: 'text-embedding-3-small', chunks },
  );
  expect(stored.statusCode, stored.body).toBe(200);
  const complete = await internal(
    'POST',
    `/internal/v1/knowledge/versions/${versionId}/complete`,
    ['knowledge.ingest'],
    {
      chunk_count: chunks.length,
      ...(extractedLocationFacts === undefined
        ? {}
        : { extracted_location_facts: extractedLocationFacts }),
    },
  );
  expect(complete.statusCode, complete.body).toBe(200);
  return versionId;
}

async function search(
  query: string,
  extra: Record<string, unknown> = {},
): Promise<{ mode: string; results: { chunk_id: string; source_id: string; content: string }[] }> {
  const response = await internal('POST', '/internal/v1/knowledge/search', ['knowledge.retrieve'], {
    query,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

describe('knowledge sources', () => {
  it('ingests an uploaded PDF end to end and serves it through retrieval', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7 Rendelési idő: hétfőtől péntekig 8 és 18 óra között. Parkolás az udvarban ingyenes.',
    );
    const sha = createHash('sha256').update(pdf).digest('hex');
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'FILE_PDF',
        title: 'Házirend',
        size_bytes: pdf.length,
        sha256: sha,
        language: 'hu',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source>();
    expect(source).toMatchObject({
      status: 'PENDING_UPLOAD',
      version: 1,
      upload: {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) },
      },
    });
    const key = (await sourceRow(source.id)).storage_key ?? '';
    expect(key).toBe(`tenants/${tenant.tenantId}/knowledge/${source.id}/v1/upload-${sha}.pdf`);

    const early = await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/upload-complete`,
      headers: headers(),
    });
    expect(early.statusCode).toBe(428);
    harness().objects.simulateClientUpload(key, pdf, 'application/pdf');
    const completed = await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/upload-complete`,
      headers: headers(),
    });
    expect(completed.statusCode, completed.body).toBe(202);
    expect(completed.json<Source>().status).toBe('QUEUED');
    expect(await outboxTypes(source.id)).toEqual(['knowledge.ingestion_requested']);

    const context = await internal(
      'GET',
      `/internal/v1/knowledge/ingestions/${source.id}?source_version=1`,
      ['knowledge.ingest'],
    );
    expect(context.json()).toMatchObject({
      source: { id: source.id, source_type: 'FILE_PDF', source_version: 1, language: 'hu' },
      fetch: { kind: 'OBJECT', expected_sha256: sha, size_bytes: pdf.length },
      embedding: {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        required: harness().vectorSearch,
      },
      active_content_sha256: null,
    });
    expect((await sourceRow(source.id)).status).toBe('SCANNING');

    const versionResponse = await internal(
      'POST',
      `/internal/v1/knowledge/ingestions/${source.id}/versions`,
      ['knowledge.ingest'],
      {
        source_version: 1,
        content_sha256: sha,
        malware_scan_result: 'CLEAN',
        parser: 'pdfplumber',
        ocr_used: false,
        pii_findings: [],
      },
    );
    expect(versionResponse.statusCode, versionResponse.body).toBe(201);
    const versionId = versionResponse.json<{ version_id: string }>().version_id;
    expect(harness().objects.knowledge.has(key)).toBe(true);
    const chunks = [
      chunk(0, 'Rendelési idő: hétfőtől péntekig 8 és 18 óra között.'),
      chunk(1, 'Parkolás az udvarban ingyenes, akadálymentes bejárat a kapunál.'),
    ];
    const first = await internal(
      'POST',
      `/internal/v1/knowledge/versions/${versionId}/chunks`,
      ['knowledge.ingest'],
      { embedding_model: 'text-embedding-3-small', chunks: chunks.slice(0, 1) },
    );
    expect(first.json()).toMatchObject({ accepted: 1, inserted: 1 });
    const retried = await internal(
      'POST',
      `/internal/v1/knowledge/versions/${versionId}/chunks`,
      ['knowledge.ingest'],
      { embedding_model: 'text-embedding-3-small', chunks },
    );
    expect(retried.json()).toMatchObject({ accepted: 2, inserted: 1 });
    const wrongCount = await internal(
      'POST',
      `/internal/v1/knowledge/versions/${versionId}/complete`,
      ['knowledge.ingest'],
      { chunk_count: 3 },
    );
    expect(wrongCount.statusCode).toBe(409);
    const activated = await internal(
      'POST',
      `/internal/v1/knowledge/versions/${versionId}/complete`,
      ['knowledge.ingest'],
      { chunk_count: 2 },
    );
    expect(activated.json()).toEqual({
      outcome: 'ACTIVATED',
      version_id: versionId,
      chunk_count: 2,
    });
    expect(await sourceRow(source.id)).toMatchObject({
      status: 'ACTIVE',
      active_version_id: versionId,
      last_error_code: null,
    });
    expect(await outboxTypes(source.id)).toEqual([
      'knowledge.ingestion_requested',
      'knowledge.ingestion_completed',
      'knowledge.source_activated',
    ]);

    const found = await search('parkolás udvarban');
    expect(found.mode).toBe('LEXICAL');
    expect(found.results[0]).toMatchObject({
      source_id: source.id,
      content: expect.stringContaining('Parkolás') as string,
    });
    if (harness().vectorSearch) {
      const hybrid = await search('parkolás', { embedding: embedding(2) });
      expect(hybrid.mode).toBe('HYBRID');
      expect(hybrid.results[0]?.content).toContain('Parkolás');
    }

    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/knowledge-sources/${source.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json<Source>().versions).toEqual([
      expect.objectContaining({ id: versionId, status: 'ACTIVE', chunk_count: 2 }),
    ]);

    const archived = await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/archive`,
      headers: headers(),
    });
    expect(archived.json<Source>()).toMatchObject({ status: 'ARCHIVED', active_version_id: null });
    expect(
      (await search('parkolás udvarban')).results.filter(
        (result) => result.source_id === source.id,
      ),
    ).toEqual([]);
  });

  it('refreshes remote sources, skips unchanged content and ignores superseded jobs', async () => {
    const blocked = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'URL',
        title: 'Belső wiki',
        uri: 'https://intranet.partner.test/wiki',
      },
    });
    expect(blocked.json()).toMatchObject({
      code: 'SSRF_BLOCKED',
      details: { reason: 'ADDRESS_NOT_PUBLIC' },
    });
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'URL',
        title: 'Árlista',
        uri: 'https://api.partner.test/arak#top',
        freshness_ttl_hours: 24,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source & { uri: string }>();
    expect(source).toMatchObject({ status: 'QUEUED', uri: 'https://api.partner.test/arak' });
    const context = await internal(
      'GET',
      `/internal/v1/knowledge/ingestions/${source.id}?source_version=1`,
      ['knowledge.ingest'],
    );
    expect(context.json()).toMatchObject({
      fetch: { kind: 'URL', uri: 'https://api.partner.test/arak' },
    });
    const sha = 'a'.repeat(64);
    const versionId = await ingest(source.id, 1, sha, [
      chunk(0, 'Konzultáció díja 25 000 Ft, kontroll vizsgálat 15 000 Ft.'),
    ]);

    const sync = await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/sync`,
      headers: headers(),
    });
    expect(sync.json<Source>()).toMatchObject({ status: 'QUEUED', version: 2 });
    const stale = await internal(
      'GET',
      `/internal/v1/knowledge/ingestions/${source.id}?source_version=1`,
      ['knowledge.ingest'],
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'superseded', current_version: 2 },
    });
    await internal('GET', `/internal/v1/knowledge/ingestions/${source.id}?source_version=2`, [
      'knowledge.ingest',
    ]);
    const unchanged = await internal(
      'POST',
      `/internal/v1/knowledge/ingestions/${source.id}/versions`,
      ['knowledge.ingest'],
      {
        source_version: 2,
        content_sha256: sha,
        malware_scan_result: 'CLEAN',
        parser: 'html',
        ocr_used: false,
        pii_findings: [],
      },
    );
    expect(unchanged.json()).toEqual({ outcome: 'UNCHANGED', version_id: versionId });
    expect(await sourceRow(source.id)).toMatchObject({
      status: 'ACTIVE',
      active_version_id: versionId,
    });

    await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/sync`,
      headers: headers(),
    });
    await internal('GET', `/internal/v1/knowledge/ingestions/${source.id}?source_version=3`, [
      'knowledge.ingest',
    ]);
    const failed = await internal(
      'POST',
      `/internal/v1/knowledge/ingestions/${source.id}/failures`,
      ['knowledge.ingest'],
      { source_version: 3, error_code: 'fetch_http_503', retryable: true },
    );
    expect(failed.json()).toEqual({ outcome: 'FAILED', still_serving_version_id: versionId });
    expect(
      (await search('kontroll vizsgálat')).results.map((result) => result.source_id),
    ).toContain(source.id);
  });

  it('quarantines infected uploads and never activates them', async () => {
    const body = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const sha = createHash('sha256').update(body).digest('hex');
    const created = (
      await harness().app.inject({
        method: 'POST',
        url: '/v1/knowledge-sources',
        headers: headers(),
        payload: { source_type: 'FILE_TXT', title: 'Gyanús', size_bytes: body.length, sha256: sha },
      })
    ).json<Source>();
    const key = (await sourceRow(created.id)).storage_key ?? '';
    harness().objects.simulateClientUpload(key, body, 'text/plain');
    await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${created.id}/upload-complete`,
      headers: headers(),
    });
    await internal('GET', `/internal/v1/knowledge/ingestions/${created.id}?source_version=1`, [
      'knowledge.ingest',
    ]);
    const scanned = await internal(
      'POST',
      `/internal/v1/knowledge/ingestions/${created.id}/versions`,
      ['knowledge.ingest'],
      {
        source_version: 1,
        content_sha256: sha,
        malware_scan_result: 'INFECTED',
        parser: 'clamav',
        ocr_used: false,
        pii_findings: [],
      },
    );
    expect(scanned.json()).toMatchObject({ outcome: 'QUARANTINED' });
    expect(harness().objects.knowledge.has(key)).toBe(false);
    expect(await sourceRow(created.id)).toMatchObject({
      status: 'QUARANTINED',
      active_version_id: null,
      last_error_code: 'malware_detected',
    });
    expect(await outboxTypes(created.id)).toEqual([
      'knowledge.ingestion_requested',
      'knowledge.ingestion_failed',
    ]);
  });

  it('stores FAQ entries as a document, filters by ACL and enforces permissions and service scopes', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'FAQ',
        title: 'Belső GYIK',
        language: 'hu',
        acl: ['staff'],
        entries: [{ question: 'Hol a kulcs?', answer: 'A recepciós széf felső polcán.' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source>();
    const key = (await sourceRow(source.id)).storage_key ?? '';
    expect(JSON.parse(harness().objects.transient.get(key)?.body.toString('utf8') ?? '{}')).toEqual(
      {
        format: 'velyric.faq.v1',
        language: 'hu',
        entries: [{ question: 'Hol a kulcs?', answer: 'A recepciós széf felső polcán.' }],
      },
    );
    await ingest(
      source.id,
      1,
      createHash('sha256')
        .update(harness().objects.transient.get(key)?.body ?? Buffer.alloc(0))
        .digest('hex'),
      [chunk(0, 'Kérdés: Hol a kulcs? Válasz: A recepciós széf felső polcán.')],
    );
    expect((await search('recepciós széf')).results).toEqual([]);
    expect(
      (await search('recepciós széf', { acl: ['staff'] })).results.map(
        (result) => result.source_id,
      ),
    ).toEqual([source.id]);

    const viewerUser = harness().sessions.issue(`viewer-${randomUUID().slice(0, 6)}@example.test`);
    const me = await harness().app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: browserHeaders(viewerUser),
    });
    await harness().admin.query(
      `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'VIEWER', 'ACTIVE')`,
      [tenant.tenantId, me.json<{ user: { id: string } }>().user.id],
    );
    const listed = await harness().app.inject({
      method: 'GET',
      url: '/v1/knowledge-sources?source_type=FAQ',
      headers: browserHeaders(viewerUser, tenant.tenantId),
    });
    expect(listed.json<{ data: Source[] }>().data.map((row) => row.id)).toContain(source.id);
    const denied = await harness().app.inject({
      method: 'POST',
      url: `/v1/knowledge-sources/${source.id}/archive`,
      headers: headers(viewerUser),
    });
    expect(denied.statusCode).toBe(403);

    const wrongScope = await internal(
      'GET',
      `/internal/v1/knowledge/ingestions/${source.id}?source_version=1`,
      ['knowledge.retrieve'],
    );
    expect(wrongScope.json()).toMatchObject({ code: 'SERVICE_SCOPE_MISSING' });
    const other = await seedRuntimeTenant(harness());
    const foreign = await internal(
      'POST',
      '/internal/v1/knowledge/search',
      ['knowledge.retrieve'],
      { query: 'recepciós széf', acl: ['staff'] },
      other.tenantId,
    );
    expect(foreign.json<{ results: unknown[] }>().results).toEqual([]);

    const replaced = await harness().app.inject({
      method: 'PUT',
      url: `/v1/knowledge-sources/${source.id}/entries`,
      headers: headers(tenant.owner, { 'if-match': 'W/"1"' }),
      payload: {
        entries: [
          { question: 'Hol a kulcs?', answer: 'A kulcs mostantól a kulcsszekrényben van.' },
        ],
      },
    });
    expect(replaced.statusCode, replaced.body).toBe(202);
    expect(replaced.json<Source>()).toMatchObject({ status: 'QUEUED', version: 2 });

    const loaded = await harness().app.inject({
      method: 'GET',
      url: `/v1/knowledge-sources/${source.id}/entries`,
      headers: browserHeaders(viewerUser, tenant.tenantId),
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.headers.etag).toBe('W/"2"');
    expect(loaded.json()).toEqual({
      entries: [{ question: 'Hol a kulcs?', answer: 'A kulcs mostantól a kulcsszekrényben van.' }],
    });
  });

  it('exposes the extracted chunk content for a knowledge source version', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'URL',
        title: 'Weboldal',
        uri: 'https://api.partner.test/hubertus',
        language: 'hu',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source>();
    const content = 'Nyitvatartás: hétfőtől péntekig 8-18 óráig.';
    const sha = createHash('sha256').update(content).digest('hex');
    const versionId = await ingest(source.id, 1, sha, [
      chunk(0, content, { heading_path: ['Nyitvatartás'] }),
    ]);

    const response = await harness().app.inject({
      method: 'GET',
      url: `/v1/knowledge-sources/${source.id}/versions/${versionId}/chunks`,
      headers: headers(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<{
        chunks: { content: string; heading_path: string[]; chunk_index: number }[];
      }>().chunks,
    ).toEqual([
      expect.objectContaining({ content, heading_path: ['Nyitvatartás'], chunk_index: 0 }),
    ]);

    const missingVersion = await harness().app.inject({
      method: 'GET',
      url: `/v1/knowledge-sources/${source.id}/versions/${randomUUID()}/chunks`,
      headers: headers(),
    });
    expect(missingVersion.statusCode).toBe(404);

    const other = await seedRuntimeTenant(harness());
    const crossTenant = await harness().app.inject({
      method: 'GET',
      url: `/v1/knowledge-sources/${source.id}/versions/${versionId}/chunks`,
      headers: browserHeaders(other.owner, other.tenantId),
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it('auto-applies extracted address and business hours to the tenant location', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'URL',
        title: 'Weboldal',
        uri: 'https://api.partner.test/hubertus2',
        language: 'hu',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source>();
    const content = 'Kapcsolat oldal tartalma.';
    const sha = createHash('sha256').update(content).digest('hex');
    await ingest(source.id, 1, sha, [chunk(0, content)], {
      address: { line1: 'Hubertusz út 1.', city: 'Sopron', postal_code: '9400' },
      business_hours: [
        { iso_weekday: 1, opens: '07:00', closes: '22:00' },
        { iso_weekday: 7, opens: '07:00', closes: '21:00' },
      ],
    });

    const row = await harness().admin.query<{
      address: { line1: string; city: string; postal_code: string };
      business_hours: { iso_weekday: number; opens: string; closes: string }[];
      version: number;
    }>('SELECT address, business_hours, version FROM app.locations WHERE id = $1', [
      tenant.locationId,
    ]);
    expect(row.rows[0]).toMatchObject({
      address: { line1: 'Hubertusz út 1.', city: 'Sopron', postal_code: '9400' },
      business_hours: [
        { iso_weekday: 1, opens: '07:00', closes: '22:00' },
        { iso_weekday: 7, opens: '07:00', closes: '21:00' },
      ],
    });
    expect(row.rows[0]?.version).toBeGreaterThan(1);
  });

  it('does not fail ingestion when extracted business hours are invalid', async () => {
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/knowledge-sources',
      headers: headers(),
      payload: {
        source_type: 'URL',
        title: 'Weboldal',
        uri: 'https://api.partner.test/hubertus3',
        language: 'hu',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json<Source>();
    const content = 'Kapcsolat oldal tartalma.';
    const sha = createHash('sha256').update(content).digest('hex');
    const before = await harness().admin.query<{ version: number }>(
      'SELECT version FROM app.locations WHERE id = $1',
      [tenant.locationId],
    );
    const versionId = await ingest(source.id, 1, sha, [chunk(0, content)], {
      business_hours: [{ iso_weekday: 1, opens: '22:00', closes: '07:00' }],
    });
    expect(versionId).toBeTruthy();
    const after = await harness().admin.query<{ version: number }>(
      'SELECT version FROM app.locations WHERE id = $1',
      [tenant.locationId],
    );
    expect(after.rows[0]?.version).toBe(before.rows[0]?.version);
  });
});
