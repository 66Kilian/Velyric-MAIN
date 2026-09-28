import type { BadgeTone } from '@velyric/ui';

export function splitDuration(totalSeconds: number): {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
} {
  const safe = Math.max(0, Math.round(totalSeconds));
  return {
    hours: Math.floor(safe / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: safe % 60,
  };
}

export function clock(totalSeconds: number): string {
  const { hours, minutes, seconds } = splitDuration(totalSeconds);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function usdFromMicros(micros: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: micros < 10_000_000 ? 4 : 2,
  }).format(micros / 1_000_000);
}

export function percent(value: number | null, locale: string, digits = 0): string {
  return value === null
    ? '–'
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(
        value,
      );
}

export const INTENT_TONES: Readonly<Record<string, BadgeTone>> = {
  BOOKING: 'violet',
  SUPPORT: 'sky',
  SALES: 'sky',
  LEAD: 'peach',
  BILLING: 'mint',
  GENERAL_INQUIRY: 'neutral',
  HUMAN_REQUEST: 'pink',
  SPAM: 'danger',
  OTHER: 'neutral',
};

export const OUTCOME_TONES: Readonly<Record<string, BadgeTone>> = {
  RESOLVED: 'success',
  INFORMATION_PROVIDED: 'success',
  BOOKING_CREATED: 'success',
  BOOKING_CHANGED: 'success',
  BOOKING_CANCELED: 'neutral',
  WAITLISTED: 'sky',
  LEAD_CAPTURED: 'success',
  CALLBACK_REQUESTED: 'sky',
  MESSAGE_TAKEN: 'sky',
  TRANSFERRED_TO_HUMAN: 'warning',
  UNRESOLVED: 'warning',
  ABANDONED: 'neutral',
  SPAM: 'danger',
  POLICY_BLOCKED: 'danger',
  FAILED: 'danger',
};

export const BOOKING_TONES: Readonly<Record<string, BadgeTone>> = {
  PENDING_DEPOSIT: 'warning',
  CONFIRMED: 'success',
  CANCELED: 'neutral',
  NO_SHOW: 'danger',
  COMPLETED: 'violet',
};

export function formatMinor(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}

export const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  INITIATED: 'sky',
  QUEUED: 'sky',
  IN_PROGRESS: 'pink',
  TRANSFERRING: 'warning',
  TRANSFERRED: 'violet',
  COMPLETED: 'success',
  FAILED: 'danger',
  REJECTED: 'danger',
  ABANDONED: 'neutral',
};
