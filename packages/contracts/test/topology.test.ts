import { describe, expect, it } from 'vitest';

import {
  EVENT_ENVELOPE_SCHEMA_VERSION,
  LOCAL_INFRA_PORTS,
  LOCAL_SERVICE_PORTS,
  eventEnvelopeIssues,
  isEventEnvelope,
  isTraceId,
  isUtcTimestamp,
  isUuidV7,
  natsSubjects,
  redisKeys,
  s3,
  temporalWorkflowIds,
} from '../src/index.js';

const TENANT = '0192f3a1-7b2c-7d4e-8f90-123456789abc';
const CALL = '0192f3a1-7b2c-7d4e-9f90-abcdef012345';
const HASH = 'a'.repeat(64);

describe('local ports', () => {
  it('has unique ports across services and infrastructure', () => {
    const ports = [...Object.values(LOCAL_SERVICE_PORTS), ...Object.values(LOCAL_INFRA_PORTS)];
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThan(65536);
    }
  });
});

describe('nats subjects', () => {
  it('builds tenant and call scoped subjects', () => {
    expect(natsSubjects.callEvent(TENANT, CALL, 'call.ended')).toBe(
      `call.v1.${TENANT}.${CALL}.call.ended`,
    );
    expect(natsSubjects.usage(TENANT, 'connected_voice_seconds')).toBe(
      `usage.v1.${TENANT}.connected_voice_seconds`,
    );
    expect(natsSubjects.domain(TENANT, 'agent_version.published')).toBe(
      `domain.v1.${TENANT}.agent_version.published`,
    );
    expect(natsSubjects.domain(null, 'provider_health.changed')).toBe(
      'domain.v1.platform.provider_health.changed',
    );
    expect(natsSubjects.job('knowledge_ingest', TENANT)).toBe(`jobs.v1.knowledge_ingest.${TENANT}`);
    expect(natsSubjects.runtimeCommand(TENANT, CALL)).toBe(`runtime.v1.cmd.${TENANT}.${CALL}`);
    expect(natsSubjects.connectorExecute(TENANT)).toBe(`svc.v1.connector.execute.${TENANT}`);
  });

  it('rejects tokens that would break subject semantics', () => {
    for (const bad of ['a.b', '*', '>', '', 'with space']) {
      expect(() => natsSubjects.callEvent(bad, CALL, 'call.started')).toThrow(RangeError);
    }
  });
});

