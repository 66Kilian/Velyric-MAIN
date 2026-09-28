import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { connect, credsAuthenticator } from '@nats-io/transport-node';
import {
  NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX,
  NATS_CONNECTOR_QUEUE_GROUP,
} from '@velyric/contracts';
import { createDatabase, type DB } from '@velyric/db';
import { systemResolver, type HostResolver, type ReplayGuard } from '@velyric/security';
import {
  AwsTenantSecrets,
  LocalVaultTenantSecrets,
  RoutingTenantSecrets,
} from '@velyric/tenant-secrets';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import pino from 'pino';
import {
  ConfigError,
  SIMULATOR_HOSTNAME,
  loadConnectorWorkerConfig,
  type CalendarProviderConfig,
  type SecretResolver,
} from './config.js';
import { CalendarConnector } from './connectors/calendar.js';
import { executeMessage } from './executor.js';
import { CustomApiExecutor } from './tools/custom-api.js';
import { WebhookDeliveryWorker } from './webhooks/delivery.js';

class AwsSecretResolver implements SecretResolver {
  readonly #client: SecretsManagerClient;

  constructor(client: SecretsManagerClient) {
    this.#client = client;
  }

  async resolve(arn: string): Promise<string> {
    const output = await this.#client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (output.SecretString === undefined) {
      throw new Error('SecretStringMissing');
    }
    return output.SecretString;
  }
}

function simulatorResolver(provider: CalendarProviderConfig): HostResolver | undefined {
  const upstream = provider.simulatorUpstreamHost;
  if (upstream === null) {
    return undefined;
  }
  return (hostname) => {
    if (hostname !== SIMULATOR_HOSTNAME) {
      return systemResolver(hostname);
    }
    const family = isIP(upstream);
    return family === 0
      ? systemResolver(upstream)
      : Promise.resolve([{ address: upstream, family: family === 6 ? 6 : 4 }]);
  };
}

async function main(): Promise<void> {
  const region = process.env['VELYRIC_AWS_REGION'] ?? 'eu-central-1';
  const secretsManager = new SecretsManagerClient({ region });
  const config = await loadConnectorWorkerConfig(
    process.env,
    new AwsSecretResolver(secretsManager),
  ).catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78);
    }
    throw error;
  });
  const logger = pino({
    level: config.logLevel,
    base: { service: 'connector-worker', environment: config.environment },
  });

  const db = createDatabase<DB>({
    connectionString: config.databaseUrl,
    applicationName: 'connector-worker',
    maxConnections: 20,
    ...(config.databaseAssumeRole ? { assumeRole: 'velyric_app' as const } : {}),
  });
  await sql`SELECT 1`.execute(db);

  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  const replayGuard: ReplayGuard = async (issuer, jti, ttlSeconds) =>
    (await redis.set(
      `vly:${config.environment}:jti:${issuer}:${jti}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    )) === 'OK';

  const secrets = new RoutingTenantSecrets({
    aws:
      config.environment === 'local' && config.localVaultDir !== null
        ? null
        : new AwsTenantSecrets(secretsManager),
    local: config.localVaultDir === null ? null : new LocalVaultTenantSecrets(config.localVaultDir),
  });
  const calendarOptions = {
    db,
    secrets,
    environment: config.environment,
    allowHttp: config.egressAllowHttp,
  };
  const googleResolver = simulatorResolver(config.google);
  const microsoftResolver = simulatorResolver(config.microsoft);
  const calendars = {
    google_calendar: new CalendarConnector({
      ...calendarOptions,
      provider: 'google',
      config: config.google,
      ...(googleResolver === undefined ? {} : { resolver: googleResolver }),
    }),
    microsoft_365: new CalendarConnector({
      ...calendarOptions,
      provider: 'microsoft',
      config: config.microsoft,
      ...(microsoftResolver === undefined ? {} : { resolver: microsoftResolver }),
    }),
  };
  const customApi = new CustomApiExecutor({
    secrets,
    environment: config.environment,
    allowHttp: config.egressAllowHttp,
  });
  const webhookDeliveries = new WebhookDeliveryWorker({
    db,
    secrets,
    environment: config.environment,
    workerId: `connector-worker-${String(process.pid)}-${randomUUID()}`,
    logger: {
      info: (details, message) => {
        logger.info(details, message);
      },
      warn: (details, message) => {
        logger.warn(details, message);
      },
      error: (details, message) => {
        logger.error(details, message);
      },
    },
  });
  webhookDeliveries.start();

  const nats = await connect({
    servers: config.natsUrl.split(',').map((server) => server.trim()),
    name: 'connector-worker',
    ...(config.natsCreds === null
      ? {}
      : { authenticator: credsAuthenticator(new TextEncoder().encode(config.natsCreds)) }),
  });
  const deps = {
    db,
    verifier: {
      audience: 'connector-worker' as const,
      jwks: JSON.parse(config.serviceJwks) as never,
      replayGuard,
    },
    calendars,
    customApi,
    now: () => new Date(),
    logger: {
      warn: (details: Record<string, unknown>, message: string) => {
        logger.warn(details, message);
      },
      error: (details: Record<string, unknown>, message: string) => {
        logger.error(details, message);
      },
    },
  };

  let inFlight = 0;
  const subscription = nats.subscribe(`${NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX}.*`, {
    queue: NATS_CONNECTOR_QUEUE_GROUP,
  });
  const consume = (async () => {
    for await (const message of subscription) {
      if (message.reply === undefined || message.reply === '') {
        continue;
      }
      inFlight += 1;
      void executeMessage(deps, {
        subject: message.subject,
        authorization: message.headers?.get('authorization') ?? null,
        traceparent: message.headers?.get('traceparent') ?? null,
        payload: message.data,
      })
        .then((reply) => {
          message.respond(JSON.stringify(reply));
        })
        .catch((error: unknown) => {
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              subject: message.subject,
            },
            'connector execution crashed',
          );
          message.respond(
            JSON.stringify({
              status: 'FAILED',
              result: null,
              error_code: 'INTERNAL_ERROR',
              retryable: true,
              http_status: null,
            }),
          );
        })
        .finally(() => {
          inFlight -= 1;
        });
    }
  })();

  let draining = false;
  const health = createServer((request, response) => {
    const send = (status: number, body: unknown, contentType = 'application/json'): void => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (request.url === '/healthz/live') {
      send(200, { status: 'ok' });
      return;
    }
    if (request.url === '/healthz/ready') {
      const ready = !draining && !nats.isClosed() && redis.status === 'ready';
      send(ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable', in_flight: inFlight });
      return;
    }
    if (request.url === '/metrics') {
      send(
        200,
        `# TYPE velyric_connector_worker_in_flight gauge\nvelyric_connector_worker_in_flight ${String(inFlight)}\n`,
        'text/plain; version=0.0.4',
      );
      return;
    }
    send(404, { code: 'NOT_FOUND' });
  });
  await new Promise<void>((resolve) => health.listen(config.port, config.host, resolve));
  logger.info({ port: config.port }, 'connector worker listening');

  const shutdown = async (): Promise<void> => {
    if (draining) {
      return;
    }
    draining = true;
    subscription.unsubscribe();
    await webhookDeliveries.stop();
    const deadline = Date.now() + 15_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await nats.drain();
    await consume.catch(() => undefined);
    health.close();
    await db.destroy();
    redis.disconnect();
    logger.info({ in_flight: inFlight }, 'connector worker stopped');
  };
  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
