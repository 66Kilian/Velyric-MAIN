export const RESOURCE_TYPES = [
  'EMPLOYEE',
  'DOCTOR',
  'ROOM',
  'TABLE',
  'BAY',
  'VEHICLE',
  'EQUIPMENT',
  'SERVICE_POINT',
] as const;
export type ResourceKind = (typeof RESOURCE_TYPES)[number];
export type Currency = 'HUF' | 'EUR' | 'USD';

export interface Service {
  readonly id: string;
  readonly location_id: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly buffer_before_minutes: number;
  readonly buffer_after_minutes: number;
  readonly required_resource_types: readonly ResourceKind[];
  readonly min_party_size: number | null;
  readonly max_party_size: number | null;
  readonly cancellation_window_minutes: number | null;
  readonly price_minor: number | null;
  readonly currency: Currency | null;
  readonly deposit_required: boolean;
  readonly deposit_minor: number | null;
  readonly active: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Resource {
  readonly id: string;
  readonly location_id: string;
  readonly name: string;
  readonly resource_type: ResourceKind;
  readonly parallel_slots: number;
  readonly seat_capacity: number | null;
  readonly calendar_integration_id: string | null;
  readonly external_calendar_ref: string | null;
  readonly active: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AvailabilityRule {
  readonly id: string;
  readonly iso_weekday: number;
  readonly start_local: string;
  readonly end_local: string;
  readonly timezone: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
}

export interface AvailabilityException {
  readonly id: string;
  readonly location_id: string;
  readonly resource_id: string | null;
  readonly exception_kind: 'CLOSED' | 'EXTRA_OPENING';
  readonly starts_at: string;
  readonly ends_at: string;
  readonly reason: string | null;
  readonly created_at: string;
}

export type BookingStatus = 'PENDING_DEPOSIT' | 'CONFIRMED' | 'CANCELED' | 'NO_SHOW' | 'COMPLETED';

export interface Booking {
  readonly id: string;
  readonly reference: string;
  readonly location_id: string;
  readonly service_id: string;
  readonly call_id: string | null;
  readonly status: BookingStatus;
  readonly source: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly timezone: string;
  readonly party_size: number | null;
  readonly customer_note: string | null;
  readonly deposit_status: string | null;
  readonly external_sync_status: string | null;
  readonly canceled_at: string | null;
  readonly cancellation_reason: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BusinessHoursEntry {
  readonly iso_weekday: number;
  readonly opens: string;
  readonly closes: string;
}

export interface Holiday {
  readonly date: string;
  readonly name: string;
  readonly closed: boolean;
}

export interface Location {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly timezone: string;
  readonly country: string;
  readonly address: {
    readonly line1: string;
    readonly line2?: string;
    readonly city: string;
    readonly postal_code: string;
    readonly region?: string;
  } | null;
  readonly business_hours: readonly BusinessHoursEntry[];
  readonly holiday_calendar: readonly Holiday[];
  readonly is_primary: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export function zonedInstant(localDateTime: string, timeZone: string): string {
  const guess = new Date(`${localDateTime}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(guess);
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value.replace('GMT', '') ?? '';
  return new Date(`${localDateTime}:00${offset === '' ? '+00:00' : offset}`).toISOString();
}
