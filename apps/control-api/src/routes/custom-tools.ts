import { createRequire } from 'node:module';
import { BUILT_IN_TOOL_NAMES, type VelyricEnvironment } from '@velyric/contracts';
import type { ToolDefinitions } from '@velyric/db';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  resolveAllowedAddresses,
  validateEgressUrl,
  type EgressPolicy,
  type HostResolver,
} from '@velyric/security';
import type { TenantSecretWriter } from '@velyric/tenant-secrets';
import type { Selectable } from 'kysely';
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
import { ApiError } from '../errors.js';
import { buildPage, newId, readCursor, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import { IdParams, iso, limitFromQuery } from './common.js';

export interface CustomToolRouteDependencies {
  readonly secrets: TenantSecretWriter;
  readonly resolver: HostResolver;
  readonly onSecretCleanupFailure?: (secretRef: string, error: unknown) => void;
}

interface SchemaCompiler {
  compile(schema: object): unknown;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (
  options: Readonly<Record<string, unknown>>,
) => SchemaCompiler;
const addFormats = require('ajv-formats') as (ajv: SchemaCompiler) => SchemaCompiler;

const MAX_SCHEMA_BYTES = 32_768;
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,63})\}/g;
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...BUILT_IN_TOOL_NAMES,
  'lookup_availability',
  'transfer_call',
  'end_call',
]);

const JsonSchemaObject = Type.Record(Type.String(), Type.Unknown());

const SideEffect = Type.Union([
  Type.Literal('READ'),
  Type.Literal('WRITE'),
  Type.Literal('HIGH_RISK_WRITE'),
  Type.Literal('EXTERNAL_COMMUNICATION'),
]);
const Confirmation = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('CALLER_CONFIRMATION'),
  Type.Literal('CALLER_CONFIRMATION_WITH_VERIFICATION'),
  Type.Literal('HUMAN_APPROVAL'),
]);

const Auth = Type.Union([
  Type.Object({ type: Type.Literal('NONE') }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('BEARER'),
      secret: Type.String({ minLength: 16, maxLength: 4096, pattern: '^[\\x21-\\x7E]+$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('HMAC'),
      secret: Type.String({ minLength: 32, maxLength: 512, pattern: '^[\\x21-\\x7E]+$' }),
    },
    { additionalProperties: false },
  ),
]);

const CreateBody = Type.Object(
  {
    name: Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' }),
    description: Type.String({ minLength: 10, maxLength: 1000 }),
    http_method: Type.Union([
      Type.Literal('GET'),
      Type.Literal('POST'),
      Type.Literal('PUT'),
      Type.Literal('PATCH'),
      Type.Literal('DELETE'),
    ]),
    base_url: Type.String({ minLength: 10, maxLength: 300 }),
    path_template: Type.String({ pattern: '^/[A-Za-z0-9._~{}/-]{0,300}$' }),
    input_schema: JsonSchemaObject,
    output_schema: JsonSchemaObject,
    side_effect_class: SideEffect,
    confirmation_policy: Confirmation,
    idempotency_supported: Type.Boolean(),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 500, maximum: 10_000 })),
    max_retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    response_max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1_048_576 })),
    auth: Auth,
  },
  { additionalProperties: false },
);

const UpdateBody = Type.Object(
  {
    description: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED')])),
    confirmation_policy: Type.Optional(Confirmation),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 500, maximum: 10_000 })),
    max_retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    response_max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1_048_576 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const RotateBody = Type.Object(
  { secret: Type.String({ minLength: 16, maxLength: 4096, pattern: '^[\\x21-\\x7E]+$' }) },
  { additionalProperties: false },
);

const ListQuery = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED'), Type.Literal('KILLED')]),
    ),
  },
  { additionalProperties: false },
);

const CONFIRMATION_STRENGTH: Readonly<Record<string, number>> = {
  NONE: 0,
  CALLER_CONFIRMATION: 1,
  CALLER_CONFIRMATION_WITH_VERIFICATION: 2,
  HUMAN_APPROVAL: 3,
};

