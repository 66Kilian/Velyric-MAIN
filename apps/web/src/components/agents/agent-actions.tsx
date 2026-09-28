'use client';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@velyric/ui';
import { Pause, Play, Plus, Rocket, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { issueFor, useApiErrorToast, validationIssues } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { Agent, PhoneNumber } from '@/lib/api/agents';

export function CreateAgentDialog({
  workspaceId,
  locations,
}: {
  readonly workspaceId: string;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const router = useRouter();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [pending, setPending] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('create.button')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('create.title')}
        description={t('create.description')}
        closeLabel={tc('actions.close')}
        size="sm"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setNameError(undefined);
            try {
              const agent = await api.post<Agent>('/agents', {
                workspace: workspaceId,
                body: {
                  name: name.trim(),
                  ...(locationId === '' ? {} : { location_id: locationId }),
                },
              });
              setOpen(false);
              router.push(`/app/${workspaceId}/agents/${agent.id}`);
            } catch (error) {
              if (issueFor(validationIssues(error), 'name') !== undefined) {
                setNameError(t('create.nameInvalid'));
              }
              showError(error);
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="agent-name" label={t('create.name')} required error={nameError}>
            <Input
              id="agent-name"
              value={name}
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
              autoFocus
            />
          </Field>
          {locations.length > 0 ? (
            <Field id="agent-location" label={t('create.location')}>
              <NativeSelect
                id="agent-location"
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                }}
              >
                <option value="">{t('create.allLocations')}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('actions.cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={pending || name.trim() === ''}>
              {tc('actions.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AgentStatusControls({
  workspaceId,
  agent,
}: {
  readonly workspaceId: string;
  readonly agent: Agent;
}) {
  const t = useTranslations('agents.status');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  const update = async (status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED') => {
    setPending(true);
    try {
      await api.patch(`/agents/${agent.id}`, {
        workspace: workspaceId,
        body: { status },
        ifMatch: agent.version,
      });
      notify({ tone: 'success', title: t(`changed.${status}`) });
      router.refresh();
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {agent.status === 'ACTIVE' ? (
        <ConfirmDialog
          trigger={
            <Button variant="secondary" size="sm" disabled={pending}>
              <Pause className="h-4 w-4" aria-hidden="true" />
              {t('pause')}
            </Button>
          }
          title={t('pauseTitle')}
          description={t('pauseDescription')}
          confirmLabel={t('pause')}
          onConfirm={() => update('PAUSED')}
        />
      ) : null}
      {agent.status === 'PAUSED' && agent.production_version_id !== null ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => void update('ACTIVE')}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          {t('resume')}
        </Button>
      ) : null}
      {agent.status !== 'ARCHIVED' ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={pending}>
              {t('archive')}
            </Button>
          }
          title={t('archiveTitle')}
          description={t('archiveDescription')}
          confirmLabel={t('archive')}
          destructive
          onConfirm={() => update('ARCHIVED')}
        />
      ) : null}
    </div>
  );
}

export function PublishVersionButton({
  workspaceId,
  versionId,
  versionNumber,
}: {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}) {
  const t = useTranslations('agents.versions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [rollout, setRollout] = useState(100);
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm">
          <Rocket className="h-4 w-4" aria-hidden="true" />
          {t('publish')}
        </Button>
      }
      title={t('publishTitle', { version: versionNumber })}
      description={t('publishDescription')}
      confirmLabel={
        rollout === 100 ? t('publishProduction') : t('publishCanary', { percent: rollout })
      }
      confirmDisabled={!Number.isInteger(rollout) || rollout < 1 || rollout > 100}
      onConfirm={async () => {
        try {
          await api.post(`/agent-versions/${versionId}/publish`, {
            workspace: workspaceId,
            body: { rollout_percent: rollout },
          });
          notify({ tone: 'success', title: t('published', { version: versionNumber }) });
          router.refresh();
          return true;
        } catch (error) {
          showError(error);
          return false;
        }
      }}
    >
      <Field id={`rollout-${versionId}`} label={t('rollout')} hint={t('rolloutHint')}>
        <Input
          id={`rollout-${versionId}`}
          type="number"
          min={1}
          max={100}
          value={rollout}
          onChange={(event) => {
            setRollout(Number(event.target.value));
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

export function RollbackVersionButton({
  workspaceId,
  versionId,
  versionNumber,
}: {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}) {
  const t = useTranslations('agents.versions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary">
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          {t('rollback')}
        </Button>
      }
      title={t('rollbackTitle', { version: versionNumber })}
      description={t('rollbackDescription')}
      confirmLabel={t('rollback')}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onConfirm={async () => {
        try {
          await api.post(`/agent-versions/${versionId}/rollback`, {
            workspace: workspaceId,
            body: { reason: reason.trim() },
          });
          notify({ tone: 'success', title: t('rolledBack', { version: versionNumber }) });
          router.refresh();
          return true;
        } catch (error) {
          showError(error);
          return false;
        }
      }}
    >
      <Field id={`rollback-reason-${versionId}`} label={t('reason')} required>
        <Textarea
          id={`rollback-reason-${versionId}`}
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

export function PhoneBindings({
  workspaceId,
  agentId,
  numbers,
  canManage,
}: {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly numbers: readonly PhoneNumber[];
  readonly canManage: boolean;
}) {
  const t = useTranslations('agents.phones');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const bind = async (number: PhoneNumber, bound: boolean) => {
    setPendingId(number.id);
    try {
      await api.put(`/phone-numbers/${number.id}/agent`, {
        workspace: workspaceId,
        body: { agent_id: bound ? agentId : null },
        ifMatch: number.version,
      });
      notify({
        tone: 'success',
        title: bound ? t('bound', { number: number.e164 }) : t('unbound', { number: number.e164 }),
      });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPendingId(null);
    }
  };
  if (numbers.length === 0) {
    return <p className="text-sm text-text-muted">{t('none')}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {numbers.map((number) => {
        const boundHere = number.agent?.id === agentId;
        return (
          <li key={number.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <span className="flex flex-col">
              <span className="font-medium tabular-nums text-text">{number.e164}</span>
              <span className="text-xs text-text-muted">
                {number.agent === null
                  ? t('unassigned')
                  : boundHere
                    ? t('thisAgent')
                    : t('otherAgent', { name: number.agent.name })}
              </span>
            </span>
            {canManage ? (
              <Button
                size="sm"
                variant={boundHere ? 'ghost' : 'secondary'}
                loading={pendingId === number.id}
                disabled={pendingId !== null}
                onClick={() => void bind(number, !boundHere)}
              >
                {boundHere ? t('unbind') : t('bind')}
              </Button>
            ) : boundHere ? (
              <Badge tone="success">{t('thisAgent')}</Badge>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
