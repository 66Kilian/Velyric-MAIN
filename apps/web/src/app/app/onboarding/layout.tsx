import { VelyricLogo } from '@velyric/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LanguageMenu, ThemeMenu } from '@/components/shell/preferences';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding');
  return { title: t('title') };
}

export default function OnboardingLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="vly-blush min-h-dvh">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 md:px-6">
        <Link href="/app">
          <VelyricLogo />
        </Link>
        <div className="flex items-center gap-1">
          <LanguageMenu mode="app" />
          <ThemeMenu />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl px-4 pb-16 pt-4 md:px-6">
        {children}
      </main>
    </div>
  );
}
