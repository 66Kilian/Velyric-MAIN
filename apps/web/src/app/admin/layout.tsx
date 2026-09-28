import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/providers/app-providers';
import { AdminShell } from '@/components/shell/admin-shell';
import { getStaffContext } from '@/server/staff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin');
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const { staff } = await getStaffContext();
  return (
    <AppProviders>
      <AdminShell
        email={staff.email}
        platformRole={staff.platform_role}
        permissions={staff.permissions}
      >
        {children}
      </AdminShell>
    </AppProviders>
  );
}
