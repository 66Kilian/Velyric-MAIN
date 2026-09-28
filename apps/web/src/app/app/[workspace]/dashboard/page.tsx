import {
  Badge,
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  EmptyState,
  KpiCard,
  ProgressBar,
} from '@velyric/ui';
import { ArrowRight, BookOpenCheck, PhoneCall } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { LiveCalls } from '@/components/dashboard/live-calls';
import { RangeSelect } from '@/components/dashboard/range-select';
import type { Page } from '@/lib/api-types';
import { enumerateDays, parseRange, percentChange, rangeWindow } from '@/lib/dates';
import { INTENT_TONES, OUTCOME_TONES, percent, splitDuration } from '@/lib/format';
import type { AnalyticsOverview, CallDetail, CallListItem, WorkspaceDetail } from '@/lib/types';
import { serverGet, serverGetOrNull } from '@/server/api';
import { getWorkspaceContext } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('dashboard') };
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions, staffMode } = await getWorkspaceContext(workspaceId);
  const callsHref = staffMode ? `/admin/calls/${workspaceId}` : null;
  const [t, te, tt, format, locale] = await Promise.all([
    getTranslations('dashboard'),
    getTranslations('enums'),
    getTranslations('common.time'),
    getFormatter(),
    getLocale(),
  ]);
  const range = parseRange(search['range']);
  const workspace = await serverGet<WorkspaceDetail>(`/workspaces/${workspaceId}`, {
    workspace: workspaceId,
  });
  const windows = rangeWindow(range, workspace.timezone);
  const canAnalytics = permissions.has('analytics:read');
  const canCalls = permissions.has('calls:read');

  const [current, previous, active, recent] = await Promise.all([
    canAnalytics
      ? serverGet<AnalyticsOverview>('/analytics/overview', {
          workspace: workspaceId,
          query: { ...windows.current },
        })
      : Promise.resolve(null),
    canAnalytics
      ? serverGet<AnalyticsOverview>('/analytics/overview', {
          workspace: workspaceId,
          query: { ...windows.previous },
        })
      : Promise.resolve(null),
    canCalls
      ? serverGet<Page<CallListItem>>('/calls', {
          workspace: workspaceId,
          query: { status: 'ACTIVE', limit: 6 },
        })
      : Promise.resolve(null),
    canCalls
      ? serverGet<Page<CallListItem>>('/calls', {
          workspace: workspaceId,
          query: { status: 'COMPLETED', limit: 1 },
        })
      : Promise.resolve(null),
  ]);
  const latest =
    recent?.data[0] === undefined
      ? null
      : await serverGetOrNull<CallDetail>(`/calls/${recent.data[0].id}`, {
          workspace: workspaceId,
        });

  const days = enumerateDays(windows.current.from, windows.current.to);
  const dailyByDate = new Map(
    (current?.daily ?? []).map((entry) => [entry.date.slice(0, 10), entry]),
  );
  const series = days.map((day) => dailyByDate.get(day));
  const callsTrend = series.map((entry) => entry?.calls_total ?? 0);
  const resolvedTrend = series.map((entry) =>
    entry === undefined || entry.calls_total === 0 ? 0 : entry.resolved_by_ai / entry.calls_total,
  );
  const durationTrend = series.map((entry) => entry?.avg_connected_seconds ?? 0);
  const qualityTrend = series.map((entry) => entry?.avg_quality_score ?? 0);
  const avg = current?.totals.avg_connected_seconds ?? null;
  const avgParts = avg === null ? null : splitDuration(avg);
  const quality = current?.totals.avg_quality_score ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-text">
            {t('welcome', { workspace: workspace.display_name })}
          </h1>
          <p className="text-[15px] text-text-muted">{t('subtitle')}</p>
        </div>
        {canAnalytics ? <RangeSelect value={range} label={t('rangeLabel')} /> : null}
      </div>

      {current !== null && previous !== null ? (
        <section
          aria-label={t('kpi.label')}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <KpiCard
            label={t('kpi.totalCalls')}
            value={format.number(current.totals.calls_total)}
            delta={percentChange(current.totals.calls_total, previous.totals.calls_total)}
            deltaLabel={t('kpi.vsPrevious')}
            trend={callsTrend}
            color="pink"
          />
          <KpiCard
            label={t('kpi.avgDuration')}
            value={
              avgParts === null
                ? '–'
                : tt('durationShort', {
                    minutes: avgParts.hours * 60 + avgParts.minutes,
                    seconds: avgParts.seconds,
                  })
            }
            delta={percentChange(avg, previous.totals.avg_connected_seconds)}
            deltaLabel={t('kpi.vsPrevious')}
            trend={durationTrend}
            color="violet"
          />
          <KpiCard
            label={t('kpi.resolutionRate')}
            value={percent(current.totals.containment_rate, locale)}
            delta={percentChange(current.totals.containment_rate, previous.totals.containment_rate)}
            deltaLabel={t('kpi.vsPrevious')}
            trend={resolvedTrend}
            color="magenta"
          />
          <KpiCard
            label={t('kpi.qualityScore')}
            value={quality === null ? '–' : format.number(quality, { maximumFractionDigits: 1 })}
            suffix={quality === null ? undefined : '/5'}
            delta={percentChange(quality, previous.totals.avg_quality_score)}
            deltaLabel={t('kpi.vsPrevious')}
            trend={qualityTrend}
            color="coral"
          />
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {active !== null ? (
          <LiveCalls workspaceId={workspaceId} initial={active} callsHref={callsHref} />
        ) : null}
        {canCalls ? (
          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('summary.title')}</CardTitle>
              {latest === null || callsHref === null ? null : (
                <Link
                  href={`${callsHref}/${latest.id}`}
                  className="inline-flex items-center gap-1 text-[13px] font-semibold text-violet-text hover:underline"
                >
                  {t('summary.viewFull')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5">
              {latest === null ? (
                <EmptyState
                  icon={<PhoneCall className="h-5 w-5" aria-hidden="true" />}
                  title={t('summary.empty')}
                  className="h-full border-none py-10"
                />
              ) : (
                <>
                  <div className="flex items-center gap-4">
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-pink-tint text-pink-text ring-1 ring-border">
                      <PhoneCall className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[16px] font-semibold text-text">
                        {te(`callChannel.${latest.channel}`)}
                      </span>
                      <span className="truncate text-[15px] tabular-nums text-text-muted">
                        {latest.caller_e164 ?? t('live.unknownCaller')}
                      </span>
                    </div>
                    {latest.intent === null ? null : (
                      <Badge tone={INTENT_TONES[latest.intent] ?? 'neutral'}>
                        {te(`callIntent.${latest.intent}`)}
                      </Badge>
                    )}
                  </div>
                  <DescriptionList
                    items={[
                      {
                        term: t('summary.duration'),
                        description:
                          latest.duration_seconds === null
                            ? '–'
                            : tt('durationShort', {
                                minutes: Math.floor(latest.duration_seconds / 60),
                                seconds: latest.duration_seconds % 60,
                              }),
                      },
                      {
                        term: t('summary.timestamp'),
                        description: format.dateTime(new Date(latest.started_at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: workspace.timezone,
                        }),
                      },
                      {
                        term: t('summary.outcome'),
                        description:
                          latest.outcome === null ? (
                            '–'
                          ) : (
                            <Badge tone={OUTCOME_TONES[latest.outcome] ?? 'neutral'}>
                              {te(`callOutcome.${latest.outcome}`)}
                            </Badge>
                          ),
                      },
                    ]}
                  />
                  {permissions.has('calls:read_transcript') ? (
                    <blockquote className="border-l-2 border-pink/50 pl-4 text-[15px] leading-relaxed text-text">
                      {latest.summary ?? t('summary.noSummary')}
                    </blockquote>
                  ) : (
                    <p className="text-sm text-text-muted">{t('summary.restricted')}</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {current !== null ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>{t('volume.title')}</CardTitle>
              <div className="flex items-center gap-4 text-xs text-text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-pink" aria-hidden="true" />
                  {t('volume.total')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-violet" aria-hidden="true" />
                  {t('volume.resolved')}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {current.totals.calls_total === 0 ? (
                <EmptyState title={t('volume.empty')} className="border-none py-10" />
              ) : (
                <BarChart
                  ariaLabel={t('volume.title')}
                  data={days.map((day, index) => ({
                    label: day.slice(8, 10),
                    value: series[index]?.calls_total ?? 0,
                    secondary: series[index]?.resolved_by_ai ?? 0,
                  }))}
                />
              )}
              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-text-muted">{t('volume.transferRate')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-text">
                    {percent(current.totals.transfer_rate, locale)}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">{t('volume.abandonmentRate')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-text">
                    {percent(current.totals.abandonment_rate, locale)}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">{t('volume.bookings')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-text">
                    {format.number(current.totals.bookings_created)}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">{t('volume.minutes')}</dt>
                  <dd className="text-lg font-semibold tabular-nums text-text">
                    {format.number(current.totals.connected_minutes)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('intents.title')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {current.intents.length === 0 ? (
                  <p className="text-sm text-text-muted">{t('intents.empty')}</p>
                ) : (
                  current.intents.slice(0, 5).map((entry) => (
                    <div key={entry.intent} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text">
                          {entry.intent === 'UNKNOWN'
                            ? t('intents.unknown')
                            : te(`callIntent.${entry.intent}`)}
                        </span>
                        <span className="tabular-nums text-text-muted">
                          {format.number(entry.calls_total)}
                        </span>
                      </div>
                      <ProgressBar
                        value={entry.calls_total}
                        max={current.totals.calls_total}
                        label={entry.intent}
                      />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            {permissions.has('knowledge:read') ? (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>{t('gaps.title')}</CardTitle>
                  <Link
                    href={`/app/${workspaceId}/knowledge`}
                    className="text-[13px] font-semibold text-violet-text hover:underline"
                  >
                    {t('gaps.manage')}
                  </Link>
                </CardHeader>
                <CardContent>
                  {current.knowledge_gaps.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-text-muted">
                      <BookOpenCheck className="h-4 w-4 text-success" aria-hidden="true" />
                      {t('gaps.empty')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {current.knowledge_gaps.slice(0, 5).map((gap) => (
                        <li key={gap.id} className="flex items-start justify-between gap-3 text-sm">
                          <span className="line-clamp-2 text-text">{gap.question}</span>
                          <Badge tone="peach">
                            {t('gaps.occurrences', { count: gap.occurrences })}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
