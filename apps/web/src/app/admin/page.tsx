import { Badge, Card, CardContent, CardTitle, PageHeader } from '@velyric/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import {
  HeadlineKpis,
  SignupChart,
  StatusBreakdown,
  type StatusSlice,
  type TicketTrendPoint,
  type TrendPoint,
} from '@/components/admin/stat-visuals';
import type { AdminStats, AdminTenantPage } from '@/lib/api/admin';
import type { AdminTicketSummary } from '@/lib/api/support';
import { serverGet, serverGetOrNull } from '@/server/api';
import { getStaffContext } from '@/server/staff';

interface StatsResponse extends AdminStats {
  readonly by_status: readonly StatusSlice[];
  readonly signup_trend: readonly TrendPoint[];
  readonly ticket_trend: readonly TicketTrendPoint[];
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ACTIVE') {
    return 'success';
  }
  if (status.startsWith('SUSPENDED') || status.startsWith('CANCELED')) {
    return 'danger';
  }
  if (status === 'PROVISIONING' || status === 'GRACE_PERIOD' || status === 'PAYMENT_AT_RISK') {
    return 'warning';
  }
  return 'neutral';
}

export default async function AdminOverviewPage() {
  const { permissions } = await getStaffContext();
  const [t, tp, format, stats, recent, queue] = await Promise.all([
    getTranslations('admin.overview'),
    getTranslations('support.priorities'),
    getFormatter(),
    permissions.has('platform.stats:read')
      ? serverGetOrNull<StatsResponse>('/admin/stats')
      : Promise.resolve(null),
    permissions.has('platform.tenants:search')
      ? serverGet<AdminTenantPage>('/admin/tenants', { query: { limit: 6 } })
      : Promise.resolve(null),
    permissions.has('platform.tickets:read')
      ? serverGetOrNull<{ data: AdminTicketSummary[]; total: number }>('/admin/tickets', {
          query: { limit: 6, status: 'PENDING_STAFF' },
        })
      : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {stats === null ? null : (
        <HeadlineKpis
          total={stats.tenants.total}
          active={stats.tenants.active}
          newCount={stats.tenants.new_30d}
          numbers={stats.phone_numbers_active}
          trend={stats.signup_trend}
        />
      )}
      {stats === null ? null : (
        <div className="grid gap-4 xl:grid-cols-2">
          <SignupChart trend={stats.signup_trend} />
          <StatusBreakdown slices={stats.by_status} />
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {queue === null ? null : (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>{t('waiting')}</CardTitle>
                <Link
                  href="/admin/tickets"
                  className="text-sm font-semibold text-violet-text hover:underline"
                >
                  {t('allTickets')}
                </Link>
              </div>
              {queue.data.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noWaiting')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {queue.data.map((ticket) => (
                    <li key={ticket.id}>
                      <Link
                        href={`/admin/tickets?ticket=${ticket.id}`}
                        className="flex flex-col gap-1 py-2.5 hover:text-pink-text"
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {ticket.subject}
                          </span>
                          {ticket.priority === 'URGENT' || ticket.priority === 'HIGH' ? (
                            <Badge tone={ticket.priority === 'URGENT' ? 'danger' : 'warning'}>
                              {tp(ticket.priority)}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="truncate text-xs text-text-muted">
                          {ticket.workspace_name}
                          {ticket.last_message_at === null
                            ? ''
                            : ` · ${format.relativeTime(new Date(ticket.last_message_at))}`}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
        {recent === null ? null : (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>{t('recent')}</CardTitle>
                <Link
                  href="/admin/tenants"
                  className="text-sm font-semibold text-violet-text hover:underline"
                >
                  {t('allCustomers')}
                </Link>
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {recent.data.map((tenant) => (
                  <li key={tenant.id}>
                    <Link
                      href={`/admin/tenants/${tenant.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:text-pink-text"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{tenant.display_name}</span>
                        <span className="text-xs text-text-muted">
                          {tenant.plan_code ?? '—'} · {tenant.member_count} ·{' '}
                          {tenant.phone_number_count}
                        </span>
                      </span>
                      <Badge tone={statusTone(tenant.status)}>{tenant.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
