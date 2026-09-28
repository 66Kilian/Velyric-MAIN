'use client';

import { Button, Input, NativeSelect } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

const STATUSES = [
  'PROVISIONING',
  'ACTIVE',
  'PAYMENT_AT_RISK',
  'GRACE_PERIOD',
  'RESTRICTED',
  'SUSPENDED_BILLING',
  'SUSPENDED_DISPUTE',
  'SUSPENDED_RISK',
  'SUSPENDED_ADMIN',
  'CANCELED_GRACE',
  'DATA_RETENTION',
] as const;

export function TenantSearch({
  initialQuery,
  initialStatus,
}: {
  readonly initialQuery: string;
  readonly initialStatus: string;
}) {
  const t = useTranslations('admin.tenants');
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);

  const go = (nextQuery: string, nextStatus: string) => {
    const search = new URLSearchParams();
    if (nextQuery.trim() !== '') {
      search.set('query', nextQuery.trim());
    }
    if (nextStatus !== '') {
      search.set('status', nextStatus);
    }
    const params = search.toString();
    router.push(params === '' ? '/admin/tenants' : `/admin/tenants?${params}`);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    go(query, status);
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={t('searchLabel')}
        placeholder={t('searchPlaceholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="max-w-sm"
      />
      <NativeSelect
        aria-label={t('statusFilter')}
        value={status}
        onChange={(event) => {
          setStatus(event.target.value);
          go(query, event.target.value);
        }}
        className="max-w-56"
      >
        <option value="">{t('allStatuses')}</option>
        {STATUSES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </NativeSelect>
      <Button type="submit" variant="secondary">
        {t('search')}
      </Button>
      {initialQuery === '' && initialStatus === '' ? null : (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setQuery('');
            setStatus('');
            router.push('/admin/tenants');
          }}
        >
          {t('clear')}
        </Button>
      )}
    </form>
  );
}
