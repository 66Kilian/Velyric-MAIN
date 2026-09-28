import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_CALENDAR_ACCOUNTS,
  DEFAULT_CREDENTIALS,
  DEFAULT_USERS,
  type ProviderModule,
  type ResolvedSimulatorConfig,
  type SimulatorContext,
  type SimulatorCredentials,
  type StripePrice,
  type SyntheticUser,
} from './context.js';
import { FaultInjector, isSimulatedProvider, type SimulatedProvider } from './faults.js';
import {
  json,
  jsonBody,
  Router,
  SimulatorHttpError,
  type SimRequest,
  type SimResponse,
} from './http.js';
import { BillingoSimulator } from './providers/billingo.js';
import { CalendarSimulator } from './providers/calendar.js';
import { OpenAiSimulator } from './providers/openai.js';
import { StripeSimulator } from './providers/stripe.js';
import { TelnyxSimulator } from './providers/telnyx.js';
import { WorkosSimulator } from './providers/workos.js';
import { DeterministicIds } from './state.js';
import { WebhookDispatcher, type WebhookDelivery, type WebhookTarget } from './webhooks.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface ProviderSimulatorOptions {
  readonly environment: string;
  readonly host?: string;
  readonly port?: number;
  readonly seed?: string;
  readonly sequenceOffset?: number;
  readonly publicUrl?: string;
  readonly credentials?: Partial<SimulatorCredentials>;
  readonly users?: readonly SyntheticUser[];
  readonly calendarAccounts?: readonly string[];
  readonly stripePrices?: readonly StripePrice[];
  readonly stripeWebhook?: WebhookTarget | null;
  readonly openaiWebhook?: WebhookTarget | null;
  readonly telnyxOrderApprovalMs?: number;
  readonly now?: () => Date;
}

export interface ProviderSimulator {
  readonly url: string;
  readonly port: number;
  deliveries(): readonly WebhookDelivery[];
  idle(): Promise<void>;
  reset(): void;
  close(): Promise<void>;
}

export class SimulatorEnvironmentError extends Error {
  constructor(environment: string) {
    super(
      `the provider simulator only runs when VELYRIC_ENV is local or ci (got ${environment || 'unset'})`,
    );
    this.name = 'SimulatorEnvironmentError';
  }
}

function providerForPath(path: string): SimulatedProvider | null {
  const segment = path.split('/')[1] ?? '';
  if (isSimulatedProvider(segment)) {
    return segment;
  }
  if (path.startsWith('/user_management/') || path.startsWith('/sso/')) {
    return 'workos';
  }
  if (path.startsWith('/v1/')) {
    return 'stripe';
  }
  return null;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SimulatorHttpError(json(413, { error: 'payload_too_large' })));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function send(response: ServerResponse, result: SimResponse): void {
  response.writeHead(result.status, result.headers ?? {});
  response.end(result.body);
}

