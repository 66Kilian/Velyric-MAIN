import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuthEntry } from '@/components/marketing/auth-entry';
import { sanitizeReturnTo } from '@/components/marketing/return-to';
import { webConfig } from '@/server/config';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth.signUp' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function SignupPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  return (
    <AuthEntry
      mode="sign-up"
      returnTo={sanitizeReturnTo(search['return_to'], '/app/onboarding')}
      turnstileSiteKey={webConfig().turnstileSiteKey}
    />
  );
}
