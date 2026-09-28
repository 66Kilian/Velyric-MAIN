import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AvailabilityInputError,
  findAvailableSlots,
  normalizeIntervals,
  openingIntervals,
  subtractIntervals,
  type AvailabilityRuleSpec,
  type ResourceSpec,
} from '../src/availability.js';

const doctor: ResourceSpec = {
  id: 'doc-1',
  name: 'Dr. Kiss',
  resourceType: 'DOCTOR',
  parallelSlots: 1,
};
const room: ResourceSpec = {
  id: 'room-1',
  name: 'Rendelő 1',
  resourceType: 'ROOM',
  parallelSlots: 2,
};

function weekdayRules(
  resourceId: string,
  startLocal: string,
  endLocal: string,
  days: readonly number[],
): AvailabilityRuleSpec[] {
  return days.map((isoWeekday) => ({
    resourceId,
    isoWeekday,
    startLocal,
    endLocal,
    timezone: 'Europe/Budapest',
    validFrom: null,
    validTo: null,
  }));
}

const doctorRules = weekdayRules('doc-1', '08:00', '12:00', [1, 2, 3, 4, 5]);
const roomRules = weekdayRules('room-1', '07:00', '20:00', [1, 2, 3, 4, 5, 6]);
const consultation = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  requiredResourceTypes: ['DOCTOR'],
};
const hhmm = (date: Date): string => date.toISOString().slice(11, 16);

