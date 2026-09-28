import { VelyricMark } from '@velyric/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { serverGetOrNull } from '@/server/api';

interface InvitationPreview {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_name: string;
  readonly role: string;
  readonly expires_at: string | null;
  readonly email: string;
  readonly has_account: boolean;
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth.invite' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function InvitePage({
  params,
}: {
  readonly params: Promise<{ locale: string; tenant: string; id: string }>;
}) {
  const { locale, tenant, id } = await params;
  setRequestLocale(locale);
  const acceptPath = `/app/invitations/${tenant}/${id}`;
  // Already signed in: the private page can accept the invitation right away.
  if ((await cookies()).get('vly_session') !== undefined) {
    redirect(acceptPath);
  }
  const [t, tr, format, invitation] = await Promise.all([
    getTranslations('auth.invite'),
    getTranslations('enums.role'),
    getFormatter(),
    serverGetOrNull<InvitationPreview>(`/invitations/${tenant}/${id}/preview`),
  ]);

  if (invitation === null) {
    return (
      <section className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 px-4 py-20">
        <VelyricMark className="h-12 w-auto" />
        <div className="vly-glass w-full rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold text-text">{t('invalidTitle')}</h1>
          <p className="mt-2 text-sm text-text-muted">{t('invalidBody')}</p>
        </div>
      </section>
    );
  }

  const rows: readonly (readonly [string, string])[] = [
    [t('workspaceLabel'), invitation.workspace_name],
    [t('roleLabel'), tr.has(invitation.role) ? tr(invitation.role) : invitation.role],
    [t('emailLabel'), invitation.email],
    ...(invitation.expires_at === null
      ? []
      : ([
          [
            t('expiresLabel'),
            format.dateTime(new Date(invitation.expires_at), { dateStyle: 'long' }),
          ],
        ] as const)),
  ];

  return (
    <section className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 px-4 py-20">
      <VelyricMark className="h-12 w-auto" />
      <div className="vly-glass flex w-full flex-col gap-5 rounded-2xl p-8">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-text">
            {t('heading', { workspace: invitation.workspace_name })}
          </h1>
          <p className="mt-2 text-[15px] text-text-muted">
            {invitation.has_account ? t('bodyExisting') : t('body')}
          </p>
        </div>
        <dl className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface px-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-3 text-sm">
              <dt className="text-text-muted">{label}</dt>
              <dd className="truncate font-medium text-text">{value}</dd>
            </div>
          ))}
        </dl>
        <Link
          href={{
            pathname: invitation.has_account ? '/login' : '/signup',
            query: { return_to: acceptPath },
          }}
          className="vly-gradient-cta flex h-12 items-center justify-center rounded-full text-[15px] font-semibold shadow-cta"
        >
          {invitation.has_account ? t('signIn') : t('signUp')}
        </Link>
        <p className="text-center text-sm text-text-muted">
          {invitation.has_account ? t('noAccount') : t('haveAccount')}{' '}
          <Link
            href={{
              pathname: invitation.has_account ? '/signup' : '/login',
              query: { return_to: acceptPath },
            }}
            className="font-semibold text-violet-text hover:underline"
          >
            {invitation.has_account ? t('signUp') : t('signIn')}
          </Link>
        </p>
      </div>
    </section>
  );
}
