import { createHash } from 'node:crypto';
import type { ProviderModule, SimulatorContext } from '../context.js';
import { bearer, json, jsonBody, type Router, type SimRequest, type SimResponse } from '../http.js';
import { unixSeconds } from '../state.js';

type OpenAiObject = Record<string, unknown>;

interface ServiceAccount {
  readonly object: OpenAiObject;
  readonly keys: OpenAiObject[];
}

interface Project {
  readonly object: OpenAiObject;
  readonly serviceAccounts: Map<string, ServiceAccount>;
  spendLimit: OpenAiObject | null;
}

type LiveStatus = 'incoming' | 'accepted' | 'rejected' | 'referred' | 'ended';

interface LiveSession {
  readonly id: string;
  status: LiveStatus;
  readonly actions: { readonly action: string; readonly body: unknown }[];
}

interface ScriptedReply {
  readonly content: string | null;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[];
}

const PAGE_LIMIT = 100;

function openAiError(
  status: number,
  message: string,
  type: string,
  code: string | null,
): SimResponse {
  return json(status, { error: { message, type, param: null, code } });
}

function deterministicVector(input: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block += 1) {
    const digest = createHash('sha256')
      .update(`${String(block)}:${input}`)
      .digest();
    for (let offset = 0; offset + 4 <= digest.length && values.length < dimensions; offset += 4) {
      values.push(digest.readInt32BE(offset) / 2_147_483_648);
    }
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class OpenAiSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #projects = new Map<string, Project>();
  readonly #issuedKeys = new Set<string>();
  readonly #sessions = new Map<string, LiveSession>();
  readonly #replies: ScriptedReply[] = [];

  constructor(context: SimulatorContext) {
    this.#context = context;
  }

  snapshot(): Record<string, number> {
    return {
      projects: this.#projects.size,
      live_sessions: this.#sessions.size,
      scripted_replies: this.#replies.length,
    };
  }

  register(api: Router, control: Router): void {
    const base = '/openai/v1';
    api.add('GET', `${base}/organization/projects`, (request) =>
      this.#admin(request, () => this.#listProjects(request)),
    );
    api.add('POST', `${base}/organization/projects`, (request) =>
      this.#admin(request, () => this.#createProject(request)),
    );
    api.add('GET', `${base}/organization/projects/:projectId`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) => json(200, project.object)),
      ),
    );
    api.add('POST', `${base}/organization/projects/:projectId/archive`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) => {
          project.object['archived_at'] = unixSeconds(this.#context.now());
          project.object['status'] = 'archived';
          return json(200, project.object);
        }),
      ),
    );
    api.add('POST', `${base}/organization/projects/:projectId/spend_limit`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) => {
          const body = jsonBody(request);
          if (typeof body['threshold_amount'] !== 'number' || body['threshold_amount'] <= 0) {
            return openAiError(
              400,
              'threshold_amount must be a positive number',
              'invalid_request_error',
              'invalid_value',
            );
          }
          project.spendLimit = { object: 'organization.project.spend_limit', ...body };
          return json(200, project.spendLimit);
        }),
      ),
    );
    api.add('GET', `${base}/organization/projects/:projectId/spend_limit`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) =>
          project.spendLimit === null
            ? openAiError(404, 'No spend limit configured', 'invalid_request_error', 'not_found')
            : json(200, project.spendLimit),
        ),
      ),
    );
    api.add('GET', `${base}/organization/projects/:projectId/service_accounts`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) =>
          json(
            200,
            this.#page(
              [...project.serviceAccounts.values()].map((account) => account.object),
              request,
            ),
          ),
        ),
      ),
    );
    api.add('POST', `${base}/organization/projects/:projectId/service_accounts`, (request) =>
      this.#admin(request, () =>
        this.#withProject(request, (project) => this.#createServiceAccount(project, request)),
      ),
    );
    api.add(
      'POST',
      `${base}/organization/projects/:projectId/service_accounts/:accountId/api_keys`,
      (request) =>
        this.#admin(request, () =>
          this.#withProject(request, (project) => {
            const account = project.serviceAccounts.get(request.params['accountId'] ?? '');
            if (account === undefined) {
              return openAiError(
                404,
                'Service account not found',
                'invalid_request_error',
                'not_found',
              );
            }
            const key = this.#issueKey(
              typeof jsonBody(request)['name'] === 'string'
                ? String(jsonBody(request)['name'])
                : 'Secret Key',
            );
            account.keys.push(key);
            return json(200, key);
          }),
        ),
    );
    api.add('POST', `${base}/embeddings`, (request) =>
      this.#model(request, () => this.#embeddings(request)),
    );
    api.add('POST', `${base}/chat/completions`, (request) =>
      this.#model(request, () => this.#chat(request)),
    );
    for (const action of ['accept', 'reject', 'refer', 'hangup'] as const) {
      api.add('POST', `${base}/live/sessions/:sessionId/${action}`, (request) =>
        this.#model(request, () => this.#liveAction(request, action)),
      );
    }

    control.add('POST', '/_control/openai/calls', (request) => this.#incomingCall(request));
    control.add('GET', '/_control/openai/calls/:sessionId', (request) => {
      const session = this.#sessions.get(request.params['sessionId'] ?? '');
      return session === undefined ? json(404, { error: 'session_not_found' }) : json(200, session);
    });
    control.add('POST', '/_control/openai/chat/replies', (request) => {
      const body = jsonBody(request);
      const replies = Array.isArray(body['replies']) ? body['replies'] : [];
      for (const raw of replies) {
        const reply =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        const toolCalls = Array.isArray(reply['tool_calls']) ? reply['tool_calls'] : [];
        this.#replies.push({
          content: typeof reply['content'] === 'string' ? reply['content'] : null,
          toolCalls: toolCalls.flatMap((call: unknown) => {
            const record =
              typeof call === 'object' && call !== null ? (call as Record<string, unknown>) : {};
            return typeof record['name'] === 'string'
              ? [{ name: record['name'], arguments: JSON.stringify(record['arguments'] ?? {}) }]
              : [];
          }),
        });
      }
      return json(202, { queued: this.#replies.length });
    });
  }

  #admin(request: SimRequest, next: () => SimResponse): SimResponse {
    return bearer(request) === this.#context.config.credentials.openaiAdminKey
      ? next()
      : openAiError(401, 'Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key');
  }

  #model(request: SimRequest, next: () => SimResponse): SimResponse {
    const token = bearer(request);
    if (
      token === null ||
      !token.startsWith('sk-') ||
      token === this.#context.config.credentials.openaiAdminKey
    ) {
      return openAiError(
        401,
        'Incorrect API key provided.',
        'invalid_request_error',
        'invalid_api_key',
      );
    }
    return next();
  }

  #withProject(request: SimRequest, next: (project: Project) => SimResponse): SimResponse {
    const project = this.#projects.get(request.params['projectId'] ?? '');
    return project === undefined
      ? openAiError(404, 'Project not found', 'invalid_request_error', 'not_found')
      : next(project);
  }

  #page(items: readonly OpenAiObject[], request: SimRequest): OpenAiObject {
    const after = request.query.get('after');
    const limit = Math.min(
      Number(request.query.get('limit') ?? String(PAGE_LIMIT)) || PAGE_LIMIT,
      PAGE_LIMIT,
    );
    const start = after === null ? 0 : items.findIndex((item) => item['id'] === after) + 1;
    const data = items.slice(start, start + limit);
    return {
      object: 'list',
      data,
      first_id: data[0]?.['id'] ?? null,
      last_id: data.at(-1)?.['id'] ?? null,
      has_more: start + limit < items.length,
    };
  }

  #listProjects(request: SimRequest): SimResponse {
    const includeArchived = request.query.get('include_archived') === 'true';
    const projects = [...this.#projects.values()]
      .map((project) => project.object)
      .filter((project) => includeArchived || project['archived_at'] === null);
    return json(200, this.#page(projects, request));
  }

  #createProject(request: SimRequest): SimResponse {
    const name = jsonBody(request)['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      return openAiError(400, 'name is required', 'invalid_request_error', 'invalid_value');
    }
    const object: OpenAiObject = {
      id: this.#context.ids.id('proj', '_', 24),
      object: 'organization.project',
      name,
      created_at: unixSeconds(this.#context.now()),
      archived_at: null,
      status: 'active',
    };
    this.#projects.set(String(object['id']), {
      object,
      serviceAccounts: new Map(),
      spendLimit: null,
    });
    return json(200, object);
  }

  #issueKey(name: string): OpenAiObject {
    const value = `sk-svcacct-${this.#context.ids.token('openai_key', 48)}`;
    this.#issuedKeys.add(value);
    return {
      object: 'organization.project.service_account.api_key',
      id: this.#context.ids.id('key', '_', 16),
      name,
      value,
      created_at: unixSeconds(this.#context.now()),
    };
  }

  #createServiceAccount(project: Project, request: SimRequest): SimResponse {
    const name = jsonBody(request)['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      return openAiError(400, 'name is required', 'invalid_request_error', 'invalid_value');
    }
    if (project.object['archived_at'] !== null) {
      return openAiError(400, 'Project is archived', 'invalid_request_error', 'project_archived');
    }
    const key = this.#issueKey('Secret Key');
    const object: OpenAiObject = {
      object: 'organization.project.service_account',
      id: this.#context.ids.id('svc_acct', '_', 24),
      name,
      role: 'member',
      created_at: unixSeconds(this.#context.now()),
    };
    project.serviceAccounts.set(String(object['id']), { object, keys: [key] });
    return json(200, { ...object, api_key: key });
  }

  #embeddings(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const inputs =
      typeof body['input'] === 'string'
        ? [body['input']]
        : Array.isArray(body['input'])
          ? body['input']
          : [];
    if (
      inputs.length === 0 ||
      !inputs.every((input): input is string => typeof input === 'string' && input.length > 0)
    ) {
      return openAiError(
        400,
        "'input' must be a non-empty string or array of strings",
        'invalid_request_error',
        null,
      );
    }
    const dimensions = typeof body['dimensions'] === 'number' ? body['dimensions'] : 1536;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 3072) {
      return openAiError(
        400,
        'dimensions must be between 1 and 3072',
        'invalid_request_error',
        null,
      );
    }
    const base64 = body['encoding_format'] === 'base64';
    const tokens = inputs.reduce((sum, input) => sum + tokenEstimate(input), 0);
    return json(200, {
      object: 'list',
      model: typeof body['model'] === 'string' ? body['model'] : 'text-embedding-3-small',
      data: inputs.map((input, index) => {
        const vector = deterministicVector(input, dimensions);
        return {
          object: 'embedding',
          index,
          embedding: base64
            ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
            : vector,
        };
      }),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  }

  #chat(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const messages = Array.isArray(body['messages'])
      ? (body['messages'] as Record<string, unknown>[])
      : [];
    if (messages.length === 0) {
      return openAiError(
        400,
        "'messages' must contain at least one message",
        'invalid_request_error',
        null,
      );
    }
    const lastUser = [...messages].reverse().find((message) => message['role'] === 'user');
    const lastText = typeof lastUser?.['content'] === 'string' ? lastUser['content'] : '';
    const scripted = this.#replies.shift();
    const jsonMode =
      typeof body['response_format'] === 'object' &&
      body['response_format'] !== null &&
      (body['response_format'] as Record<string, unknown>)['type'] === 'json_object';
    const content =
      scripted !== undefined
        ? scripted.content
        : jsonMode
          ? JSON.stringify({ score: 0.9, notes: 'Deterministic simulator evaluation.' })
          : `Simulated reply to: ${lastText.slice(0, 160)}`;
    const toolCalls = (scripted?.toolCalls ?? []).map((call) => ({
      id: this.#context.ids.id('call', '_', 24),
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
    const promptTokens = messages.reduce(
      (sum, message) =>
        sum + tokenEstimate(typeof message['content'] === 'string' ? message['content'] : ''),
      0,
    );
    const completionTokens = tokenEstimate(content ?? '');
    return json(200, {
      id: this.#context.ids.id('chatcmpl', '-', 29),
      object: 'chat.completion',
      created: unixSeconds(this.#context.now()),
      model: typeof body['model'] === 'string' ? body['model'] : 'gpt-5-mini',
      system_fingerprint: 'fp_simulator',
      choices: [
        {
          index: 0,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content,
            refusal: null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  #liveAction(request: SimRequest, action: 'accept' | 'reject' | 'refer' | 'hangup'): SimResponse {
    const session = this.#sessions.get(request.params['sessionId'] ?? '');
    if (session === undefined) {
      return openAiError(404, 'Session not found', 'invalid_request_error', 'session_not_found');
    }
    const allowed: Readonly<Record<typeof action, readonly LiveStatus[]>> = {
      accept: ['incoming'],
      reject: ['incoming'],
      refer: ['accepted'],
      hangup: ['incoming', 'accepted', 'referred'],
    };
    if (!allowed[action].includes(session.status)) {
      return openAiError(
        409,
        `Session cannot ${action} while ${session.status}`,
        'invalid_request_error',
        'invalid_session_state',
      );
    }
    const body = request.rawBody.length === 0 ? null : jsonBody(request);
    if (action === 'refer' && (body === null || typeof body['target_uri'] !== 'string')) {
      return openAiError(400, 'target_uri is required', 'invalid_request_error', null);
    }
    session.actions.push({ action, body });
    session.status =
      action === 'accept'
        ? 'accepted'
        : action === 'reject'
          ? 'rejected'
          : action === 'refer'
            ? 'referred'
            : 'ended';
    return json(200, {});
  }

  #incomingCall(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const to = body['to'];
    const from = body['from'];
    if (
      typeof to !== 'string' ||
      !/^\+[1-9]\d{6,14}$/.test(to) ||
      (from !== undefined && (typeof from !== 'string' || !/^\+[1-9]\d{6,14}$/.test(from)))
    ) {
      return json(400, { error: 'to and from must be E.164 numbers' });
    }
    const carrier = body['carrier'] === 'twilio' ? 'twilio' : 'telnyx';
    const sessionId = this.#context.ids.id('rtc', '_', 32);
    this.#sessions.set(sessionId, { id: sessionId, status: 'incoming', actions: [] });
    const sipCallId = `${this.#context.ids.token('sip_call', 20)}@simulator`;
    const headers = [
      {
        name: 'From',
        value:
          from === undefined
            ? '<sip:anonymous@sip.simulator.test>;tag=sim'
            : `<sip:${from}@sip.${carrier}.com>;tag=${this.#context.ids.token('sip_tag', 10)}`,
      },
      { name: 'To', value: `<sip:${to}@proj_simulator.sip.api.openai.com;user=phone>` },
      { name: 'Call-ID', value: sipCallId },
      ...(carrier === 'twilio'
        ? [{ name: 'X-Twilio-CallSid', value: this.#context.ids.id('CA', '', 32) }]
        : []),
    ];
    const event = {
      id: this.#context.ids.id('evt', '_', 24),
      object: 'event',
      type: 'live.call.incoming',
      created_at: unixSeconds(this.#context.now()),
      data: { session_id: sessionId, sip_headers: headers },
    };
    const target = this.#context.config.openaiWebhook;
    const tenantId = typeof body['tenant_id'] === 'string' ? body['tenant_id'] : null;
    const secret =
      typeof body['webhook_secret'] === 'string' ? body['webhook_secret'] : target?.secret;
    const url =
      target === null || secret === undefined
        ? null
        : {
            url: tenantId === null ? target.url : `${target.url.replace(/\/$/, '')}/${tenantId}`,
            secret,
          };
    this.#context.webhooks.send('openai', url, {
      id: event.id,
      type: event.type,
      payload: JSON.stringify(event),
    });
    return json(202, { session_id: sessionId, event_id: event.id, delivered_to: url?.url ?? null });
  }
}
