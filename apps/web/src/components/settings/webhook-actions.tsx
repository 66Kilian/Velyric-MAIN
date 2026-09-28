'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  Switch,
  useToast,
} from '@velyric/ui';
import { KeyRound, Plus, RotateCw, Send, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/navigation';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { OutboundWebhook, WebhookDelivery } from '@/lib/api/settings';

function isHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const parsed = new URL(value);
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === '' &&
    (parsed.port === '' || parsed.port === '443')
  );
}

function SecretReveal({
  secret,
  onDone,
}: {
  readonly secret: string;
  readonly onDone: () => void;
}) {
  const t = useTranslations('settings.webhooks');
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">{t('secretOnce')}</p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret}</code>
        <CopyButton value={secret} label={t('copySecret')} />
      </div>
      <p className="text-sm text-text-muted">{t('verifyHint')}</p>
      <Button className="self-end" onClick={onDone}>
        {t('secretSaved')}
      </Button>
    </div>
  );
}

function EventPicker({
  eventTypes,
  selected,
  onChange,
}: {
  readonly eventTypes: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
}) {
  const t = useTranslations('settings.webhooks');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text">{t('events')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {eventTypes.map((eventType) => (
          <label key={eventType} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(eventType)}
              onCheckedChange={(value) => {
                onChange(
                  value === true
                    ? [...selected, eventType]
                    : selected.filter((entry) => entry !== eventType),
                );
              }}
            />
            <span className="flex flex-col">
              <span>
                {t.has(`eventLabels.${eventType.replace('.', '_')}`)
                  ? t(`eventLabels.${eventType.replace('.', '_')}`)
                  : eventType}
              </span>
              <code className="font-mono text-xs text-text-muted">{eventType}</code>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateWebhookDialog({
  workspaceId,
  eventTypes,
  disabled,
}: {
  readonly workspaceId: string;
  readonly eventTypes: readonly string[];
  readonly disabled: boolean;
}) {
  const t = useTranslations('settings.webhooks');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const validUrl = isHttpsUrl(url.trim());

  const close = (next: boolean) => {
    if (pending) {
      return;
    }
    setOpen(next);
    if (!next) {
      setUrl('');
      setSelected([]);
      setSecret(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('create')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={secret === null ? t('createTitle') : t('secretTitle')}
        closeLabel={tc('close')}
        size="lg"
      >
        {secret === null ? (
          <form
            className="flex flex-col gap-5"
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              try {
                const created = await api.post<OutboundWebhook & { signing_secret: string }>(
                  '/outbound-webhooks',
                  {
                    workspace: workspaceId,
                    body: { url: url.trim(), event_types: selected },
                  },
                );
                setSecret(created.signing_secret);
                router.refresh();
              } catch (error) {
                showError(error);
              } finally {
                setPending(false);
              }
            }}
          >
            <Field id="webhook-url" label={t('url')} hint={t('urlHint')} required>
              <Input
                id="webhook-url"
                type="url"
                inputMode="url"
                value={url}
                maxLength={2048}
                placeholder="https://"
                onChange={(event) => {
                  setUrl(event.target.value);
                }}
              />
            </Field>
            <EventPicker eventTypes={eventTypes} selected={selected} onChange={setSelected} />
            <Button
              type="submit"
              className="self-end"
              loading={pending}
              disabled={!validUrl || selected.length === 0}
            >
              {t('create')}
            </Button>
          </form>
        ) : (
          <SecretReveal
            secret={secret}
            onDone={() => {
              close(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function WebhookControls({
  workspaceId,
  webhook,
  eventTypes,
}: {
  readonly workspaceId: string;
  readonly webhook: OutboundWebhook;
  readonly eventTypes: readonly string[];
}) {
  const t = useTranslations('settings.webhooks');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([...webhook.event_types]);

  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setPending(true);
    try {
      await action();
      notify({ tone: 'success', title: success });
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
    <div className="flex flex-wrap items-center gap-2">
      <label className="mr-2 flex items-center gap-2 text-sm text-text-muted">
        <Switch
          checked={webhook.active}
          disabled={pending}
          aria-label={t('active')}
          onCheckedChange={(active) => {
            void run(
              () =>
                api.patch(`/outbound-webhooks/${webhook.id}`, {
                  workspace: workspaceId,
                  ifMatch: webhook.version,
                  body: { active },
                }),
              active ? t('enabled') : t('disabled'),
            );
          }}
        />
        {webhook.active ? t('active') : t('inactive')}
      </label>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger asChild>
          <Button variant="secondary" size="sm">
            {t('editEvents')}
          </Button>
        </DialogTrigger>
        <DialogContent title={t('editEvents')} closeLabel={tc('close')} size="lg">
          <div className="flex flex-col gap-5">
            <EventPicker eventTypes={eventTypes} selected={selected} onChange={setSelected} />
            <Button
              className="self-end"
              loading={pending}
              disabled={selected.length === 0}
              onClick={async () => {
                if (
                  await run(
                    () =>
                      api.patch(`/outbound-webhooks/${webhook.id}`, {
                        workspace: workspaceId,
                        ifMatch: webhook.version,
                        body: { event_types: selected },
                      }),
                    t('saved'),
                  )
                ) {
                  setEditOpen(false);
                }
              }}
            >
              {tc('saveChanges')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Button
        variant="secondary"
        size="sm"
        disabled={!webhook.active || pending}
        onClick={() => {
          void run(
            () => api.post(`/outbound-webhooks/${webhook.id}/test`, { workspace: workspaceId }),
            t('testQueued'),
          );
        }}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
        {t('sendTest')}
      </Button>
      <ConfirmDialog
        trigger={
          <Button variant="secondary" size="sm">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {t('rotate')}
          </Button>
        }
        title={t('rotateTitle')}
        description={t('rotateDescription')}
        confirmLabel={t('rotate')}
        onConfirm={async () => {
          try {
            const rotated = await api.post<{ signing_secret: string }>(
              `/outbound-webhooks/${webhook.id}/rotate-secret`,
              { workspace: workspaceId },
            );
            setSecret(rotated.signing_secret);
            router.refresh();
            return true;
          } catch (error) {
            showError(error);
            return false;
          }
        }}
      />
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" aria-label={t('delete')}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        }
        title={t('deleteTitle')}
        description={t('deleteDescription', { url: webhook.url })}
        confirmLabel={tc('delete')}
        destructive
        onConfirm={() =>
          run(
            () => api.delete(`/outbound-webhooks/${webhook.id}`, { workspace: workspaceId }),
            t('deleted'),
          )
        }
      />
      <Dialog
        open={secret !== null}
        onOpenChange={(next) => {
          if (!next) {
            setSecret(null);
          }
        }}
      >
        <DialogContent title={t('secretTitle')} closeLabel={tc('close')}>
          {secret === null ? null : (
            <SecretReveal
              secret={secret}
              onDone={() => {
                setSecret(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RetryDeliveryButton({
  workspaceId,
  webhookId,
  delivery,
}: {
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly delivery: WebhookDelivery;
}) {
  const t = useTranslations('settings.webhooks');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          await api.post(`/outbound-webhooks/${webhookId}/deliveries/${delivery.id}/retry`, {
            workspace: workspaceId,
          });
          notify({ tone: 'success', title: t('retryQueued') });
          router.refresh();
        } catch (error) {
          showError(error);
        } finally {
          setPending(false);
        }
      }}
    >
      <RotateCw className="h-4 w-4" aria-hidden="true" />
      {t('retry')}
    </Button>
  );
}
