import {
  AgentConfigSchema,
  ConversationState,
  MODEL_TIER_DEFAULT_MODEL,
  REALTIME_VOICE_FALLBACK_MODELS,
  type AgentConfig,
  type ProviderMode,
} from '@velyric/contracts';
import type { TenantSecretReader } from '@velyric/tenant-secrets';
import type { FastifyRequest } from 'fastify';
import Type from 'typebox';
import { Value } from 'typebox/value';
import { inTenant, requestMeta, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { newId, writeAudit } from '../persistence.js';
import { requireTenantActor, type TenantActor } from '../principal.js';
import type { JsonSchemaValidator, ToolDispatcher } from '../runtime/tool-dispatch.js';
import { executeToolRun } from '../runtime/tool-execution.js';
import { IdParams, iso } from './common.js';

const SESSION_SECONDS = 600;
const SessionBody = Type.Optional(
  Type.Object(
    {
      rejected_models: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 8 }),
      ),
    },
    { additionalProperties: false },
  ),
);
const MAX_CALL_AGE_MS = 60 * 60 * 1000;
const TERMINAL_CALL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'ABANDONED',
  'TRANSFERRED',
]);
const ToolCallBody = Type.Object(
  {
    tool_name: Type.String({ pattern: '^[a-z][a-z0-9_]{2,63}$' }),
    specialist: Type.String({ pattern: '^[A-Z_]{3,30}$' }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    conversation_state: Type.Enum(Object.values(ConversationState)),
    provider_call_id: Type.String({ minLength: 8, maxLength: 120 }),
    confirmed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const EndCallBody = Type.Object(
  {
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    transcript: Type.Optional(
      Type.Array(
        Type.Object(
          {
            speaker: Type.Union([Type.Literal('CALLER'), Type.Literal('AGENT')]),
            language: Type.Optional(Type.String({ pattern: '^[a-z]{2,3}$' })),
            start_ms: Type.Integer({ minimum: 0 }),
            end_ms: Type.Integer({ minimum: 0 }),
            content: Type.String({ minLength: 1, maxLength: 4000 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 400 },
      ),
    ),
  },
  { additionalProperties: false },
);
const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  hu: 'Hungarian',
  de: 'German',
  en: 'English',
};

export interface RealtimeSessionInput {
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  readonly speed: number;
  readonly instructions: string;
  readonly tools: readonly {
    readonly type: 'function';
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }[];
}

export interface RealtimeSessionResult {
  readonly value: string;
  readonly expiresAt: number;
  readonly model: string;
}

export interface RealtimeSessionClient {
  create(input: RealtimeSessionInput): Promise<RealtimeSessionResult>;
}

export class ModelUnavailableError extends Error {
  constructor(model: string) {
    super(`realtime model ${model} is not available`);
    this.name = 'ModelUnavailableError';
  }
}

export class OpenAiRealtimeSessions implements RealtimeSessionClient {
  readonly #baseUrl: string;

  constructor(baseUrl = 'https://api.openai.com/v1') {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async create(input: RealtimeSessionInput): Promise<RealtimeSessionResult> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: SESSION_SECONDS },
          session: {
            type: 'realtime',
            model: input.model,
            instructions: input.instructions,
            audio: {
              input: {
                turn_detection: { type: 'semantic_vad' },
                transcription: { model: 'whisper-1' },
              },
              output: { voice: input.voice, speed: input.speed },
            },
            tools: input.tools,
            tool_choice: input.tools.length === 0 ? 'none' : 'auto',
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'openai_unreachable' });
    }
    if (response.status === 400 || response.status === 404) {
      throw new ModelUnavailableError(input.model);
    }
    if (!response.ok) {
      throw new ApiError('PROVIDER_UNAVAILABLE', {
        reason: `openai_http_${String(response.status)}`,
      });
    }
    const body = (await response.json()) as { value?: unknown; expires_at?: unknown };
    if (typeof body.value !== 'string' || typeof body.expires_at !== 'number') {
      throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'openai_response_invalid' });
    }
    return { value: body.value, expiresAt: body.expires_at, model: input.model };
  }
}

