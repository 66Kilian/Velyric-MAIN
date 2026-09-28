'use client';

import { BarChart, Card, CardContent, CardTitle, KpiCard, ProgressBar, cn } from '@velyric/ui';
import { useFormatter, useTranslations } from 'next-intl';

export interface StatusSlice {
  readonly status: string;
  readonly total: number;
}

export interface TrendPoint {
  readonly week: string | null;
  readonly tenants: number;
  readonly active: number;
}

export interface TicketTrendPoint {
  readonly week: string | null;
  readonly opened: number;
  readonly closed: number;
}

export interface UsageSlice {
  readonly metric: string;
  readonly quantity: number;
  readonly cost_usd_micros: number;
  readonly tenants: number;
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'pink' {
  if (status === 'ACTIVE') {
    return 'success';
  }
  if (status.startsWith('SUSPENDED') || status.startsWith('CANCELED') || status === 'DELETION') {
    return 'danger';
  }
  if (status === 'PROVISIONING' || status === 'GRACE_PERIOD' || status === 'PAYMENT_AT_RISK') {
    return 'warning';
  }
  return 'pink';
}

export function HeadlineKpis({
  total,
  active,
  newCount,
  numbers,
  trend,
}: {
  readonly total: number;
  readonly active: number;
  readonly newCount: number;
  readonly numbers: number;
  readonly trend: readonly TrendPoint[];
}) {
  const t = useTranslations('admin.stats');
  const series = trend.map((point) => point.tenants);
  const previous = series.at(-2) ?? 0;
  const latest = series.at(-1) ?? 0;
  const delta = previous === 0 ? null : Math.round(((latest - previous) / previous) * 100);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard label={t('customers')} value={String(total)} trend={series} color="pink" />
      <KpiCard
        label={t('active')}
        value={String(active)}
        trend={trend.map((point) => point.active)}
        color="violet"
      />
      <KpiCard
        label={t('new30d')}
        value={String(newCount)}
        delta={delta}
        deltaLabel={t('vsLastWeek')}
        color="magenta"
      />
      <KpiCard label={t('numbers')} value={String(numbers)} color="coral" />
    </div>
  );
}

