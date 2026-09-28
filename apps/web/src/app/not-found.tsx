import { Button, VelyricLogo } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

export default async function NotFound() {
  const t = await getTranslations('errors.generic');
  const common = await getTranslations('common');
  return (
    <main className="vly-blush flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <VelyricLogo />
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t('notFoundTitle')}</h1>
        <p className="text-text-muted">{t('notFoundDescription')}</p>
      </div>
      <Button asChild variant="secondary">
        <Link href="/">{common('actions.back')}</Link>
      </Button>
    </main>
  );
}
