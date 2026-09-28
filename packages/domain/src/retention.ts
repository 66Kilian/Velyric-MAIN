import type { RetentionClass } from '@velyric/contracts';

export type RetentionAnchor =
  | 'CREATED'
  | 'LAST_INTERACTION'
  | 'NUMBER_RELEASE'
  | 'DISPUTE_CLOSED'
  | 'SOURCE_DELETED'
  | 'NOT_STORED';

export interface RetentionRule {
  readonly retentionClass: RetentionClass;
  readonly defaultDays: number;
  readonly minDays: number;
  readonly platformMaxDays: number;
  readonly anchor: RetentionAnchor;
  readonly tenantConfigurable: boolean;
}

const rule = (
  retentionClass: RetentionClass,
  defaultDays: number,
  anchor: RetentionAnchor,
  minDays: number | null,
): RetentionRule => ({
  retentionClass,
  defaultDays,
  minDays: minDays ?? defaultDays,
  platformMaxDays: Math.max(defaultDays, 1),
  anchor,
  tenantConfigurable: minDays !== null && minDays < defaultDays,
});

export const RETENTION_RULES: Readonly<Record<RetentionClass, RetentionRule>> = {
  RAW_AUDIO: rule('RAW_AUDIO', 0, 'NOT_STORED', null),
  TRANSCRIPT: rule('TRANSCRIPT', 90, 'CREATED', 1),
  CALL_EVENTS: rule('CALL_EVENTS', 180, 'CREATED', 30),
  TOOL_PAYLOAD: rule('TOOL_PAYLOAD', 30, 'CREATED', 1),
  CALLER_PROFILE: rule('CALLER_PROFILE', 730, 'LAST_INTERACTION', 30),
  ANALYTICS: rule('ANALYTICS', 761, 'CREATED', 90),
  RAW_PROVIDER_PAYLOAD: rule('RAW_PROVIDER_PAYLOAD', 30, 'CREATED', 7),
  KNOWLEDGE_DOCUMENT: rule('KNOWLEDGE_DOCUMENT', 0, 'SOURCE_DELETED', null),
  KYC_REFERENCE: rule('KYC_REFERENCE', 30, 'NUMBER_RELEASE', null),
  CONSENT: rule('CONSENT', 2192, 'CREATED', null),
  AUDIT: rule('AUDIT', 2192, 'CREATED', null),
  BILLING: rule('BILLING', 2922, 'CREATED', null),
  DISPUTE_EVIDENCE: rule('DISPUTE_EVIDENCE', 548, 'DISPUTE_CLOSED', null),
  OPERATIONAL_LOG: rule('OPERATIONAL_LOG', 30, 'CREATED', null),
  EXPORT_ARTIFACT: rule('EXPORT_ARTIFACT', 7, 'CREATED', 1),
};

export class RetentionPolicyError extends Error {
  readonly code: 'NOT_CONFIGURABLE' | 'OUT_OF_RANGE';

  constructor(code: 'NOT_CONFIGURABLE' | 'OUT_OF_RANGE', message: string) {
    super(message);
    this.name = 'RetentionPolicyError';
    this.code = code;
  }
}

export function validateRetentionDays(
  retentionClass: RetentionClass,
  retainDays: number,
): RetentionRule {
  const current = RETENTION_RULES[retentionClass];
  if (!current.tenantConfigurable) {
    throw new RetentionPolicyError(
      'NOT_CONFIGURABLE',
      `${retentionClass} retention is fixed by platform policy`,
    );
  }
  if (
    !Number.isInteger(retainDays) ||
    retainDays < current.minDays ||
    retainDays > current.platformMaxDays
  ) {
    throw new RetentionPolicyError(
      'OUT_OF_RANGE',
      `${retentionClass} retention must be between ${String(current.minDays)} and ${String(current.platformMaxDays)} days`,
    );
  }
  return current;
}

export function effectiveRetentionDays(
  retentionClass: RetentionClass,
  tenantDays: number | null | undefined,
): number {
  const current = RETENTION_RULES[retentionClass];
  if (!current.tenantConfigurable || tenantDays === null || tenantDays === undefined) {
    return current.defaultDays;
  }
  return Math.min(Math.max(tenantDays, current.minDays), current.platformMaxDays);
}

export function retentionCutoff(
  retentionClass: RetentionClass,
  tenantDays: number | null | undefined,
  now: Date,
): Date | null {
  const current = RETENTION_RULES[retentionClass];
  if (current.anchor === 'NOT_STORED' || current.anchor === 'SOURCE_DELETED') {
    return null;
  }
  return new Date(now.getTime() - effectiveRetentionDays(retentionClass, tenantDays) * 86_400_000);
}