export function presentCustomTool(row: Selectable<ToolDefinitions>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    http_method: row.http_method,
    base_url: row.base_url,
    path_template: row.path_template,
    allowed_hosts: row.allowed_hosts,
    input_schema: row.input_schema,
    output_schema: row.output_schema,
    side_effect_class: row.side_effect_class,
    confirmation_policy: row.confirmation_policy,
    idempotency_supported: row.idempotency_supported,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    response_max_bytes: row.response_max_bytes,
    auth_type: row.auth_type,
    credential_configured: row.auth_secret_ref_id !== null,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function schemaIssues(
  ajv: SchemaCompiler,
  schema: Readonly<Record<string, unknown>>,
  path: string,
): string[] {
  const issues: string[] = [];
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) {
    issues.push(`${path}:too_large`);
  }
  if (schema['type'] !== 'object') {
    issues.push(`${path}:root_must_be_object`);
  }
  if (
    JSON.stringify(schema).includes('"$ref":"http') ||
    JSON.stringify(schema).includes('"$dynamicRef"')
  ) {
    issues.push(`${path}:remote_reference`);
  }
  try {
    ajv.compile(schema);
  } catch {
    issues.push(`${path}:uncompilable`);
  }
  return issues;
}

function policyFor(environment: VelyricEnvironment, host: string): EgressPolicy {
  return {
    ...DEFAULT_EGRESS_POLICY,
    allowedHosts: [host],
    allowHttp: environment === 'local' || environment === 'ci',
  };
}

