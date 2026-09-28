import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ActiveTenantDirectory } from '@/components/admin/tenant-directory';
import { requireStaffPermission } from '@/server/staff';
import { searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.nav');
  return { title: t('calls') };
}

export default async function AdminCallsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaffPermission('platform.tenants:read');
  const search = await searchParams;
  return (
    <ActiveTenantDirectory section="calls" query={searchValue(search['query'])?.trim() ?? ''} />
  );
}
