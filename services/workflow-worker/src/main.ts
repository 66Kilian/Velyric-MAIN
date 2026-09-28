import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { connect, credsAuthenticator } from '@nats-io/transport-node';
import {
  NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX,
  NATS_WORKFLOW_QUEUE_GROUP,
} from '@velyric/contracts';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { createDatabase, type DB } from '@velyric/db';
import { systemResolver, type ReplayGuard } from '@velyric/security';
import {
  AwsTenantSecrets,
  LocalVaultTenantSecrets,
  RoutingTenantSecrets,
} from '@velyric/tenant-secrets';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import pino from 'pino';
import { createBillingActivities } from './activities/billing.js';
import { createGuestNotificationActivities } from './activities/guest-notifications.js';
import { createNotificationActivity } from './activities/notifications.js';
import { createPrivacyActivities } from './activities/privacy.js';
import { createRetentionActivities } from './activities/retention.js';
import { ensureRetentionSchedule } from './schedules.js';
import { createProvisioningActivities } from './activities/provisioning.js';
import type { ActivityDependencies } from './activities/support.js';
import {
  ConfigError,
  loadWorkflowWorkerConfig,
  providerBaseUrl,
  type SecretResolver,
} from './config.js';
import { DomainEventConsumer, ensureStreams } from './consumer.js';
import { handleControlMessage } from './control.js';
import { HttpBillingoApi } from './providers/billingo.js';
import { SmtpEmailSender } from './providers/email.js';
import { OpenAiSdkProjectAdmin } from './providers/openai-admin.js';
import { StripeSdkBillingGateway } from './providers/stripe.js';
import { TelnyxSdkCarrier } from './providers/telnyx.js';
import { recoverOrphanedProvisioning } from './recovery.js';
import { DomainEventRouter, KyselyRouterRepository, TemporalWorkflowGateway } from './router.js';

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

function workflowsPath(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './workflows/index.ts' : './workflows/index.js',
      import.meta.url,
    ),
  );
}

