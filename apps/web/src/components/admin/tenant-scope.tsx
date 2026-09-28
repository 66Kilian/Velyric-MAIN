import { Avatar, Badge, cn } from '@velyric/ui';
import { ChevronLeft, PhoneCall, SquareArrowOutUpRight, UsersRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AdminTenantDetail } from '@/lib/api/admin';
import { serverGetOrNull } from '@/server/api';

const SECTIONS = [
  { key: 'calls', icon: PhoneCall },
  { key: 'contacts', icon: UsersRound },
] as const;

/** Company header shown above every per-company admin page (calls, contacts). */
export async function TenantScope({
  tenantId,
  section,
}: {
  readonly tenantId: string;
  readonly section: 'calls' | 'contacts';
}) {
  const [t, tenant] = await Promise.all([
    getTranslations('admin.scope'),
    serverGetOrNull<AdminTenantDetail>(`/admin/tenants/${tenantId}`),
  ]);
  if (tenant === null) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/admin/${section}`}
        className="inline-flex w-fit items-center gap-1 text-sm font-medium text-text-muted hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {t('allCompanies')}
      </Link>
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4 shadow-soft">
        <Avatar name={tenant.display_name} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            href={`/admin/tenants/${tenant.id}`}
            className="truncate text-lg font-semibold text-text hover:text-pink-text"
          >
            {tenant.display_name}
          </Link>
          <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <Badge tone={tenant.status === 'ACTIVE' ? 'success' : 'warning'}>{tenant.status}</Badge>
            <span>{tenant.plan_code ?? '—'}</span>
            <span aria-hidden="true">·</span>
            <span>{tenant.timezone}</span>
          </span>
        </div>
        <nav
          aria-label={t('label')}
          className="flex items-center gap-1 rounded-lg border border-border bg-surface-muted p-1"
        >
          {SECTIONS.map((item) => {
            const active = item.key === section;
            return (
              <Link
                key={item.key}
                href={`/admin/${item.key}/${tenant.id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-surface text-pink-text shadow-soft'
                    : 'text-text-muted hover:text-text',
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
        <Link
          href={`/app/${tenant.id}/dashboard`}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:border-pink/40 hover:text-text"
        >
          <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
          {t('openWorkspace')}
        </Link>
      </div>
    </div>
  );
}
