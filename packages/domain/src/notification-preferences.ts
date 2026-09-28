import type { NotificationChannel, NotificationType } from '@velyric/contracts';

export type NotificationAudience = 'WORKSPACE' | 'CALLER';

export interface NotificationPreferenceRule {
  readonly type: NotificationType;
  readonly audience: NotificationAudience;
  readonly channels: readonly NotificationChannel[];
  readonly mandatory: boolean;
  readonly defaultEnabled: boolean;
}

const WORKSPACE_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'IN_APP'];
const CALLER_CHANNELS: readonly NotificationChannel[] = ['SMS', 'EMAIL'];

const mandatory = (type: NotificationType): NotificationPreferenceRule => ({
  type,
  audience: 'WORKSPACE',
  channels: WORKSPACE_CHANNELS,
  mandatory: true,
  defaultEnabled: true,
});

const optional = (type: NotificationType, defaultEnabled = true): NotificationPreferenceRule => ({
  type,
  audience: 'WORKSPACE',
  channels: WORKSPACE_CHANNELS,
  mandatory: false,
  defaultEnabled,
});

const caller = (type: NotificationType): NotificationPreferenceRule => ({
  type,
  audience: 'CALLER',
  channels: CALLER_CHANNELS,
  mandatory: false,
  defaultEnabled: true,
});

export const NOTIFICATION_PREFERENCE_RULES: Readonly<
  Record<NotificationType, NotificationPreferenceRule>
> = {
  RENEWAL_REMINDER_5D: mandatory('RENEWAL_REMINDER_5D'),
  RENEWAL_REMINDER_3D: mandatory('RENEWAL_REMINDER_3D'),
  RENEWAL_REMINDER_1D: mandatory('RENEWAL_REMINDER_1D'),
  PAYMENT_SUCCEEDED: mandatory('PAYMENT_SUCCEEDED'),
  PAYMENT_FAILED_GRACE_STARTED: mandatory('PAYMENT_FAILED_GRACE_STARTED'),
  GRACE_PERIOD_REMINDER: mandatory('GRACE_PERIOD_REMINDER'),
  GRACE_PERIOD_FINAL_DAY: mandatory('GRACE_PERIOD_FINAL_DAY'),
  SERVICE_RESTRICTED: mandatory('SERVICE_RESTRICTED'),
  SERVICE_SUSPENDED_BILLING: mandatory('SERVICE_SUSPENDED_BILLING'),
  SERVICE_REACTIVATED: mandatory('SERVICE_REACTIVATED'),
  PLAN_CHANGED: optional('PLAN_CHANGED'),
  ADD_ON_CHANGED: optional('ADD_ON_CHANGED'),
  SUBSCRIPTION_CANCELED: mandatory('SUBSCRIPTION_CANCELED'),
  CANCELED_GRACE_ENDING: mandatory('CANCELED_GRACE_ENDING'),
  DATA_RETENTION_STARTED: mandatory('DATA_RETENTION_STARTED'),
  DATA_DELETION_COMPLETED: mandatory('DATA_DELETION_COMPLETED'),
  PHONE_NUMBER_RETENTION_ENDING: mandatory('PHONE_NUMBER_RETENTION_ENDING'),
  PHONE_NUMBER_RELEASED: mandatory('PHONE_NUMBER_RELEASED'),
  REFUND_ISSUED: mandatory('REFUND_ISSUED'),
  DISPUTE_OPENED: mandatory('DISPUTE_OPENED'),
  INVOICE_DELIVERY_FAILED: mandatory('INVOICE_DELIVERY_FAILED'),
  PROVISIONING_STARTED: optional('PROVISIONING_STARTED'),
  PROVISIONING_KYC_REQUIRED: mandatory('PROVISIONING_KYC_REQUIRED'),
  PROVISIONING_KYC_DECLINED: mandatory('PROVISIONING_KYC_DECLINED'),
  PROVISIONING_DELAYED: optional('PROVISIONING_DELAYED'),
  PHONE_NUMBER_ACTIVE: optional('PHONE_NUMBER_ACTIVE'),
  TEST_CALL_READY: optional('TEST_CALL_READY'),
  GO_LIVE_COMPLETED: optional('GO_LIVE_COMPLETED'),
  SPEND_CAP_WARNING: optional('SPEND_CAP_WARNING'),
  SPEND_CAP_REACHED: mandatory('SPEND_CAP_REACHED'),
  CONCURRENCY_LIMIT_REACHED: optional('CONCURRENCY_LIMIT_REACHED'),
  INTEGRATION_AUTH_EXPIRED: optional('INTEGRATION_AUTH_EXPIRED'),
  KNOWLEDGE_SYNC_FAILED: optional('KNOWLEDGE_SYNC_FAILED'),
  QUALITY_ALERT: optional('QUALITY_ALERT'),
  SECURITY_MEMBER_INVITED: mandatory('SECURITY_MEMBER_INVITED'),
  SECURITY_MEMBER_ROLE_CHANGED: mandatory('SECURITY_MEMBER_ROLE_CHANGED'),
  SECURITY_API_KEY_CREATED: mandatory('SECURITY_API_KEY_CREATED'),
  SECURITY_SSO_CONFIGURATION_CHANGED: mandatory('SECURITY_SSO_CONFIGURATION_CHANGED'),
  SECURITY_SUPPORT_ACCESS_GRANTED: mandatory('SECURITY_SUPPORT_ACCESS_GRANTED'),
  SUPPORT_REQUEST_RECEIVED: mandatory('SUPPORT_REQUEST_RECEIVED'),
  SUPPORT_REQUEST_UPDATED: mandatory('SUPPORT_REQUEST_UPDATED'),
  DSAR_EXPORT_READY: mandatory('DSAR_EXPORT_READY'),
  CALLER_BOOKING_CONFIRMATION: caller('CALLER_BOOKING_CONFIRMATION'),
  CALLER_BOOKING_CHANGED: caller('CALLER_BOOKING_CHANGED'),
  CALLER_BOOKING_CANCELED: caller('CALLER_BOOKING_CANCELED'),
  CALLER_WAITLIST_OFFER: caller('CALLER_WAITLIST_OFFER'),
  TENANT_CALLBACK_REQUESTED: optional('TENANT_CALLBACK_REQUESTED'),
  TENANT_MESSAGE_TAKEN: optional('TENANT_MESSAGE_TAKEN'),
};

