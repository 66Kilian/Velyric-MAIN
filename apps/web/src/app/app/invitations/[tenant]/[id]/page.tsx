import { VelyricLogo } from '@velyric/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { InvitationList } from '@/components/onboarding/onboarding-forms';
import type { PendingInvitation } from '@/lib/api/billing';
import { serverGet } from '@/server/api';
import { getMe } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding.invitations');
  return { title: t('title') };
}

export default async function InvitationPage({
  params,
}: {
  readonly params: Promise<{ tenant: string; id: string }>;
}) {
  const { tenant, id } = await params;
  const me = await getMe();
  if (me.workspaces.some((workspace) => workspace.id === tenant)) {
    redirect(`/app/${tenant}/dashboard`);
  }
  const [t, invitations] = await Promise.all([
    getTranslations('onboarding.invitations'),
    serverGet<{ data: PendingInvitation[] }>('/invitations'),
  ]);
  const invitation = invitations.data.filter(
    (entry) => entry.id === id && entry.tenant_id === tenant,
  );
  return (
    <div className="vly-blush flex min-h-dvh flex-col items-center gap-8 px-4 pt-16">
      <VelyricLogo />
      <div className="w-full max-w-lg">
        {invitation.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-6 text-center shadow-soft">
            <h1 className="text-xl font-semibold text-text">{t('notFoundTitle')}</h1>
            <p className="mt-2 text-sm text-text-muted">
              {t('notFoundBody', { email: me.user.email })}
            </p>
          </div>
        ) : (
          <InvitationList invitations={invitation} />
        )}
      </div>
    </div>
  );
}
