import { Badge, Card, CardContent, CardTitle, DescriptionList, PageHeader } from '@velyric/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { AdminAuditRow, AdminTenantDetail } from '@/lib/api/admin';
import { serverGet, serverGetOrNull } from '@/server/api';
import { TenantWorkbench } from '@/components/admin/tenant-workbench';
import { getStaffContext, requireStaffPermission } from '@/server/staff';

export default async function AdminTenantPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireStaffPermission('platform.tenants:read');
  const { permissions } = await getStaffContext();
  const [t, format, tenant] = await Promise.all([
    getTranslations('admin.tenant'),
    getFormatter(),
    serverGetOrNull<AdminTenantDetail>(`/admin/tenants/${id}`),
  ]);
  if (tenant === null) {
    notFound();
  }
  const audit = permissions.has('platform.audit:read')
    ? await serverGet<{ data: AdminAuditRow[] }>('/admin/audit-logs', {
        query: { tenant_id: id, limit: 15 },
      })
    : null;

  const facts: readonly { readonly term: string; readonly description: string }[] = [
    { term: t('fields.legalName'), description: tenant.legal_name },
    { term: t('fields.slug'), description: tenant.slug },
    { term: t('fields.status'), description: tenant.status },
    { term: t('fields.statusReason'), description: tenant.status_reason ?? '—' },
    { term: t('fields.plan'), description: tenant.plan_code ?? '—' },
    { term: t('fields.market'), description: tenant.billing_market },
    { term: t('fields.trust'), description: tenant.trust_tier },
    { term: t('fields.vertical'), description: tenant.vertical_pack },
    { term: t('fields.locale'), description: tenant.default_locale },
    { term: t('fields.timezone'), description: tenant.timezone },
    { term: t('fields.owner'), description: tenant.owner_email ?? '—' },
    {
      term: t('fields.created'),
      description:
        tenant.created_at === null
          ? '—'
          : format.dateTime(new Date(tenant.created_at), { dateStyle: 'medium' }),
    },
    { term: t('fields.members'), description: String(tenant.member_count) },
    { term: t('fields.locations'), description: String(tenant.location_count) },
    {
      term: t('fields.agents'),
      description: `${String(tenant.published_agent_count)} / ${String(tenant.agent_count)}`,
    },
    { term: t('fields.provisioning'), description: tenant.provisioning_state ?? '—' },
    { term: t('fields.subscription'), description: tenant.subscription_status ?? '—' },
    {
      term: t('fields.periodEnd'),
      description:
        tenant.subscription_period_end === null
          ? '—'
          : format.dateTime(new Date(tenant.subscription_period_end), { dateStyle: 'medium' }),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href="/admin/tenants">{t('back')}</Link>}
        title={tenant.display_name}
        description={tenant.id}
        actions={
          <Link
            href={`/app/${tenant.id}/dashboard`}
            className="vly-gradient-cta flex h-10 items-center rounded-full px-4 text-sm font-semibold shadow-cta"
          >
            {t('openWorkspace')}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-5">
            <CardTitle>{t('service')}</CardTitle>
            <DescriptionList items={facts} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <CardTitle>{t('numbers')}</CardTitle>
            {tenant.phone_numbers.length === 0 ? (
              <p className="text-sm text-text-muted">{t('noNumbers')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {tenant.phone_numbers.map((number) => (
                  <li key={number.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="font-medium tabular-nums">{number.e164}</span>
                    <Badge tone={number.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {number.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <TenantWorkbench
        tenantId={tenant.id}
        currentStatus={tenant.status}
        can={{
          suspend: permissions.has('platform.tenants:suspend'),
          usage: permissions.has('platform.usage:manage'),
          balance: permissions.has('platform.balance:manage'),
          billing: permissions.has('platform.billing:manage'),
          numbers: permissions.has('platform.phone_numbers:manage'),
          secrets: permissions.has('platform.secrets:manage'),
        }}
      />
      {audit === null ? null : (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <CardTitle>{t('activity')}</CardTitle>
            {audit.data.length === 0 ? (
              <p className="text-sm text-text-muted">{t('noActivity')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {audit.data.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="text-text-muted tabular-nums">
                      {row.occurred_at === null
                        ? '—'
                        : format.dateTime(new Date(row.occurred_at), {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                    </span>
                    <span className="font-medium">{row.action}</span>
                    <span className="text-text-muted">{row.actor.label ?? row.actor.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
