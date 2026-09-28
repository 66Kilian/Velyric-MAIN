import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ThemeScript } from '@/components/theme-script';
import { webConfig } from '@/server/config';
import './globals.css';

export function generateMetadata(): Metadata {
  const { publicWebOrigin, searchConsoleVerification, bingVerification } = webConfig();
  const verification = {
    ...(searchConsoleVerification === null ? {} : { google: searchConsoleVerification }),
    ...(bingVerification === null ? {} : { other: { 'msvalidate.01': bingVerification } }),
  };
  return {
    ...(Object.keys(verification).length === 0 ? {} : { verification }),
    metadataBase: new URL(publicWebOrigin),
    title: { default: 'Velyric – AI voice agents', template: '%s · Velyric' },
    applicationName: 'Velyric',
    openGraph: { siteName: 'Velyric', type: 'website' },
    twitter: { card: 'summary_large_image' },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#08090d' },
  ],
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <html
      lang={locale}
      data-theme="system"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
