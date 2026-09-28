import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { EmailBrandingCard, EmailTemplateEditor } from '@/components/settings/email-branding';
import { NotificationPreferencesEditor } from '@/components/settings/notification-preferences';
import type { EmailSender, EmailTemplate, MessagingSettings } from '@/lib/api/messaging';
import type { NotificationPreferences } from '@/lib/api/settings';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.tabs');
  return { title: t('notifications') };
}

export default async function NotificationSettingsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'workspace:read');
  const t = await getTranslations('settings.notifications');
  const scope = { workspace: workspaceId };
  const [preferences, messaging, sender, templates] = await Promise.all([
    serverGet<NotificationPreferences>('/notification-preferences', scope),
    serverGet<MessagingSettings>('/messaging-settings', scope),
    serverGetOrNull<EmailSender>('/integrations/smtp', scope),
    serverGet<{ data: readonly EmailTemplate[] }>('/email-templates', scope),
  ]);
  const canManage = permissions.has('notifications:manage');

  return (
    <div className="flex flex-col gap-6">
      <div
        className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-text-muted"
        role="note"
      >
        {sender === null || sender.status !== 'CONNECTED'
          ? t.rich('senderBanner.missing', {
              link: (chunks) => (
                <Link
                  href={`/app/${workspaceId}/integrations`}
                  className="font-medium text-pink-text hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })
          : t.rich('senderBanner.connected', {
              sender: sender.from_address ?? sender.account ?? '',
              link: (chunks) => (
                <Link
                  href={`/app/${workspaceId}/integrations`}
                  className="font-medium text-pink-text hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
      </div>
      <NotificationPreferencesEditor
        workspaceId={workspaceId}
        preferences={preferences}
        canManageWorkspace={canManage}
      />
      <EmailBrandingCard workspaceId={workspaceId} settings={messaging} canManage={canManage} />
      <EmailTemplateEditor
        workspaceId={workspaceId}
        templates={templates.data}
        sender={sender}
        canManage={canManage}
      />
    </div>
  );
}
