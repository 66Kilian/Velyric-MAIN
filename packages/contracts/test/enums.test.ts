import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  API_ERROR_HTTP_STATUS,
  ApiErrorCode,
  ENUM_REGISTRY,
  EventType,
  FEATURE_FLAG_DEFINITIONS,
  FLAG_SCOPE_PRECEDENCE,
  FeatureFlagKey,
  FeatureFlagScope,
  KILL_SWITCH_DEFINITIONS,
  KillSwitchKey,
  MODEL_TIERS_ENABLED_BY_DEFAULT,
  MODEL_TIER_DEFAULT_MODEL,
  ModelId,
  ModelTier,
  NATS_STREAM_SUBJECTS,
  NatsStream,
  PLATFORM_SCOPED_EVENT_TYPES,
  Permission,
  PlatformPermission,
  ProvisioningState,
  REALTIME_VOICE_FALLBACK_MODELS,
  RETRYABLE_API_ERROR_CODES,
  TenantStatus,
  apiErrorHttpStatus,
  apiErrorMessageKey,
  createApiErrorEnvelope,
  enumValues,
  isEnumValue,
  parseEnumValue,
  renderEnumsJson,
} from '../src/index.js';

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const LOWERCASE_VALUE_ENUMS: Readonly<Record<string, RegExp>> = {
  VelyricEnvironment: /^[a-z]+$/,
  ProviderMode: /^[a-z]+$/,
  Locale: /^[a-z]{2}$/,
  ThemePreference: /^[a-z]+$/,
  ServiceName: /^[a-z]+(?:-[a-z]+)*$/,
  FeatureKey: /^[a-z0-9]+(?:_[a-z0-9]+)*$/,
  Permission: /^[a-z]+(?:_[a-z]+)*:[a-z]+(?:_[a-z]+)*$/,
  PlatformPermission: /^platform\.[a-z]+(?:_[a-z]+)*:[a-z]+(?:_[a-z]+)*$/,
  ProviderId: /^[a-z]+(?:_[a-z]+)*$/,
  TelephonyProvider: /^[a-z]+$/,
  ProviderCapability: /^[a-z]+(?:_[a-z]+)*$/,
  ModelId: /^gpt-[a-z0-9.-]+$/,
  VerticalSlug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  FeatureFlagKey: /^feature\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/,
  KillSwitchKey: /^kill\.[a-z0-9_]+$/,
  UsageMetric: /^[a-z]+(?:_[a-z]+)*$/,
  EventType: /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/,
  JobQueue: /^[a-z]+(?:_[a-z]+)*$/,
  TemporalTaskQueue: /^[a-z]+$/,
  S3BucketPurpose: /^[a-z]+$/,
  RateLimitScope: /^[a-z]+(?:_[a-z]+)*$/,
};

