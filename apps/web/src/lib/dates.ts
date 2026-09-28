export type RangeKey = '7d' | '30d' | '90d';

export const RANGE_DAYS: Readonly<Record<RangeKey, number>> = { '7d': 7, '30d': 30, '90d': 90 };

export function parseRange(value: string | string[] | undefined): RangeKey {
  return value === '7d' || value === '90d' ? value : '30d';
}

export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

export interface DayWindow {
  readonly from: string;
  readonly to: string;
}

export function rangeWindow(
  range: RangeKey,
  timeZone: string,
  now: Date = new Date(),
): { readonly current: DayWindow; readonly previous: DayWindow } {
  const days = RANGE_DAYS[range];
  const to = todayInZone(timeZone, now);
  const from = addDays(to, -(days - 1));
  return { current: { from, to }, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}
