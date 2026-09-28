import type { BadgeTone } from '@velyric/ui';

export interface OutboundWebhook {
  readonly id: string;
  readonly url: string;
  readonly event_types: readonly string[];
  readonly active: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_delivery_at?: string | null;
  readonly last_delivery_status?: string | null;
  readonly failing_deliveries?: number;
}

export interface OutboundWebhookList {
  readonly data: readonly OutboundWebhook[];
  readonly event_types: readonly string[];
  readonly max_endpoints: number;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly status: 'PENDING' | 'DELIVERED' | 'RETRYING' | 'FAILED' | 'DEAD_LETTER';
  readonly attempt: number;
  readonly http_status: number | null;
  readonly last_error_code: string | null;
  readonly response_ms: number | null;
  readonly next_attempt_at: string | null;
  readonly delivered_at: string | null;
  readonly created_at: string;
}

export interface RetentionPolicy {
  readonly retention_class: string;
  readonly anchor: string;
  readonly tenant_configurable: boolean;
  readonly default_days: number;
  readonly min_days: number;
  readonly platform_max_days: number;
  readonly retain_days: number;
  readonly customized: boolean;
  readonly version: number | null;
  readonly updated_at: string | null;
}

export interface PrivacyRequest {
  readonly id: string;
  readonly person_id: string | null;
  readonly person_display_name?: string | null;
  readonly request_type: 'DELETE' | 'EXPORT' | 'RECTIFY' | 'RESTRICT';
  readonly status:
    'RECEIVED' | 'VERIFYING' | 'IN_PROGRESS' | 'ON_LEGAL_HOLD' | 'COMPLETED' | 'REJECTED';
  readonly received_via: string;
  readonly verification_method: string | null;
  readonly verified_at: string | null;
  readonly legal_hold_id: string | null;
  readonly export_ready: boolean;
  readonly due_at: string;
  readonly completed_at: string | null;
  readonly rejection_reason: string | null;
  readonly version: number;
  readonly created_at: string;
}

export interface LegalHold {
  readonly id: string;
  readonly scope_type: 'TENANT' | 'PERSON' | 'CALL' | 'DISPUTE' | 'BILLING';
  readonly scope_ref: string | null;
  readonly reason: string;
  readonly legal_basis: string;
  readonly created_by: string;
  readonly released_by: string | null;
  readonly released_reason: string | null;
  readonly active: boolean;
  readonly created_at: string;
  readonly released_at: string | null;
}

export interface NotificationRule {
  readonly notification_type: string;
  readonly audience: 'WORKSPACE' | 'CALLER';
  readonly channels: readonly string[];
  readonly mandatory: boolean;
  readonly default_enabled: boolean;
}

export interface NotificationPreference {
  readonly notification_type: string;
  readonly channel: string;
  readonly enabled: boolean;
}

export interface NotificationPreferences {
  readonly rules: readonly NotificationRule[];
  readonly workspace: readonly NotificationPreference[];
  readonly personal: readonly NotificationPreference[];
}

export const DELIVERY_TONES: Readonly<Record<string, BadgeTone>> = {
  PENDING: 'sky',
  DELIVERED: 'success',
  RETRYING: 'warning',
  FAILED: 'danger',
  DEAD_LETTER: 'danger',
};

export const PRIVACY_REQUEST_TONES: Readonly<Record<string, BadgeTone>> = {
  RECEIVED: 'sky',
  VERIFYING: 'sky',
  IN_PROGRESS: 'warning',
  ON_LEGAL_HOLD: 'peach',
  COMPLETED: 'success',
  REJECTED: 'neutral',
};
