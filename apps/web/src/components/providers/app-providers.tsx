'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { ApiRequestError } from '@/lib/api-types';

export function AppProviders({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('common');
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) =>
              !(error instanceof ApiRequestError && error.status < 500) && failureCount < 2,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider closeLabel={t('actions.close')}>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