export function StatusBreakdown({ slices }: { readonly slices: readonly StatusSlice[] }) {
  const t = useTranslations('admin.stats');
  const total = slices.reduce((sum, slice) => sum + slice.total, 0);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle>{t('distribution')}</CardTitle>
          <span className="text-sm text-text-muted">{t('ofTotal', { total })}</span>
        </div>
        {total === 0 ? (
          <p className="text-sm text-text-muted">{t('noCustomers')}</p>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-muted">
              {slices.map((slice) => (
                <span
                  key={slice.status}
                  title={`${slice.status}: ${String(slice.total)}`}
                  style={{ width: `${String((slice.total / total) * 100)}%` }}
                  className={cn(
                    'h-full',
                    statusTone(slice.status) === 'success'
                      ? 'bg-success'
                      : statusTone(slice.status) === 'danger'
                        ? 'bg-danger'
                        : statusTone(slice.status) === 'warning'
                          ? 'bg-warning'
                          : 'vly-gradient-cta',
                  )}
                />
              ))}
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {slices.map((slice) => (
                <li key={slice.status} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate text-text">{slice.status}</span>
                    <span className="tabular-nums font-semibold text-text">{slice.total}</span>
                  </span>
                  <ProgressBar
                    value={slice.total}
                    max={total}
                    tone={statusTone(slice.status) === 'pink' ? 'pink' : statusTone(slice.status)}
                    label={`${slice.status} ${String(slice.total)}`}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SignupChart({ trend }: { readonly trend: readonly TrendPoint[] }) {
  const t = useTranslations('admin.stats');
  const format = useFormatter();
  const data = trend.map((point) => ({
    label:
      point.week === null
        ? '—'
        : format.dateTime(new Date(point.week), { month: 'short', day: 'numeric' }),
    value: point.tenants,
    secondary: point.active,
  }));
  const total = trend.reduce((sum, point) => sum + point.tenants, 0);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle>{t('signups')}</CardTitle>
          <span className="text-sm text-text-muted">{t('last12Weeks', { total })}</span>
        </div>
        <BarChart data={data} ariaLabel={t('signups')} color="pink" secondaryColor="violet" />
        <div className="flex flex-wrap gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-pink" aria-hidden="true" />
            {t('legendNew')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-violet" aria-hidden="true" />
            {t('legendActive')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function TicketChart({ trend }: { readonly trend: readonly TicketTrendPoint[] }) {
  const t = useTranslations('admin.stats');
  const format = useFormatter();
  const data = trend.map((point) => ({
    label:
      point.week === null
        ? '—'
        : format.dateTime(new Date(point.week), { month: 'short', day: 'numeric' }),
    value: point.opened,
    secondary: point.closed,
  }));
  const opened = trend.reduce((sum, point) => sum + point.opened, 0);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle>{t('ticketTrend')}</CardTitle>
          <span className="text-sm text-text-muted">{t('last12Weeks', { total: opened })}</span>
        </div>
        <BarChart
          data={data}
          ariaLabel={t('ticketTrend')}
          color="magenta"
          secondaryColor="violet"
        />
        <div className="flex flex-wrap gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-magenta" aria-hidden="true" />
            {t('legendOpened')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-violet" aria-hidden="true" />
            {t('legendClosed')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function UsageBreakdown({
  slices,
  days,
}: {
  readonly slices: readonly UsageSlice[];
  readonly days: number;
}) {
  const t = useTranslations('admin.stats');
  const maxCost = Math.max(1, ...slices.map((slice) => slice.cost_usd_micros));
  const totalCost = slices.reduce((sum, slice) => sum + slice.cost_usd_micros, 0);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle>{t('usage', { days })}</CardTitle>
          <span className="text-sm font-semibold tabular-nums text-text">
            ${(totalCost / 1_000_000).toFixed(2)}
          </span>
        </div>
        {slices.length === 0 ? (
          <p className="text-sm text-text-muted">{t('noUsage')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {slices.map((slice) => (
              <li key={slice.metric} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-text">{slice.metric}</span>
                  <span className="flex items-baseline gap-3 text-text-muted">
                    <span className="tabular-nums">{slice.quantity.toLocaleString()}</span>
                    <span className="tabular-nums font-semibold text-text">
                      ${(slice.cost_usd_micros / 1_000_000).toFixed(2)}
                    </span>
                    <span className="tabular-nums">
                      {t('tenantCount', { count: slice.tenants })}
                    </span>
                  </span>
                </span>
                <ProgressBar
                  value={slice.cost_usd_micros}
                  max={maxCost}
                  label={`${slice.metric} ${String(slice.cost_usd_micros)}`}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RevenueCards({
  rows,
  days,
}: {
  readonly rows: readonly {
    currency: string;
    issued_documents: number;
    issued_total_minor: number;
    pending_documents: number;
    balance_minor: number;
  }[];
  readonly days: number;
}) {
  const t = useTranslations('admin.stats');
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5">
        <CardTitle>{t('revenue', { days })}</CardTitle>
        {rows.length === 0 ? (
          <p className="text-sm text-text-muted">{t('noRevenue')}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {rows.map((row) => {
              const documents = row.issued_documents + row.pending_documents;
              return (
                <div
                  key={row.currency}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-text-muted">{row.currency}</span>
                    <span className="text-[22px] font-[650] tabular-nums leading-none text-text">
                      {(row.issued_total_minor / 100).toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </div>
                  <ProgressBar
                    value={row.issued_documents}
                    max={Math.max(1, documents)}
                    tone="success"
                    label={t('issued')}
                  />
                  <ul className="flex flex-col gap-1 text-sm">
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('issued')}</span>
                      <span className="tabular-nums">{row.issued_documents}</span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('pending')}</span>
                      <span className="tabular-nums">{row.pending_documents}</span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('balances')}</span>
                      <span className="tabular-nums">
                        {(row.balance_minor / 100).toFixed(2)} {row.currency}
                      </span>
                    </li>
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