export function createCustomToolRoutes(deps: CustomToolRouteDependencies): RouteModule {
  const ajv = new Ajv2020({ strict: true, allErrors: false, validateSchema: true });
  addFormats(ajv);
  const cleanup = (secretRef: string | null): void => {
    if (secretRef !== null) {
      deps.secrets
        .scheduleDeletion(secretRef)
        .catch((error: unknown) => deps.onSecretCleanupFailure?.(secretRef, error));
    }
  };

  const storeCredential = async (
    trx: Trx,
    actor: TenantActor,
    toolId: string,
    secret: string,
  ): Promise<{
    readonly refId: string;
    readonly secretRef: string;
    readonly previous: readonly string[];
  }> => {
    const current = await trx
      .selectFrom('tenant_secret_refs')
      .select((eb) => eb.fn.max('secret_version').as('version'))
      .where('kind', '=', 'CUSTOM_API_CREDENTIAL')
      .where('provider', '=', 'custom_api')
      .where('subject_id', '=', toolId)
      .executeTakeFirst();
    const version = (current?.version ?? 0) + 1;
    const refId = newId();
    const secretRef = await deps.secrets.store({
      tenantId: actor.tenantId,
      kind: 'CUSTOM_API_CREDENTIAL',
      secretRefId: refId,
      version,
      value: secret,
    });
    try {
      const previous = await trx
        .updateTable('tenant_secret_refs')
        .set({ status: 'REVOKED', revoked_at: new Date(), updated_at: new Date() })
        .where('kind', '=', 'CUSTOM_API_CREDENTIAL')
        .where('provider', '=', 'custom_api')
        .where('subject_id', '=', toolId)
        .where('status', '=', 'ACTIVE')
        .returning(['secret_ref'])
        .execute();
      await trx
        .insertInto('tenant_secret_refs')
        .values({
          id: refId,
          tenant_id: actor.tenantId,
          kind: 'CUSTOM_API_CREDENTIAL',
          provider: 'custom_api',
          subject_id: toolId,
          secret_ref: secretRef,
          secret_version: version,
          status: 'ACTIVE',
          activated_at: new Date(),
        })
        .execute();
      return { refId, secretRef, previous: previous.map((row) => row.secret_ref) };
    } catch (error) {
      cleanup(secretRef);
      throw error;
    }
  };

  return (app, services) => {
    app.get(
      '/v1/integrations/custom-tools',
      { schema: { querystring: ListQuery } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'integrations:read');
        const limit = limitFromQuery(request.query.limit);
        const cursor = readCursor(request.query.cursor, services.cursorKey);
        const rows = await inTenant(services, actor, request, (trx) => {
          let query = trx
            .selectFrom('tool_definitions')
            .selectAll()
            .where('kind', '=', 'CUSTOM_API')
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1);
          if (request.query.status !== undefined) {
            query = query.where('status', '=', request.query.status);
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
          presentCustomTool,
        );
      },
    );

    app.get(
      '/v1/integrations/custom-tools/:id',
      { schema: { params: IdParams } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'integrations:read');
        const row = await inTenant(services, actor, request, (trx) =>
          trx
            .selectFrom('tool_definitions')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('kind', '=', 'CUSTOM_API')
            .executeTakeFirst(),
        );
        if (row === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        return reply.header('etag', weakEtag(row.version)).send(presentCustomTool(row));
      },
    );

    app.post(
      '/v1/integrations/custom-tools',
      { schema: { body: CreateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'custom_tools:manage');
        const body = request.body;
        if (RESERVED_NAMES.has(body.name)) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [{ path: '/body/name', rule: 'reserved' }],
          });
        }
        const issues = [
          ...schemaIssues(ajv, body.input_schema, '/body/input_schema'),
          ...schemaIssues(ajv, body.output_schema, '/body/output_schema'),
        ];
        const properties = body.input_schema['properties'];
        const required = Array.isArray(body.input_schema['required'])
          ? (body.input_schema['required'] as unknown[])
          : [];
        for (const match of body.path_template.matchAll(PLACEHOLDER)) {
          const name = match[1] ?? '';
          if (
            typeof properties !== 'object' ||
            properties === null ||
            !(name in properties) ||
            !required.includes(name)
          ) {
            issues.push(`/body/path_template:placeholder_${name}_not_required_input`);
          }
        }
        if (body.path_template.includes('..') || body.path_template.includes('//')) {
          issues.push('/body/path_template:unsafe');
        }
        if (issues.length > 0) {
          throw new ApiError('TOOL_SCHEMA_INVALID', { issues });
        }
        if (
          body.side_effect_class !== 'READ' &&
          body.confirmation_policy === 'NONE' &&
          !body.idempotency_supported
        ) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [
              {
                path: '/body/confirmation_policy',
                rule: 'write_requires_confirmation_or_idempotency',
              },
            ],
          });
        }
        if (
          body.side_effect_class === 'HIGH_RISK_WRITE' &&
          !['CALLER_CONFIRMATION_WITH_VERIFICATION', 'HUMAN_APPROVAL'].includes(
            body.confirmation_policy,
          )
        ) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [
              { path: '/body/confirmation_policy', rule: 'high_risk_requires_verification' },
            ],
          });
        }
        let baseUrl: URL;
        try {
          const parsed = new URL(body.base_url);
          const policy = policyFor(
            services.environment,
            parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'),
          );
          baseUrl = validateEgressUrl(parsed, policy);
          if (baseUrl.pathname !== '/' || baseUrl.search !== '' || baseUrl.hash !== '') {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [{ path: '/body/base_url', rule: 'origin_only' }],
            });
          }
          await resolveAllowedAddresses(baseUrl.hostname, policy, deps.resolver);
        } catch (error) {
          if (error instanceof ApiError || error instanceof EgressBlockedError) {
            throw error;
          }
          throw new ApiError('SSRF_BLOCKED', { reason: 'INVALID_URL' });
        }
        const origin = baseUrl.origin;
        const host = baseUrl.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');

        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'custom_tools.create',
          async (trx) => {
            const existing = await trx
              .selectFrom('tool_definitions')
              .select(['id'])
              .where('name', '=', body.name)
              .executeTakeFirst();
            if (existing !== undefined) {
              throw new ApiError('CONFLICT', { reason: 'tool_name_taken' });
            }
            const toolId = newId();
            const credential =
              body.auth.type === 'NONE'
                ? null
                : await storeCredential(trx, actor, toolId, body.auth.secret);
            try {
              const row = await trx
                .insertInto('tool_definitions')
                .values({
                  id: toolId,
                  tenant_id: actor.tenantId,
                  name: body.name,
                  description: body.description,
                  kind: 'CUSTOM_API',
                  http_method: body.http_method,
                  base_url: origin,
                  path_template: body.path_template,
                  allowed_hosts: [host],
                  input_schema: JSON.stringify(body.input_schema),
                  output_schema: JSON.stringify(body.output_schema),
                  auth_type: body.auth.type,
                  auth_secret_ref_id: credential?.refId ?? null,
                  side_effect_class: body.side_effect_class,
                  confirmation_policy: body.confirmation_policy,
                  idempotency_supported: body.idempotency_supported,
                  timeout_ms: body.timeout_ms ?? 5000,
                  max_retries:
                    body.side_effect_class === 'READ'
                      ? (body.max_retries ?? 0)
                      : body.idempotency_supported
                        ? (body.max_retries ?? 0)
                        : 0,
                  response_max_bytes: body.response_max_bytes ?? 262_144,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
              await writeAudit(trx, actor, requestMeta(request), {
                action: 'custom_tool.created',
                objectType: 'tool_definition',
                objectId: row.id,
                metadata: {
                  name: row.name,
                  host,
                  method: row.http_method,
                  side_effect_class: row.side_effect_class,
                  auth_type: row.auth_type,
                },
              });
              return {
                status: 201,
                body: presentCustomTool(row),
                headers: {
                  etag: weakEtag(row.version),
                  location: `/v1/integrations/custom-tools/${row.id}`,
                },
                resource: { type: 'tool_definition', id: row.id },
              };
            } catch (error) {
              cleanup(credential?.secretRef ?? null);
              throw error;
            }
          },
        );
      },
    );

    app.patch(
      '/v1/integrations/custom-tools/:id',
      { schema: { params: IdParams, body: UpdateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'custom_tools:manage');
        const expected = requireIfMatch(request);
        const body = request.body;
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'custom_tools.update',
          async (trx) => {
            const row = await trx
              .selectFrom('tool_definitions')
              .selectAll()
              .where('id', '=', request.params.id)
              .where('kind', '=', 'CUSTOM_API')
              .forUpdate()
              .executeTakeFirst();
            if (row === undefined) {
              throw new ApiError('NOT_FOUND');
            }
            if (row.version !== expected) {
              throw new ApiError('VERSION_CONFLICT', { current_version: row.version });
            }
            if (row.status === 'KILLED') {
              throw new ApiError('KILL_SWITCH_ACTIVE', { tool_id: row.id });
            }
            const confirmation = body.confirmation_policy ?? row.confirmation_policy;
            if (
              (CONFIRMATION_STRENGTH[confirmation] ?? 0) <
                (CONFIRMATION_STRENGTH[row.confirmation_policy] ?? 0) &&
              row.side_effect_class !== 'READ'
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [
                  { path: '/body/confirmation_policy', rule: 'cannot_weaken_write_confirmation' },
                ],
              });
            }
            if (
              row.side_effect_class === 'HIGH_RISK_WRITE' &&
              !['CALLER_CONFIRMATION_WITH_VERIFICATION', 'HUMAN_APPROVAL'].includes(confirmation)
            ) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [
                  { path: '/body/confirmation_policy', rule: 'high_risk_requires_verification' },
                ],
              });
            }
            const updated = await trx
              .updateTable('tool_definitions')
              .set((eb) => ({
                ...(body.description === undefined ? {} : { description: body.description }),
                ...(body.status === undefined ? {} : { status: body.status }),
                ...(body.timeout_ms === undefined ? {} : { timeout_ms: body.timeout_ms }),
                ...(body.max_retries === undefined
                  ? {}
                  : {
                      max_retries:
                        row.side_effect_class === 'READ' || row.idempotency_supported
                          ? body.max_retries
                          : 0,
                    }),
                ...(body.response_max_bytes === undefined
                  ? {}
                  : { response_max_bytes: body.response_max_bytes }),
                confirmation_policy: confirmation,
                version: eb('version', '+', 1),
                updated_at: new Date(),
              }))
              .where('id', '=', row.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, actor, requestMeta(request), {
              action: body.status === 'DISABLED' ? 'custom_tool.disabled' : 'custom_tool.updated',
              objectType: 'tool_definition',
              objectId: row.id,
              diff: body,
              metadata: { fields: Object.keys(body) },
            });
            return {
              status: 200,
              body: presentCustomTool(updated),
              headers: { etag: weakEtag(updated.version) },
            };
          },
        );
      },
    );

    app.post(
      '/v1/integrations/custom-tools/:id/credentials',
      { schema: { params: IdParams, body: RotateBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'custom_tools:manage');
        let revoked: readonly string[] = [];
        const response = await idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'custom_tools.rotate_credential',
          async (trx) => {
            const row = await trx
              .selectFrom('tool_definitions')
              .selectAll()
              .where('id', '=', request.params.id)
              .where('kind', '=', 'CUSTOM_API')
              .forUpdate()
              .executeTakeFirst();
            if (row === undefined) {
              throw new ApiError('NOT_FOUND');
            }
            if (row.auth_type === 'NONE') {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'tool_has_no_credential' });
            }
            if (row.auth_type === 'HMAC' && request.body.secret.length < 32) {
              throw new ApiError('VALIDATION_FAILED', {
                issues: [{ path: '/body/secret', rule: 'hmac_min_length_32' }],
              });
            }
            const credential = await storeCredential(trx, actor, row.id, request.body.secret);
            try {
              const updated = await trx
                .updateTable('tool_definitions')
                .set((eb) => ({
                  auth_secret_ref_id: credential.refId,
                  version: eb('version', '+', 1),
                  updated_at: new Date(),
                }))
                .where('id', '=', row.id)
                .returningAll()
                .executeTakeFirstOrThrow();
              await writeAudit(trx, actor, requestMeta(request), {
                action: 'custom_tool.credential_rotated',
                objectType: 'tool_definition',
                objectId: row.id,
                metadata: { auth_type: row.auth_type },
              });
              revoked = credential.previous;
              return {
                status: 200,
                body: presentCustomTool(updated),
                headers: { etag: weakEtag(updated.version) },
              };
            } catch (error) {
              cleanup(credential.secretRef);
              throw error;
            }
          },
        );
        revoked.forEach((secretRef) => {
          cleanup(secretRef);
        });
        return response;
      },
    );
  };
}
