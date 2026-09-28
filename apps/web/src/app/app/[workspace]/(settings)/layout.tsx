import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/shell/settings-nav';
import { getWorkspaceContext } from '@/server/session';

export default async function SettingsAreaLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await getWorkspaceContext(workspaceId);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[224px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav workspaceId={workspaceId} permissions={[...permissions]} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
