import { Card, CardContent, CardTitle, PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import {
  HeadlineKpis,
  RevenueCards,
  SignupChart,
  StatusBreakdown,
  TicketChart,
  UsageBreakdown,
  type StatusSlice,
  type TicketTrendPoint,
  type TrendPoint,
  type UsageSlice,
} from '@/components/admin/stat-visuals';
import type { AdminStats } from '@/lib/api/admin';
import { serverGet, serverGetOrNull } from '@/server/api';
import { getStaffContext, requireStaffPermission } from '@/server/staff';

interface PlatformUsage {
  readonly days: number;
  readonly data: readonly UsageSlice[];
}

interface PlatformRevenue {
  readonly days: number;
  readonly data: readonly {
    currency: string;
    issued_documents: number;
    issued_total_minor: number;
    pending_documents: number;
    balance_minor: number;
  }[];
}

interface TicketCounts {
  readonly data: readonly { status: string; total: number }[];
}

interface StatsResponse extends AdminStats {
  readonly by_status: readonly StatusSlice[];
  readonly signup_trend: readonly TrendPoint[];
  readonly ticket_trend: readonly TicketTrendPoint[];
}

export default async function AdminStatsPage() {
  await requireStaffPermission('platform.stats:read');
  const { permissions } = await getStaffContext();
  const [t, ts, stats, usage, revenue, tickets] = await Promise.all([
    getTranslations('admin.stats'),
    getTranslations('support.status'),
    serverGet<StatsResponse>('/admin/stats'),
    serverGet<PlatformUsage>('/admin/usage', { query: { days: 90 } }),
    serverGet<PlatformRevenue>('/admin/revenue', { query: { days: 90 } }),
    permissions.has('platform.tickets:read')
      ? serverGetOrNull<TicketCounts>('/admin/tickets/counts')
      : Promise.resolve(null),
  ]);

  const openTickets = (tickets?.data ?? []).reduce(
    (sum, row) => (row.status === 'RESOLVED' || row.status === 'CLOSED' ? sum : sum + row.total),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <HeadlineKpis
        total={stats.tenants.total}
        active={stats.tenants.active}
        newCount={stats.tenants.new_30d}
        numbers={stats.phone_numbers_active}
        trend={stats.signup_trend}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <SignupChart trend={stats.signup_trend} />
        <StatusBreakdown slices={stats.by_status} />
      </div>
      <UsageBreakdown slices={usage.data} days={usage.days} />
      <div className="grid gap-4 xl:grid-cols-2">
        <RevenueCards rows={revenue.data} days={revenue.days} />
        {tickets === null ? (
          <TicketChart trend={stats.ticket_trend} />
        ) : (
          <div className="flex flex-col gap-4">
            <TicketChart trend={stats.ticket_trend} />
            <Card>
              <CardContent className="flex flex-col gap-3 pt-5">
                <div className="flex items-baseline justify-between gap-3">
                  <CardTitle>{t('tickets')}</CardTitle>
                  <span className="text-sm text-text-muted">{t('openNow', { openTickets })}</span>
                </div>
                {tickets.data.length === 0 ? (
                  <p className="text-sm text-text-muted">{t('noTickets')}</p>
                ) : (
                  <ul className="flex flex-wrap gap-x-8 gap-y-3">
                    {tickets.data.map((row) => (
                      <li key={row.status} className="flex flex-col">
                        <span className="text-xl font-semibold tabular-nums text-text">
                          {row.total}
                        </span>
                        <span className="text-sm text-text-muted">
                          {ts.has(row.status) ? ts(row.status) : row.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
