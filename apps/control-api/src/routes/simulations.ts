import { randomInt } from 'node:crypto';
import type { SimulationRuns, SimulationScenarios, SimulationSuites } from '@velyric/db';
import { withTenantTransaction } from '@velyric/db';
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
import {
  appendOutbox,
  buildPage,
  newId,
  readCursor,
  writeAudit,
  type Trx,
} from '../persistence.js';
import { requireServiceScope, requireTenantActor, type ServicePrincipal } from '../principal.js';
import { domainSubject, IdParams, iso, limitFromQuery, Uuid } from './common.js';

export const SIMULATION_RUBRIC_VERSION = 'velyric.simulation.rubric.2026-09';
export const SIMULATION_TOOL_FIXTURE_VERSION = 'velyric.simulation.fixtures.1';
const MAX_ACTIVE_RUNS_PER_TENANT = 3;
const MAX_SCENARIOS_PER_SUITE = 200;
const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING'] as const;
const ToolName = Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' });

const ScenarioDefinition = Type.Object(
  {
    caller_goal: Type.String({ minLength: 1, maxLength: 500 }),
    caller_persona: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    opening_line: Type.String({ minLength: 1, maxLength: 300 }),
    caller_facts: Type.Record(
      Type.String({ pattern: '^[a-z][a-z0-9_]{0,39}$' }),
      Type.String({ maxLength: 200 }),
      { maxProperties: 20 },
    ),
    max_turns: Type.Integer({ minimum: 2, maximum: 30 }),
    tool_fixtures: Type.Optional(
      Type.Array(
        Type.Object(
          {
            tool: ToolName,
            response: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            error_code: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{2,40}$' })),
            latency_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
  },
  { additionalProperties: false },
);

const Assertion = Type.Union([
  Type.Object(
    {
      type: Type.Literal('OUTCOME_IN'),
      values: Type.Array(Type.String({ pattern: '^[A-Z_]{4,30}$' }), {
        minItems: 1,
        maxItems: 15,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('INTENT_IS'), value: Type.String({ pattern: '^[A-Z_]{4,30}$' }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Union([Type.Literal('TOOL_CALLED'), Type.Literal('TOOL_NOT_CALLED')]),
      tool: ToolName,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Union([Type.Literal('TRANSFERRED'), Type.Literal('NOT_TRANSFERRED')]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Union([Type.Literal('PHRASE_PRESENT'), Type.Literal('PHRASE_ABSENT')]),
      phrase: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('MAX_AGENT_TURNS'), value: Type.Integer({ minimum: 1, maximum: 30 }) },
    { additionalProperties: false },
  ),
]);

const Assertions = Type.Array(Assertion, { maxItems: 20 });
const ScenarioClass = Type.Enum([
  'HAPPY_PATH',
  'CONVERSATION_STRESS',
  'TOOL_FAILURE',
  'SECURITY',
  'AUDIO_STRESS',
  'CONCURRENCY',
]);
const Language = Type.Union([Type.Literal('hu'), Type.Literal('de'), Type.Literal('en')]);

const ListSuitesQuery = Type.Object(
  {
    agent_id: Type.Optional(Uuid),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

const CreateSuiteBody = Type.Object(
  {
    agent_id: Uuid,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    is_release_gate: Type.Optional(Type.Boolean()),
    min_pass_ratio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

const UpdateSuiteBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    description: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
    ),
    is_release_gate: Type.Optional(Type.Boolean()),
    min_pass_ratio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const CreateScenarioBody = Type.Object(
  {
    scenario_key: Type.String({ pattern: '^[a-z0-9][a-z0-9_.-]{2,119}$' }),
    scenario_class: ScenarioClass,
    language: Language,
    definition: ScenarioDefinition,
    deterministic_assertions: Assertions,
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
  },
  { additionalProperties: false },
);

const UpdateScenarioBody = Type.Object(
  {
    scenario_class: Type.Optional(ScenarioClass),
    language: Type.Optional(Language),
    definition: Type.Optional(ScenarioDefinition),
    deterministic_assertions: Type.Optional(Assertions),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

const StartRunBody = Type.Object({ agent_version_id: Uuid }, { additionalProperties: false });

const ListRunsQuery = Type.Object(
  {
    suite_id: Type.Optional(Uuid),
    agent_version_id: Type.Optional(Uuid),
    status: Type.Optional(
      Type.Enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERRORED', 'CANCELED']),
    ),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

const ClaimBody = Type.Object(
  {
    model_versions: Type.Record(
      Type.String({ pattern: '^[a-z_]{2,40}$' }),
      Type.String({ minLength: 1, maxLength: 120 }),
      { maxProperties: 10 },
    ),
  },
  { additionalProperties: false },
);

const ScenarioResult = Type.Object(
  {
    scenario_id: Uuid,
    verdict: Type.Union([Type.Literal('PASSED'), Type.Literal('FAILED'), Type.Literal('ERRORED')]),
    score: Type.Number({ minimum: 0, maximum: 1 }),
    failed_assertions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
    turns: Type.Integer({ minimum: 0, maximum: 60 }),
    duration_ms: Type.Integer({ minimum: 0, maximum: 3_600_000 }),
    outcome: Type.Optional(Type.String({ pattern: '^[A-Z_]{4,30}$' })),
    intent: Type.Optional(Type.String({ pattern: '^[A-Z_]{4,30}$' })),
    tools_called: Type.Array(ToolName, { maxItems: 50 }),
    judge_notes: Type.Optional(Type.String({ maxLength: 1000 })),
    error_code: Type.Optional(Type.String({ pattern: '^[a-z0-9_]{3,60}$' })),
  },
  { additionalProperties: false },
);

const CompleteBody = Type.Object(
  {
    results: Type.Array(ScenarioResult, { minItems: 1, maxItems: MAX_SCENARIOS_PER_SUITE }),
    artifacts_prefix: Type.Optional(
      Type.String({ pattern: '^tenants/[0-9a-f-]{36}/simulations/[0-9a-f-]{36}/$' }),
    ),
  },
  { additionalProperties: false },
);

const ErrorBody = Type.Object(
  { error_code: Type.String({ pattern: '^[a-z0-9_]{3,60}$' }) },
  { additionalProperties: false },
);

function presentSuite(
  row: Selectable<SimulationSuites>,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    is_release_gate: row.is_release_gate,
    min_pass_ratio: Number(row.min_pass_ratio),
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...extra,
  };
}

function presentScenario(row: Selectable<SimulationScenarios>): Record<string, unknown> {
  return {
    id: row.id,
    suite_id: row.suite_id,
    scenario_key: row.scenario_key,
    scenario_class: row.scenario_class,
    language: row.language,
    definition: row.definition,
    deterministic_assertions: row.deterministic_assertions,
    seed: Number(row.seed),
    active: row.active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function presentRun(
  row: Selectable<SimulationRuns>,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: row.id,
    suite_id: row.suite_id,
    agent_version_id: row.agent_version_id,
    status: row.status,
    seed: Number(row.seed),
    model_versions: row.model_versions,
    rubric_version: row.rubric_version,
    tool_fixture_version: row.tool_fixture_version,
    passed_count: row.passed_count,
    failed_count: row.failed_count,
    errored_count: row.errored_count,
    scores: row.scores,
    gate_passed: row.gate_passed,
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    created_at: iso(row.created_at),
    ...extra,
  };
}

async function loadSuite(
  trx: Trx,
  id: string,
  lock = false,
): Promise<Selectable<SimulationSuites>> {
  let query = trx.selectFrom('simulation_suites').selectAll().where('id', '=', id);
  if (lock) {
    query = query.forUpdate();
  }
  const suite = await query.executeTakeFirst();
  if (suite === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return suite;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export const registerSimulationRoutes: RouteModule = (app, services) => {
  app.get(
    '/v1/simulation-suites',
    { schema: { querystring: ListSuitesQuery } },
    async (request) => {
      const actor = requireTenantActor(request.principal, 'simulations:read');
      const limit = limitFromQuery(request.query.limit);
      const cursor = readCursor(request.query.cursor, services.cursorKey);
      const rows = await inTenant(services, actor, request, (trx) => {
        let query = trx
          .selectFrom('simulation_suites')
          .selectAll()
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1);
        if (request.query.agent_id !== undefined) {
          query = query.where('agent_id', '=', request.query.agent_id);
        }
        if (cursor !== null) {
          const createdAt = new Date(String(cursor.k[0]));
          query = query.where((eb) =>
            eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(createdAt, cursor.id)),
          );
        }
        return query.execute();
      });
      return buildPage(
        rows,
        limit,
        services.cursorKey,
        (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
        (row) => presentSuite(row),
      );
    },
  );

  app.post(
    '/v1/simulation-suites',
    { schema: { body: CreateSuiteBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_suites.create',
        async (trx) => {
          const agent = await trx
            .selectFrom('agents')
            .select(['id', 'location_id'])
            .where('id', '=', body.agent_id)
            .executeTakeFirst();
          if (
            agent === undefined ||
            (actor.locationScope.length > 0 &&
              !actor.locationScope.includes(agent.location_id ?? ''))
          ) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/agent_id', rule: 'exists' }],
            });
          }
          const exists = await trx
            .selectFrom('simulation_suites')
            .select(['id'])
            .where('agent_id', '=', body.agent_id)
            .where('name', '=', body.name)
            .executeTakeFirst();
          if (exists !== undefined) {
            throw new ApiError('CONFLICT', { reason: 'suite_name_taken' });
          }
          const row = await trx
            .insertInto('simulation_suites')
            .values({
              id: newId(),
              tenant_id: actor.tenantId,
              agent_id: body.agent_id,
              name: body.name,
              description: body.description ?? null,
              is_release_gate: body.is_release_gate ?? false,
              min_pass_ratio: String(body.min_pass_ratio ?? 1),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_suite.created',
            objectType: 'simulation_suite',
            objectId: row.id,
            metadata: { agent_id: body.agent_id, is_release_gate: row.is_release_gate },
          });
          return {
            status: 201,
            body: presentSuite(row, { scenarios: [] }),
            resource: { type: 'simulation_suite', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.get('/v1/simulation-suites/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'simulations:read');
    const { suite, scenarios } = await inTenant(services, actor, request, async (trx) => {
      const row = await loadSuite(trx, request.params.id);
      const list = await trx
        .selectFrom('simulation_scenarios')
        .selectAll()
        .where('suite_id', '=', row.id)
        .orderBy('scenario_key')
        .limit(MAX_SCENARIOS_PER_SUITE)
        .execute();
      return { suite: row, scenarios: list };
    });
    return reply
      .header('etag', weakEtag(suite.version))
      .send(presentSuite(suite, { scenarios: scenarios.map(presentScenario) }));
  });

  app.patch(
    '/v1/simulation-suites/:id',
    { schema: { params: IdParams, body: UpdateSuiteBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      const expected = requireIfMatch(request);
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_suites.update',
        async (trx) => {
          const suite = await loadSuite(trx, request.params.id, true);
          if (suite.version !== expected) {
            throw new ApiError('VERSION_CONFLICT', { current_version: suite.version });
          }
          if (body.name !== undefined && body.name !== suite.name) {
            const clash = await trx
              .selectFrom('simulation_suites')
              .select(['id'])
              .where('agent_id', '=', suite.agent_id)
              .where('name', '=', body.name)
              .executeTakeFirst();
            if (clash !== undefined) {
              throw new ApiError('CONFLICT', { reason: 'suite_name_taken' });
            }
          }
          const row = await trx
            .updateTable('simulation_suites')
            .set({
              ...(body.name === undefined ? {} : { name: body.name }),
              ...(body.description === undefined ? {} : { description: body.description }),
              ...(body.is_release_gate === undefined
                ? {}
                : { is_release_gate: body.is_release_gate }),
              ...(body.min_pass_ratio === undefined
                ? {}
                : { min_pass_ratio: String(body.min_pass_ratio) }),
              version: suite.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', suite.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_suite.updated',
            objectType: 'simulation_suite',
            objectId: row.id,
            diff: body,
          });
          return {
            status: 200,
            body: presentSuite(row),
            resource: { type: 'simulation_suite', id: row.id },
            headers: { etag: weakEtag(row.version) },
          };
        },
      );
    },
  );

  app.post(
    '/v1/simulation-suites/:id/scenarios',
    { schema: { params: IdParams, body: CreateScenarioBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_scenarios.create',
        async (trx) => {
          const suite = await loadSuite(trx, request.params.id, true);
          const count = await trx
            .selectFrom('simulation_scenarios')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('suite_id', '=', suite.id)
            .executeTakeFirstOrThrow();
          if (Number(count.count) >= MAX_SCENARIOS_PER_SUITE) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [
                { path: '/params/id', rule: `max_${String(MAX_SCENARIOS_PER_SUITE)}_scenarios` },
              ],
            });
          }
          let row: Selectable<SimulationScenarios>;
          try {
            row = await trx
              .insertInto('simulation_scenarios')
              .values({
                id: newId(),
                tenant_id: actor.tenantId,
                suite_id: suite.id,
                scenario_key: body.scenario_key,
                scenario_class: body.scenario_class,
                language: body.language,
                definition: JSON.stringify(body.definition),
                deterministic_assertions: JSON.stringify(body.deterministic_assertions),
                seed: String(body.seed ?? randomInt(0, 2_147_483_647)),
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          } catch (error) {
            if (uniqueViolation(error)) {
              throw new ApiError('CONFLICT', { reason: 'scenario_key_taken' });
            }
            throw error;
          }
          await trx
            .updateTable('simulation_suites')
            .set({ version: suite.version + 1, updated_at: new Date() })
            .where('id', '=', suite.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_scenario.created',
            objectType: 'simulation_scenario',
            objectId: row.id,
            metadata: { suite_id: suite.id, scenario_key: row.scenario_key },
          });
          return {
            status: 201,
            body: presentScenario(row),
            resource: { type: 'simulation_scenario', id: row.id },
          };
        },
      );
    },
  );

  app.patch(
    '/v1/simulation-scenarios/:id',
    { schema: { params: IdParams, body: UpdateScenarioBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_scenarios.update',
        async (trx) => {
          const current = await trx
            .selectFrom('simulation_scenarios')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (current === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          const row = await trx
            .updateTable('simulation_scenarios')
            .set({
              ...(body.scenario_class === undefined ? {} : { scenario_class: body.scenario_class }),
              ...(body.language === undefined ? {} : { language: body.language }),
              ...(body.definition === undefined
                ? {}
                : { definition: JSON.stringify(body.definition) }),
              ...(body.deterministic_assertions === undefined
                ? {}
                : { deterministic_assertions: JSON.stringify(body.deterministic_assertions) }),
              ...(body.active === undefined ? {} : { active: body.active }),
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('simulation_suites')
            .set((eb) => ({ version: eb('version', '+', 1), updated_at: new Date() }))
            .where('id', '=', current.suite_id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_scenario.updated',
            objectType: 'simulation_scenario',
            objectId: row.id,
            metadata: { suite_id: row.suite_id, fields: Object.keys(body) },
          });
          return {
            status: 200,
            body: presentScenario(row),
            resource: { type: 'simulation_scenario', id: row.id },
          };
        },
      );
    },
  );

  app.post(
    '/v1/simulation-suites/:id/runs',
    { schema: { params: IdParams, body: StartRunBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      const body = request.body;
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_runs.create',
        async (trx) => {
          const suite = await loadSuite(trx, request.params.id);
          const version = await trx
            .selectFrom('agent_versions')
            .select(['id', 'agent_id'])
            .where('id', '=', body.agent_version_id)
            .executeTakeFirst();
          if (version === undefined || version.agent_id !== suite.agent_id) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/agent_version_id', rule: 'version_of_suite_agent' }],
            });
          }
          const scenarios = await trx
            .selectFrom('simulation_scenarios')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('suite_id', '=', suite.id)
            .where('active', '=', true)
            .executeTakeFirstOrThrow();
          if (Number(scenarios.count) === 0) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/params/id', rule: 'active_scenarios_required' }],
            });
          }
          await trx
            .selectFrom('tenants')
            .select(['id'])
            .where('id', '=', actor.tenantId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const active = await trx
            .selectFrom('simulation_runs')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('status', 'in', [...ACTIVE_RUN_STATUSES])
            .executeTakeFirstOrThrow();
          if (Number(active.count) >= MAX_ACTIVE_RUNS_PER_TENANT) {
            throw new ApiError(
              'RATE_LIMITED',
              { reason: 'active_simulation_runs', limit: MAX_ACTIVE_RUNS_PER_TENANT },
              { headers: { 'retry-after': '60' } },
            );
          }
          const row = await trx
            .insertInto('simulation_runs')
            .values({
              id: newId(),
              tenant_id: actor.tenantId,
              suite_id: suite.id,
              agent_version_id: version.id,
              status: 'QUEUED',
              seed: String(randomInt(0, 2_147_483_647)),
              model_versions: JSON.stringify({}),
              rubric_version: SIMULATION_RUBRIC_VERSION,
              tool_fixture_version: SIMULATION_TOOL_FIXTURE_VERSION,
              requested_by: actor.actorId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: actor.tenantId,
            eventType: 'simulation.run_requested',
            subject: domainSubject(actor.tenantId, 'simulation.run_requested'),
            payload: {
              tenant_id: actor.tenantId,
              run_id: row.id,
              suite_id: suite.id,
              agent_id: suite.agent_id,
              agent_version_id: version.id,
            },
            traceId: request.traceId,
          });
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_run.requested',
            objectType: 'simulation_run',
            objectId: row.id,
            metadata: { suite_id: suite.id, agent_version_id: version.id },
          });
          return {
            status: 202,
            body: presentRun(row),
            resource: { type: 'simulation_run', id: row.id },
          };
        },
      );
    },
  );

  app.get('/v1/simulation-runs', { schema: { querystring: ListRunsQuery } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'simulations:read');
    const query = request.query;
    const limit = limitFromQuery(query.limit);
    const cursor = readCursor(query.cursor, services.cursorKey);
    const rows = await inTenant(services, actor, request, (trx) => {
      let builder = trx
        .selectFrom('simulation_runs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (query.suite_id !== undefined) builder = builder.where('suite_id', '=', query.suite_id);
      if (query.agent_version_id !== undefined)
        builder = builder.where('agent_version_id', '=', query.agent_version_id);
      if (query.status !== undefined) builder = builder.where('status', '=', query.status);
      if (cursor !== null) {
        const createdAt = new Date(String(cursor.k[0]));
        builder = builder.where((eb) =>
          eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(createdAt, cursor.id)),
        );
      }
      return builder.execute();
    });
    return buildPage(
      rows,
      limit,
      services.cursorKey,
      (row) => ({ v: 1, k: [row.created_at.toISOString()], id: row.id }),
      (row) => presentRun(row),
    );
  });

  app.get('/v1/simulation-runs/:id', { schema: { params: IdParams } }, async (request) => {
    const actor = requireTenantActor(request.principal, 'simulations:read');
    const { run, previous } = await inTenant(services, actor, request, async (trx) => {
      const row = await trx
        .selectFrom('simulation_runs')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (row === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      const prior = await trx
        .selectFrom('simulation_runs')
        .selectAll()
        .where('suite_id', '=', row.suite_id)
        .where('status', 'in', ['PASSED', 'FAILED'])
        .where('created_at', '<', row.created_at)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return { run: row, previous: prior };
    });
    return presentRun(run, { previous_run: previous === undefined ? null : presentRun(previous) });
  });

  app.post(
    '/v1/simulation-runs/:id/cancel',
    { schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'simulations:run');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: actor.userId ?? null },
        'simulation_runs.cancel',
        async (trx) => {
          const run = await trx
            .selectFrom('simulation_runs')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (run === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
            throw new ApiError('INVALID_STATE_TRANSITION', { status: run.status });
          }
          const row = await trx
            .updateTable('simulation_runs')
            .set({ status: 'CANCELED', finished_at: new Date(), updated_at: new Date() })
            .where('id', '=', run.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'simulation_run.canceled',
            objectType: 'simulation_run',
            objectId: row.id,
          });
          return {
            status: 200,
            body: presentRun(row),
            resource: { type: 'simulation_run', id: row.id },
          };
        },
      );
    },
  );
};

function serviceContext(service: ServicePrincipal, traceId: string) {
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

type ScenarioResultInput = Static<typeof ScenarioResult>;

export function evaluateGate(
  results: readonly ScenarioResultInput[],
  minPassRatio: number,
): { passed: number; failed: number; errored: number; passRatio: number; gatePassed: boolean } {
  const passed = results.filter((result) => result.verdict === 'PASSED').length;
  const failed = results.filter((result) => result.verdict === 'FAILED').length;
  const errored = results.filter((result) => result.verdict === 'ERRORED').length;
  const passRatio = results.length === 0 ? 0 : passed / results.length;
  return {
    passed,
    failed,
    errored,
    passRatio: Number(passRatio.toFixed(4)),
    gatePassed: errored === 0 && passRatio + 1e-9 >= minPassRatio,
  };
}

export const registerInternalSimulationRoutes: RouteModule = (app, services) => {
  app.post(
    '/internal/v1/simulation-runs/:id/claim',
    { schema: { params: IdParams, body: ClaimBody } },
    async (request) => {
      const service = requireServiceScope(request.principal, 'simulation.run');
      return withTenantTransaction(
        services.db,
        serviceContext(service, request.traceId),
        async (trx) => {
          const run = await trx
            .selectFrom('simulation_runs')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (run === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
            throw new ApiError('CONFLICT', { reason: 'run_not_claimable', status: run.status });
          }
          const claimed =
            run.status === 'QUEUED'
              ? await trx
                  .updateTable('simulation_runs')
                  .set({
                    status: 'RUNNING',
                    started_at: new Date(),
                    model_versions: JSON.stringify(request.body.model_versions),
                    updated_at: new Date(),
                  })
                  .where('id', '=', run.id)
                  .returningAll()
                  .executeTakeFirstOrThrow()
              : run;
          const suite = await loadSuite(trx, run.suite_id);
          const [scenarios, version, credential] = await Promise.all([
            trx
              .selectFrom('simulation_scenarios')
              .selectAll()
              .where('suite_id', '=', suite.id)
              .where('active', '=', true)
              .orderBy('scenario_key')
              .limit(MAX_SCENARIOS_PER_SUITE)
              .execute(),
            trx
              .selectFrom('agent_versions')
              .select(['id', 'agent_id', 'version_number', 'config', 'config_hash'])
              .where('id', '=', run.agent_version_id)
              .executeTakeFirstOrThrow(),
            trx
              .selectFrom('tenant_secret_refs')
              .select(['secret_ref', 'secret_version'])
              .where('provider', '=', 'openai')
              .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
              .where('status', '=', 'ACTIVE')
              .executeTakeFirst(),
          ]);
          return {
            openai_api_key:
              credential === undefined
                ? null
                : { secret_ref: credential.secret_ref, secret_version: credential.secret_version },
            run: presentRun(claimed),
            suite: presentSuite(suite),
            scenarios: scenarios.map(presentScenario),
            agent_version: {
              id: version.id,
              agent_id: version.agent_id,
              version_number: version.version_number,
              config_hash: version.config_hash,
              config: version.config,
            },
          };
        },
      );
    },
  );

  app.post(
    '/internal/v1/simulation-runs/:id/complete',
    { schema: { params: IdParams, body: CompleteBody } },
    async (request) => {
      const service = requireServiceScope(request.principal, 'simulation.run');
      const body = request.body;
      return withTenantTransaction(
        services.db,
        serviceContext(service, request.traceId),
        async (trx) => {
          const run = await trx
            .selectFrom('simulation_runs')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (run === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (run.status === 'PASSED' || run.status === 'FAILED') {
            return presentRun(run);
          }
          if (run.status !== 'RUNNING') {
            throw new ApiError('CONFLICT', { reason: 'run_not_running', status: run.status });
          }
          const scenarioIds = new Set(
            (
              await trx
                .selectFrom('simulation_scenarios')
                .select(['id'])
                .where('suite_id', '=', run.suite_id)
                .execute()
            ).map((row) => row.id),
          );
          const unknown = body.results.findIndex((result) => !scenarioIds.has(result.scenario_id));
          if (unknown >= 0) {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [
                { path: `/body/results/${String(unknown)}/scenario_id`, rule: 'scenario_of_suite' },
              ],
            });
          }
          const suite = await loadSuite(trx, run.suite_id);
          const gate = evaluateGate(body.results, Number(suite.min_pass_ratio));
          const finishedAt = new Date();
          const row = await trx
            .updateTable('simulation_runs')
            .set({
              status: gate.gatePassed ? 'PASSED' : 'FAILED',
              passed_count: gate.passed,
              failed_count: gate.failed,
              errored_count: gate.errored,
              gate_passed: gate.gatePassed,
              scores: JSON.stringify({
                pass_ratio: gate.passRatio,
                min_pass_ratio: Number(suite.min_pass_ratio),
                results: body.results,
              }),
              ...(body.artifacts_prefix === undefined
                ? {}
                : { artifacts_prefix: body.artifacts_prefix }),
              finished_at: finishedAt,
              updated_at: finishedAt,
            })
            .where('id', '=', run.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: run.tenant_id,
            eventType: 'simulation.run_completed',
            subject: domainSubject(run.tenant_id, 'simulation.run_completed'),
            payload: {
              tenant_id: run.tenant_id,
              run_id: run.id,
              suite_id: run.suite_id,
              agent_version_id: run.agent_version_id,
              status: row.status,
              gate_passed: gate.gatePassed,
              pass_ratio: gate.passRatio,
            },
            traceId: request.traceId,
          });
          return presentRun(row);
        },
      );
    },
  );

  app.post(
    '/internal/v1/simulation-runs/:id/error',
    { schema: { params: IdParams, body: ErrorBody } },
    async (request) => {
      const service = requireServiceScope(request.principal, 'simulation.run');
      return withTenantTransaction(
        services.db,
        serviceContext(service, request.traceId),
        async (trx) => {
          const run = await trx
            .selectFrom('simulation_runs')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (run === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
            return presentRun(run);
          }
          const finishedAt = new Date();
          const row = await trx
            .updateTable('simulation_runs')
            .set({
              status: 'ERRORED',
              scores: JSON.stringify({ error_code: request.body.error_code }),
              finished_at: finishedAt,
              updated_at: finishedAt,
            })
            .where('id', '=', run.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendOutbox(trx, {
            tenantId: run.tenant_id,
            eventType: 'simulation.run_completed',
            subject: domainSubject(run.tenant_id, 'simulation.run_completed'),
            payload: {
              tenant_id: run.tenant_id,
              run_id: run.id,
              suite_id: run.suite_id,
              agent_version_id: run.agent_version_id,
              status: 'ERRORED',
              gate_passed: false,
              error_code: request.body.error_code,
            },
            traceId: request.traceId,
          });
          return presentRun(row);
        },
      );
    },
  );
};
