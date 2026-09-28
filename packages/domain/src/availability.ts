import {
  addDays,
  isoWeekdayOf,
  localDaysBetween,
  parseLocalTime,
  toLocalParts,
  zonedToUtc,
} from './timezone.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface ServiceSpec {
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly requiredResourceTypes: readonly string[];
}

export interface ResourceSpec {
  readonly id: string;
  readonly name: string;
  readonly resourceType: string;
  readonly parallelSlots: number;
}

export interface AvailabilityRuleSpec {
  readonly resourceId: string;
  readonly isoWeekday: number;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timezone: string;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
}

export interface AvailabilityExceptionSpec {
  readonly resourceId: string | null;
  readonly kind: 'CLOSED' | 'EXTRA_OPENING';
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface Occupation {
  readonly resourceId: string;
  readonly slotIndex: number | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface SlotQuery {
  readonly from: Date;
  readonly to: Date;
  readonly now: Date;
  readonly stepMinutes?: number;
  readonly minLeadMinutes?: number;
  readonly maxResults?: number;
}

export interface SlotAssignment {
  readonly resourceId: string;
  readonly resourceType: string;
  readonly slotIndex: number;
}

export interface AvailableSlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly occupiesFrom: Date;
  readonly occupiesUntil: Date;
  readonly assignments: readonly SlotAssignment[];
}

export interface AvailabilityInput {
  readonly service: ServiceSpec;
  readonly resources: readonly ResourceSpec[];
  readonly rules: readonly AvailabilityRuleSpec[];
  readonly exceptions: readonly AvailabilityExceptionSpec[];
  readonly occupations: readonly Occupation[];
  readonly query: SlotQuery;
}

export class AvailabilityInputError extends RangeError {}

export function normalizeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

export function subtractIntervals(
  base: readonly Interval[],
  remove: readonly Interval[],
): Interval[] {
  const removals = normalizeIntervals(remove);
  const result: Interval[] = [];
  for (const interval of normalizeIntervals(base)) {
    let cursor = interval.start;
    for (const removal of removals) {
      if (removal.end <= cursor || removal.start >= interval.end) {
        continue;
      }
      if (removal.start > cursor) {
        result.push({ start: cursor, end: removal.start });
      }
      cursor = Math.max(cursor, removal.end);
      if (cursor >= interval.end) {
        break;
      }
    }
    if (cursor < interval.end) {
      result.push({ start: cursor, end: interval.end });
    }
  }
  return result;
}

function contains(intervals: readonly Interval[], target: Interval): boolean {
  return intervals.some((interval) => interval.start <= target.start && interval.end >= target.end);
}

function overlaps(intervals: readonly Interval[], target: Interval): boolean {
  return intervals.some((interval) => interval.start < target.end && interval.end > target.start);
}

function clip(interval: Interval, window: Interval): Interval | null {
  const start = Math.max(interval.start, window.start);
  const end = Math.min(interval.end, window.end);
  return end > start ? { start, end } : null;
}

export function openingIntervals(
  resourceId: string,
  rules: readonly AvailabilityRuleSpec[],
  exceptions: readonly AvailabilityExceptionSpec[],
  window: Interval,
): Interval[] {
  const open: Interval[] = [];
  for (const rule of rules) {
    if (rule.resourceId !== resourceId) {
      continue;
    }
    const opens = parseLocalTime(rule.startLocal);
    const closes = parseLocalTime(rule.endLocal);
    const firstDay = toLocalParts(new Date(window.start - DAY_MS), rule.timezone);
    const lastDay = toLocalParts(new Date(window.end + DAY_MS), rule.timezone);
    const days = localDaysBetween(firstDay, lastDay);
    for (let offset = 0; offset <= days; offset += 1) {
      const date = addDays(firstDay, offset);
      if (isoWeekdayOf(date) !== rule.isoWeekday) {
        continue;
      }
      const start = zonedToUtc({ ...date, ...opens }, rule.timezone).getTime();
      const end = zonedToUtc({ ...date, ...closes }, rule.timezone).getTime();
      if (
        (rule.validFrom !== null && end <= rule.validFrom.getTime()) ||
        (rule.validTo !== null && start >= rule.validTo.getTime())
      ) {
        continue;
      }
      const bounded = clip(
        {
          start: rule.validFrom === null ? start : Math.max(start, rule.validFrom.getTime()),
          end: rule.validTo === null ? end : Math.min(end, rule.validTo.getTime()),
        },
        window,
      );
      if (bounded !== null) {
        open.push(bounded);
      }
    }
  }
  const applicable = exceptions.filter(
    (exception) => exception.resourceId === null || exception.resourceId === resourceId,
  );
  const extra = applicable
    .filter((exception) => exception.kind === 'EXTRA_OPENING')
    .map((exception) =>
      clip({ start: exception.startsAt.getTime(), end: exception.endsAt.getTime() }, window),
    )
    .filter((interval): interval is Interval => interval !== null);
  const closed = applicable
    .filter((exception) => exception.kind === 'CLOSED')
    .map((exception) => ({ start: exception.startsAt.getTime(), end: exception.endsAt.getTime() }));
  return subtractIntervals([...open, ...extra], closed);
}

function validate(input: AvailabilityInput): { step: number; lead: number; maxResults: number } {
  const { service, query } = input;
  const step = query.stepMinutes ?? 15;
  const lead = query.minLeadMinutes ?? 0;
  const maxResults = query.maxResults ?? 20;
  if (
    !Number.isInteger(service.durationMinutes) ||
    service.durationMinutes <= 0 ||
    service.durationMinutes > 24 * 60
  ) {
    throw new AvailabilityInputError('service duration must be between 1 and 1440 minutes');
  }
  if (service.bufferBeforeMinutes < 0 || service.bufferAfterMinutes < 0) {
    throw new AvailabilityInputError('service buffers must not be negative');
  }
  if (service.requiredResourceTypes.length === 0) {
    throw new AvailabilityInputError('service must require at least one resource type');
  }
  if (!Number.isInteger(step) || step < 5 || step > 240) {
    throw new AvailabilityInputError('step must be between 5 and 240 minutes');
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new AvailabilityInputError('maxResults must be between 1 and 200');
  }
  if (
    query.to.getTime() <= query.from.getTime() ||
    query.to.getTime() - query.from.getTime() > 62 * DAY_MS
  ) {
    throw new AvailabilityInputError('query window must be positive and at most 62 days');
  }
  return { step, lead, maxResults };
}

export function findAvailableSlots(input: AvailabilityInput): AvailableSlot[] {
  const { step, lead, maxResults } = validate(input);
  const { service, query } = input;
  const before = service.bufferBeforeMinutes * MINUTE_MS;
  const after = service.bufferAfterMinutes * MINUTE_MS;
  const duration = service.durationMinutes * MINUTE_MS;
  const stepMs = step * MINUTE_MS;
  const window: Interval = { start: query.from.getTime(), end: query.to.getTime() };
  const resources = [...input.resources]
    .filter((resource) => resource.parallelSlots > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const opening = new Map<string, Interval[]>();
  const wholeBusy = new Map<string, Interval[]>();
  const slotBusy = new Map<string, Interval[][]>();
  for (const resource of resources) {
    opening.set(resource.id, openingIntervals(resource.id, input.rules, input.exceptions, window));
    const own = input.occupations.filter((occupation) => occupation.resourceId === resource.id);
    const toInterval = (occupation: Occupation): Interval => ({
      start: occupation.startsAt.getTime(),
      end: occupation.endsAt.getTime(),
    });
    wholeBusy.set(
      resource.id,
      normalizeIntervals(own.filter((occupation) => occupation.slotIndex === null).map(toInterval)),
    );
    slotBusy.set(
      resource.id,
      Array.from({ length: resource.parallelSlots }, (_, index) =>
        normalizeIntervals(
          own.filter((occupation) => occupation.slotIndex === index).map(toInterval),
        ),
      ),
    );
  }
  const earliest = Math.max(window.start, query.now.getTime() + lead * MINUTE_MS);
  const results: AvailableSlot[] = [];
  for (
    let start = Math.ceil(earliest / stepMs) * stepMs;
    start + duration <= window.end && results.length < maxResults;
    start += stepMs
  ) {
    const serviceInterval: Interval = { start, end: start + duration };
    const occupancy: Interval = { start: start - before, end: start + duration + after };
    const used = new Set<string>();
    const assignments: SlotAssignment[] = [];
    for (const resourceType of service.requiredResourceTypes) {
      let assigned: SlotAssignment | null = null;
      for (const resource of resources) {
        if (resource.resourceType !== resourceType || used.has(resource.id)) {
          continue;
        }
        if (
          !contains(opening.get(resource.id) ?? [], serviceInterval) ||
          overlaps(wholeBusy.get(resource.id) ?? [], occupancy)
        ) {
          continue;
        }
        const slots = slotBusy.get(resource.id) ?? [];
        const slotIndex = slots.findIndex((busy) => !overlaps(busy, occupancy));
        if (slotIndex >= 0) {
          assigned = { resourceId: resource.id, resourceType, slotIndex };
          break;
        }
      }
      if (assigned === null) {
        break;
      }
      used.add(assigned.resourceId);
      assignments.push(assigned);
    }
    if (assignments.length === service.requiredResourceTypes.length) {
      results.push({
        startsAt: new Date(serviceInterval.start),
        endsAt: new Date(serviceInterval.end),
        occupiesFrom: new Date(occupancy.start),
        occupiesUntil: new Date(occupancy.end),
        assignments,
      });
    }
  }
  return results;
}
