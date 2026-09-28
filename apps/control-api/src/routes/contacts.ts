import type { CallerProfiles, PersonIdentities } from '@velyric/db';
import { sql, type Selectable } from 'kysely';
import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import {
  canonicalProfileId,
  identityHash,
  normalizeIdentity,
  type IdentityType,
} from '../contacts/identity.js';
import { ApiError } from '../errors.js';
import { appendOutbox, buildPage, readCursor, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { maskE164 } from './calls.js';
import { domainSubject, IdParams, iso, limitFromQuery, Uuid } from './common.js';

const UNMASKED_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'OPERATOR']);
const DSAR_DUE_DAYS = 30;

const ListQuery = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

const UpdateBody = Type.Object(
  {
    display_name: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
    ),
    preferred_language: Type.Optional(
      Type.Union([Type.Literal('hu'), Type.Literal('de'), Type.Literal('en'), Type.Null()]),
    ),
    memory_enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

const IdentityBody = Type.Object(
  {
    identity_type: Type.Union([
      Type.Literal('PHONE'),
      Type.Literal('EMAIL'),
      Type.Literal('EXTERNAL_ID'),
    ]),
    value: Type.String({ minLength: 3, maxLength: 254 }),
  },
  { additionalProperties: false },
);

const IdentityParams = Type.Object({ id: Uuid, identityId: Uuid }, { additionalProperties: false });
const MergeBody = Type.Object({ target_id: Uuid }, { additionalProperties: false });
const ErasureBody = Type.Object(
  {
    verification_method: Type.String({ minLength: 3, maxLength: 120 }),
    received_via: Type.Union([
      Type.Literal('PHONE'),
      Type.Literal('EMAIL'),
      Type.Literal('LETTER'),
      Type.Literal('IN_PERSON'),
      Type.Literal('DASHBOARD'),
    ]),
  },
  { additionalProperties: false },
);

function unmasked(actor: TenantActor): boolean {
  return actor.actorType === 'API_KEY' || (actor.role !== null && UNMASKED_ROLES.has(actor.role));
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function presentIdentity(
  row: Selectable<PersonIdentities>,
  actor: TenantActor,
): Record<string, unknown> {
  const visible = unmasked(actor)
    ? row.normalized_value
    : row.identity_type === 'PHONE'
      ? maskE164(row.normalized_value)
      : row.identity_type === 'EMAIL'
        ? maskEmail(row.normalized_value)
        : row.normalized_value;
  return {
    id: row.id,
    identity_type: row.identity_type,
    value: visible,
    verification_state: row.verification_state,
    source: row.source,
    confidence: Number(row.confidence),
    location_id: row.location_id,
    verified_at: iso(row.verified_at),
    last_confirmed_at: iso(row.last_confirmed_at),
    created_at: iso(row.created_at),
  };
}

function presentProfile(
  row: Selectable<CallerProfiles>,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: row.id,
    display_name: row.display_name,
    display_name_verification: row.display_name_verification,
    preferred_language: row.preferred_language,
    preferred_language_source: row.preferred_language_source,
    trust_level: row.trust_level,
    memory_enabled: row.memory_enabled,
    shared_phone_suspected: row.shared_phone_suspected,
    last_interaction_at: iso(row.last_interaction_at),
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...extra,
  };
}

async function loadProfile(
  trx: Trx,
  actor: TenantActor,
  id: string,
  lock = false,
): Promise<Selectable<CallerProfiles>> {
  let query = trx
    .selectFrom('caller_profiles')
    .selectAll()
    .where('id', '=', id)
    .where('merged_into_profile_id', 'is', null);
  if (lock) {
    query = query.forUpdate();
  }
  const row = await query.executeTakeFirst();
  if (row === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  if (actor.locationScope.length > 0) {
    const visible = await trx
      .selectFrom('calls')
      .select(['id'])
      .where('person_id', '=', row.id)
      .where('location_id', 'in', actor.locationScope)
      .limit(1)
      .executeTakeFirst();
    if (visible === undefined) {
      throw new ApiError('NOT_FOUND');
    }
  }
  return row;
}

async function lineage(trx: Trx, profileId: string): Promise<string[]> {
  const result = await sql<{ id: string }>`
    WITH RECURSIVE merged(id, depth) AS (
      SELECT ${profileId}::uuid, 0
      UNION ALL
      SELECT p.id, merged.depth + 1 FROM app.caller_profiles p JOIN merged ON p.merged_into_profile_id = merged.id WHERE merged.depth < 16
    )
    SELECT DISTINCT id FROM merged`.execute(trx);
  return result.rows.map((row) => row.id);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export const registerContactRoutes: RouteModule = (app, services) => {
  app.get('/v1/contacts', { schema: { querystring: ListQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'contacts:read');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const term = request.query.q?.trim();
    const { rows, identities } = await inTenant(services, actor, request, async (trx) => {
      let query = trx
        .selectFrom('caller_profiles as p')
        .selectAll('p')
        .select(sql<Date>`coalesce(p.last_interaction_at, p.created_at)`.as('sort_at'))
        .where('p.merged_into_profile_id', 'is', null)
        .orderBy('sort_at', 'desc')
        .orderBy('p.id', 'desc')
        .limit(limit + 1);
      if (term !== undefined && term !== '') {
        const pattern = `%${escapeLike(term.toLowerCase())}%`;
        query = query.where((eb) =>
          eb.or([
            sql<boolean>`lower(p.display_name) LIKE ${pattern} ESCAPE '\\'`,
            eb.exists(
              eb
                .selectFrom('person_identities as i')
                .select('i.id')
                .whereRef('i.person_id', '=', 'p.id')
                .where(sql<boolean>`lower(i.normalized_value) LIKE ${pattern} ESCAPE '\\'`),
            ),
          ]),
        );
      }
      if (actor.locationScope.length > 0) {
        query = query.where((eb) =>
          eb.exists(
            eb
              .selectFrom('calls as c')
              .select('c.id')
              .whereRef('c.person_id', '=', 'p.id')
              .where('c.location_id', 'in', actor.locationScope),
          ),
        );
      }
      if (cursor !== null) {
        const sortAt = new Date(String(cursor.k[0]));
        query = query.where(
          sql<boolean>`(coalesce(p.last_interaction_at, p.created_at), p.id) < (${sortAt}, ${cursor.id}::uuid)`,
        );
      }
      const found = await query.execute();
      const ids = found.map((row) => row.id);
      const identityRows =
        ids.length === 0
          ? []
          : await trx
              .selectFrom('person_identities')
              .selectAll()
              .where('person_id', 'in', ids)
              .orderBy('created_at')
              .execute();
      return { rows: found, identities: identityRows };
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [new Date(row.sort_at).toISOString()], id: row.id }),
      (row) =>
        presentProfile(row, {
          identities: identities
            .filter((identity) => identity.person_id === row.id)
            .map((identity) => presentIdentity(identity, actor)),
        }),
    );
  });

  app.get('/v1/contacts/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'contacts:read');
    const detail = await inTenant(services, actor, request, async (trx) => {
      const profile = await loadProfile(trx, actor, request.params.id);
      const personIds = await lineage(trx, profile.id);
      const [identities, calls, bookings, consents, waitlist, requests] = await Promise.all([
        trx
          .selectFrom('person_identities')
          .selectAll()
          .where('person_id', '=', profile.id)
          .orderBy('created_at')
          .execute(),
        trx
          .selectFrom('calls')
          .select([
            'id',
            'status',
            'channel',
            'direction',
            'intent',
            'outcome',
            'language',
            'started_at',
            'connected_seconds',
            'location_id',
          ])
          .where('person_id', '=', profile.id)
          .orderBy('started_at', 'desc')
          .limit(20)
          .execute(),
        trx
          .selectFrom('bookings')
          .select(['id', 'status', 'service_id', 'location_id', 'starts_at', 'ends_at', 'timezone'])
          .where('person_id', '=', profile.id)
          .orderBy('starts_at', 'desc')
          .limit(20)
          .execute(),
        trx
          .selectFrom('consent_ledger')
          .select([
            'id',
            'call_id',
            'channel',
            'disclosure_version',
            'disclosure_language',
            'disclosure_delivered_at',
            'recording_consent',
            'contact_consent',
          ])
          .where('person_id', 'in', personIds)
          .orderBy('disclosure_delivered_at', 'desc')
          .limit(20)
          .execute(),
        trx
          .selectFrom('waitlist_entries')
          .select(['id', 'status', 'service_id', 'location_id', 'expires_at', 'created_at'])
          .where('person_id', '=', profile.id)
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        trx
          .selectFrom('dsar_requests')
          .select(['id', 'request_type', 'status', 'due_at', 'created_at'])
          .where('person_id', '=', profile.id)
          .orderBy('created_at', 'desc')
          .limit(10)
          .execute(),
      ]);
      return { profile, identities, calls, bookings, consents, waitlist, requests };
    });
    return reply.header('etag', weakEtag(detail.profile.version)).send(
      presentProfile(detail.profile, {
        identities: detail.identities.map((identity) => presentIdentity(identity, actor)),
        calls: detail.calls.map((call) => ({
          ...call,
          started_at: iso(call.started_at),
          duration_seconds: call.connected_seconds,
        })),
        bookings: detail.bookings.map((booking) => ({
          ...booking,
          starts_at: iso(booking.starts_at),
          ends_at: iso(booking.ends_at),
        })),
        consents: detail.consents.map((consent) => ({
          ...consent,
          disclosure_delivered_at: iso(consent.disclosure_delivered_at),
        })),
        waitlist: detail.waitlist.map((entry) => ({
          ...entry,
          expires_at: iso(entry.expires_at),
          created_at: iso(entry.created_at),
        })),
        privacy_requests: detail.requests.map((entry) => ({
          ...entry,
          due_at: iso(entry.due_at),
          created_at: iso(entry.created_at),
        })),
      }),
    );
  });

  app.patch(
    '/v1/contacts/:id',
    { schema: { params: IdParams, body: UpdateBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'contacts:write');
      const expected = requireIfMatch(request);
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'contacts.update',
        async (trx) => {
          const profile = await loadProfile(trx, actor, request.params.id, true);
          if (profile.version !== expected) {
            throw new ApiError('VERSION_CONFLICT', { current_version: profile.version });
          }
          const row = await trx
            .updateTable('caller_profiles')
            .set({
              ...(body.display_name === undefined
                ? {}
                : {
                    display_name: body.display_name,
                    display_name_verification: body.display_name === null ? null : 'HUMAN_VERIFIED',
                  }),
              ...(body.preferred_language === undefined
                ? {}
                : {
                    preferred_language: body.preferred_language,
                    preferred_language_source:
                      body.preferred_language === null ? null : 'DASHBOARD',
                  }),
              ...(body.memory_enabled === undefined ? {} : { memory_enabled: body.memory_enabled }),
              version: profile.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', profile.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'contact.updated',
            objectType: 'caller_profile',
            objectId: row.id,
            metadata: { fields: Object.keys(body) },
          });
          return {
            status: 200,
            body: presentProfile(row),
            resource: { type: 'caller_profile', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/contacts/:id/identities',
    { schema: { params: IdParams, body: IdentityBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'contacts:write');
      const type: IdentityType = request.body.identity_type;
      const normalized = normalizeIdentity(type, request.body.value);
      if (
        (type === 'PHONE' && !/^\+[1-9][0-9]{6,14}$/.test(normalized)) ||
        (type === 'EMAIL' && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/.test(normalized))
      ) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/value', rule: type === 'PHONE' ? 'e164' : 'email' }],
        });
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'contacts.add_identity',
        async (trx) => {
          const profile = await loadProfile(trx, actor, request.params.id, true);
          const now = new Date();
          const row = await trx
            .insertInto('person_identities')
            .values({
              tenant_id: actor.tenantId,
              person_id: profile.id,
              identity_type: type,
              normalized_value: normalized,
              value_hash: identityHash(actor.tenantId, type, normalized),
              verification_state: 'HUMAN_VERIFIED',
              source: 'DASHBOARD',
              confidence: '1.000',
              verified_at: now,
              last_confirmed_at: now,
            })
            .onConflict((conflict) =>
              conflict.columns(['tenant_id', 'identity_type', 'normalized_value']).doNothing(),
            )
            .returningAll()
            .executeTakeFirst();
          if (row === undefined) {
            throw new ApiError('CONFLICT', { reason: 'identity_in_use' });
          }
          await trx
            .updateTable('caller_profiles')
            .set({ version: profile.version + 1, updated_at: now })
            .where('id', '=', profile.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'contact.identity_added',
            objectType: 'caller_profile',
            objectId: profile.id,
            metadata: { identity_type: type },
          });
          return {
            status: 201,
            body: presentIdentity(row, actor),
            resource: { type: 'person_identity', id: row.id },
          };
        },
      );
    },
  );

  app.delete(
    '/v1/contacts/:id/identities/:identityId',
    { schema: { params: IdentityParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'contacts:write');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'contacts.remove_identity',
        async (trx) => {
          const profile = await loadProfile(trx, actor, request.params.id, true);
          const removed = await trx
            .deleteFrom('person_identities')
            .where('id', '=', request.params.identityId)
            .where('person_id', '=', profile.id)
            .returning(['identity_type'])
            .executeTakeFirst();
          if (removed === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          await trx
            .updateTable('caller_profiles')
            .set({ version: profile.version + 1, updated_at: new Date() })
            .where('id', '=', profile.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'contact.identity_removed',
            objectType: 'caller_profile',
            objectId: profile.id,
            metadata: { identity_type: removed.identity_type },
          });
          return {
            status: 200,
            body: { id: request.params.identityId, removed: true },
            resource: { type: 'person_identity', id: request.params.identityId },
          };
        },
      );
    },
  );

  app.post(
    '/v1/contacts/:id/merge',
    { schema: { params: IdParams, body: MergeBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'contacts:write');
      if (request.params.id === request.body.target_id) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/target_id', rule: 'different_contact' }],
        });
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'contacts.merge',
        async (trx) => {
          const source = await loadProfile(trx, actor, request.params.id, true);
          const target = await loadProfile(
            trx,
            actor,
            await canonicalProfileId(trx, request.body.target_id),
            true,
          );
          if (target.id === source.id) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/target_id', rule: 'different_contact' }],
            });
          }
          const identities = await trx
            .selectFrom('person_identities')
            .select(['identity_type'])
            .where('person_id', '=', source.id)
            .execute();
          for (const table of [
            'person_identities',
            'calls',
            'bookings',
            'waitlist_entries',
            'dsar_requests',
          ] as const) {
            await trx
              .updateTable(table)
              .set({ person_id: target.id })
              .where('person_id', '=', source.id)
              .execute();
          }
          const now = new Date();
          await trx
            .updateTable('caller_profiles')
            .set({
              display_name: target.display_name ?? source.display_name,
              preferred_language: target.preferred_language ?? source.preferred_language,
              last_interaction_at:
                [target.last_interaction_at, source.last_interaction_at]
                  .filter((value): value is Date => value !== null)
                  .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
              version: target.version + 1,
              updated_at: now,
            })
            .where('id', '=', target.id)
            .execute();
          await trx
            .updateTable('caller_profiles')
            .set({
              merged_into_profile_id: target.id,
              version: source.version + 1,
              updated_at: now,
            })
            .where('id', '=', source.id)
            .execute();
          await trx
            .insertInto('identity_merge_events')
            .values({
              tenant_id: actor.tenantId,
              source_person_id: source.id,
              target_person_id: target.id,
              merge_kind: 'MANUAL',
              matched_keys: [...new Set(identities.map((identity) => identity.identity_type))],
              confidence: '1.000',
              actor_type: actor.actorType,
              actor_id: actor.actorId,
            })
            .execute();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'contact.merged',
            subject: domainSubject(actor.tenantId, 'contact.merged'),
            payload: {
              tenant_id: actor.tenantId,
              source_person_id: source.id,
              target_person_id: target.id,
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'contact.merged',
            objectType: 'caller_profile',
            objectId: target.id,
            metadata: { source_person_id: source.id },
          });
          return {
            status: 200,
            body: { id: target.id, merged_from: source.id },
            resource: { type: 'caller_profile', id: target.id },
          };
        },
      );
    },
  );

  app.get('/v1/contacts/:id/export', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'contacts:export');
    const exported = await inTenant(services, actor, request, async (trx) => {
      const profile = await loadProfile(trx, actor, request.params.id);
      const personIds = await lineage(trx, profile.id);
      const [identities, calls, bookings, consents, waitlist] = await Promise.all([
        trx
          .selectFrom('person_identities')
          .select([
            'identity_type',
            'normalized_value',
            'verification_state',
            'source',
            'verified_at',
            'created_at',
          ])
          .where('person_id', '=', profile.id)
          .execute(),
        trx
          .selectFrom('calls')
          .select([
            'id',
            'channel',
            'direction',
            'language',
            'intent',
            'outcome',
            'started_at',
            'ended_at',
            'summary',
          ])
          .where('person_id', '=', profile.id)
          .orderBy('started_at')
          .execute(),
        trx
          .selectFrom('bookings')
          .select([
            'id',
            'status',
            'starts_at',
            'ends_at',
            'timezone',
            'party_size',
            'customer_note',
            'created_at',
          ])
          .where('person_id', '=', profile.id)
          .orderBy('starts_at')
          .execute(),
        trx
          .selectFrom('consent_ledger')
          .select([
            'call_id',
            'channel',
            'disclosure_version',
            'disclosure_language',
            'disclosure_delivered_at',
            'recording_consent',
            'contact_consent',
          ])
          .where('person_id', 'in', personIds)
          .execute(),
        trx
          .selectFrom('waitlist_entries')
          .select(['id', 'status', 'party_size', 'contact_channel', 'expires_at', 'created_at'])
          .where('person_id', '=', profile.id)
          .execute(),
      ]);
      const transcripts =
        calls.length === 0
          ? []
          : await trx
              .selectFrom('transcript_segments')
              .select(['call_id', 'seq', 'speaker', 'content'])
              .where(
                'call_id',
                'in',
                calls.map((call) => call.id),
              )
              .where('redaction_state', '<>', 'PURGED')
              .orderBy('call_id')
              .orderBy('seq')
              .execute();
      await writeAudit(trx, actor, requestMeta(request), {
        action: 'contact.exported',
        objectType: 'caller_profile',
        objectId: profile.id,
        metadata: { calls: calls.length, bookings: bookings.length },
      });
      return { profile, identities, calls, bookings, consents, waitlist, transcripts };
    });
    return reply
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="contact-${exported.profile.id}.json"`)
      .send({
        format: 'velyric.contact_export.v1',
        exported_at: new Date().toISOString(),
        profile: presentProfile(exported.profile),
        identities: exported.identities.map((identity) => ({
          ...identity,
          verified_at: iso(identity.verified_at),
          created_at: iso(identity.created_at),
        })),
        calls: exported.calls.map((call) => ({
          ...call,
          started_at: iso(call.started_at),
          ended_at: iso(call.ended_at),
          transcript: exported.transcripts
            .filter((segment) => segment.call_id === call.id)
            .map((segment) => ({
              seq: segment.seq,
              speaker: segment.speaker,
              content: segment.content,
            })),
        })),
        bookings: exported.bookings.map((booking) => ({
          ...booking,
          starts_at: iso(booking.starts_at),
          ends_at: iso(booking.ends_at),
          created_at: iso(booking.created_at),
        })),
        consents: exported.consents.map((consent) => ({
          ...consent,
          disclosure_delivered_at: iso(consent.disclosure_delivered_at),
        })),
        waitlist: exported.waitlist.map((entry) => ({
          ...entry,
          expires_at: iso(entry.expires_at),
          created_at: iso(entry.created_at),
        })),
      });
  });

  app.post(
    '/v1/contacts/:id/erasure',
    { schema: { params: IdParams, body: ErasureBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'contacts:delete');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'contacts.erasure',
        async (trx) => {
          const profile = await loadProfile(trx, actor, request.params.id, true);
          const open = await trx
            .selectFrom('dsar_requests')
            .select(['id'])
            .where('person_id', '=', profile.id)
            .where('request_type', '=', 'DELETE')
            .where('status', 'in', ['RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'ON_LEGAL_HOLD'])
            .executeTakeFirst();
          if (open !== undefined) {
            throw new ApiError('CONFLICT', {
              reason: 'erasure_already_requested',
              request_id: open.id,
            });
          }
          const hold = await trx
            .selectFrom('legal_holds')
            .select(['id'])
            .where('released_at', 'is', null)
            .where((eb) =>
              eb.or([
                eb('scope_type', '=', 'TENANT'),
                eb.and([eb('scope_type', '=', 'PERSON'), eb('scope_ref', '=', profile.id)]),
              ]),
            )
            .executeTakeFirst();
          const now = new Date();
          const row = await trx
            .insertInto('dsar_requests')
            .values({
              tenant_id: actor.tenantId,
              person_id: profile.id,
              request_type: 'DELETE',
              status: hold === undefined ? 'IN_PROGRESS' : 'ON_LEGAL_HOLD',
              received_via: request.body.received_via,
              verification_method: request.body.verification_method,
              verified_at: now,
              legal_hold_id: hold?.id ?? null,
              due_at: new Date(now.getTime() + DSAR_DUE_DAYS * 86_400_000),
              created_by: actor.actorId,
            })
            .returning(['id', 'status', 'due_at'])
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'privacy.request_created',
            subject: domainSubject(actor.tenantId, 'privacy.request_created'),
            payload: {
              tenant_id: actor.tenantId,
              request_id: row.id,
              request_type: 'DELETE',
              person_id: profile.id,
              status: row.status,
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'contact.erasure_requested',
            objectType: 'caller_profile',
            objectId: profile.id,
            metadata: { request_id: row.id, on_legal_hold: hold !== undefined },
          });
          return {
            status: 202,
            body: { id: row.id, status: row.status, due_at: iso(row.due_at) },
            resource: { type: 'dsar_request', id: row.id },
          };
        },
      );
    },
  );
};
