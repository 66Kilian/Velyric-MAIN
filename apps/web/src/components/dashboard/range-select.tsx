'use client';

import { NativeSelect } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { RangeKey } from '@/lib/dates';

export function RangeSelect({
  value,
  label,
}: {
  readonly value: RangeKey;
  readonly label: string;
}) {
  const t = useTranslations('common.time');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <NativeSelect
      aria-label={label}
      className="h-10 w-44 rounded-md bg-surface shadow-soft"
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = new URLSearchParams(params.toString());
        next.set('range', event.target.value);
        startTransition(() => {
          router.replace(`${pathname}?${next.toString()}`, { scroll: false });
        });
      }}
    >
      <option value="7d">{t('last7Days')}</option>
      <option value="30d">{t('last30Days')}</option>
      <option value="90d">{t('last90Days')}</option>
    </NativeSelect>
  );
}