export interface BusinessFacts {
  readonly businessName: string;
  readonly services: readonly {
    readonly name: string;
    readonly durationMinutes: number;
    readonly minParty: number | null;
    readonly maxParty: number | null;
  }[];
  readonly faq: readonly { readonly question: string; readonly answer: string }[];
}

const MAX_FAQ_CHARACTERS = 6000;

function faqBlock(faq: BusinessFacts['faq']): string {
  const lines: string[] = [];
  let size = 0;
  for (const entry of faq) {
    const line = `Q: ${entry.question}\nA: ${entry.answer}`;
    if (size + line.length > MAX_FAQ_CHARACTERS) {
      break;
    }
    size += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

export function webTestInstructions(config: AgentConfig, facts: BusinessFacts): string {
  const language = config.languages.find((entry) => entry.locale === config.default_locale);
  const businessLanguage = LANGUAGE_NAMES[config.default_locale] ?? config.default_locale;
  const hours =
    config.business_hours.length === 0
      ? 'Opening hours are not configured yet; say you will check with the team.'
      : config.business_hours
          .map((entry) => `${WEEKDAYS[entry.iso_weekday] ?? ''} ${entry.opens}-${entry.closes}`)
          .join('; ');
  const handoff =
    config.handoff.destinations.length === 0
      ? 'There is no human transfer destination, so offer to take a message instead of transferring.'
      : `You may offer to transfer the caller to: ${config.handoff.destinations
          .map((destination) => destination.description)
          .join(', ')}.`;
  const disclosure = config.disclosure.texts[config.default_locale] ?? '';
  const pronunciation =
    config.pronunciation.length === 0
      ? ''
      : `Pronounce these exactly as written: ${config.pronunciation
          .map((entry) => `"${entry.term}" -> "${entry.spoken_as}"`)
          .join('; ')}.`;
  const services =
    facts.services.length === 0
      ? 'No bookable services are configured yet.'
      : facts.services
          .map(
            (service) =>
              `${service.name} (${String(service.durationMinutes)} minutes${
                service.maxParty === null
                  ? ''
                  : `, ${String(service.minParty ?? 1)}-${String(service.maxParty)} people`
              })`,
          )
          .join('; ');
  const faq = faqBlock(facts.faq);
  return [
    `# Role`,
    `You answer incoming phone calls for ${facts.businessName}. You are their voice assistant, nothing else.`,
    `# Language`,
    `You speak every language fluently. Start in ${businessLanguage}. From the caller's first words on, always answer in the language the caller is speaking and switch immediately whenever the caller switches, without commenting on it. Never mix languages inside a sentence.`,
    `Business data, services and knowledge are in ${businessLanguage}: use that language for tool arguments and translate the answers for the caller.`,
    'Say numbers, dates and times the way a person would say them out loud, never as digits read one by one.',
    pronunciation,
    `# Opening`,
    `Your very first sentence in the call is exactly: "${language?.greeting ?? ''}". If the caller then speaks another language, continue in their language without repeating the greeting.`,
    'Say that greeting only once, at the very beginning. Never introduce yourself again later in the call, even after a pause, an interruption or a silence. After the greeting, continue the conversation from where it stopped.',
    disclosure === ''
      ? ''
      : `If the caller asks whether you are a human or a machine, answer: "${disclosure}"`,
    `# Style`,
    `Warmth ${String(config.persona.warmth)}/100, formality ${String(config.persona.formality)}/100, energy ${String(config.persona.energy)}/100, brevity ${String(config.persona.brevity)}/100, humour ${String(config.persona.humor)}/100.`,
    'Keep every answer to one or two short spoken sentences. Ask one question at a time. Never read lists aloud unless the caller asks for them.',
    `# What you know`,
    `Opening hours (${config.timezone}): ${hours}`,
    `Bookable services: ${services}`,
    faq === '' ? '' : `Questions the business already answered:\n${faq}`,
    `# Boundaries`,
    'Only discuss this business and what a caller could reasonably ask its reception: services, prices, opening hours, location, bookings, messages.',
    'If the caller asks about anything else (recipes, general knowledge, news, personal advice, coding, or any topic unrelated to this business), do not answer it. Say in one short sentence that you can only help with matters of this business, then ask how you can help with that.',
    "Never invent facts about the business. If something is not written above, say that you will check it with a colleague and offer to take the caller's details.",
    handoff,
    `If you cannot understand the caller after ${String(config.handoff.failed_understandings_before_offer)} attempts, offer help from a colleague.`,
    `# This call`,
    'This is a browser test call from the setup wizard. You have no tools here, so you cannot search the knowledge base, check live availability or create a real booking.',
    'If the caller asks for a booking, collect the details, repeat them back, and say that on the live phone line you complete the booking right away.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface VoiceTestRouteDependencies {
  readonly secrets: TenantSecretReader;
  readonly sessions: RealtimeSessionClient;
  readonly objects: KnowledgeDocumentReader;
  readonly dispatcher: ToolDispatcher;
  readonly schemaValidator: JsonSchemaValidator;
  readonly openAiMode: ProviderMode;
}

export interface KnowledgeDocumentReader {
  readDocument(key: string, maxBytes: number): Promise<Buffer | null>;
}

async function readFaqEntries(
  objects: KnowledgeDocumentReader,
  keys: readonly string[],
): Promise<BusinessFacts['faq']> {
  const entries: { question: string; answer: string }[] = [];
  for (const key of keys) {
    let parsed: unknown;
    try {
      const document = await objects.readDocument(key, 1024 * 1024);
      if (document === null) {
        continue;
      }
      parsed = JSON.parse(document.toString('utf8'));
    } catch {
      continue;
    }
    const list =
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    for (const item of list) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { question?: unknown }).question === 'string' &&
        typeof (item as { answer?: unknown }).answer === 'string'
      ) {
        entries.push({
          question: (item as { question: string }).question,
          answer: (item as { answer: string }).answer,
        });
      }
    }
  }
  return entries;
}

