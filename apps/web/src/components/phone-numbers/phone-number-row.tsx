'use client';

import { Badge, Button, Input, NativeSelect, Td, Tr, useToast, type BadgeTone } from '@velyric/ui';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { PhoneNumber } from '@/lib/api/agents';

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  ACTIVE: 'success',
  PROVISIONING: 'sky',
  PORTING_IN: 'sky',
  SUSPENDED: 'danger',
  RETENTION_HOLD: 'warning',
  RELEASE_PENDING: 'neutral',
  RELEASED: 'neutral',
};

export function PhoneNumberRow({
  workspaceId,
  number,
  agents,
  locations,
  canManage,
}: {
  readonly workspaceId: string;
  readonly number: PhoneNumber;
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly canManage: boolean;
}) {
  const t = useTranslations('phoneNumbers');
  const te = useTranslations('enums');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [locationId, setLocationId] = useState(number.location_id ?? '');
  const [maxCalls, setMaxCalls] = useState(String(number.max_concurrent_calls));
  const [agentId, setAgentId] = useState(number.agent?.id ?? '');
  const [pending, setPending] = useState(false);
  const settingsDirty =
    locationId !== (number.location_id ?? '') || maxCalls !== String(number.max_concurrent_calls);
  const agentDirty = agentId !== (number.agent?.id ?? '');
  const maxValid = /^\d+$/.test(maxCalls) && Number(maxCalls) >= 1 && Number(maxCalls) <= 100;

  const save = async () => {
    setPending(true);
    try {
      if (settingsDirty) {
        await api.patch(`/phone-numbers/${number.id}`, {
          workspace: workspaceId,
          ifMatch: number.version,
          body: {
            ...(locationId !== (number.location_id ?? '')
              ? { location_id: locationId === '' ? null : locationId }
              : {}),
            ...(maxCalls !== String(number.max_concurrent_calls)
              ? { max_concurrent_calls: Number(maxCalls) }
              : {}),
          },
        });
      }
      if (agentDirty) {
        await api.put(`/phone-numbers/${number.id}/agent`, {
          workspace: workspaceId,
          body: { agent_id: agentId === '' ? null : agentId },
        });
      }
      notify({ tone: 'success', title: t('saved', { number: number.e164 }) });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Tr>
      <Td className="whitespace-nowrap font-medium tabular-nums">
        {number.e164}
        <span className="block text-xs font-normal text-text-muted">
          {number.country} ·{' '}
          {t.has(`types.${number.number_type}`)
            ? t(`types.${number.number_type}`)
            : number.number_type}
        </span>
      </Td>
      <Td>
        <Badge tone={STATUS_TONES[number.status] ?? 'neutral'}>
          {te.has(`phoneNumberStatus.${number.status}`)
            ? te(`phoneNumberStatus.${number.status}`)
            : number.status}
        </Badge>
      </Td>
      <Td className="min-w-44">
        <NativeSelect
          aria-label={t('columns.agent')}
          value={agentId}
          disabled={!canManage || pending}
          onChange={(event) => {
            setAgentId(event.target.value);
          }}
        >
          <option value="">{t('unassigned')}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
      </Td>
      <Td className="min-w-40">
        <NativeSelect
          aria-label={t('columns.location')}
          value={locationId}
          disabled={!canManage || pending}
          onChange={(event) => {
            setLocationId(event.target.value);
          }}
        >
          <option value="">{t('allLocations')}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </NativeSelect>
      </Td>
      <Td className="w-28">
        <Input
          aria-label={t('columns.maxCalls')}
          type="number"
          min={1}
          max={100}
          value={maxCalls}
          disabled={!canManage || pending}
          aria-invalid={!maxValid}
          onChange={(event) => {
            setMaxCalls(event.target.value);
          }}
        />
      </Td>
      <Td className="text-right">
        {canManage ? (
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            disabled={pending || (!settingsDirty && !agentDirty) || !maxValid}
            onClick={() => void save()}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('save')}
          </Button>
        ) : null}
      </Td>
    </Tr>
  );
}
