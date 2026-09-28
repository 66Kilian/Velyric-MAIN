'use client';

import type { PlatformPermission } from '@velyric/contracts';
import {
  Avatar,
  Badge,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  VelyricLogo,
} from '@velyric/ui';
import {
  BarChart3,
  Building2,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  PhoneCall,
  ScrollText,
  ShieldCheck,
  SquareArrowOutUpRight,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, useTransition, type ReactNode } from 'react';
import { LanguageMenu, ThemeMenu } from './preferences';
import { signOutAction } from './sign-out';
import { SidebarGroupLabel, SidebarLink } from './sidebar';

interface AdminNavItem {
  readonly key: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly permission: PlatformPermission | null;
}

interface AdminNavGroup {
  readonly key: 'operate' | 'companies' | 'insight' | 'admin';
  readonly items: readonly AdminNavItem[];
}

const NAV: readonly AdminNavGroup[] = [
  {
    key: 'operate',
    items: [
      { key: 'overview', href: '/admin', icon: LayoutDashboard, permission: null },
      {
        key: 'tenants',
        href: '/admin/tenants',
        icon: Building2,
        permission: 'platform.tenants:search',
      },
      {
        key: 'tickets',
        href: '/admin/tickets',
        icon: LifeBuoy,
        permission: 'platform.tickets:read',
      },
    ],
  },
  {
    key: 'companies',
    items: [
      { key: 'calls', href: '/admin/calls', icon: PhoneCall, permission: 'platform.tenants:read' },
      {
        key: 'contacts',
        href: '/admin/contacts',
        icon: UsersRound,
        permission: 'platform.tenants:read',
      },
    ],
  },
  {
    key: 'insight',
    items: [
      { key: 'stats', href: '/admin/stats', icon: BarChart3, permission: 'platform.stats:read' },
      { key: 'audit', href: '/admin/audit', icon: ScrollText, permission: 'platform.audit:read' },
    ],
  },
  {
    key: 'admin',
    items: [
      {
        key: 'staff',
        href: '/admin/staff',
        icon: ShieldCheck,
        permission: 'platform.staff:manage',
      },
    ],
  },
];

function AdminNav({
  permissions,
  onNavigate,
}: {
  readonly permissions: ReadonlySet<PlatformPermission>;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  return (
    <nav aria-label={t('console')} className="flex flex-col gap-5">
      {NAV.map((group) => {
        const items = group.items.filter(
          (item) => item.permission === null || permissions.has(item.permission),
        );
        if (items.length === 0) {
          return null;
        }
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <SidebarGroupLabel>{t(`groups.${group.key}`)}</SidebarGroupLabel>
            {items.map((item) => (
              <SidebarLink
                key={item.key}
                href={item.href}
                icon={item.icon}
                label={t(item.key)}
                active={
                  item.href === '/admin'
                    ? pathname === '/admin'
                    : pathname === item.href || pathname.startsWith(`${item.href}/`)
                }
                onNavigate={onNavigate}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function BackToApp({ onNavigate }: { readonly onNavigate?: () => void }) {
  const t = useTranslations('admin.nav');
  return (
    <Link
      href="/app"
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px] font-medium text-text-muted shadow-soft transition hover:border-pink/40 hover:text-text"
    >
      <SquareArrowOutUpRight className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{t('backToApp')}</span>
    </Link>
  );
}

function StaffMenu({
  email,
  platformRole,
}: {
  readonly email: string;
  readonly platformRole: string;
}) {
  const t = useTranslations('admin.nav');
  const tr = useTranslations('admin.roles');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full focus-visible:outline-2"
        aria-label={tc('actions.signOut')}
      >
        <Avatar name={email} size={34} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
        <DropdownMenuLabel className="pt-0 text-xs font-normal text-text-muted">
          {tr.has(platformRole) ? tr(platformRole) : platformRole}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/app">
            <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
            {t('backToApp')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            startTransition(async () => {
              await signOutAction();
            });
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {tc('actions.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AdminShell({
  email,
  platformRole,
  permissions,
  children,
}: {
  readonly email: string;
  readonly platformRole: string;
  readonly permissions: readonly PlatformPermission[];
  readonly children: ReactNode;
}) {
  const t = useTranslations('admin.nav');
  const tr = useTranslations('admin.roles');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const allowed = new Set(permissions);

  return (
    <div className="vly-blush min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {tc('a11y.skipToContent')}
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col gap-6 border-r border-border bg-surface/80 px-3 pb-4 pt-5 backdrop-blur lg:flex">
        <Link href="/admin" className="flex items-center gap-2 px-2">
          <VelyricLogo />
          <Badge tone="violet">{t('console')}</Badge>
        </Link>
        <div className="flex-1 overflow-y-auto">
          <AdminNav permissions={allowed} />
        </div>
        <BackToApp />
      </aside>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col gap-6 bg-surface px-3 pb-4 pt-5 shadow-float focus:outline-none lg:hidden">
            <div className="flex items-center justify-between px-2">
              <DialogPrimitive.Title className="sr-only">
                {tc('a11y.openMenu')}
              </DialogPrimitive.Title>
              <VelyricLogo />
              <DialogPrimitive.Close
                className="rounded-sm p-1 text-text-muted hover:bg-pink-tint"
                aria-label={tc('a11y.closeMenu')}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <div className="flex-1 overflow-y-auto">
              <AdminNav
                permissions={allowed}
                onNavigate={() => {
                  setOpen(false);
                }}
              />
            </div>
            <BackToApp
              onNavigate={() => {
                setOpen(false);
              }}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </Dialog>
      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur md:px-8">
          <button
            type="button"
            className="rounded-md p-2 text-text-muted hover:bg-pink-tint lg:hidden"
            onClick={() => {
              setOpen(true);
            }}
            aria-label={tc('a11y.openMenu')}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="flex h-10 min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text shadow-soft">
            <ShieldCheck className="h-4 w-4 shrink-0 text-pink-text" aria-hidden="true" />
            <span className="truncate">{t('console')}</span>
            <span className="hidden truncate text-text-muted sm:inline">
              · {tr.has(platformRole) ? tr(platformRole) : platformRole}
            </span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <LanguageMenu mode="app" />
            <ThemeMenu />
            <div className="ml-2">
              <StaffMenu email={email} platformRole={platformRole} />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1320px] px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
