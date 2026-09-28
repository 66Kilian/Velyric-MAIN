'use client';

import type { Permission } from '@velyric/contracts';
import { cn } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SETTINGS_GROUPS } from './settings-sections';
import { SidebarGroupLabel, SidebarLink } from './sidebar';

export function SettingsNav({
  workspaceId,
  permissions,
}: {
  readonly workspaceId: string;
  readonly permissions: readonly Permission[];
}) {
  const t = useTranslations('navigation.app');
  const pathname = usePathname();
  const allowed = new Set(permissions);
  const groups = SETTINGS_GROUPS.map((group) => ({
    key: group.key,
    items: group.items
      .filter((item) => allowed.has(item.permission))
      .map((item) => {
        const href = `/app/${workspaceId}/${item.segment}`;
        return {
          ...item,
          href,
          active: pathname === href || pathname.startsWith(`${href}/`),
        };
      }),
  })).filter((group) => group.items.length > 0);

  return (
    <nav aria-label={t('settingsNav')} className="lg:sticky lg:top-24">
      <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-[0.1em] text-text-muted lg:px-3">
        {t('settings')}
      </h2>
      {/* Compact screens: one horizontally scrolling row of pills. */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        {groups
          .flatMap((group) => group.items)
          .map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
                item.active
                  ? 'border-pink/40 bg-pink-tint-strong text-pink-text'
                  : 'border-border bg-surface text-text-muted hover:text-text',
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
              {t(item.key)}
            </Link>
          ))}
      </div>
      {/* Large screens: grouped vertical list. */}
      <div className="hidden flex-col gap-5 rounded-xl border border-border bg-surface/70 p-3 shadow-soft lg:flex">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-0.5">
            <SidebarGroupLabel>{t(`groups.${group.key}`)}</SidebarGroupLabel>
            {group.items.map((item) => (
              <SidebarLink
                key={item.key}
                href={item.href}
                icon={item.icon}
                label={t(item.key)}
                active={item.active}
              />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