describe('enum registry', () => {
  it('contains every enumeration required by the blueprint', () => {
    const required = [
      'TenantStatus',
      'Role',
      'Permission',
      'PlatformRole',
      'PlatformPermission',
      'PlanCode',
      'AddOnCode',
      'ProvisioningState',
      'PhoneOrderStatus',
      'KycRequirementStatus',
      'ConversationState',
      'TransferState',
      'AgentVersionStatus',
      'CallStatus',
      'CallDirection',
      'CallOutcome',
      'ToolRunStatus',
      'ToolSideEffectClass',
      'BookingStatus',
      'BookingHoldStatus',
      'WaitlistStatus',
      'KnowledgeSourceStatus',
      'NotificationType',
      'NotificationStatus',
      'RetentionClass',
      'FeatureFlagKey',
      'KillSwitchKey',
      'FeatureFlagScope',
      'SpecialistAgentKind',
      'ModelTier',
      'ModelId',
      'ProviderId',
      'ApiErrorCode',
      'EventType',
      'NatsStream',
      'TemporalTaskQueue',
    ];
    for (const name of required) {
      expect(ENUM_REGISTRY, name).toHaveProperty(name);
    }
  });

  it('has unique non-empty values in every enumeration', () => {
    for (const [name, definition] of Object.entries(ENUM_REGISTRY)) {
      const values = Object.values(definition);
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
  });

  it('follows the casing convention for every enumeration', () => {
    for (const [name, definition] of Object.entries(ENUM_REGISTRY)) {
      const pattern = LOWERCASE_VALUE_ENUMS[name];
      for (const [key, value] of Object.entries(definition)) {
        expect(key, `${name} key`).toMatch(UPPER_SNAKE);
        if (pattern === undefined) {
          expect(value, `${name}.${key}`).toBe(key);
        } else {
          expect(value, `${name}.${key}`).toMatch(pattern);
        }
      }
    }
  });

  it('keeps generated/enums.json in sync with the source', () => {
    const file = readFileSync(new URL('../generated/enums.json', import.meta.url), 'utf8');
    expect(file).toBe(renderEnumsJson());
    const parsed = JSON.parse(file) as {
      schema_version: number;
      enums: Record<string, Record<string, string>>;
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.enums['TenantStatus']).toEqual(TenantStatus);
  });
});

describe('enum helpers', () => {
  it('lists, checks and parses values', () => {
    expect(enumValues(TenantStatus)).toContain('GRACE_PERIOD');
    expect(Object.isFrozen(enumValues(TenantStatus))).toBe(true);
    expect(isEnumValue(ProvisioningState, 'MANUAL_REVIEW_REQUIRED')).toBe(true);
    expect(isEnumValue(ProvisioningState, 'LIVE')).toBe(false);
    expect(isEnumValue(ProvisioningState, 42)).toBe(false);
    expect(parseEnumValue(Permission, 'calls:transfer', 'Permission')).toBe('calls:transfer');
    expect(() => parseEnumValue(Permission, 'calls:everything', 'Permission')).toThrow(RangeError);
  });

  it('includes the reconciled lifecycle and provisioning states from both specifications', () => {
    for (const state of [
      'PAYMENT_AT_RISK',
      'GRACE_PERIOD',
      'RESTRICTED',
      'SUSPENDED_BILLING',
      'SUSPENDED_DISPUTE',
      'CANCELED_GRACE',
      'DATA_RETENTION',
      'DELETION',
    ]) {
      expect(isEnumValue(TenantStatus, state), state).toBe(true);
    }
    for (const state of [
      'PAYMENT_CONFIRMED',
      'BILLING_DOCUMENT_CREATED',
      'OPENAI_READY',
      'PHONE_KYC_REQUIRED',
      'WAITING_FOR_CUSTOMER',
      'WAITING_FOR_PROVIDER',
      'SIP_AGENT_BINDING',
      'TEST_CALL_READY',
      'GO_LIVE_ELIGIBLE',
      'MANUAL_REVIEW_REQUIRED',
      'COMPENSATING',
    ]) {
      expect(isEnumValue(ProvisioningState, state), state).toBe(true);
    }
  });
});

describe('api errors', () => {
  it('maps every error code to an HTTP error status', () => {
    for (const code of enumValues(ApiErrorCode)) {
      const status = apiErrorHttpStatus(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    expect(Object.keys(API_ERROR_HTTP_STATUS).sort()).toEqual([...enumValues(ApiErrorCode)].sort());
  });

  it('derives stable message keys and envelopes', () => {
    expect(apiErrorMessageKey('VERSION_CONFLICT')).toBe('errors.version_conflict');
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(createApiErrorEnvelope('NOT_FOUND', trace)).toEqual({
      code: 'NOT_FOUND',
      message_key: 'errors.not_found',
      trace_id: trace,
    });
    expect(createApiErrorEnvelope('VERSION_CONFLICT', trace, { current_version: 7 })).toEqual({
      code: 'VERSION_CONFLICT',
      message_key: 'errors.version_conflict',
      trace_id: trace,
      details: { current_version: 7 },
    });
  });

  it('only marks transient failures as retryable', () => {
    for (const code of RETRYABLE_API_ERROR_CODES) {
      const status = apiErrorHttpStatus(code);
      expect([409, 429, 502, 503, 504]).toContain(status);
    }
    expect(RETRYABLE_API_ERROR_CODES).not.toContain('VALIDATION_FAILED');
  });
});

describe('flags and kill switches', () => {
  it('defines every feature flag and kill switch with valid scopes', () => {
    const scopes = new Set<string>(enumValues(FeatureFlagScope));
    for (const key of enumValues(FeatureFlagKey)) {
      const definition = FEATURE_FLAG_DEFINITIONS[key];
      expect(definition.key).toBe(key);
      expect(definition.allowedScopes.length).toBeGreaterThan(0);
      for (const scope of definition.allowedScopes) {
        expect(scopes.has(scope)).toBe(true);
      }
    }
    for (const key of enumValues(KillSwitchKey)) {
      const definition = KILL_SWITCH_DEFINITIONS[key];
      expect(definition.key).toBe(key);
      expect(definition.allowedScopes.length).toBeGreaterThan(0);
    }
    expect([...FLAG_SCOPE_PRECEDENCE].sort()).toEqual([...scopes].sort());
  });

  it('keeps risky capabilities off by default', () => {
    expect(FEATURE_FLAG_DEFINITIONS['feature.outbound_calls'].defaultEnabled).toBe(false);
    expect(FEATURE_FLAG_DEFINITIONS['feature.call_recording'].defaultEnabled).toBe(false);
    expect(FEATURE_FLAG_DEFINITIONS['feature.routing.premium_reasoning'].defaultEnabled).toBe(
      false,
    );
    expect(FEATURE_FLAG_DEFINITIONS['feature.routing.frontier_reasoning'].defaultEnabled).toBe(
      false,
    );
    expect(FEATURE_FLAG_DEFINITIONS['feature.caller_memory'].defaultEnabled).toBe(false);
  });

  it('covers the spec kill switches: outbound, provider, model, tool, recording, tenant, global', () => {
    for (const key of [
      'kill.outbound_calls',
      'kill.provider',
      'kill.model',
      'kill.tool',
      'kill.recording',
      'kill.tenant_traffic',
      'kill.global_new_calls',
      'kill.payment',
      'kill.agent_publish',
    ]) {
      expect(isEnumValue(KillSwitchKey, key), key).toBe(true);
    }
  });
});

describe('model strategy', () => {
  it('assigns a known default model to every tier', () => {
    for (const tier of enumValues(ModelTier)) {
      expect(isEnumValue(ModelId, MODEL_TIER_DEFAULT_MODEL[tier]), tier).toBe(true);
    }
    expect(MODEL_TIER_DEFAULT_MODEL.VOICE_FRONTEND).toBe('gpt-live-1');
    expect(MODEL_TIER_DEFAULT_MODEL.ROUTINE).toBe('gpt-5.6-luna');
    expect(MODEL_TIERS_ENABLED_BY_DEFAULT).not.toContain('ESCALATION');
    expect(MODEL_TIERS_ENABLED_BY_DEFAULT).not.toContain('FRONTIER');
    expect(REALTIME_VOICE_FALLBACK_MODELS.every((model) => isEnumValue(ModelId, model))).toBe(true);
  });
});

describe('events and streams', () => {
  it('declares subjects for every stream and platform scoped types are known', () => {
    for (const stream of enumValues(NatsStream)) {
      expect(NATS_STREAM_SUBJECTS[stream].length).toBeGreaterThan(0);
    }
    for (const type of PLATFORM_SCOPED_EVENT_TYPES) {
      expect(isEnumValue(EventType, type)).toBe(true);
    }
  });

  it('keeps platform permissions separate from workspace permissions', () => {
    const workspace = new Set<string>(enumValues(Permission));
    for (const permission of enumValues(PlatformPermission)) {
      expect(workspace.has(permission)).toBe(false);
    }
  });
});
