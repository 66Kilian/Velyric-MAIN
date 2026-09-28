import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/providers/app-providers';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