export async function startProviderSimulator(
  options: ProviderSimulatorOptions,
): Promise<ProviderSimulator> {
  if (options.environment !== 'local' && options.environment !== 'ci') {
    throw new SimulatorEnvironmentError(options.environment);
  }
  const now = options.now ?? (() => new Date());
  const webhooks = new WebhookDispatcher(now);
  const faults = new FaultInjector();
  let config: ResolvedSimulatorConfig | null = null;
  let modules: ProviderModule[] = [];
  let api = new Router();
  let control = new Router();

  const build = (resolved: ResolvedSimulatorConfig): void => {
    const context: SimulatorContext = {
      config: resolved,
      ids: new DeterministicIds(resolved.seed, options.sequenceOffset ?? 0),
      webhooks,
      now,
    };
    modules = [
      new WorkosSimulator(context),
      new StripeSimulator(context),
      new OpenAiSimulator(context),
      new TelnyxSimulator(context),
      new BillingoSimulator(context),
      new CalendarSimulator(context, 'google'),
      new CalendarSimulator(context, 'microsoft'),
    ];
    api = new Router();
    control = new Router();
    for (const module of modules) {
      module.register(api, control);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://simulator.local');
    const method = request.method ?? 'GET';
    const rawBody = await readBody(request);
    const simRequest = (params: Record<string, string>): SimRequest => ({
      method,
      path: url.pathname,
      params,
      query: url.searchParams,
      headers: request.headers,
      rawBody,
      baseUrl: config?.publicUrl ?? '',
    });

    if (url.pathname.startsWith('/_control/')) {
      const builtIn = handleControl(method, url.pathname, simRequest({}));
      if (builtIn !== null) {
        send(response, builtIn);
        return;
      }
      const matched = control.match(method, url.pathname);
      send(
        response,
        matched === null || matched === 'METHOD_NOT_ALLOWED'
          ? json(404, { error: 'control_endpoint_not_found' })
          : await matched.handler(simRequest(matched.params)),
      );
      return;
    }

    const provider = providerForPath(url.pathname);
    const providerPath =
      provider !== null && url.pathname.startsWith(`/${provider}/`)
        ? url.pathname.slice(provider.length + 1)
        : url.pathname;
    const fault = provider === null ? null : faults.take(provider, method, providerPath);
    if (fault !== null) {
      if (fault.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fault.latencyMs));
      }
      if (fault.timeout) {
        request.socket.destroy();
        return;
      }
      if (fault.status !== null) {
        send(
          response,
          json(
            fault.status,
            {
              error: {
                code: fault.errorCode ?? `simulated_${String(fault.status)}`,
                message: 'Fault injected by the provider simulator.',
              },
            },
            fault.status === 429 ? { 'retry-after': '1' } : {},
          ),
        );
        return;
      }
    }
    const matched = api.match(method, url.pathname);
    if (matched === null) {
      send(
        response,
        json(404, {
          error: {
            code: 'not_found',
            message: `The simulator does not implement ${method} ${url.pathname}`,
          },
        }),
      );
      return;
    }
    if (matched === 'METHOD_NOT_ALLOWED') {
      send(
        response,
        json(405, {
          error: {
            code: 'method_not_allowed',
            message: `${method} is not supported for ${url.pathname}`,
          },
        }),
      );
      return;
    }
    send(response, await matched.handler(simRequest(matched.params)));
  };

  const handleControl = (method: string, path: string, request: SimRequest): SimResponse | null => {
    if (method === 'GET' && path === '/_control/health') {
      return json(200, {
        status: 'ok',
        environment: options.environment,
        seed: config?.seed ?? null,
      });
    }
    if (method === 'GET' && path === '/_control/state') {
      return json(200, {
        providers: Object.fromEntries(
          modules.map((module, index) => [
            ['workos', 'stripe', 'openai', 'telnyx', 'billingo', 'google', 'microsoft'][index] ??
              String(index),
            module.snapshot(),
          ]),
        ),
        faults: faults.list(),
        webhook_deliveries: webhooks.deliveries,
      });
    }
    if (method === 'POST' && path === '/_control/reset') {
      faults.clear();
      if (config !== null) {
        build(config);
      }
      return json(200, { reset: true });
    }
    if (method === 'POST' && path === '/_control/faults') {
      const body = jsonBody(request);
      if (!isSimulatedProvider(body['provider'])) {
        return json(400, { error: 'provider is required' });
      }
      try {
        const rule = faults.add({
          provider: body['provider'],
          ...(typeof body['method'] === 'string' ? { method: body['method'] } : {}),
          ...(typeof body['path_prefix'] === 'string' ? { pathPrefix: body['path_prefix'] } : {}),
          ...(typeof body['status'] === 'number' ? { status: body['status'] } : {}),
          ...(typeof body['latency_ms'] === 'number' ? { latencyMs: body['latency_ms'] } : {}),
          ...(body['timeout'] === true ? { timeout: true } : {}),
          ...(typeof body['error_code'] === 'string' ? { errorCode: body['error_code'] } : {}),
          ...(typeof body['times'] === 'number' ? { times: body['times'] } : {}),
        });
        return json(201, rule);
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : 'invalid_fault' });
      }
    }
    if (method === 'DELETE' && path === '/_control/faults') {
      const provider = request.query.get('provider');
      return json(200, {
        removed: faults.clear(isSimulatedProvider(provider) ? provider : undefined),
      });
    }
    return null;
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(
        response,
        error instanceof SimulatorHttpError
          ? error.response
          : json(500, {
              error: {
                code: 'simulator_error',
                message: error instanceof Error ? error.message : 'unexpected simulator failure',
              },
            }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host =
    options.host === undefined || options.host === '0.0.0.0' ? '127.0.0.1' : options.host;
  const url = `http://${host}:${String(address.port)}`;
  const resolved: ResolvedSimulatorConfig = {
    seed: options.seed ?? 'velyric-simulator',
    publicUrl: (options.publicUrl ?? url).replace(/\/$/, ''),
    credentials: { ...DEFAULT_CREDENTIALS, ...options.credentials },
    users: options.users ?? DEFAULT_USERS,
    calendarAccounts: options.calendarAccounts ?? DEFAULT_CALENDAR_ACCOUNTS,
    stripePrices: options.stripePrices ?? [],
    stripeWebhook: options.stripeWebhook ?? null,
    openaiWebhook: options.openaiWebhook ?? null,
    telnyxOrderApprovalMs: options.telnyxOrderApprovalMs ?? 2_000,
  };
  config = resolved;
  build(resolved);

  return {
    url,
    port: address.port,
    deliveries: () => webhooks.deliveries,
    idle: () => webhooks.idle(),
    reset: () => {
      faults.clear();
      build(resolved);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error?: Error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
