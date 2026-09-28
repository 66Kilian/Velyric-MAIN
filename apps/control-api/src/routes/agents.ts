import { AgentConfigSchema, VerticalPack, type AgentConfig } from '@velyric/contracts';
import { ensureBuiltInTools, type AgentVersions, type Agents } from '@velyric/db';
import { agentConfigIssues, type ToolCatalogEntry } from '@velyric/domain';
import { sha256Hex } from '@velyric/security';
import type { Selectable } from 'kysely';
import Type from 'typebox';
import { Value } from 'typebox/value';
import {
  assertKillSwitchReleased,
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import {
  appendOutbox,
  buildPage,
  canonicalJson,
  newId,
  readCursor,
  writeAudit,
  type Trx,
} from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso, limitFromQuery, PageQuery, Uuid } from './common.js';

const VERTICAL_PACKS: ReadonlySet<string> = new Set(Object.values(VerticalPack));

const CreateAgentBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    location_id: Type.Optional(Uuid),
    vertical_pack: Type.Optional(Type.String({ pattern: '^[A-Z_]{3,20}$' })),
  },
  { additionalProperties: false },
);

const UpdateAgentBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('PAUSED'), Type.Literal('ARCHIVED')]),
    ),
    location_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);

const CreateVersionBody = Type.Object(
  {
    config: AgentConfigSchema,
    change_summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    based_on_version_id: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

const PublishBody = Type.Object(
  { rollout_percent: Type.Integer({ minimum: 1, maximum: 100 }) },
  { additionalProperties: false },
);

const RollbackBody = Type.Object(
  { reason: Type.String({ minLength: 5, maxLength: 500 }) },
  { additionalProperties: false },
);

export function presentAgent(row: Selectable<Agents>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    location_id: row.location_id,
    vertical_pack: row.vertical_pack,
    production_version_id: row.production_version_id,
    canary_version_id: row.canary_version_id,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function presentVersion(
  row: Selectable<AgentVersions>,
  includeConfig: boolean,
): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agent_id,
    version_number: row.version_number,
    status: row.status,
    config_hash: row.config_hash,
    schema_version: row.schema_version,
    rollout_percent: row.rollout_percent,
    change_summary: row.change_summary,
    based_on_version_id: row.based_on_version_id,
    simulation_run_id: row.simulation_run_id,
    published_at: iso(row.published_at),
    superseded_at: iso(row.superseded_at),
    rolled_back_at: iso(row.rolled_back_at),
    created_at: iso(row.created_at),
    ...(includeConfig ? { config: row.config } : {}),
  };
}

function configValidationError(issues: readonly { path: string; rule: string }[]): ApiError {
  return new ApiError('VALIDATION_FAILED', {
    issues: issues
      .slice(0, 50)
      .map((issue) => ({ path: `/body/config${issue.path}`, rule: issue.rule })),
  });
}

async function toolCatalog(trx: Trx, tenantId: string): Promise<Map<string, ToolCatalogEntry>> {
  await ensureBuiltInTools(trx, tenantId);
  const tools = await trx
    .selectFrom('tool_definitions')
    .select(['name', 'side_effect_class', 'status'])
    .execute();
  return new Map(
    tools.map((tool) => [
      tool.name,
      {
        name: tool.name,
        sideEffectClass: tool.side_effect_class as ToolCatalogEntry['sideEffectClass'],
        status: tool.status as ToolCatalogEntry['status'],
      },
    ]),
  );
}

async function assertReleaseGatePassed(
  trx: Trx,
  agentId: string,
  versionId: string,
): Promise<void> {
  const suites = await trx
    .selectFrom('simulation_suites')
    .select(['id', 'name'])
    .where('agent_id', '=', agentId)
    .where('is_release_gate', '=', true)
    .execute();
  if (suites.length === 0) {
    throw new ApiError('SIMULATION_GATE_FAILED', { reason: 'no_release_gate_suite' });
  }
  const passed = await trx
    .selectFrom('simulation_runs')
    .select(['suite_id'])
    .where('agent_version_id', '=', versionId)
    .where('status', '=', 'PASSED')
    .where('gate_passed', '=', true)
    .where(
      'suite_id',
      'in',
      suites.map((suite) => suite.id),
    )
    .execute();
  const passedIds = new Set(passed.map((run) => run.suite_id));
  const missing = suites.filter((suite) => !passedIds.has(suite.id)).map((suite) => suite.name);
  if (missing.length > 0) {
    throw new ApiError('SIMULATION_GATE_FAILED', {
      reason: 'release_gate_not_passed',
      missing_suites: missing,
    });
  }
}

async function loadVersionForUpdate(
  trx: Trx,
  versionId: string,
): Promise<Selectable<AgentVersions>> {
  const version = await trx
    .selectFrom('agent_versions')
    .selectAll()
    .where('id', '=', versionId)
    .forUpdate()
    .executeTakeFirst();
  if (version === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return version;
}

async function loadAgentForUpdate(trx: Trx, agentId: string): Promise<Selectable<Agents>> {
  const agent = await trx
    .selectFrom('agents')
    .selectAll()
    .where('id', '=', agentId)
    .forUpdate()
    .executeTakeFirst();
  if (agent === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return agent;
}

function killSwitchScopes(
  actor: TenantActor,
  agentId: string,
): { scopeType: string; scopeRef: string }[] {
  return [
    { scopeType: 'TENANT', scopeRef: actor.tenantId },
    { scopeType: 'AGENT', scopeRef: agentId },
  ];
}

export const registerAgentRoutes: RouteModule = (app, services) => {
  app.get('/v1/agents', { schema: { querystring: PageQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'agents:read');
    const limit = limitFromQuery(request.query.limit);
    const cursor = readCursor(request.query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let query = trx
        .selectFrom('agents')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (cursor !== null) {
        const createdAt = new Date(String(cursor.k[0]));
        query = query.where((eb) =>
          eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(createdAt, cursor.id)),
        );
      }
      if (actor.locationScope.length > 0) {
        query = query.where('location_id', 'in', actor.locationScope);
      }
      return query.execute();
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
      presentAgent,
    );
  });

  app.post('/v1/agents', { schema: { body: CreateAgentBody } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'agents:write');
    const body = request.body;
    if (body.vertical_pack !== undefined && !VERTICAL_PACKS.has(body.vertical_pack)) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: '/body/vertical_pack', rule: 'enum' }],
      });
    }
    return idempotentWrite(
      request,
      reply,
      services,
      tenantContext(actor, request),
      { tenantId: actor.tenantId, userId: null },
      'agents.create',
      async (trx) => {
        const agentId = newId();
        const agent = await trx
          .insertInto('agents')
          .values({
            id: agentId,
            tenant_id: actor.tenantId,
            name: body.name,
            location_id: body.location_id ?? null,
            vertical_pack: body.vertical_pack ?? 'GENERAL',
            status: 'DRAFT',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'agent.created',
          objectType: 'agent',
          objectId: agentId,
          diff: body,
        });
        return {
          status: 201,
          body: presentAgent(agent),
          resource: { type: 'agent', id: agentId },
          headers: { etag: weakEtag(agent.version) },
        };
      },
    );
  });

  app.get('/v1/agents/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'agents:read');
    const result = await inTenant(services, actor, request, async (trx) => {
      const agent = await trx
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (agent === undefined) {
        return null;
      }
      const activeIds = [agent.production_version_id, agent.canary_version_id].filter(
        (id): id is string => id !== null,
      );
      const versions =
        activeIds.length === 0
          ? []
          : await trx
              .selectFrom('agent_versions')
              .selectAll()
              .where('id', 'in', activeIds)
              .execute();
      return { agent, versions };
    });
    if (
      result === null ||
      (actor.locationScope.length > 0 &&
        !actor.locationScope.includes(result.agent.location_id ?? ''))
    ) {
      throw new ApiError('NOT_FOUND');
    }
    const byId = new Map(result.versions.map((version) => [version.id, version]));
    const production =
      result.agent.production_version_id === null
        ? undefined
        : byId.get(result.agent.production_version_id);
    const canary =
      result.agent.canary_version_id === null
        ? undefined
        : byId.get(result.agent.canary_version_id);
    return reply.header('etag', weakEtag(result.agent.version)).send({
      ...presentAgent(result.agent),
      production_version: production === undefined ? null : presentVersion(production, false),
      canary_version: canary === undefined ? null : presentVersion(canary, false),
    });
  });

  app.patch(
    '/v1/agents/:id',
    { schema: { params: IdParams, body: UpdateAgentBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'agents:write');
      const expectedVersion = requireIfMatch(request);
      const body = request.body;
      const updated = await inTenant(services, actor, request, async (trx) => {
        const row = await trx
          .updateTable('agents')
          .set((eb) => ({
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.status === undefined ? {} : { status: body.status }),
            ...(body.location_id === undefined ? {} : { location_id: body.location_id }),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', request.params.id)
          .where('version', '=', expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) {
          const current = await trx
            .selectFrom('agents')
            .select(['version'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          throw current === undefined
            ? new ApiError('NOT_FOUND')
            : new ApiError('VERSION_CONFLICT', { current_version: current.version });
        }
        if (body.status === 'ACTIVE' && row.production_version_id === null) {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'no_production_version' });
        }
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'agent.updated',
          objectType: 'agent',
          objectId: row.id,
          diff: body,
        });
        return row;
      });
      return reply.header('etag', weakEtag(updated.version)).send(presentAgent(updated));
    },
  );

  app.get(
    '/v1/agents/:id/versions',
    { schema: { params: IdParams, querystring: PageQuery } },
    async (request) => {
      const actor = requireTenantActor(request.principal, 'agents:read');
      const limit = limitFromQuery(request.query.limit);
      const cursor = readCursor(request.query.cursor, services.cursorKey);
      const rows = await inTenant(services, actor, request, (trx) => {
        let query = trx
          .selectFrom('agent_versions')
          .selectAll()
          .where('agent_id', '=', request.params.id)
          .orderBy('version_number', 'desc')
          .limit(limit + 1);
        if (cursor !== null) {
          query = query.where('version_number', '<', Number(cursor.k[0]));
        }
        return query.execute();
      });
      return buildPage(
        rows,
        limit,
        services.cursorKey,
        (row) => ({ v: 1, k: [row.version_number], id: row.id }),
        (row) => presentVersion(row, false),
      );
    },
  );

  app.get('/v1/agent-versions/:id', { schema: { params: IdParams } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'agents:read');
    const version = await inTenant(services, actor, request, (trx) =>
      trx
        .selectFrom('agent_versions')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst(),
    );
    if (version === undefined) {
      throw new ApiError('NOT_FOUND');
    }
    return presentVersion(version, true);
  });

  app.post(
    '/v1/agents/:id/versions',
    { schema: { params: IdParams, body: CreateVersionBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'agents:write');
      const config: AgentConfig = request.body.config;
      const issues = agentConfigIssues(config, null);
      if (issues.length > 0) {
        throw configValidationError(issues);
      }
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'agent_versions.create',
        async (trx) => {
          const agent = await loadAgentForUpdate(trx, request.params.id);
          if (agent.status === 'ARCHIVED') {
            throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'agent_archived' });
          }
          if (request.body.based_on_version_id !== undefined) {
            const base = await trx
              .selectFrom('agent_versions')
              .select(['id'])
              .where('id', '=', request.body.based_on_version_id)
              .where('agent_id', '=', agent.id)
              .executeTakeFirst();
            if (base === undefined) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/based_on_version_id', rule: 'same_agent' }],
              });
            }
          }
          const latest = await trx
            .selectFrom('agent_versions')
            .select((eb) => eb.fn.max('version_number').as('max_version'))
            .where('agent_id', '=', agent.id)
            .executeTakeFirst();
          const versionNumber = (latest?.max_version ?? 0) + 1;
          const versionId = newId();
          const version = await trx
            .insertInto('agent_versions')
            .values({
              id: versionId,
              tenant_id: actor.tenantId,
              agent_id: agent.id,
              version_number: versionNumber,
              status: 'DRAFT',
              config: JSON.stringify(config),
              config_hash: sha256Hex(canonicalJson(config)),
              schema_version: config.schema_version,
              rollout_percent: 0,
              change_summary: request.body.change_summary ?? null,
              based_on_version_id: request.body.based_on_version_id ?? null,
              created_by_user_id: actor.userId ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'agent_version.created',
            objectType: 'agent_version',
            objectId: versionId,
            metadata: {
              agent_id: agent.id,
              version_number: versionNumber,
              config_hash: version.config_hash,
            },
          });
          return {
            status: 201,
            body: presentVersion(version, true),
            resource: { type: 'agent_version', id: versionId },
          };
        },
      );
    },
  );

  app.post(
    '/v1/agent-versions/:id/publish',
    { schema: { params: IdParams, body: PublishBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'agent_versions:publish');
      const rollout = request.body.rollout_percent;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'agent_versions.publish',
        async (trx) => {
          const version = await loadVersionForUpdate(trx, request.params.id);
          if (
            version.status !== 'DRAFT' &&
            version.status !== 'STAGING' &&
            version.status !== 'VALIDATION_FAILED'
          ) {
            throw new ApiError('INVALID_STATE_TRANSITION', { status: version.status });
          }
          const agent = await loadAgentForUpdate(trx, version.agent_id);
          await assertKillSwitchReleased(
            trx,
            'kill.agent_publish',
            killSwitchScopes(actor, agent.id),
          );
          if (!Value.Check(AgentConfigSchema, version.config)) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/config', rule: 'schema' }],
            });
          }
          const config = version.config;
          const issues = agentConfigIssues(config, await toolCatalog(trx, actor.tenantId));
          if (issues.length > 0) {
            throw configValidationError(issues);
          }
          await assertReleaseGatePassed(trx, agent.id, version.id);
          if (rollout < 100 && agent.production_version_id === null) {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              reason: 'canary_requires_production_version',
            });
          }
          const now = services.now();
          if (rollout === 100) {
            await trx
              .updateTable('agent_versions')
              .set({ status: 'SUPERSEDED', superseded_at: now })
              .where('agent_id', '=', agent.id)
              .where('status', 'in', ['PRODUCTION', 'CANARY'])
              .execute();
            await trx
              .updateTable('agent_versions')
              .set({
                status: 'PRODUCTION',
                rollout_percent: 100,
                published_at: now,
                published_by_user_id: actor.userId ?? null,
              })
              .where('id', '=', version.id)
              .execute();
            await trx
              .updateTable('agents')
              .set({
                production_version_id: version.id,
                canary_version_id: null,
                status: agent.status === 'DRAFT' ? 'ACTIVE' : agent.status,
                version: agent.version + 1,
              })
              .where('id', '=', agent.id)
              .execute();
          } else {
            await trx
              .updateTable('agent_versions')
              .set({ status: 'SUPERSEDED', superseded_at: now })
              .where('agent_id', '=', agent.id)
              .where('status', '=', 'CANARY')
              .execute();
            await trx
              .updateTable('agent_versions')
              .set({
                status: 'CANARY',
                rollout_percent: rollout,
                published_at: now,
                published_by_user_id: actor.userId ?? null,
              })
              .where('id', '=', version.id)
              .execute();
            await trx
              .updateTable('agents')
              .set({ canary_version_id: version.id, version: agent.version + 1 })
              .where('id', '=', agent.id)
              .execute();
          }
          const published = await trx
            .selectFrom('agent_versions')
            .selectAll()
            .where('id', '=', version.id)
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'agent_version.published',
            subject: domainSubject(actor.tenantId, 'agent_version.published'),
            payload: {
              agent_id: agent.id,
              agent_version_id: version.id,
              config_hash: version.config_hash,
              rollout_percent: rollout,
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'agent_version.published',
            objectType: 'agent_version',
            objectId: version.id,
            metadata: {
              agent_id: agent.id,
              rollout_percent: rollout,
              config_hash: version.config_hash,
            },
          });
          return { status: 200, body: presentVersion(published, false) };
        },
      );
    },
  );

  app.post(
    '/v1/agent-versions/:id/rollback',
    { schema: { params: IdParams, body: RollbackBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'agent_versions:rollback');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: null },
        'agent_versions.rollback',
        async (trx) => {
          const target = await loadVersionForUpdate(trx, request.params.id);
          if (
            target.published_at === null ||
            (target.status !== 'SUPERSEDED' && target.status !== 'ROLLED_BACK')
          ) {
            throw new ApiError('INVALID_STATE_TRANSITION', {
              status: target.status,
              reason: 'target_must_be_previously_published',
            });
          }
          const agent = await loadAgentForUpdate(trx, target.agent_id);
          await assertKillSwitchReleased(
            trx,
            'kill.agent_publish',
            killSwitchScopes(actor, agent.id),
          );
          const now = services.now();
          await trx
            .updateTable('agent_versions')
            .set({ status: 'ROLLED_BACK', rolled_back_at: now })
            .where('agent_id', '=', agent.id)
            .where('status', 'in', ['PRODUCTION', 'CANARY'])
            .execute();
          await trx
            .updateTable('agent_versions')
            .set({ status: 'PRODUCTION', rollout_percent: 100 })
            .where('id', '=', target.id)
            .execute();
          await trx
            .updateTable('agents')
            .set({
              production_version_id: target.id,
              canary_version_id: null,
              version: agent.version + 1,
            })
            .where('id', '=', agent.id)
            .execute();
          const restored = await trx
            .selectFrom('agent_versions')
            .selectAll()
            .where('id', '=', target.id)
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'agent_version.rolled_back',
            subject: domainSubject(actor.tenantId, 'agent_version.rolled_back'),
            payload: {
              agent_id: agent.id,
              agent_version_id: target.id,
              previous_production_version_id: agent.production_version_id,
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'agent_version.rolled_back',
            objectType: 'agent_version',
            objectId: target.id,
            metadata: {
              agent_id: agent.id,
              reason: request.body.reason,
              previous_production_version_id: agent.production_version_id,
            },
          });
          return { status: 200, body: presentVersion(restored, false) };
        },
      );
    },
  );
};
