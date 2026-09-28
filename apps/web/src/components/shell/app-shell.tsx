'use client';

import type { Permission } from '@velyric/contracts';
import {
  Avatar,
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
  Building2,
  CalendarCheck,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Plus,
  Settings,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import { rememberWorkspace } from './actions';
import { signOutAction } from './sign-out';
import { LanguageMenu, ThemeMenu } from './preferences';
import { SETTINGS_SEGMENTS } from './settings-sections';
import { SidebarGroupLabel, SidebarLink } from './sidebar';

interface NavItem {
  readonly key: string;
  readonly segment: string;
  readonly icon: LucideIcon;
  readonly permission: Permission;
  /** Other top-level segments that should light this item up (e.g. the settings area). */
  readonly also?: readonly string[];
}

const MAIN_NAV: readonly NavItem[] = [
  { key: 'dashboard', segment: 'dashboard', icon: LayoutDashboard, permission: 'workspace:read' },
  { key: 'bookings', segment: 'bookings', icon: CalendarCheck, permission: 'bookings:read' },
];

const FOOTER_NAV: readonly NavItem[] = [
  { key: 'support', segment: 'support', icon: LifeBuoy, permission: 'support_tickets:read' },
  {
    key: 'settings',
    segment: 'settings',
    icon: Settings,
    permission: 'workspace:read',
    also: SETTINGS_SEGMENTS,
  },
];

function isActive(pathname: string, workspaceId: string, item: NavItem): boolean {
  return [item.segment, ...(item.also ?? [])].some((segment) => {
    const href = `/app/${workspaceId}/${segment}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  });
}

export interface ShellWorkspace {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface ShellInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: string;
}

export interface AppShellProps {
  readonly isStaff?: boolean;
  readonly workspace: ShellWorkspace;
  readonly workspaces: readonly ShellWorkspace[];
  readonly invitations: readonly ShellInvitation[];
  readonly permissions: readonly Permission[];
  readonly userEmail: string;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}

function SidebarNav({
  workspace,
  workspaces,
  invitations,
  permissions,
  onNavigate,
}: {
  readonly workspace: ShellWorkspace;
  readonly workspaces: readonly ShellWorkspace[];
  readonly invitations: readonly ShellInvitation[];
  readonly permissions: ReadonlySet<Permission>;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('navigation.app');
  const pathname = usePathname();
  const main = MAIN_NAV.filter((item) => permissions.has(item.permission));
  const footer = FOOTER_NAV.filter((item) => permissions.has(item.permission));
  const link = (item: NavItem) => (
    <SidebarLink
      key={item.key}
      href={`/app/${workspace.id}/${item.segment}`}
      icon={item.icon}
      label={t(item.key)}
      active={isActive(pathname, workspace.id, item)}
      onNavigate={onNavigate}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <WorkspaceSwitcher
        workspace={workspace}
        workspaces={workspaces}
        invitations={invitations}
        variant="sidebar"
      />
      <nav aria-label={t('groups.main')} className="flex flex-col gap-0.5">
        <SidebarGroupLabel>{t('groups.main')}</SidebarGroupLabel>
        {main.map(link)}
      </nav>
      <div className="flex-1" />
      <div className="hidden [@media(min-height:720px)]:block">
        <QuoteCard />
      </div>
      {footer.length === 0 ? null : (
        <nav
          aria-label={t('settings')}
          className="flex flex-col gap-0.5 border-t border-border pt-3"
        >
          {footer.map(link)}
        </nav>
      )}
    </div>
  );
}

function QuoteCard() {
  const t = useTranslations('navigation.app');
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 pb-16 pt-4 shadow-soft">
      <p className="relative z-10 text-[13px] leading-snug text-text-muted">{t('sidebarQuote')}</p>
      <svg
        viewBox="0 0 160 70"
        className="absolute inset-x-0 bottom-0 h-16 w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="vly-quote-wave" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--pink)" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--magenta)" stopOpacity="0.6" />
          </linearGradient>
        </defs>
        <path
          d="M0 52 C24 40 38 62 62 50 S104 18 124 30 S150 22 160 8 V70 H0 Z"
          fill="url(#vly-quote-wave)"
          opacity="0.45"
        />
        <path
          d="M0 52 C24 40 38 62 62 50 S104 18 124 30 S150 22 160 8"
          fill="none"
          stroke="var(--pink)"
          strokeWidth="1.5"
        />
        <path
          d="M0 60 C30 50 46 66 70 58 S110 34 130 42 S152 34 160 24"
          fill="none"
          stroke="var(--magenta)"
          strokeOpacity="0.5"
          strokeWidth="1.2"
        />
      </svg>
    </div>
  );
}

function WorkspaceSwitcher({
  workspace,
  workspaces,
  invitations,
  variant = 'header',
}: {
  readonly workspace: ShellWorkspace;
  readonly workspaces: readonly ShellWorkspace[];
  readonly invitations: readonly ShellInvitation[];
  readonly variant?: 'header' | 'sidebar';
}) {
  const t = useTranslations('navigation.app');
  const tr = useTranslations('enums.role');
  const router = useRouter();
  const showError = useApiErrorToast();
  const [joining, setJoining] = useState<string | null>(null);
  return (
    <DropdownMenu>
      {variant === 'sidebar' ? (
        <DropdownMenuTrigger
          className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-2.5 text-left shadow-soft transition hover:border-pink/40"
          aria-label={t('workspaceSwitcher')}
        >
          <Avatar name={workspace.name} size={36} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-text">{workspace.name}</span>
            <span className="truncate text-xs text-text-muted">
              {tr.has(workspace.role) ? tr(workspace.role) : workspace.role}
            </span>
          </span>
          {invitations.length > 0 ? (
            <span className="rounded-full bg-pink-tint-strong px-1.5 text-xs font-semibold text-pink-text">
              {invitations.length}
            </span>
          ) : null}
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger
          className="flex h-10 min-w-0 max-w-72 items-center gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm font-medium text-text shadow-soft hover:border-pink/40"
          aria-label={t('workspaceSwitcher')}
        >
          <span className="truncate">{workspace.name}</span>
          {invitations.length > 0 ? (
            <span className="rounded-full bg-pink-tint-strong px-1.5 text-xs font-semibold text-pink-text">
              {invitations.length}
            </span>
          ) : null}
          <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" className={variant === 'sidebar' ? 'w-64' : 'w-72'}>
        <DropdownMenuLabel>{t('workspaceSwitcher')}</DropdownMenuLabel>
        {workspaces.map((candidate) => (
          <DropdownMenuItem key={candidate.id} asChild>
            <Link href={`/app/${candidate.id}/dashboard`}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{candidate.name}</span>
                <span className="text-xs text-text-muted">{tr(candidate.role)}</span>
              </span>
              {candidate.id === workspace.id ? (
                <Check className="h-4 w-4 text-pink-text" aria-hidden="true" />
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
        {invitations.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('pendingInvitations')}</DropdownMenuLabel>
            {invitations.map((invitation) => (
              <DropdownMenuItem
                key={invitation.id}
                disabled={joining !== null}
                onSelect={(event) => {
                  event.preventDefault();
                  setJoining(invitation.id);
                  void (async () => {
                    try {
                      await api.post(`/invitations/${invitation.tenantId}/${invitation.id}/accept`);
                      await rememberWorkspace(invitation.tenantId);
                      router.push(`/app/${invitation.tenantId}/dashboard`);
                      router.refresh();
                    } catch (error) {
                      showError(error);
                      setJoining(null);
                    }
                  })();
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{invitation.name}</span>
                  <span className="text-xs text-text-muted">
                    {tr.has(invitation.role) ? tr(invitation.role) : invitation.role}
                  </span>
                </span>
                <span className="text-xs font-semibold text-pink-text">
                  {joining === invitation.id ? t('joining') : t('joinWorkspace')}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/app/onboarding">
            <Plus className="h-4 w-4 text-text-muted" aria-hidden="true" />
            {t('createWorkspace')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountMenu({
  email,
  workspaceId,
  canSecurity,
  isStaff,
}: {
  readonly email: string;
  readonly workspaceId: string;
  readonly canSecurity: boolean;
  readonly isStaff: boolean;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full focus-visible:outline-2"
        aria-label={t('navigation.app.account')}
      >
        <Avatar name={email} size={34} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isStaff ? (
          <>
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <Building2 className="h-4 w-4" aria-hidden="true" />
                {t('navigation.app.adminConsole')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {canSecurity ? (
          <DropdownMenuItem asChild>
            <Link href={`/app/${workspaceId}/security`}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              {t('navigation.app.security')}
            </Link>
          </DropdownMenuItem>
        ) : null}
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
          {t('common.actions.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({
  workspace,
  workspaces,
  invitations,
  permissions,
  userEmail,
  isStaff = false,
  banner,
  children,
}: AppShellProps) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const allowed = new Set(permissions);
  useEffect(() => {
    void rememberWorkspace(workspace.id);
  }, [workspace.id]);
  return (
    <div className="vly-blush min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('a11y.skipToContent')}
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col gap-6 border-r border-border bg-surface/80 px-3 pb-4 pt-5 backdrop-blur lg:flex">
        <Link href={`/app/${workspace.id}/dashboard`} className="px-2">
          <VelyricLogo />
        </Link>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SidebarNav
            workspace={workspace}
            workspaces={workspaces}
            invitations={invitations}
            permissions={allowed}
          />
        </div>
      </aside>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col gap-6 bg-surface px-3 pb-4 pt-5 shadow-float focus:outline-none lg:hidden">
            <div className="flex items-center justify-between px-2">
              <DialogPrimitive.Title className="sr-only">
                {t('a11y.openMenu')}
              </DialogPrimitive.Title>
              <VelyricLogo />
              <DialogPrimitive.Close
                className="rounded-sm p-1 text-text-muted hover:bg-pink-tint"
                aria-label={t('a11y.closeMenu')}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <SidebarNav
                workspace={workspace}
                workspaces={workspaces}
                invitations={invitations}
                permissions={allowed}
                onNavigate={() => {
                  setOpen(false);
                }}
              />
            </div>
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
            aria-label={t('a11y.openMenu')}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 lg:hidden">
            <WorkspaceSwitcher
              workspace={workspace}
              workspaces={workspaces}
              invitations={invitations}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <LanguageMenu mode="app" />
            <ThemeMenu />
            <div className="ml-2">
              <AccountMenu
                email={userEmail}
                workspaceId={workspace.id}
                canSecurity={allowed.has('security:read')}
                isStaff={isStaff}
              />
            </div>
          </div>
        </header>
        {banner ?? null}
        <main id="main" className="mx-auto w-full max-w-[1320px] px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
