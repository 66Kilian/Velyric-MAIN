import { Avatar, Button, Card, EmptyState, Input, PageHeader } from '@velyric/ui';
import { ArrowRight, Building2, Phone, UsersRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { AdminTenantPage } from '@/lib/api/admin';
import { serverGet } from '@/server/api';

const DIRECTORY_LIMIT = 200;

/**
 * Picker of ACTIVE workspaces that the per-company admin sections (calls, contacts) start from.
 * Suspended, provisioning or canceled companies are intentionally left out.
 */
export async function ActiveTenantDirectory({
  section,
  query,
}: {
  readonly section: 'calls' | 'contacts';
  readonly query: string;
}) {
  const [t, ts, tenants] = await Promise.all([
    getTranslations('admin.directory'),
    getTranslations('admin.tenants'),
    serverGet<AdminTenantPage>('/admin/tenants', {
      query: {
        status: 'ACTIVE',
        limit: DIRECTORY_LIMIT,
        ...(query === '' ? {} : { query }),
      },
    }),
  ]);
  const basePath = `/admin/${section}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(section === 'calls' ? 'callsTitle' : 'contactsTitle')}
        description={t(section === 'calls' ? 'callsDescription' : 'contactsDescription')}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form method="get" action={basePath} className="flex w-full max-w-md items-center gap-2">
          <Input
            name="query"
            defaultValue={query}
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
          />
          <Button type="submit" variant="secondary">
            {ts('search')}
          </Button>
        </form>
        <p className="text-sm text-text-muted">{t('count', { count: tenants.total })}</p>
      </div>
      {tenants.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
            title={query === '' ? t('empty') : t('noMatches')}
            description={query === '' ? t('emptyBody') : t('noMatchesBody')}
            className="m-4 border-none"
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tenants.data.map((tenant) => (
            <li key={tenant.id}>
              <Link
                href={`${basePath}/${tenant.id}`}
                className="group flex h-full items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-soft transition hover:-translate-y-0.5 hover:border-pink/40 hover:shadow-float"
              >
                <Avatar name={tenant.display_name} size={40} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-semibold text-text">{tenant.display_name}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1">
                      <UsersRound className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('members', { count: tenant.member_count })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('numbers', { count: tenant.phone_number_count })}
                    </span>
                    {tenant.plan_code === null ? null : <span>{tenant.plan_code}</span>}
                  </span>
                </span>
                <ArrowRight
                  className="h-4 w-4 shrink-0 text-text-muted transition group-hover:translate-x-0.5 group-hover:text-pink-text"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
