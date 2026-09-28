import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  NativeSelect,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  cn,
} from '@velyric/ui';
import {
  Bot,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Hourglass,
  List,
  MapPin,
  SlidersHorizontal,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CursorPager } from '@/components/common/navigation';
import { CancelBookingButton } from '@/components/scheduling/scheduling-forms';
import type { Page } from '@/lib/api-types';
import { zonedInstant, type Booking, type Location, type Service } from '@/lib/api/scheduling';
import { addDays, todayInZone } from '@/lib/dates';
import { BOOKING_TONES } from '@/lib/format';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('bookings') };
}

const STATUSES = ['CONFIRMED', 'PENDING_DEPOSIT', 'COMPLETED', 'CANCELED', 'NO_SHOW'] as const;
const RANGES = ['upcoming', 'today', 'week', 'past', 'all'] as const;
type RangeKey = (typeof RANGES)[number];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_BAR: Readonly<Record<string, string>> = {
  CONFIRMED: 'bg-success',
  PENDING_DEPOSIT: 'bg-warning',
  COMPLETED: 'bg-violet',
  NO_SHOW: 'bg-danger',
  CANCELED: 'bg-border',
};

/** Local calendar day (YYYY-MM-DD) of an instant in the given zone. */
function dayOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function rangeWindow(range: RangeKey, today: string): { from?: string; to?: string } {
  switch (range) {
    case 'upcoming':
      return { from: today };
    case 'today':
      return { from: today, to: today };
    case 'week':
      return { from: today, to: addDays(today, 6) };
    case 'past':
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'all':
      return {};
  }
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly accent: string;
}) {
  return (
    <Card className="flex items-center gap-4 p-4">
      <span
        className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', accent)}
      >
        <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] text-text-muted">{label}</span>
        <span className="text-2xl font-bold tabular-nums leading-tight text-text">{value}</span>
        {hint === undefined ? null : (
          <span className="truncate text-xs text-text-muted">{hint}</span>
        )}
      </span>
    </Card>
  );
}