export interface StoredNotificationPreference {
  readonly userId: string | null;
  readonly type: string;
  readonly channel: string;
  readonly enabled: boolean;
}

export function notificationPreferenceIssue(
  type: NotificationType,
  channel: NotificationChannel,
  enabled: boolean,
  scope: 'WORKSPACE' | 'USER',
): 'channel_not_supported' | 'mandatory' | 'caller_notifications_are_workspace_scoped' | null {
  const current = NOTIFICATION_PREFERENCE_RULES[type];
  if (!current.channels.includes(channel)) {
    return 'channel_not_supported';
  }
  if (current.mandatory && !enabled) {
    return 'mandatory';
  }
  if (current.audience === 'CALLER' && scope === 'USER') {
    return 'caller_notifications_are_workspace_scoped';
  }
  return null;
}

export function isNotificationEnabled(
  type: NotificationType,
  channel: NotificationChannel,
  userId: string | null,
  stored: readonly StoredNotificationPreference[],
): boolean {
  const current = NOTIFICATION_PREFERENCE_RULES[type];
  if (!current.channels.includes(channel)) {
    return false;
  }
  if (current.mandatory) {
    return true;
  }
  const match = (candidate: string | null) =>
    stored.find(
      (entry) => entry.userId === candidate && entry.type === type && entry.channel === channel,
    );
  const workspace = match(null);
  if (workspace !== undefined && !workspace.enabled) {
    return false;
  }
  const personal = userId === null ? undefined : match(userId);
  return personal?.enabled ?? workspace?.enabled ?? current.defaultEnabled;
}
