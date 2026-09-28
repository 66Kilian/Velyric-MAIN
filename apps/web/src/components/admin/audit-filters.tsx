'use client';

import { Button, Input, NativeSelect } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

const ACTOR_TYPES = [
  'USER',
  'SUPPORT_STAFF',
  'API_KEY',
  'SERVICE',
  'PROVIDER_WEBHOOK',
  'SYSTEM',
] as const;

const ACTION_PREFIXES = [
  'tenant.',
  'member.',
  'agent.',
  'billing.',
  'usage.',
  'phone_number.',
  'secret.',
  'support_ticket.',
  'support_access.',
  'platform.',
  'api_key.',
  'knowledge.',
  'booking.',
] as const;

export function AuditFilters({
  initialActorType,
  initialAction,
  initialTenant,
}: {
  readonly initialActorType: string;
  readonly initialAction: string;
  readonly initialTenant: string;
}) {
  const t = useTranslations('admin.audit');
  const router = useRouter();
  const [actorType, setActorType] = useState(initialActorType);
  const [action, setAction] = useState(initialAction);
  const [tenant, setTenant] = useState(initialTenant);

  const go = (next: { actorType: string; action: string; tenant: string }) => {
    const search = new URLSearchParams();
    if (next.actorType !== '') {
      search.set('actor_type', next.actorType);
    }
    if (next.action !== '') {
      search.set('action', next.action);
    }
    if (next.tenant.trim() !== '') {
      search.set('tenant_id', next.tenant.trim());
    }
    const params = search.toString();
    router.push(params === '' ? '/admin/audit' : `/admin/audit?${params}`);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    go({ actorType, action, tenant });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={t('actorFilter')}
        value={actorType}
        onChange={(event) => {
          setActorType(event.target.value);
          go({ actorType: event.target.value, action, tenant });
        }}
        className="max-w-52"
      >
        <option value="">{t('allActors')}</option>
        {ACTOR_TYPES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label={t('actionFilter')}
        value={action}
        onChange={(event) => {
          setAction(event.target.value);
          go({ actorType, action: event.target.value, tenant });
        }}
        className="max-w-52"
      >
        <option value="">{t('allActions')}</option>
        {ACTION_PREFIXES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </NativeSelect>
      <Input
        aria-label={t('tenantFilter')}
        placeholder={t('tenantPlaceholder')}
        value={tenant}
        onChange={(event) => {
          setTenant(event.target.value);
        }}
        className="max-w-80"
      />
      <Button type="submit" variant="secondary">
        {t('apply')}
      </Button>
      {initialActorType === '' && initialAction === '' && initialTenant === '' ? null : (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setActorType('');
            setAction('');
            setTenant('');
            router.push('/admin/audit');
          }}
        >
          {t('clear')}
        </Button>
      )}
    </form>
  );
}
