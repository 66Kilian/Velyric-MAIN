import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  isSupportedTimeZone,
  isoWeekdayOf,
  parseLocalTime,
  toLocalParts,
  zonedToUtc,
} from '../src/timezone.js';

describe('time zone conversion', () => {
  it('converts wall clock times across Budapest daylight saving transitions', () => {
    expect(
      zonedToUtc(
        { year: 2026, month: 1, day: 15, hour: 8, minute: 0, second: 0 },
        'Europe/Budapest',
      ).toISOString(),
    ).toBe('2026-01-15T07:00:00.000Z');
    expect(
      zonedToUtc(
        { year: 2026, month: 7, day: 15, hour: 8, minute: 0, second: 0 },
        'Europe/Budapest',
      ).toISOString(),
    ).toBe('2026-07-15T06:00:00.000Z');
    expect(
      zonedToUtc(
        { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
        'Europe/Budapest',
      ).toISOString(),
    ).toBe('2026-03-29T01:30:00.000Z');
    expect(
      zonedToUtc(
        { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
        'Europe/Budapest',
        'earlier',
      ).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(
      zonedToUtc(
        { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
        'Europe/Budapest',
        'later',
      ).toISOString(),
    ).toBe('2026-10-25T01:30:00.000Z');
  });

  it('reads local parts, weekdays and calendar arithmetic', () => {
    expect(toLocalParts(new Date('2026-09-13T22:30:00Z'), 'Europe/Budapest')).toEqual({
      year: 2026,
      month: 9,
      day: 14,
      hour: 0,
      minute: 30,
      second: 0,
      isoWeekday: 1,
    });
    expect(isoWeekdayOf({ year: 2026, month: 9, day: 20 })).toBe(7);
    expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1 });
    expect(parseLocalTime('08:15:00')).toEqual({ hour: 8, minute: 15, second: 0 });
    expect(() => parseLocalTime('24:00')).toThrow(RangeError);
    expect(isSupportedTimeZone('Europe/Budapest')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus')).toBe(false);
  });

  it('round-trips arbitrary instants through local wall clock time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
        fc.constantFrom(
          'Europe/Budapest',
          'Europe/Berlin',
          'America/New_York',
          'Asia/Kolkata',
          'Australia/Lord_Howe',
        ),
        (milliseconds, zone) => {
          const instant = Math.floor(milliseconds / 1000) * 1000;
          const local = toLocalParts(new Date(instant), zone);
          return (
            zonedToUtc(local, zone, 'earlier').getTime() === instant ||
            zonedToUtc(local, zone, 'later').getTime() === instant
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