async function main(): Promise<void> {
  const region = process.env['VELYRIC_AWS_REGION'] ?? 'eu-central-1';
  const secretsManager = new SecretsManagerClient({ region });
  const config = await loadWorkflowWorkerConfig(
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
    base: { service: 'workflow-worker', environment: config.environment },
  });

  const db = createDatabase<DB>({
    connectionString: config.databaseUrl,
    applicationName: 'workflow-worker',
    maxConnections: 20,
    ...(config.databaseAssumeRole ? { assumeRole: 'velyric_app' as const } : {}),
  });
  await sql`SELECT 1`.execute(db);

  const deps: ActivityDependencies = {
    db,
    secrets: new RoutingTenantSecrets({
      aws:
        config.localVaultDir !== null && config.environment === 'local'
          ? null
          : new AwsTenantSecrets(secretsManager),
      local:
        config.localVaultDir === null ? null : new LocalVaultTenantSecrets(config.localVaultDir),
    }),
    openai: new OpenAiSdkProjectAdmin(config.openAiAdminKey, providerBaseUrl(config, 'OPENAI')),
    carrier: new TelnyxSdkCarrier(config.telnyx.apiKey, providerBaseUrl(config, 'TELNYX')),
    billingo: new HttpBillingoApi(config.billingo.apiKey, providerBaseUrl(config, 'BILLINGO')),
    billing: new StripeSdkBillingGateway(
      config.stripeSecretKey,
      config.providerModes.STRIPE === 'simulator' ? config.simulatorUrl : null,
    ),
    email: new SmtpEmailSender(config.email.smtpUrl, config.email.from),
    tenantEmail: {
      environment: config.environment,
      resolver: systemResolver,
      google: config.googleOauth,
    },
    settings: {
      environment: config.environment,
      webOrigin: config.webOrigin,
      telnyxConnectionId: config.telnyx.connectionId,
      billingoBlockId: config.billingo.blockId,
      openAiMonthlySpendLimitUsd: config.openAiMonthlySpendLimitUsd,
    },
    now: () => new Date(),
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
  };

  const temporalOptions = {
    address: config.temporal.address,
    tls: config.temporal.tls,
    ...(config.temporal.apiKey === null ? {} : { apiKey: config.temporal.apiKey }),
  };
  const nativeConnection = await NativeConnection.connect(temporalOptions);
  const clientConnection = await Connection.connect(temporalOptions);
  const client = new Client({ connection: clientConnection, namespace: config.temporal.namespace });
  await ensureRetentionSchedule(client);
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: workflowsPath() });
  const workers = await Promise.all([
    Worker.create({
      connection: nativeConnection,
      namespace: config.temporal.namespace,
      taskQueue: 'provisioning',
      workflowBundle,
      activities: createProvisioningActivities(deps),
      maxConcurrentActivityTaskExecutions: 20,
    }),
    Worker.create({
      connection: nativeConnection,
      namespace: config.temporal.namespace,
      taskQueue: 'billing',
      workflowBundle,
      activities: createBillingActivities(deps),
      maxConcurrentActivityTaskExecutions: 20,
    }),
    Worker.create({
      connection: nativeConnection,
      namespace: config.temporal.namespace,
      taskQueue: 'notifications',
      workflowBundle,
      activities: {
        notify: createNotificationActivity(deps),
        ...createGuestNotificationActivities(deps),
      },
      maxConcurrentActivityTaskExecutions: 20,
    }),
    Worker.create({
      connection: nativeConnection,
      namespace: config.temporal.namespace,
      taskQueue: 'retention',
      workflowBundle,
      activities: { ...createPrivacyActivities(deps), ...createRetentionActivities(deps) },
      maxConcurrentActivityTaskExecutions: 4,
    }),
  ]);

  let draining = false;
  const nats = await connect({
    servers: config.natsUrl.split(',').map((server) => server.trim()),
    name: 'workflow-worker',
    ...(config.natsCreds === null
      ? {}
      : { authenticator: credsAuthenticator(new TextEncoder().encode(config.natsCreds)) }),
  });
  await ensureStreams(nats, config.streamReplicas);
  const gateway = new TemporalWorkflowGateway(client);
  const router = new DomainEventRouter({
    gateway,
    repository: new KyselyRouterRepository(db),
    logger,
  });
  const restartedAfterFailure = new Set<string>();
  const recoverProvisioning = (): void => {
    recoverOrphanedProvisioning({
      db,
      client,
      gateway,
      logger,
      restartedAfterFailure,
    }).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : 'unknown' },
        'provisioning recovery failed',
      );
    });
  };
  const recoveryStart = setTimeout(recoverProvisioning, 30_000);
  const recoveryTimer = setInterval(recoverProvisioning, 10 * 60_000);
  const consumer = new DomainEventConsumer({ nats, router, logger });

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
  const controlDeps = {
    activities: deps,
    verifier: {
      audience: 'workflow-worker' as const,
      jwks: JSON.parse(config.serviceJwks) as never,
      replayGuard,
    },
    gateway,
  };
  let controlInFlight = 0;
  const controlSubscription = nats.subscribe(`${NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX}.*`, {
    queue: NATS_WORKFLOW_QUEUE_GROUP,
  });
  const controlLoop = (async () => {
    for await (const message of controlSubscription) {
      if (message.reply === undefined || message.reply === '') {
        continue;
      }
      controlInFlight += 1;
      void handleControlMessage(controlDeps, {
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
            'provisioning control handler crashed',
          );
          message.respond(JSON.stringify({ ok: false, error_code: 'INTERNAL_ERROR' }));
        })
        .finally(() => {
          controlInFlight -= 1;
        });
    }
  })();

  const health = createServer((request, response) => {
    const send = (status: number, body: unknown, contentType = 'application/json'): void => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (request.url === '/healthz/live') {
      send(200, { status: 'ok' });
      return;
    }
    const states = workers.map((worker) => worker.getState());
    if (request.url === '/healthz/ready') {
      const ready =
        !draining &&
        !nats.isClosed() &&
        redis.status === 'ready' &&
        states.every((state) => state === 'RUNNING');
      send(ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable', workers: states });
      return;
    }
    if (request.url === '/metrics') {
      const lines = [
        '# TYPE velyric_workflow_worker_running gauge',
        ...workers.map(
          (worker, index) =>
            `velyric_workflow_worker_running{task_queue="${worker.options.taskQueue}"} ${states[index] === 'RUNNING' ? '1' : '0'}`,
        ),
      ];
      send(200, `${lines.join('\n')}\n`, 'text/plain; version=0.0.4');
      return;
    }
    send(404, { code: 'NOT_FOUND' });
  });

  const shutdown = async (): Promise<void> => {
    if (draining) {
      return;
    }
    draining = true;
    clearTimeout(recoveryStart);
    clearInterval(recoveryTimer);
    controlSubscription.unsubscribe();
    const deadline = Date.now() + 30_000;
    while (controlInFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await controlLoop.catch(() => undefined);
    await consumer.stop().catch(() => undefined);
    await nats.drain().catch(() => undefined);
    for (const worker of workers) {
      if (worker.getState() === 'RUNNING') {
        worker.shutdown();
      }
    }
    await Promise.all(running);
    await nativeConnection.close();
    await clientConnection.close();
    health.close();
    await db.destroy();
    redis.disconnect();
    logger.info({}, 'workflow worker stopped');
  };

  const running = workers.map((worker) =>
    worker.run().catch((error: unknown) => {
      logger.fatal(
        {
          err: error instanceof Error ? error.message : String(error),
          task_queue: worker.options.taskQueue,
        },
        'temporal worker crashed',
      );
      process.exitCode = 1;
      void shutdown().then(() => process.exit());
    }),
  );
  await consumer.start();
  await new Promise<void>((resolve) => health.listen(config.port, config.host, resolve));
  logger.info(
    { port: config.port, namespace: config.temporal.namespace },
    'workflow worker listening',
  );

  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit());
  });
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit());
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
