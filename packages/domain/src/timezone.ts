const formatterCache = new Map<string, Intl.DateTimeFormat>();

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface LocalDateTimeParts extends LocalDateTime {
  readonly isoWeekday: number;
}

export type Disambiguation = 'earlier' | 'later';

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function toLocalParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
    isoWeekday: WEEKDAYS[value('weekday')] ?? 1,
  };
}

function wallClockMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
}

function offsetMs(instantMs: number, timeZone: string): number {
  const truncated = Math.floor(instantMs / 1000) * 1000;
  return wallClockMs(toLocalParts(new Date(truncated), timeZone)) - truncated;
}

function sameWallClock(instantMs: number, local: LocalDateTime, timeZone: string): boolean {
  return wallClockMs(toLocalParts(new Date(instantMs), timeZone)) === wallClockMs(local);
}

export function zonedToUtc(
  local: LocalDateTime,
  timeZone: string,
  disambiguation: Disambiguation = 'earlier',
): Date {
  const wall = wallClockMs(local);
  const before = wall - offsetMs(wall - 12 * HOUR_MS, timeZone);
  const after = wall - offsetMs(wall + 12 * HOUR_MS, timeZone);
  const valid = [before, after].filter((candidate) => sameWallClock(candidate, local, timeZone));
  if (valid.length === 0) {
    return new Date(before);
  }
  const chosen = disambiguation === 'earlier' ? Math.min(...valid) : Math.max(...valid);
  return new Date(chosen);
}

export function parseLocalTime(value: string): {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (match === null) {
    throw new RangeError(`invalid local time ${JSON.stringify(value)}`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? '0') };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function isoWeekdayOf(date: LocalDate): number {
  return ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7) + 1;
}

export function localDaysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      DAY_MS,
  );
}
