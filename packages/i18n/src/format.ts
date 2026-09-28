import { CURRENCY_MINOR_UNIT_EXPONENT } from '@velyric/contracts';
import type { Currency, Locale } from '@velyric/contracts';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const INTL_LOCALE_TAGS: Readonly<Record<Locale, string>> = Object.freeze({
  hu: 'hu-HU',
  de: 'de-DE',
  en: 'en-US',
});

export const CURRENCY_DISPLAY_FRACTION_DIGITS: Readonly<Record<Currency, number>> = Object.freeze({
  HUF: 0,
  EUR: 2,
  USD: 2,
});

export type DateInput = Date | string | number;

export type DateStyle = 'full' | 'long' | 'medium' | 'short';

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date value: ${String(value)}`);
  }
  return date;
}

export function assertTimeZone(timeZone: string): string {
  if (timeZone.trim() === '') {
    throw new RangeError('An explicit IANA time zone is required');
  }
  new Intl.DateTimeFormat('en-US', { timeZone });
  return timeZone;
}

export interface DateTimeFormatOptions {
  readonly dateStyle?: DateStyle;
  readonly timeStyle?: DateStyle;
}

export function formatDateTime(
  value: DateInput,
  locale: Locale,
  timeZone: string,
  options: DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE_TAGS[locale], {
    ...options,
    timeZone: assertTimeZone(timeZone),
  }).format(toDate(value));
}

export function formatDate(
  value: DateInput,
  locale: Locale,
  timeZone: string,
  dateStyle: DateStyle = 'medium',
): string {
  return formatDateTime(value, locale, timeZone, { dateStyle });
}

export function formatTime(
  value: DateInput,
  locale: Locale,
  timeZone: string,
  timeStyle: DateStyle = 'short',
): string {
  return formatDateTime(value, locale, timeZone, { timeStyle });
}

export function formatDateRange(
  start: DateInput,
  end: DateInput,
  locale: Locale,
  timeZone: string,
): string {
  return `${formatDate(start, locale, timeZone)} – ${formatDate(end, locale, timeZone)}`;
}

export function minorUnitsToMajor(amountMinor: number, currency: Currency): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amounts must be integer minor units, got ${amountMinor}`);
  }
  return amountMinor / 10 ** CURRENCY_MINOR_UNIT_EXPONENT[currency];
}

export function formatMoneyMinor(amountMinor: number, currency: Currency, locale: Locale): string {
  const digits = CURRENCY_DISPLAY_FRACTION_DIGITS[currency];
  return new Intl.NumberFormat(INTL_LOCALE_TAGS[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorUnitsToMajor(amountMinor, currency));
}

export function formatNumber(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(INTL_LOCALE_TAGS[locale], options).format(value);
}

export function formatPercent(ratio: number, locale: Locale, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(INTL_LOCALE_TAGS[locale], {
    style: 'percent',
    maximumFractionDigits,
  }).format(ratio);
}

export type PhoneDisplayFormat = 'international' | 'national';

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

export function formatPhoneE164(
  value: string,
  format: PhoneDisplayFormat = 'international',
): string {
  if (!isE164(value)) {
    return value;
  }
  const parsed = parsePhoneNumberFromString(value);
  if (parsed === undefined) {
    return value;
  }
  return format === 'national' ? parsed.formatNational() : parsed.formatInternational();
}

const DURATION_UNITS: Readonly<
  Record<
    Locale,
    {
      readonly hours: string;
      readonly minutes: string;
      readonly seconds: string;
      readonly spaced: boolean;
    }
  >
> = Object.freeze({
  en: { hours: 'h', minutes: 'm', seconds: 's', spaced: false },
  hu: { hours: 'ó', minutes: 'p', seconds: 'mp', spaced: true },
  de: { hours: 'Std.', minutes: 'Min.', seconds: 'Sek.', spaced: true },
});

function assertDurationSeconds(totalSeconds: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`Durations must be non-negative, got ${totalSeconds}`);
  }
  return Math.round(totalSeconds);
}

export function formatDuration(totalSeconds: number, locale: Locale): string {
  const seconds = assertDurationSeconds(totalSeconds);
  const units = DURATION_UNITS[locale];
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const separator = units.spaced ? ' ' : '';
  const part = (value: number, unit: string): string =>
    `${formatNumber(value, locale)}${separator}${unit}`;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(part(hours, units.hours));
  }
  if (minutes > 0 || (hours > 0 && rest > 0)) {
    parts.push(part(minutes, units.minutes));
  }
  if (rest > 0 || parts.length === 0) {
    parts.push(part(rest, units.seconds));
  }
  return parts.join(' ');
}

export function formatClockDuration(totalSeconds: number): string {
  const seconds = assertDurationSeconds(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}
