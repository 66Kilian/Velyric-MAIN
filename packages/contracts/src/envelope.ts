import { EventType, ServiceName } from './enums.js';

export const EVENT_ENVELOPE_SCHEMA_VERSION = 1;

export interface EventEnvelope<TType extends EventType = EventType, TPayload = unknown> {
  readonly schema_version: number;
  readonly event_id: string;
  readonly event_type: TType;
  readonly tenant_id: string | null;
  readonly trace_id: string;
  readonly occurred_at: string;
  readonly producer: ServiceName;
  readonly payload: TPayload;
}

export const PLATFORM_SCOPED_EVENT_TYPES: readonly EventType[] = Object.freeze([
  EventType.FEATURE_FLAG_CHANGED,
  EventType.KILL_SWITCH_CHANGED,
  EventType.PROVIDER_HEALTH_CHANGED,
  EventType.RUNTIME_INSTANCE_STATE_CHANGED,
]);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const RFC3339_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value);
}

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && !/^0+$/.test(value);
}

export function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && RFC3339_UTC_MILLIS.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function eventEnvelopeIssues(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return ['envelope must be an object'];
  }
  const issues: string[] = [];
  const allowed = new Set([
    'schema_version',
    'event_id',
    'event_type',
    'tenant_id',
    'trace_id',
    'occurred_at',
    'producer',
    'payload',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(`unexpected field ${key}`);
    }
  }
  const schemaVersion = value['schema_version'];
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    issues.push('schema_version must be a positive integer');
  }
  if (!isUuidV7(value['event_id'])) {
    issues.push('event_id must be a lowercase UUIDv7');
  }
  const eventType = value['event_type'];
  const knownType =
    typeof eventType === 'string' &&
    (Object.values(EventType) as readonly string[]).includes(eventType);
  if (!knownType) {
    issues.push('event_type must be a known EventType');
  }
  const tenantId = value['tenant_id'];
  if (tenantId === null) {
    if (knownType && !(PLATFORM_SCOPED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      issues.push('tenant_id may only be null for platform-scoped event types');
    }
  } else if (!isUuidV7(tenantId)) {
    issues.push('tenant_id must be a lowercase UUIDv7 or null');
  }
  if (!isTraceId(value['trace_id'])) {
    issues.push('trace_id must be a non-zero 32 character lowercase hex W3C trace id');
  }
  if (!isUtcTimestamp(value['occurred_at'])) {
    issues.push('occurred_at must be an RFC 3339 UTC timestamp with millisecond precision');
  }
  const producer = value['producer'];
  if (
    typeof producer !== 'string' ||
    !(Object.values(ServiceName) as readonly string[]).includes(producer)
  ) {
    issues.push('producer must be a known ServiceName');
  }
  if (!('payload' in value) || !isRecord(value['payload'])) {
    issues.push('payload must be an object');
  }
  return issues;
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return eventEnvelopeIssues(value).length === 0;
}