export default async function BookingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'bookings:read');
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('bookings'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const locationId = searchValue(search['location_id']);
  const status = searchValue(search['status']);
  const customFrom = searchValue(search['from']);
  const customTo = searchValue(search['to']);
  const view = searchValue(search['view']) === 'table' ? 'table' : 'agenda';
  const requestedRange = searchValue(search['range']);
  const custom = customFrom !== undefined || customTo !== undefined;
  const range: RangeKey = RANGES.includes(requestedRange as RangeKey)
    ? (requestedRange as RangeKey)
    : 'upcoming';

  const [locations, services] = await Promise.all([
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
    serverGet<Page<Service>>('/services', { workspace: workspaceId, query: { limit: 200 } }),
  ]);
  const zone =
    locations.data.find((location) => location.id === locationId)?.timezone ?? workspace.timezone;
  const today = todayInZone(zone);
  const span = custom ? { from: customFrom, to: customTo } : rangeWindow(range, today);
  const from = span.from !== undefined && DAY.test(span.from) ? span.from : undefined;
  const to = span.to !== undefined && DAY.test(span.to) ? span.to : undefined;

  const [bookings, nextWeek] = await Promise.all([
    serverGet<Page<Booking>>('/bookings', {
      workspace: workspaceId,
      query: {
        limit: 50,
        cursor: searchValue(search['cursor']),
        location_id: locationId,
        status,
        from: from === undefined ? undefined : zonedInstant(`${from}T00:00`, zone),
        to: to === undefined ? undefined : zonedInstant(`${addDays(to, 1)}T00:00`, zone),
      },
    }),
    serverGet<Page<Booking>>('/bookings', {
      workspace: workspaceId,
      query: {
        limit: 200,
        location_id: locationId,
        from: zonedInstant(`${today}T00:00`, zone),
        to: zonedInstant(`${addDays(today, 7)}T00:00`, zone),
      },
    }),
  ]);

  const serviceNames = new Map(services.data.map((service) => [service.id, service.name]));
  const locationNames = new Map(locations.data.map((location) => [location.id, location.name]));
  const canWrite = permissions.has('bookings:write');
  const cancelable = (booking: Booking) =>
    canWrite && (booking.status === 'CONFIRMED' || booking.status === 'PENDING_DEPOSIT');

  const live = nextWeek.data.filter(
    (booking) => booking.status !== 'CANCELED' && booking.status !== 'NO_SHOW',
  );
  const todayCount = live.filter((booking) => dayOf(booking.starts_at, zone) === today).length;
  const pendingDeposit = live.filter((booking) => booking.status === 'PENDING_DEPOSIT').length;
  const byAgent = live.filter((booking) => booking.source === 'VOICE_AGENT').length;
  const agentShare = live.length === 0 ? null : byAgent / live.length;

  const base = `/app/${workspaceId}/bookings`;
  const hrefWith = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      range: custom ? undefined : range === 'upcoming' ? undefined : range,
      view: view === 'agenda' ? undefined : view,
      location_id: locationId,
      status,
      from: customFrom,
      to: customTo,
    };
    for (const [key, value] of Object.entries({ ...current, ...changes })) {
      if (value !== undefined && value !== '') {
        next.set(key, value);
      }
    }
    const query = next.toString();
    return query === '' ? base : `${base}?${query}`;
  };

  const days = new Map<string, Booking[]>();
  for (const booking of bookings.data) {
    const key = dayOf(booking.starts_at, booking.timezone);
    days.set(key, [...(days.get(key) ?? []), booking]);
  }
  const tomorrow = addDays(today, 1);
  const time = (iso: string, timeZone: string) =>
    format.dateTime(new Date(iso), { timeStyle: 'short', timeZone });

  return (
    <div className="flex flex-col gap-5">
      <section
        aria-label={t('overview.label')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatTile
          icon={CalendarCheck}
          label={t('overview.today')}
          value={format.number(todayCount)}
          accent="bg-pink-tint text-pink-text"
        />
        <StatTile
          icon={CalendarDays}
          label={t('overview.next7')}
          value={format.number(live.length)}
          accent="bg-[color-mix(in_srgb,var(--violet)_16%,var(--surface))] text-violet-text"
        />
        <StatTile
          icon={Hourglass}
          label={t('overview.pendingDeposit')}
          value={format.number(pendingDeposit)}
          accent="bg-[color-mix(in_srgb,var(--warning)_18%,var(--surface))] text-warning-text"
        />
        <StatTile
          icon={Bot}
          label={t('overview.byAgent')}
          value={
            agentShare === null
              ? '–'
              : format.number(agentShare, { style: 'percent', maximumFractionDigits: 0 })
          }
          hint={t('overview.byAgentHint')}
          accent="bg-[color-mix(in_srgb,var(--magenta)_14%,var(--surface))] text-pink-text"
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label={t('ranges.label')}
          className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1 shadow-soft"
        >
          {RANGES.map((key) => {
            const active = !custom && key === range;
            return (
              <Link
                key={key}
                href={hrefWith({
                  range: key === 'upcoming' ? undefined : key,
                  from: undefined,
                  to: undefined,
                  cursor: undefined,
                })}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-pink-tint-strong text-pink-text'
                    : 'text-text-muted hover:bg-pink-tint hover:text-text',
                )}
              >
                {t(`ranges.${key}`)}
              </Link>
            );
          })}
        </nav>
        <nav
          aria-label={t('views.label')}
          className="flex gap-1 rounded-xl border border-border bg-surface p-1 shadow-soft"
        >
          {(
            [
              ['agenda', CalendarClock],
              ['table', List],
            ] as const
          ).map(([key, Icon]) => (
            <Link
              key={key}
              href={hrefWith({ view: key === 'agenda' ? undefined : key })}
              aria-current={view === key ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                view === key
                  ? 'bg-pink-tint-strong text-pink-text'
                  : 'text-text-muted hover:bg-pink-tint hover:text-text',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(`views.${key}`)}
            </Link>
          ))}
        </nav>
      </div>

      <details
        className="group rounded-xl border border-border bg-surface shadow-soft"
        open={custom || locationId !== undefined || status !== undefined}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-text-muted hover:text-text">
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          {t('filters.more')}
          <ChevronRight
            className="ml-auto h-4 w-4 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <form
          method="get"
          action={base}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-5"
          aria-label={t('filters.label')}
        >
          {view === 'table' ? <input type="hidden" name="view" value="table" /> : null}
          <NativeSelect
            name="location_id"
            defaultValue={locationId ?? ''}
            aria-label={t('filters.location')}
          >
            <option value="">{t('filters.allLocations')}</option>
            {locations.data.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect name="status" defaultValue={status ?? ''} aria-label={t('filters.status')}>
            <option value="">{t('filters.allStatuses')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {te(`bookingStatus.${value}`)}
              </option>
            ))}
          </NativeSelect>
          <Input
            type="date"
            name="from"
            defaultValue={customFrom ?? ''}
            aria-label={t('filters.from')}
          />
          <Input type="date" name="to" defaultValue={customTo ?? ''} aria-label={t('filters.to')} />
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" className="flex-1">
              {t('filters.apply')}
            </Button>
            <Button asChild variant="ghost">
              <Link href={view === 'table' ? `${base}?view=table` : base}>
                {t('filters.reset')}
              </Link>
            </Button>
          </div>
        </form>
      </details>

      {bookings.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarCheck className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        </Card>
      ) : view === 'agenda' ? (
        <div className="flex flex-col gap-4">
          {[...days.entries()].map(([day, entries]) => {
            const first = entries[0];
            const heading =
              first === undefined
                ? day
                : format.dateTime(new Date(first.starts_at), {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    timeZone: first.timezone,
                  });
            const relative =
              day === today ? t('agenda.today') : day === tomorrow ? t('agenda.tomorrow') : null;
            return (
              <Card key={day} className="overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-muted/60 px-4 py-2.5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold capitalize text-text">
                    {relative === null ? null : <Badge tone="pink">{relative}</Badge>}
                    {heading}
                  </h2>
                  <span className="text-xs text-text-muted">
                    {t('agenda.count', { count: entries.length })}
                  </span>
                </div>
                <ul className="divide-y divide-border">
                  {entries.map((booking) => {
                    const location = locationNames.get(booking.location_id);
                    return (
                      <li
                        key={booking.id}
                        className={cn(
                          'flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-muted/60',
                          booking.status === 'CANCELED' ? 'opacity-60' : null,
                        )}
                      >
                        <div className="flex w-14 shrink-0 flex-col items-end tabular-nums">
                          <span className="text-[15px] font-semibold text-text">
                            {time(booking.starts_at, booking.timezone)}
                          </span>
                          <span className="text-xs text-text-muted">
                            {time(booking.ends_at, booking.timezone)}
                          </span>
                        </div>
                        <span
                          className={cn(
                            'w-1 self-stretch rounded-full',
                            STATUS_BAR[booking.status] ?? 'bg-border',
                          )}
                          aria-hidden="true"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <Link
                            href={`${base}/${booking.id}`}
                            className="truncate font-semibold text-text hover:text-pink-text hover:underline"
                          >
                            {serviceNames.get(booking.service_id) ?? booking.reference}
                          </Link>
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
                            {location === undefined ? null : (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                                {location}
                              </span>
                            )}
                            {booking.party_size === null ? null : (
                              <span className="inline-flex items-center gap-1">
                                <UsersRound className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('agenda.party', { count: booking.party_size })}
                              </span>
                            )}
                            <span className="font-mono">{booking.reference}</span>
                            <span>
                              {t.has(`sources.${booking.source}`)
                                ? t(`sources.${booking.source}`)
                                : booking.source}
                            </span>
                          </span>
                          {booking.customer_note === null ? null : (
                            <span className="line-clamp-1 text-[13px] italic text-text-muted">
                              “{booking.customer_note}”
                            </span>
                          )}
                        </div>
                        <Badge tone={BOOKING_TONES[booking.status] ?? 'neutral'}>
                          {te(`bookingStatus.${booking.status}`)}
                        </Badge>
                        {cancelable(booking) ? (
                          <div className="hidden sm:block">
                            <CancelBookingButton workspaceId={workspaceId} booking={booking} />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.when')}</Th>
                  <Th>{t('columns.reference')}</Th>
                  <Th>{t('columns.service')}</Th>
                  <Th>{t('columns.location')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.source')}</Th>
                  <Th>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {bookings.data.map((booking) => (
                  <Tr key={booking.id}>
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`${base}/${booking.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {format.dateTimeRange(
                          new Date(booking.starts_at),
                          new Date(booking.ends_at),
                          { dateStyle: 'medium', timeStyle: 'short', timeZone: booking.timezone },
                        )}
                      </Link>
                    </Td>
                    <Td className="font-mono text-xs">{booking.reference}</Td>
                    <Td>{serviceNames.get(booking.service_id) ?? '–'}</Td>
                    <Td>{locationNames.get(booking.location_id) ?? '–'}</Td>
                    <Td>
                      <Badge tone={BOOKING_TONES[booking.status] ?? 'neutral'}>
                        {te(`bookingStatus.${booking.status}`)}
                      </Badge>
                    </Td>
                    <Td>
                      {t.has(`sources.${booking.source}`)
                        ? t(`sources.${booking.source}`)
                        : booking.source}
                    </Td>
                    <Td className="text-right">
                      {cancelable(booking) ? (
                        <CancelBookingButton workspaceId={workspaceId} booking={booking} />
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}
      <CursorPager nextCursor={bookings.page.next_cursor} />
    </div>
  );
}
