import { VelyricEnvironment } from './enums.js';
import type {
  CallDirection,
  EventType,
  ProviderCapability,
  ProviderId,
  UsageMetric,
} from './enums.js';
import type { EnumValue } from './enum-utils.js';

export const LOCAL_SERVICE_PORTS = Object.freeze({
  web: 3000,
  controlApiPublic: 4000,
  controlApiInternal: 4001,
  providerSimulator: 4010,
  voiceRuntimePublic: 7000,
  voiceRuntimeAdmin: 7001,
  meteringWorker: 7100,
  workflowWorker: 7200,
  connectorWorker: 7300,
  documentWorker: 7400,
  evalRunner: 7500,
});

export const LOCAL_INFRA_PORTS = Object.freeze({
  postgres: 55432,
  redis: 56379,
  nats: 54222,
  natsMonitoring: 58222,
  temporal: 57233,
  temporalUi: 58233,
  minioApi: 59000,
  minioConsole: 59001,
  mailpitSmtp: 51025,
  mailpitUi: 58025,
  clamav: 53310,
  otelCollectorGrpc: 54317,
  otelCollectorHttp: 54318,
  grafana: 53000,
});

export const NatsStream = {
  CALL_EVENTS: 'CALL_EVENTS',
  USAGE: 'USAGE',
  DOMAIN: 'DOMAIN',
  JOBS: 'JOBS',
  DEAD_LETTER: 'DEAD_LETTER',
} as const;
export type NatsStream = EnumValue<typeof NatsStream>;

export const NATS_STREAM_SUBJECTS: Readonly<Record<NatsStream, readonly string[]>> = Object.freeze({
  CALL_EVENTS: Object.freeze(['call.v1.>']),
  USAGE: Object.freeze(['usage.v1.>']),
  DOMAIN: Object.freeze(['domain.v1.>']),
  JOBS: Object.freeze(['jobs.v1.>']),
  DEAD_LETTER: Object.freeze(['dlq.v1.>']),
});

export const JobQueue = {
  KNOWLEDGE_INGEST: 'knowledge_ingest',
  QUALITY_SCORE: 'quality_score',
  SIMULATION_RUN: 'simulation_run',
  CONNECTOR_SYNC: 'connector_sync',
  EXPORT_BUILD: 'export_build',
} as const;
export type JobQueue = EnumValue<typeof JobQueue>;

export const TemporalTaskQueue = {
  PROVISIONING: 'provisioning',
  BILLING: 'billing',
  NOTIFICATIONS: 'notifications',
  RETENTION: 'retention',
  KNOWLEDGE: 'knowledge',
  SIMULATIONS: 'simulations',
  RECONCILIATION: 'reconciliation',
} as const;
export type TemporalTaskQueue = EnumValue<typeof TemporalTaskQueue>;

export const S3BucketPurpose = {
  KNOWLEDGE: 'knowledge',
  ARTIFACTS: 'artifacts',
  RECORDINGS: 'recordings',
  EXPORTS: 'exports',
  EVIDENCE: 'evidence',
  TRANSIENT: 'transient',
} as const;
export type S3BucketPurpose = EnumValue<typeof S3BucketPurpose>;

export const RateLimitScope = {
  IP: 'ip',
  USER: 'user',
  TENANT: 'tenant',
  API_KEY: 'api_key',
  WEBHOOK: 'webhook',
  WIDGET: 'widget',
} as const;
export type RateLimitScope = EnumValue<typeof RateLimitScope>;

export const NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX = 'svc.v1.connector.execute';
export const NATS_CONNECTOR_QUEUE_GROUP = 'connector-worker';
export const NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX = 'svc.v1.provisioning';
export const NATS_WORKFLOW_QUEUE_GROUP = 'workflow-worker';

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const REGION = /^[a-z]{2}-[a-z-]{3,20}-\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OBJECT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BUCKET_PREFIX = /^[a-z0-9][a-z0-9-]{2,40}$/;

function segment(value: string, label: string): string {
  if (!SEGMENT.test(value)) {
    throw new RangeError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function region(value: string): string {
  if (!REGION.test(value)) {
    throw new RangeError(`Invalid region: ${JSON.stringify(value)}`);
  }
  return value;
}

function isoDate(value: string): string {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RangeError(`Invalid ISO date: ${JSON.stringify(value)}`);
  }
  return value;
}

function sha256Hex(value: string, label: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new RangeError(`Invalid ${label}: expected lowercase sha256 hex`);
  }
  return value;
}

function positiveInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid ${label}: ${String(value)}`);
  }
  return String(value);
}

function environment(value: VelyricEnvironment): VelyricEnvironment {
  if (!Object.values(VelyricEnvironment).includes(value)) {
    throw new RangeError(`Invalid environment: ${JSON.stringify(value)}`);
  }
  return value;
}

export const natsSubjects = Object.freeze({
  callEvent: (tenantId: string, callId: string, eventType: EventType): string =>
    `call.v1.${segment(tenantId, 'tenant id')}.${segment(callId, 'call id')}.${eventType}`,
  usage: (tenantId: string, metric: UsageMetric): string =>
    `usage.v1.${segment(tenantId, 'tenant id')}.${metric}`,
  domain: (tenantId: string | null, eventType: EventType): string =>
    `domain.v1.${tenantId === null ? 'platform' : segment(tenantId, 'tenant id')}.${eventType}`,
  job: (queue: JobQueue, tenantId: string): string =>
    `jobs.v1.${queue}.${segment(tenantId, 'tenant id')}`,
  deadLetter: (stream: NatsStream, consumer: string): string =>
    `dlq.v1.${stream}.${segment(consumer, 'consumer name')}`,
  runtimeCommand: (tenantId: string, callId: string): string =>
    `runtime.v1.cmd.${segment(tenantId, 'tenant id')}.${segment(callId, 'call id')}`,
  connectorExecute: (tenantId: string): string =>
    `${NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX}.${segment(tenantId, 'tenant id')}`,
  provisioningControl: (tenantId: string): string =>
    `${NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX}.${segment(tenantId, 'tenant id')}`,
});

function redisPrefix(env: VelyricEnvironment): string {
  return `vly:${environment(env)}`;
}

function callScope(env: VelyricEnvironment, tenantId: string, callId: string): string {
  return `${redisPrefix(env)}:call:${segment(tenantId, 'tenant id')}:${segment(callId, 'call id')}`;
}

export const redisKeys = Object.freeze({
  callState: (env: VelyricEnvironment, tenantId: string, callId: string): string =>
    `${callScope(env, tenantId, callId)}:state`,
  callToolBudget: (env: VelyricEnvironment, tenantId: string, callId: string): string =>
    `${callScope(env, tenantId, callId)}:tool_budget`,
  callSpend: (env: VelyricEnvironment, tenantId: string, callId: string): string =>
    `${callScope(env, tenantId, callId)}:spend`,
  callLock: (env: VelyricEnvironment, tenantId: string, callId: string, lockName: string): string =>
    `${callScope(env, tenantId, callId)}:lock:${segment(lockName, 'lock name')}`,
  tenantAdmission: (env: VelyricEnvironment, tenantId: string): string =>
    `${redisPrefix(env)}:adm:tenant:${segment(tenantId, 'tenant id')}`,
  locationAdmission: (env: VelyricEnvironment, tenantId: string, locationId: string): string =>
    `${redisPrefix(env)}:adm:location:${segment(tenantId, 'tenant id')}:${segment(locationId, 'location id')}`,
  numberAdmission: (env: VelyricEnvironment, tenantId: string, phoneNumberId: string): string =>
    `${redisPrefix(env)}:adm:number:${segment(tenantId, 'tenant id')}:${segment(phoneNumberId, 'phone number id')}`,
  globalAdmission: (env: VelyricEnvironment, awsRegion: string): string =>
    `${redisPrefix(env)}:adm:global:${region(awsRegion)}`,
  providerAdmission: (env: VelyricEnvironment, provider: ProviderId, awsRegion: string): string =>
    `${redisPrefix(env)}:adm:provider:${provider}:${region(awsRegion)}`,
  cpsBucket: (
    env: VelyricEnvironment,
    provider: ProviderId,
    awsRegion: string,
    direction: CallDirection,
  ): string =>
    `${redisPrefix(env)}:cps:${provider}:${region(awsRegion)}:${direction.toLowerCase()}`,
  rateLimit: (
    env: VelyricEnvironment,
    scope: RateLimitScope,
    subjectId: string,
    bucket: string,
  ): string =>
    `${redisPrefix(env)}:rl:${scope}:${segment(subjectId, 'rate limit subject')}:${segment(bucket, 'rate limit bucket')}`,
  tenantDailySpend: (env: VelyricEnvironment, tenantId: string, date: string): string =>
    `${redisPrefix(env)}:spend:${segment(tenantId, 'tenant id')}:${isoDate(date)}`,
  agentSnapshot: (env: VelyricEnvironment, tenantId: string, agentVersionId: string): string =>
    `${redisPrefix(env)}:snap:agent:${segment(tenantId, 'tenant id')}:${segment(agentVersionId, 'agent version id')}`,
  bookingSlotLock: (
    env: VelyricEnvironment,
    tenantId: string,
    resourceId: string,
    slotStartEpochSeconds: number,
  ): string => {
    if (!Number.isSafeInteger(slotStartEpochSeconds) || slotStartEpochSeconds < 0) {
      throw new RangeError('Invalid slot start epoch seconds');
    }
    return `${redisPrefix(env)}:booking:${segment(tenantId, 'tenant id')}:${segment(resourceId, 'resource id')}:${String(slotStartEpochSeconds)}`;
  },
  idempotencyInFlight: (env: VelyricEnvironment, tenantId: string, keyHash: string): string =>
    `${redisPrefix(env)}:idem:${segment(tenantId, 'tenant id')}:${sha256Hex(keyHash, 'idempotency key hash')}`,
  oauthState: (env: VelyricEnvironment, stateHash: string): string =>
    `${redisPrefix(env)}:oauth_state:${sha256Hex(stateHash, 'oauth state hash')}`,
  providerHealth: (
    env: VelyricEnvironment,
    provider: ProviderId,
    awsRegion: string,
    capability: ProviderCapability,
  ): string => `${redisPrefix(env)}:provider_health:${provider}:${region(awsRegion)}:${capability}`,
  runtimeInstance: (env: VelyricEnvironment, instanceId: string): string =>
    `${redisPrefix(env)}:runtime:instance:${segment(instanceId, 'instance id')}`,
});

export const s3 = Object.freeze({
  bucketName: (bucketPrefix: string, purpose: S3BucketPurpose): string => {
    if (!BUCKET_PREFIX.test(bucketPrefix)) {
      throw new RangeError(`Invalid bucket prefix: ${JSON.stringify(bucketPrefix)}`);
    }
    return `${bucketPrefix}-${purpose}`;
  },
  tenantObjectKey: (
    tenantId: string,
    domain: string,
    objectId: string,
    version: number,
    filename: string,
  ): string => {
    const versionText = positiveInteger(version, 'object version');
    if (!OBJECT_FILENAME.test(filename)) {
      throw new RangeError(`Invalid object filename: ${JSON.stringify(filename)}`);
    }
    return `tenants/${segment(tenantId, 'tenant id')}/${segment(domain, 'object domain')}/${segment(objectId, 'object id')}/v${versionText}/${filename}`;
  },
});

export const temporalWorkflowIds = Object.freeze({
  provisioning: (orderId: string): string => `provisioning:${segment(orderId, 'order id')}`,
  subscriptionLifecycle: (tenantId: string): string =>
    `subscription-lifecycle:${segment(tenantId, 'tenant id')}`,
  renewalReminders: (tenantId: string, periodEndDate: string): string =>
    `renewal-reminders:${segment(tenantId, 'tenant id')}:${isoDate(periodEndDate)}`,
  dunning: (tenantId: string, stripeInvoiceId: string): string =>
    `dunning:${segment(tenantId, 'tenant id')}:${segment(stripeInvoiceId, 'stripe invoice id')}`,
  invoiceIssuance: (stripeInvoiceId: string): string =>
    `invoice:${segment(stripeInvoiceId, 'stripe invoice id')}`,
  reactivation: (tenantId: string, stripeInvoiceId: string): string =>
    `reactivation:${segment(tenantId, 'tenant id')}:${segment(stripeInvoiceId, 'stripe invoice id')}`,
  cancellation: (tenantId: string, stripeSubscriptionId: string): string =>
    `cancellation:${segment(tenantId, 'tenant id')}:${segment(stripeSubscriptionId, 'stripe subscription id')}`,
  refundCompensation: (orderId: string): string =>
    `refund-compensation:${segment(orderId, 'order id')}`,
  phoneNumberRetention: (tenantId: string, phoneNumberId: string): string =>
    `phone-number-retention:${segment(tenantId, 'tenant id')}:${segment(phoneNumberId, 'phone number id')}`,
  secretRotation: (tenantId: string, secretKind: string, targetVersion: number): string =>
    `secret-rotation:${segment(tenantId, 'tenant id')}:${segment(secretKind, 'secret kind')}:${positiveInteger(targetVersion, 'secret version')}`,
  dsar: (tenantId: string, requestId: string): string =>
    `dsar:${segment(tenantId, 'tenant id')}:${segment(requestId, 'request id')}`,
  retentionSweep: (tenantId: string, date: string): string =>
    `retention-sweep:${segment(tenantId, 'tenant id')}:${isoDate(date)}`,
  tenantDeletion: (tenantId: string): string => `tenant-deletion:${segment(tenantId, 'tenant id')}`,
  knowledgeSync: (tenantId: string, sourceId: string): string =>
    `knowledge-sync:${segment(tenantId, 'tenant id')}:${segment(sourceId, 'source id')}`,
  providerReconciliation: (provider: ProviderId, date: string): string =>
    `provider-reconciliation:${provider}:${isoDate(date)}`,
  notification: (dedupeKeyHash: string): string =>
    `notification:${sha256Hex(dedupeKeyHash, 'notification dedupe key hash')}`,
});
