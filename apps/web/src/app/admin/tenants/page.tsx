import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { TenantSearch } from '@/components/admin/tenant-search';
import type { AdminTenantPage } from '@/lib/api/admin';
import { serverGet } from '@/server/api';
import { requireStaffPermission } from '@/server/staff';
import { searchValue } from '@/server/workspace';

const PAGE_SIZE = 25;

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

export default async function AdminTenantsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaffPermission('platform.tenants:search');
  const search = await searchParams;
  const query = searchValue(search['query']) ?? '';
  const status = searchValue(search['status']) ?? '';
  const page = Number(searchValue(search['page']) ?? '1');
  const offset = Number.isFinite(page) && page > 1 ? (page - 1) * PAGE_SIZE : 0;
  const [t, format, tenants] = await Promise.all([
    getTranslations('admin.tenants'),
    getFormatter(),
    serverGet<AdminTenantPage>('/admin/tenants', {
      query: {
        limit: PAGE_SIZE,
        offset,
        ...(query === '' ? {} : { query }),
        ...(status === '' ? {} : { status }),
      },
    }),
  ]);
  const shown = tenants.offset + tenants.data.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <TenantSearch initialQuery={query} initialStatus={status} />
      {tenants.data.length === 0 ? (
        <EmptyState title={t('empty')} description={t('emptyBody')} />
      ) : (
        <Card>
          <CardContent className="pt-5">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.name')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.plan')}</Th>
                  <Th>{t('columns.members')}</Th>
                  <Th>{t('columns.numbers')}</Th>
                  <Th>{t('columns.created')}</Th>
                </Tr>
              </THead>
              <TBody>
                {tenants.data.map((tenant) => (
                  <Tr key={tenant.id}>
                    <Td>
                      <Link
                        href={`/admin/tenants/${tenant.id}`}
                        className="font-medium text-text hover:text-pink-text"
                      >
                        {tenant.display_name}
                      </Link>
                      <span className="block text-xs text-text-muted">{tenant.slug}</span>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(tenant.status)}>{tenant.status}</Badge>
                    </Td>
                    <Td>{tenant.plan_code ?? '—'}</Td>
                    <Td className="tabular-nums">{tenant.member_count}</Td>
                    <Td className="tabular-nums">{tenant.phone_number_count}</Td>
                    <Td>
                      {tenant.created_at === null
                        ? '—'
                        : format.dateTime(new Date(tenant.created_at), { dateStyle: 'medium' })}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-between pt-4 text-sm text-text-muted">
              <span>{t('counter', { shown, total: tenants.total })}</span>
              <span className="flex gap-3">
                {tenants.offset > 0 ? (
                  <Link
                    className="font-semibold text-violet-text hover:underline"
                    href={`/admin/tenants?page=${page - 1}${query === '' ? '' : `&query=${encodeURIComponent(query)}`}${status === '' ? '' : `&status=${status}`}`}
                  >
                    {t('previous')}
                  </Link>
                ) : null}
                {shown < tenants.total ? (
                  <Link
                    className="font-semibold text-violet-text hover:underline"
                    href={`/admin/tenants?page=${page + 1}${query === '' ? '' : `&query=${encodeURIComponent(query)}`}${status === '' ? '' : `&status=${status}`}`}
                  >
                    {t('next')}
                  </Link>
                ) : null}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
