import type { BadgeTone } from '@velyric/ui';

export type IdentityType = 'PHONE' | 'EMAIL' | 'EXTERNAL_ID';
export type ContactLanguage = 'hu' | 'de' | 'en';
export const PRIVACY_CHANNELS = ['PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'DASHBOARD'] as const;
export type PrivacyChannel = (typeof PRIVACY_CHANNELS)[number];
export const WAITLIST_STATUSES = [
  'ACTIVE',
  'OFFERED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'FULFILLED',
  'CANCELED',
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];
export const WAITLIST_CHANNELS = ['EMAIL', 'SMS', 'IN_APP', 'WEBHOOK'] as const;
export type WaitlistChannel = (typeof WAITLIST_CHANNELS)[number];

export interface ContactIdentity {
  readonly id: string;
  readonly identity_type: IdentityType;
  readonly value: string;
  readonly verification_state: string;
  readonly source: string;
  readonly confidence: number;
  readonly location_id: string | null;
  readonly verified_at: string | null;
  readonly last_confirmed_at: string | null;
  readonly created_at: string;
}

export interface Contact {
  readonly id: string;
  readonly display_name: string | null;
  readonly display_name_verification: string | null;
  readonly preferred_language: ContactLanguage | null;
  readonly preferred_language_source: string | null;
  readonly trust_level: string;
  readonly memory_enabled: boolean;
  readonly shared_phone_suspected: boolean;
  readonly last_interaction_at: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ContactListItem extends Contact {
  readonly identities: readonly ContactIdentity[];
}

export interface ContactDetail extends Contact {
  readonly identities: readonly ContactIdentity[];
  readonly calls: readonly {
    readonly id: string;
    readonly status: string;
    readonly channel: string;
    readonly direction: string;
    readonly intent: string | null;
    readonly outcome: string | null;
    readonly language: string | null;
    readonly started_at: string | null;
    readonly duration_seconds: number | null;
    readonly location_id: string | null;
  }[];
  readonly bookings: readonly {
    readonly id: string;
    readonly status: string;
    readonly service_id: string;
    readonly location_id: string;
    readonly starts_at: string;
    readonly ends_at: string;
    readonly timezone: string;
  }[];
  readonly consents: readonly {
    readonly id: string;
    readonly call_id: string | null;
    readonly channel: string;
    readonly disclosure_version: string;
    readonly disclosure_language: string;
    readonly disclosure_delivered_at: string;
    readonly recording_consent: string;
    readonly contact_consent: Readonly<Record<string, unknown>>;
  }[];
  readonly waitlist: readonly {
    readonly id: string;
    readonly status: WaitlistStatus;
    readonly service_id: string | null;
    readonly location_id: string;
    readonly expires_at: string;
    readonly created_at: string;
  }[];
  readonly privacy_requests: readonly {
    readonly id: string;
    readonly request_type: string;
    readonly status: string;
    readonly due_at: string;
    readonly created_at: string;
  }[];
}

export interface WaitlistEntry {
  readonly id: string;
  readonly location_id: string;
  readonly person: { readonly id: string; readonly display_name: string | null };
  readonly service_id: string | null;
  readonly resource_type: string | null;
  readonly desired_from: string;
  readonly desired_to: string;
  readonly party_size: number;
  readonly priority: number;
  readonly priority_rule: string;
  readonly contact_channel: WaitlistChannel;
  readonly status: WaitlistStatus;
  readonly contact_attempts: number;
  readonly max_contact_attempts: number;
  readonly last_contacted_at: string | null;
  readonly expires_at: string;
  readonly version: number;
  readonly created_at: string;
}

export const WAITLIST_TONES: Readonly<Record<WaitlistStatus, BadgeTone>> = {
  ACTIVE: 'sky',
  OFFERED: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'neutral',
  EXPIRED: 'neutral',
  FULFILLED: 'mint',
  CANCELED: 'danger',
};
