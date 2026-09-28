import { VelyricLogo } from '@velyric/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { webConfig } from '@/server/config';

const DOCUMENTS = ['privacy', 'terms', 'dpa'] as const;
const SECTION_COUNT = 8;

export function generateStaticParams() {
  return DOCUMENTS.map((document) => ({ document }));
}

function isDocument(value: string): value is (typeof DOCUMENTS)[number] {
  return (DOCUMENTS as readonly string[]).includes(value);
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ document: string }>;
}): Promise<Metadata> {
  const { document } = await params;
  if (!isDocument(document)) {
    return {};
  }
  const t = await getTranslations(`legal.${document}`);
  const entity = webConfig().legalEntity;
  return {
    title: t('title'),
    description: t('intro', { entity: entity.name }),
    alternates: { canonical: `/legal/${document}` },
    openGraph: { title: t('title'), description: t('intro', { entity: entity.name }) },
  };
}

export default async function LegalDocumentPage({
  params,
}: {
  readonly params: Promise<{ document: string }>;
}) {
  const { document } = await params;
  if (!isDocument(document)) {
    notFound();
  }
  const [t, tl, locale] = await Promise.all([
    getTranslations(`legal.${document}`),
    getTranslations('legal'),
    getLocale(),
  ]);
  const entity = webConfig().legalEntity;
  const args = {
    entity: entity.name,
    address: entity.address,
    registration: entity.registration,
    taxNumber: entity.taxNumber,
    email: entity.privacyEmail,
  };
  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#legal-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {tl('navLabel')}
      </a>
      <header className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4">
        <Link href={`/${locale}`}>
          <VelyricLogo />
        </Link>
        <nav aria-label={tl('navLabel')} className="flex gap-4 text-sm">
          {DOCUMENTS.map((entry) => (
            <Link
              key={entry}
              href={`/legal/${entry}`}
              aria-current={entry === document ? 'page' : undefined}
              className={
                entry === document
                  ? 'font-semibold text-pink-text'
                  : 'text-text-muted hover:text-text'
              }
            >
              {tl(`${entry}.short`)}
            </Link>
          ))}
        </nav>
      </header>
      <main id="legal-main" className="mx-auto w-full max-w-3xl px-4 pb-20 pt-6">
        <h1 className="text-[34px] font-bold tracking-[-0.02em] text-text">{t('title')}</h1>
        <p className="mt-2 text-sm text-text-muted">{tl('updated', { date: t('updated') })}</p>
        <p className="mt-6 text-[15px] leading-relaxed text-text">{t('intro', args)}</p>
        {Array.from({ length: SECTION_COUNT }, (_, index) => `s${String(index + 1)}`).map(
          (section) => (
            <section key={section} className="mt-8">
              <h2 className="text-xl font-semibold text-text">{t(`${section}.heading`)}</h2>
              <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-text">
                {t(`${section}.body`, args)}
              </p>
            </section>
          ),
        )}
        <p className="mt-10 rounded-md bg-surface-muted p-4 text-sm text-text-muted">
          {tl('operator', args)}
        </p>
      </main>
    </div>
  );
}