describe('interval arithmetic', () => {
  it('merges and subtracts half-open intervals', () => {
    expect(
      normalizeIntervals([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 6, end: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(
      subtractIntervals(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 5, end: 12 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe('available slots', () => {
  it('offers slots inside opening hours around existing allocations including buffers', () => {
    const slots = findAvailableSlots({
      service: consultation,
      resources: [doctor],
      rules: doctorRules,
      exceptions: [],
      occupations: [
        {
          resourceId: 'doc-1',
          slotIndex: 0,
          startsAt: new Date('2026-09-14T07:00:00Z'),
          endsAt: new Date('2026-09-14T07:40:00Z'),
        },
      ],
      query: {
        from: new Date('2026-09-14T05:00:00Z'),
        to: new Date('2026-09-14T12:00:00Z'),
        now: new Date('2026-09-13T00:00:00Z'),
      },
    });
    expect(slots.map((slot) => hhmm(slot.startsAt))).toEqual([
      '06:00',
      '06:15',
      '07:45',
      '08:00',
      '08:15',
      '08:30',
      '08:45',
      '09:00',
      '09:15',
      '09:30',
    ]);
    expect(slots[0]?.occupiesUntil.toISOString()).toBe('2026-09-14T06:40:00.000Z');
    expect(slots[0]?.assignments).toEqual([
      { resourceId: 'doc-1', resourceType: 'DOCTOR', slotIndex: 0 },
    ]);
  });

  it('applies closures, extra openings, lead time and result limits', () => {
    const closedTuesday = findAvailableSlots({
      service: consultation,
      resources: [doctor],
      rules: doctorRules,
      exceptions: [
        {
          resourceId: null,
          kind: 'CLOSED',
          startsAt: new Date('2026-09-15T00:00:00Z'),
          endsAt: new Date('2026-09-16T00:00:00Z'),
        },
      ],
      occupations: [],
      query: {
        from: new Date('2026-09-15T00:00:00Z'),
        to: new Date('2026-09-15T23:00:00Z'),
        now: new Date('2026-09-13T00:00:00Z'),
      },
    });
    expect(closedTuesday).toEqual([]);
    const saturday = findAvailableSlots({
      service: consultation,
      resources: [doctor],
      rules: doctorRules,
      exceptions: [
        {
          resourceId: 'doc-1',
          kind: 'EXTRA_OPENING',
          startsAt: new Date('2026-09-19T06:00:00Z'),
          endsAt: new Date('2026-09-19T08:00:00Z'),
        },
      ],
      occupations: [],
      query: {
        from: new Date('2026-09-19T00:00:00Z'),
        to: new Date('2026-09-20T00:00:00Z'),
        now: new Date('2026-09-13T00:00:00Z'),
        stepMinutes: 60,
      },
    });
    expect(saturday.map((slot) => hhmm(slot.startsAt))).toEqual(['06:00', '07:00']);
    const withLead = findAvailableSlots({
      service: consultation,
      resources: [doctor],
      rules: doctorRules,
      exceptions: [],
      occupations: [],
      query: {
        from: new Date('2026-09-14T05:00:00Z'),
        to: new Date('2026-09-14T12:00:00Z'),
        now: new Date('2026-09-14T06:50:00Z'),
        minLeadMinutes: 60,
        maxResults: 3,
      },
    });
    expect(withLead.map((slot) => hhmm(slot.startsAt))).toEqual(['08:00', '08:15', '08:30']);
  });

  it('assigns every required resource type and uses free parallel slots', () => {
    const slots = findAvailableSlots({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requiredResourceTypes: ['DOCTOR', 'ROOM'],
      },
      resources: [room, doctor],
      rules: [...doctorRules, ...roomRules],
      exceptions: [],
      occupations: [
        {
          resourceId: 'room-1',
          slotIndex: 0,
          startsAt: new Date('2026-09-14T06:00:00Z'),
          endsAt: new Date('2026-09-14T07:00:00Z'),
        },
        {
          resourceId: 'room-1',
          slotIndex: 1,
          startsAt: new Date('2026-09-14T06:00:00Z'),
          endsAt: new Date('2026-09-14T06:30:00Z'),
        },
        {
          resourceId: 'doc-1',
          slotIndex: null,
          startsAt: new Date('2026-09-14T07:00:00Z'),
          endsAt: new Date('2026-09-14T08:00:00Z'),
        },
      ],
      query: {
        from: new Date('2026-09-14T06:00:00Z'),
        to: new Date('2026-09-14T08:30:00Z'),
        now: new Date('2026-09-13T00:00:00Z'),
        stepMinutes: 30,
      },
    });
    expect(
      slots.map((slot) => [
        hhmm(slot.startsAt),
        slot.assignments.map(
          (assignment) => `${assignment.resourceId}#${String(assignment.slotIndex)}`,
        ),
      ]),
    ).toEqual([
      ['06:30', ['doc-1#0', 'room-1#1']],
      ['08:00', ['doc-1#0', 'room-1#0']],
    ]);
  });

  it('rejects invalid queries', () => {
    const base = { resources: [doctor], rules: doctorRules, exceptions: [], occupations: [] };
    const query = {
      from: new Date('2026-09-14T00:00:00Z'),
      to: new Date('2026-09-15T00:00:00Z'),
      now: new Date('2026-09-13T00:00:00Z'),
    };
    expect(() =>
      findAvailableSlots({ ...base, service: { ...consultation, durationMinutes: 0 }, query }),
    ).toThrow(AvailabilityInputError);
    expect(() =>
      findAvailableSlots({
        ...base,
        service: { ...consultation, requiredResourceTypes: [] },
        query,
      }),
    ).toThrow(AvailabilityInputError);
    expect(() =>
      findAvailableSlots({
        ...base,
        service: consultation,
        query: { ...query, to: new Date('2026-12-31T00:00:00Z') },
      }),
    ).toThrow(AvailabilityInputError);
  });

  it('never offers a slot that overlaps the assigned slot or falls outside opening hours', () => {
    const base = Date.parse('2026-09-14T05:00:00Z');
    const window = { start: base, end: base + 12 * 3_600_000 };
    const opening = openingIntervals('room-1', roomRules, [], window);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            slotIndex: fc.constantFrom<number | null>(0, 1, null),
            startMinute: fc.integer({ min: 0, max: 700 }),
            length: fc.integer({ min: 5, max: 120 }),
          }),
          { maxLength: 12 },
        ),
        (raw) => {
          const occupations = raw.map((entry) => ({
            resourceId: 'room-1',
            slotIndex: entry.slotIndex,
            startsAt: new Date(base + entry.startMinute * 60_000),
            endsAt: new Date(base + (entry.startMinute + entry.length) * 60_000),
          }));
          const slots = findAvailableSlots({
            service: {
              durationMinutes: 45,
              bufferBeforeMinutes: 5,
              bufferAfterMinutes: 5,
              requiredResourceTypes: ['ROOM'],
            },
            resources: [room],
            rules: roomRules,
            exceptions: [],
            occupations,
            query: {
              from: new Date(window.start),
              to: new Date(window.end),
              now: new Date(base - 1),
              maxResults: 200,
            },
          });
          return slots.every((slot) => {
            const [assignment] = slot.assignments;
            if (assignment === undefined) {
              return false;
            }
            const clashes = occupations.some(
              (occupation) =>
                (occupation.slotIndex === null || occupation.slotIndex === assignment.slotIndex) &&
                occupation.startsAt.getTime() < slot.occupiesUntil.getTime() &&
                occupation.endsAt.getTime() > slot.occupiesFrom.getTime(),
            );
            const inside = opening.some(
              (interval) =>
                interval.start <= slot.startsAt.getTime() && interval.end >= slot.endsAt.getTime(),
            );
            return !clashes && inside;
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
