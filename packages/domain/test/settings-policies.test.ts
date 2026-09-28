import { describe, expect, it } from 'vitest';
import {
  isNotificationEnabled,
  notificationPreferenceIssue,
  NOTIFICATION_PREFERENCE_RULES,
} from '../src/notification-preferences.js';
import {
  effectiveRetentionDays,
  RETENTION_RULES,
  RetentionPolicyError,
  retentionCutoff,
  validateRetentionDays,
} from '../src/retention.js';

describe('retention rules', () => {
  it('only lets tenants shorten configurable classes within platform bounds', () => {
    expect(validateRetentionDays('TRANSCRIPT', 30).platformMaxDays).toBe(90);
    expect(() => validateRetentionDays('TRANSCRIPT', 91)).toThrow(RetentionPolicyError);
    expect(() => validateRetentionDays('CALL_EVENTS', 29)).toThrow(RetentionPolicyError);
    expect(() => validateRetentionDays('TRANSCRIPT', 1.5)).toThrow(RetentionPolicyError);
    for (const fixed of ['AUDIT', 'BILLING', 'CONSENT', 'RAW_AUDIO', 'DISPUTE_EVIDENCE'] as const) {
      expect(() => validateRetentionDays(fixed, RETENTION_RULES[fixed].defaultDays)).toThrow(
        /fixed/,
      );
    }
  });

  it('clamps stored values and derives cutoffs', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    expect(effectiveRetentionDays('TRANSCRIPT', 400)).toBe(90);
    expect(effectiveRetentionDays('AUDIT', 10)).toBe(2192);
    expect(retentionCutoff('TRANSCRIPT', 30, now)?.toISOString()).toBe('2026-08-16T00:00:00.000Z');
    expect(retentionCutoff('RAW_AUDIO', null, now)).toBeNull();
    expect(retentionCutoff('KNOWLEDGE_DOCUMENT', null, now)).toBeNull();
  });
});

describe('notification preferences', () => {
  it('rejects disabling mandatory notifications and unsupported channels', () => {
    expect(
      notificationPreferenceIssue('PAYMENT_FAILED_GRACE_STARTED', 'EMAIL', false, 'WORKSPACE'),
    ).toBe('mandatory');
    expect(notificationPreferenceIssue('QUALITY_ALERT', 'SMS', true, 'USER')).toBe(
      'channel_not_supported',
    );
    expect(notificationPreferenceIssue('CALLER_BOOKING_CONFIRMATION', 'SMS', false, 'USER')).toBe(
      'caller_notifications_are_workspace_scoped',
    );
    expect(notificationPreferenceIssue('QUALITY_ALERT', 'EMAIL', false, 'USER')).toBeNull();
  });

  it('resolves workspace and personal preferences', () => {
    const stored = [
      { userId: null, type: 'QUALITY_ALERT', channel: 'EMAIL', enabled: true },
      { userId: 'user-1', type: 'QUALITY_ALERT', channel: 'EMAIL', enabled: false },
      { userId: null, type: 'KNOWLEDGE_SYNC_FAILED', channel: 'EMAIL', enabled: false },
      { userId: 'user-1', type: 'KNOWLEDGE_SYNC_FAILED', channel: 'EMAIL', enabled: true },
      { userId: null, type: 'SPEND_CAP_REACHED', channel: 'EMAIL', enabled: false },
    ];
    expect(isNotificationEnabled('QUALITY_ALERT', 'EMAIL', 'user-1', stored)).toBe(false);
    expect(isNotificationEnabled('QUALITY_ALERT', 'EMAIL', 'user-2', stored)).toBe(true);
    expect(isNotificationEnabled('KNOWLEDGE_SYNC_FAILED', 'EMAIL', 'user-1', stored)).toBe(false);
    expect(isNotificationEnabled('SPEND_CAP_REACHED', 'EMAIL', null, stored)).toBe(true);
    expect(isNotificationEnabled('QUALITY_ALERT', 'SMS', null, stored)).toBe(false);
    expect(
      Object.values(NOTIFICATION_PREFERENCE_RULES).every((rule) => rule.channels.length > 0),
    ).toBe(true);
  });
});
