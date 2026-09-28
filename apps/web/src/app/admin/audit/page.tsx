import { Badge, Card, CardContent, EmptyState, PageHeader } from '@velyric/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AuditFilters } from '@/components/admin/audit-filters';
import type { AdminAuditRow } from '@/lib/api/admin';
import { serverGet } from '@/server/api';
import { requireStaffPermission } from '@/server/staff';
import { searchValue } from '@/server/workspace';

export default async function AdminAuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaffPermission('platform.audit:read');
  const search = await searchParams;
  const actorType = searchValue(search['actor_type']) ?? '';
  const action = searchValue(search['action']) ?? '';
  const tenantId = searchValue(search['tenant_id']) ?? '';
  const [t, format, feed] = await Promise.all([
    getTranslations('admin.audit'),
    getFormatter(),
    serverGet<{ data: AdminAuditRow[] }>('/admin/audit-logs', {
      query: {
        limit: 100,
        ...(actorType === '' ? {} : { actor_type: actorType }),
        ...(action === '' ? {} : { action }),
        ...(tenantId === '' ? {} : { tenant_id: tenantId }),
      },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <AuditFilters initialActorType={actorType} initialAction={action} initialTenant={tenantId} />
      {feed.data.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Card>
          <CardContent className="pt-5">
            <ul className="flex flex-col divide-y divide-border text-sm">
              {feed.data.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="tabular-nums text-text-muted">
                      {row.occurred_at === null
                        ? '—'
                        : format.dateTime(new Date(row.occurred_at), {
                            dateStyle: 'short',
                            timeStyle: 'medium',
                          })}
                    </span>
                    <span className="font-medium text-text">{row.action}</span>
                    {row.actor.type === 'SUPPORT_STAFF' ? (
                      <Badge tone="violet">{t('staff')}</Badge>
                    ) : null}
                    {row.support_grant_id === null ? null : (
                      <Badge tone="warning">{t('breakGlass')}</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-text-muted">
                    <span>{row.actor.label ?? row.actor.id ?? row.actor.type}</span>
                    {row.tenant_id === null ? (
                      <span>{t('platformScope')}</span>
                    ) : (
                      <Link
                        href={`/admin/tenants/${row.tenant_id}`}
                        className="text-violet-text hover:underline"
                      >
                        {row.workspace_name ?? row.tenant_id}
                      </Link>
                    )}
                    <span>
                      {row.object_type}
                      {row.object_id === null ? '' : ` · ${row.object_id}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