describe('redis keys', () => {
  it('scopes call keys by tenant and call', () => {
    expect(redisKeys.callState('production', TENANT, CALL)).toBe(
      `vly:production:call:${TENANT}:${CALL}:state`,
    );
    expect(redisKeys.callToolBudget('local', TENANT, CALL)).toBe(
      `vly:local:call:${TENANT}:${CALL}:tool_budget`,
    );
    expect(redisKeys.callSpend('ci', TENANT, CALL)).toBe(`vly:ci:call:${TENANT}:${CALL}:spend`);
    expect(redisKeys.callLock('staging', TENANT, CALL, 'transfer')).toBe(
      `vly:staging:call:${TENANT}:${CALL}:lock:transfer`,
    );
  });

  it('builds admission, rate limit and cache keys', () => {
    expect(redisKeys.tenantAdmission('production', TENANT)).toBe(
      `vly:production:adm:tenant:${TENANT}`,
    );
    expect(redisKeys.locationAdmission('production', TENANT, CALL)).toBe(
      `vly:production:adm:location:${TENANT}:${CALL}`,
    );
    expect(redisKeys.numberAdmission('production', TENANT, CALL)).toBe(
      `vly:production:adm:number:${TENANT}:${CALL}`,
    );
    expect(redisKeys.globalAdmission('production', 'eu-central-1')).toBe(
      'vly:production:adm:global:eu-central-1',
    );
    expect(redisKeys.providerAdmission('production', 'openai', 'eu-central-1')).toBe(
      'vly:production:adm:provider:openai:eu-central-1',
    );
    expect(redisKeys.cpsBucket('production', 'telnyx', 'eu-central-1', 'OUTBOUND')).toBe(
      'vly:production:cps:telnyx:eu-central-1:outbound',
    );
    expect(redisKeys.rateLimit('production', 'api_key', 'key_123', 'writes')).toBe(
      'vly:production:rl:api_key:key_123:writes',
    );
    expect(redisKeys.tenantDailySpend('production', TENANT, '2026-09-13')).toBe(
      `vly:production:spend:${TENANT}:2026-09-13`,
    );
    expect(redisKeys.agentSnapshot('production', TENANT, CALL)).toBe(
      `vly:production:snap:agent:${TENANT}:${CALL}`,
    );
    expect(redisKeys.bookingSlotLock('production', TENANT, CALL, 1_789_000_000)).toBe(
      `vly:production:booking:${TENANT}:${CALL}:1789000000`,
    );
    expect(redisKeys.idempotencyInFlight('production', TENANT, HASH)).toBe(
      `vly:production:idem:${TENANT}:${HASH}`,
    );
    expect(redisKeys.oauthState('production', HASH)).toBe(`vly:production:oauth_state:${HASH}`);
    expect(redisKeys.providerHealth('production', 'openai', 'eu-central-1', 'realtime_voice')).toBe(
      'vly:production:provider_health:openai:eu-central-1:realtime_voice',
    );
    expect(redisKeys.runtimeInstance('production', 'task-abc')).toBe(
      'vly:production:runtime:instance:task-abc',
    );
  });

  it('rejects malformed inputs', () => {
    expect(() => redisKeys.callState('prod' as 'production', TENANT, CALL)).toThrow(RangeError);
    expect(() => redisKeys.callState('production', 'a:b', CALL)).toThrow(RangeError);
    expect(() => redisKeys.globalAdmission('production', 'EU')).toThrow(RangeError);
    expect(() => redisKeys.tenantDailySpend('production', TENANT, '13-09-2026')).toThrow(
      RangeError,
    );
    expect(() => redisKeys.bookingSlotLock('production', TENANT, CALL, -1)).toThrow(RangeError);
    expect(() => redisKeys.bookingSlotLock('production', TENANT, CALL, 1.5)).toThrow(RangeError);
    expect(() => redisKeys.idempotencyInFlight('production', TENANT, 'raw-key')).toThrow(
      RangeError,
    );
  });
});

describe('s3 naming', () => {
  it('builds bucket names and tenant prefixed keys', () => {
    expect(s3.bucketName('velyric-local', 'knowledge')).toBe('velyric-local-knowledge');
    expect(s3.tenantObjectKey(TENANT, 'knowledge', CALL, 3, 'menu.pdf')).toBe(
      `tenants/${TENANT}/knowledge/${CALL}/v3/menu.pdf`,
    );
  });

  it('rejects traversal and invalid versions', () => {
    expect(() => s3.bucketName('Velyric_Prod', 'exports')).toThrow(RangeError);
    expect(() => s3.tenantObjectKey(TENANT, 'knowledge', CALL, 1, '../secret')).toThrow(RangeError);
    expect(() => s3.tenantObjectKey(TENANT, 'knowledge', CALL, 0, 'a.pdf')).toThrow(RangeError);
    expect(() => s3.tenantObjectKey(TENANT, '../other', CALL, 1, 'a.pdf')).toThrow(RangeError);
  });
});

