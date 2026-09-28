import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { getWorkspaceContext } from '@/server/session';

const ATTENTION_STATUSES = new Set([
  'PROVISIONING',
  'PAYMENT_AT_RISK',
  'GRACE_PERIOD',
  'RESTRICTED',
  'SUSPENDED_BILLING',
  'SUSPENDED_DISPUTE',
  'SUSPENDED_RISK',
  'SUSPENDED_ADMIN',
  'CANCELED_GRACE',
  'DATA_RETENTION',
]);

export default async function WorkspaceLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { me, workspace, permissions, staffMode } = await getWorkspaceContext(workspaceId);
  const t = await getTranslations('dashboard.statusBanner');
  const ta = await getTranslations('admin.staffMode');
  const banner = ATTENTION_STATUSES.has(workspace.status) ? (
    <div
      role="status"
      className={
        workspace.status === 'PROVISIONING'
          ? 'vly-gradient-banner px-4 py-2.5 text-sm md:px-8'
          : 'bg-[color-mix(in_srgb,var(--warning)_16%,var(--surface))] px-4 py-2.5 text-sm text-warning-text md:px-8'
      }
    >
      <span className="font-medium">{t(`${workspace.status}.title`)}</span>{' '}
      <span className="opacity-90">{t(`${workspace.status}.body`)}</span>{' '}
      <Link
        className="font-semibold underline underline-offset-2"
        href={
          workspace.status === 'PROVISIONING' ? '/app/onboarding' : `/app/${workspace.id}/billing`
        }
      >
        {t(`${workspace.status}.action`)}
      </Link>
    </div>
  ) : undefined;
  const staffBanner = staffMode ? (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-[color-mix(in_srgb,var(--violet)_18%,var(--surface))] px-4 py-2.5 text-sm text-text md:px-8"
    >
      <span className="font-medium">{ta('title')}</span>
      <span className="opacity-90">{ta('body', { workspace: workspace.display_name })}</span>
      <Link className="font-semibold underline underline-offset-2" href="/admin">
        {ta('back')}
      </Link>
    </div>
  ) : undefined;

  return (
    <AppShell
      workspace={{ id: workspace.id, name: workspace.display_name, role: workspace.role }}
      workspaces={me.workspaces.map((candidate) => ({
        id: candidate.id,
        name: candidate.display_name,
        role: candidate.role,
      }))}
      invitations={me.invitations.map((invitation) => ({
        id: invitation.id,
        tenantId: invitation.tenant_id,
        name: invitation.workspace_name,
        role: invitation.role,
      }))}
      permissions={[...permissions]}
      userEmail={me.user.email}
      isStaff={me.user.platform_role !== null}
      banner={
        staffBanner === undefined ? (
          banner
        ) : (
          <>
            {staffBanner}
            {banner}
          </>
        )
      }
    >
      {children}
    </AppShell>
  );
}
