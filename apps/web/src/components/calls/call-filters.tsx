'use client';

import { Button, Input, NativeSelect } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useTransition, type SubmitEvent } from 'react';

const STATUSES = ['ACTIVE', 'COMPLETED', 'TRANSFERRED', 'ABANDONED', 'FAILED', 'REJECTED'] as const;
const OUTCOMES = [
  'RESOLVED',
  'INFORMATION_PROVIDED',
  'BOOKING_CREATED',
  'BOOKING_CHANGED',
  'BOOKING_CANCELED',
  'WAITLISTED',
  'LEAD_CAPTURED',
  'CALLBACK_REQUESTED',
  'MESSAGE_TAKEN',
  'TRANSFERRED_TO_HUMAN',
  'UNRESOLVED',
  'ABANDONED',
  'SPAM',
  'POLICY_BLOCKED',
  'FAILED',
] as const;
const FIELDS = [
  'status',
  'direction',
  'channel',
  'agent_id',
  'language',
  'outcome',
  'from',
  'to',
] as const;

export function CallFilters({
  agents,
}: {
  readonly agents: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('calls.filters');
  const te = useTranslations('enums');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const field of FIELDS) {
      const value = data.get(field);
      if (typeof value === 'string' && value !== '') {
        next.set(field, value);
      }
    }
    startTransition(() => {
      router.push(next.size === 0 ? pathname : `${pathname}?${next.toString()}`);
    });
  };

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8"
      aria-label={t('label')}
    >
      <NativeSelect
        name="status"
        defaultValue={params.get('status') ?? ''}
        aria-label={t('status')}
      >
        <option value="">{t('anyStatus')}</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {status === 'ACTIVE' ? t('active') : te(`callStatus.${status}`)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        name="direction"
        defaultValue={params.get('direction') ?? ''}
        aria-label={t('direction')}
      >
        <option value="">{t('anyDirection')}</option>
        <option value="INBOUND">{t('inbound')}</option>
        <option value="OUTBOUND">{t('outbound')}</option>
      </NativeSelect>
      <NativeSelect
        name="channel"
        defaultValue={params.get('channel') ?? ''}
        aria-label={t('channel')}
      >
        <option value="">{t('anyChannel')}</option>
        {(['PSTN', 'WEB_VOICE', 'SIMULATION'] as const).map((channel) => (
          <option key={channel} value={channel}>
            {te(`callChannel.${channel}`)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        name="agent_id"
        defaultValue={params.get('agent_id') ?? ''}
        aria-label={t('agent')}
      >
        <option value="">{t('anyAgent')}</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        name="language"
        defaultValue={params.get('language') ?? ''}
        aria-label={t('language')}
      >
        <option value="">{t('anyLanguage')}</option>
        <option value="hu">HU</option>
        <option value="de">DE</option>
        <option value="en">EN</option>
      </NativeSelect>
      <NativeSelect
        name="outcome"
        defaultValue={params.get('outcome') ?? ''}
        aria-label={t('outcome')}
      >
        <option value="">{t('anyOutcome')}</option>
        {OUTCOMES.map((outcome) => (
          <option key={outcome} value={outcome}>
            {te(`callOutcome.${outcome}`)}
          </option>
        ))}
      </NativeSelect>
      <Input
        type="date"
        name="from"
        defaultValue={params.get('from') ?? ''}
        aria-label={t('from')}
      />
      <div className="flex gap-2">
        <Input type="date" name="to" defaultValue={params.get('to') ?? ''} aria-label={t('to')} />
        <Button type="submit" variant="secondary" disabled={pending}>
          {tc('filter')}
        </Button>
      </div>
    </form>
  );
}

export function AutoRefresh({ intervalMs }: { readonly intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs, router]);
  return null;
}