describe('temporal workflow ids', () => {
  it('builds deterministic business keys', () => {
    expect(temporalWorkflowIds.provisioning(CALL)).toBe(`provisioning:${CALL}`);
    expect(temporalWorkflowIds.subscriptionLifecycle(TENANT)).toBe(
      `subscription-lifecycle:${TENANT}`,
    );
    expect(temporalWorkflowIds.renewalReminders(TENANT, '2026-10-01')).toBe(
      `renewal-reminders:${TENANT}:2026-10-01`,
    );
    expect(temporalWorkflowIds.dunning(TENANT, 'in_1PzAbc')).toBe(`dunning:${TENANT}:in_1PzAbc`);
    expect(temporalWorkflowIds.invoiceIssuance('in_1PzAbc')).toBe('invoice:in_1PzAbc');
    expect(temporalWorkflowIds.reactivation(TENANT, 'in_1PzAbc')).toBe(
      `reactivation:${TENANT}:in_1PzAbc`,
    );
    expect(temporalWorkflowIds.cancellation(TENANT, 'sub_9')).toBe(`cancellation:${TENANT}:sub_9`);
    expect(temporalWorkflowIds.refundCompensation(CALL)).toBe(`refund-compensation:${CALL}`);
    expect(temporalWorkflowIds.phoneNumberRetention(TENANT, CALL)).toBe(
      `phone-number-retention:${TENANT}:${CALL}`,
    );
    expect(temporalWorkflowIds.secretRotation(TENANT, 'openai_service_account', 2)).toBe(
      `secret-rotation:${TENANT}:openai_service_account:2`,
    );
    expect(temporalWorkflowIds.dsar(TENANT, CALL)).toBe(`dsar:${TENANT}:${CALL}`);
    expect(temporalWorkflowIds.retentionSweep(TENANT, '2026-09-13')).toBe(
      `retention-sweep:${TENANT}:2026-09-13`,
    );
    expect(temporalWorkflowIds.tenantDeletion(TENANT)).toBe(`tenant-deletion:${TENANT}`);
    expect(temporalWorkflowIds.knowledgeSync(TENANT, CALL)).toBe(
      `knowledge-sync:${TENANT}:${CALL}`,
    );
    expect(temporalWorkflowIds.providerReconciliation('telnyx', '2026-09-12')).toBe(
      'provider-reconciliation:telnyx:2026-09-12',
    );
    expect(temporalWorkflowIds.notification(HASH)).toBe(`notification:${HASH}`);
  });

  it('rejects ambiguous identifiers', () => {
    expect(() => temporalWorkflowIds.dunning(TENANT, 'in:1')).toThrow(RangeError);
    expect(() => temporalWorkflowIds.secretRotation(TENANT, 'kind', 0)).toThrow(RangeError);
    expect(() => temporalWorkflowIds.notification('not-a-hash')).toThrow(RangeError);
  });
});

describe('event envelope', () => {
  const valid = {
    schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
    event_id: '0192f3a1-7b2c-7d4e-8f90-0123456789ab',
    event_type: 'call.ended',
    tenant_id: TENANT,
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    occurred_at: '2026-09-13T12:00:00.000Z',
    producer: 'voice-runtime',
    payload: { call_id: CALL },
  };

  it('accepts a well formed envelope', () => {
    expect(eventEnvelopeIssues(valid)).toEqual([]);
    expect(isEventEnvelope(valid)).toBe(true);
  });

  it('allows null tenant only for platform scoped events', () => {
    expect(isEventEnvelope({ ...valid, tenant_id: null })).toBe(false);
    expect(
      isEventEnvelope({ ...valid, event_type: 'provider_health.changed', tenant_id: null }),
    ).toBe(true);
  });

  it('reports every malformed field', () => {
    const issues = eventEnvelopeIssues({
      schema_version: 0,
      event_id: '0192f3a1-7b2c-4d4e-8f90-0123456789ab',
      event_type: 'call.exploded',
      tenant_id: 'tenant-1',
      trace_id: '0'.repeat(32),
      occurred_at: '2026-09-13 12:00',
      producer: 'mystery',
      payload: 'text',
      extra: true,
    });
    expect(issues).toHaveLength(9);
    expect(eventEnvelopeIssues(null)).toEqual(['envelope must be an object']);
    expect(eventEnvelopeIssues([])).toEqual(['envelope must be an object']);
    const withoutPayload = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'payload'),
    );
    expect(eventEnvelopeIssues(withoutPayload)).toEqual(['payload must be an object']);
  });

  it('validates primitive formats', () => {
    expect(isUuidV7(valid.event_id)).toBe(true);
    expect(isUuidV7(42)).toBe(false);
    expect(isTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false);
    expect(isUtcTimestamp('2026-02-30T00:00:00.000Z')).toBe(true);
    expect(isUtcTimestamp('2026-13-40T00:00:00.000Z')).toBe(false);
  });
});