export function createVoiceTestRoutes(deps: VoiceTestRouteDependencies): RouteModule {
  const candidates = [
    ...REALTIME_VOICE_FALLBACK_MODELS,
    'gpt-realtime-2',
    'gpt-realtime-1.5',
    MODEL_TIER_DEFAULT_MODEL.VOICE_FRONTEND,
  ].filter((model, index, all) => all.indexOf(model) === index);
  return (app, services) => {
    app.post(
      '/v1/agents/:id/web-test-session',
      { schema: { params: IdParams, body: SessionBody } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'agents:write');
        if (deps.openAiMode === 'simulator') {
          throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'simulator_mode' });
        }
        const loaded = await inTenant(services, actor, request, async (trx) => {
          const agent = await trx
            .selectFrom('agents')
            .select(['id', 'name', 'location_id', 'production_version_id'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (agent === undefined) {
            throw new ApiError('NOT_FOUND');
          }
          const version =
            agent.production_version_id === null
              ? await trx
                  .selectFrom('agent_versions')
                  .select(['id', 'config'])
                  .where('agent_id', '=', agent.id)
                  .orderBy('version_number', 'desc')
                  .limit(1)
                  .executeTakeFirst()
              : await trx
                  .selectFrom('agent_versions')
                  .select(['id', 'config'])
                  .where('id', '=', agent.production_version_id)
                  .executeTakeFirst();
          const tools = await trx
            .selectFrom('tool_definitions')
            .select(['name', 'description', 'input_schema', 'status'])
            .where('status', '=', 'ACTIVE')
            .execute();
          const credential = await trx
            .selectFrom('tenant_secret_refs')
            .select(['secret_ref'])
            .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
            .where('provider', '=', 'openai')
            .where('status', '=', 'ACTIVE')
            .orderBy('secret_version', 'desc')
            .executeTakeFirst();
          const tenant = await trx
            .selectFrom('tenants')
            .select(['display_name'])
            .where('id', '=', actor.tenantId)
            .executeTakeFirstOrThrow();
          const services = await trx
            .selectFrom('services')
            .select(['name', 'duration_minutes', 'min_party_size', 'max_party_size'])
            .where('active', '=', true)
            .orderBy('created_at')
            .limit(20)
            .execute();
          const faqSources = await trx
            .selectFrom('knowledge_sources')
            .select(['storage_key'])
            .where('source_type', 'in', ['FAQ', 'MANUAL_QA'])
            .where('status', 'not in', ['ARCHIVED', 'DELETING', 'FAILED', 'QUARANTINED'])
            .where('storage_key', 'is not', null)
            .orderBy('created_at')
            .limit(3)
            .execute();
          return {
            agent,
            version,
            credential,
            tools,
            businessName: tenant.display_name,
            services,
            faqKeys: faqSources.flatMap((source) =>
              source.storage_key === null ? [] : [source.storage_key],
            ),
          };
        });
        if (
          loaded.version === undefined ||
          !Value.Check(AgentConfigSchema, loaded.version.config)
        ) {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'agent_version_missing' });
        }
        if (loaded.credential === undefined) {
          throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'openai_credentials_missing' });
        }
        const config = loaded.version.config;
        const allowed = new Map<string, string>();
        for (const specialist of config.specialists) {
          if (!specialist.enabled) {
            continue;
          }
          for (const name of specialist.tool_allowlist) {
            if (!allowed.has(name)) {
              allowed.set(name, specialist.kind);
            }
          }
        }
        const sessionTools = loaded.tools
          .filter((tool) => allowed.has(tool.name))
          .map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema as Record<string, unknown>,
          }));
        const apiKey = await deps.secrets.read(loaded.credential.secret_ref);
        const instructions = webTestInstructions(config, {
          businessName: loaded.businessName,
          services: loaded.services.map((service) => ({
            name: service.name,
            durationMinutes: service.duration_minutes,
            minParty: service.min_party_size,
            maxParty: service.max_party_size,
          })),
          faq: await readFaqEntries(deps.objects, loaded.faqKeys),
        });
        const body = request.body as { readonly rejected_models?: readonly string[] } | undefined;
        const rejected = new Set(body?.rejected_models ?? []);
        const models = candidates.filter((model) => !rejected.has(model));
        let session: RealtimeSessionResult | null = null;
        for (const model of models) {
          try {
            session = await deps.sessions.create({
              apiKey,
              model,
              speed: Math.round((0.85 + (config.persona.pace / 100) * 0.3) * 100) / 100,
              voice: config.voice,
              instructions,
              tools: sessionTools,
            });
            break;
          } catch (error) {
            if (!(error instanceof ModelUnavailableError)) {
              throw error;
            }
          }
        }
        if (session === null) {
          throw new ApiError('PROVIDER_UNAVAILABLE', { reason: 'realtime_model_unavailable' });
        }
        const created = session;
        const callId = newId();
        const agentVersionId = loaded.version.id;
        await inTenant(services, actor, request, async (trx) => {
          await trx
            .insertInto('calls')
            .values({
              id: callId,
              tenant_id: actor.tenantId,
              provider: 'openai',
              provider_call_id: `web-test:${callId}`,
              channel: 'WEB_VOICE',
              direction: 'INBOUND',
              status: 'IN_PROGRESS',
              started_at: services.now(),
              answered_at: services.now(),
              trace_id: request.traceId,
              recording_enabled: false,
              location_id: loaded.agent.location_id,
              agent_id: loaded.agent.id,
              agent_version_id: agentVersionId,
              language: config.default_locale,
              conversation_state: 'GREETING',
              runtime_instance_id: 'web-test',
              realtime_session_ref: created.model,
            })
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'agent.web_test_session_started',
            objectType: 'agent',
            objectId: loaded.agent.id,
            metadata: { model: created.model, voice: config.voice, call_id: callId },
          });
        });
        return {
          client_secret: created.value,
          expires_at: iso(new Date(created.expiresAt * 1000)),
          model: created.model,
          voice: config.voice,
          call_id: callId,
          agent_version_id: agentVersionId,
          tools: sessionTools.map((tool) => ({
            name: tool.name,
            specialist: allowed.get(tool.name) ?? 'RECEPTION_ROUTER',
          })),
        };
      },
    );

    const loadTestCall = async (actor: TenantActor, request: FastifyRequest, callId: string) => {
      const call = await inTenant(services, actor, request, (trx) =>
        trx
          .selectFrom('calls')
          .select(['id', 'status', 'channel', 'agent_version_id', 'started_at'])
          .where('id', '=', callId)
          .executeTakeFirst(),
      );
      if (call === undefined || call.channel !== 'WEB_VOICE' || call.agent_version_id === null) {
        throw new ApiError('NOT_FOUND');
      }
      if (services.now().getTime() - call.started_at.getTime() > MAX_CALL_AGE_MS) {
        throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'call_expired' });
      }
      return { ...call, agent_version_id: call.agent_version_id };
    };

    app.post(
      '/v1/web-test-calls/:id/tools',
      { schema: { params: IdParams, body: ToolCallBody } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'agents:write');
        const call = await loadTestCall(actor, request, request.params.id);
        if (TERMINAL_CALL_STATUSES.has(call.status)) {
          throw new ApiError('INVALID_STATE_TRANSITION', { status: call.status });
        }
        const idempotencyKey = `web-test:${call.id}:${request.body.provider_call_id}`;
        return executeToolRun(
          {
            db: services.db,
            now: services.now,
            dispatcher: deps.dispatcher,
            schemaValidator: deps.schemaValidator,
            onDispatchError: (details, message) => {
              request.log.error(details, message);
            },
          },
          {
            tenantId: actor.tenantId,
            actorType: 'USER',
            actorId: actor.actorId,
            ...(actor.userId === undefined ? {} : { userId: actor.userId }),
            traceId: request.traceId,
          },
          {
            tenantId: actor.tenantId,
            callId: call.id,
            agentVersionId: call.agent_version_id,
            specialist: request.body.specialist,
            toolName: request.body.tool_name,
            arguments: request.body.arguments,
            conversationState: request.body.conversation_state,
            confirmation:
              request.body.confirmed === true
                ? { confirmedAt: services.now().toISOString(), turnSeq: 1 }
                : null,
            verifiedIdentity: false,
            idempotencyKey,
            traceId: request.traceId,
          },
        );
      },
    );

    app.post(
      '/v1/web-test-calls/:id/end',
      { schema: { params: IdParams, body: EndCallBody } },
      async (request) => {
        const actor = requireTenantActor(request.principal, 'agents:write');
        const call = await loadTestCall(actor, request, request.params.id);
        const ended = services.now();
        const connectedSeconds = Math.max(
          0,
          Math.round((ended.getTime() - call.started_at.getTime()) / 1000),
        );
        await inTenant(services, actor, request, async (trx) => {
          if (!TERMINAL_CALL_STATUSES.has(call.status)) {
            await trx
              .updateTable('calls')
              .set((eb) => ({
                status: 'COMPLETED',
                end_reason: 'CALLER_HANGUP',
                conversation_state: 'FOLLOW_UP',
                ended_at: ended,
                connected_seconds: connectedSeconds,
                billable_seconds: connectedSeconds,
                summary: request.body.summary ?? null,
                version: eb('version', '+', 1),
              }))
              .where('id', '=', call.id)
              .execute();
          }
          const transcript = request.body.transcript ?? [];
          if (transcript.length > 0) {
            await trx
              .insertInto('transcript_segments')
              .values(
                transcript.map((segment, index) => ({
                  id: newId(),
                  tenant_id: actor.tenantId,
                  call_id: call.id,
                  seq: index,
                  speaker: segment.speaker,
                  language: segment.language ?? null,
                  start_ms: segment.start_ms,
                  end_ms: Math.max(segment.start_ms, segment.end_ms),
                  content: segment.content,
                })),
              )
              .onConflict((conflict) => conflict.columns(['call_id', 'seq']).doNothing())
              .execute();
          }
        });
        return { id: call.id, status: 'COMPLETED', connected_seconds: connectedSeconds };
      },
    );
  };
}
