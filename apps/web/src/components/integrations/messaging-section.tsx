'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Input,
  NativeSelect,
  Switch,
  useToast,
} from '@velyric/ui';
import { Mail, MessageSquare, Send, Unlink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  GMAIL_DEFAULTS,
  type EmailSender,
  type MessagingSettings,
  type SmtpSecurity,
} from '@/lib/api/messaging';

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.6-.15-3.15-.42-4.64H24v9.02h12.94c-.56 2.9-2.2 5.36-4.7 7.02l7.6 5.9c4.44-4.1 7.14-10.14 7.14-17.3z"
      />
      <path
        fill="#FBBC05"
        d="M10.4 28.7a14.4 14.4 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.2 0 11.5-2.05 15.3-5.55l-7.6-5.9c-2.1 1.42-4.8 2.25-7.7 2.25-6.3 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

export function SmsCard({
  workspaceId,
  settings,
  canManage,
}: {
  readonly workspaceId: string;
  readonly settings: MessagingSettings;
  readonly canManage: boolean;
}) {
  const t = useTranslations('integrations.messaging.sms');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [enabled, setEnabled] = useState(settings.sms_enabled);
  const [pending, setPending] = useState(false);

  const save = async (next: boolean) => {
    setEnabled(next);
    setPending(true);
    try {
      await api.put('/messaging-settings', {
        workspace: workspaceId,
        body: {
          sms_enabled: next,
          sms_sender_label: settings.sms_sender_label,
          brand_color: settings.brand_color,
          brand_footer: settings.brand_footer,
        },
        ...(settings.version === 0 ? {} : { ifMatch: settings.version }),
      });
      notify({ tone: 'success', title: next ? t('enabled') : t('disabled') });
      router.refresh();
    } catch (error) {
      setEnabled(!next);
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-pink-tint text-pink-text">
              <MessageSquare className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold text-text">{t('name')}</p>
              <p className="text-sm text-text-muted">{t('description')}</p>
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={!canManage || pending}
            aria-label={t('name')}
            onCheckedChange={(value) => {
              void save(value);
            }}
          />
        </div>
        <p className="mt-auto rounded-md border border-border px-3 py-2.5 text-xs text-text-muted">
          {enabled ? t('onHint') : t('offHint')}
        </p>
      </CardContent>
    </Card>
  );
}

function ConnectDialog({
  workspaceId,
  sender,
  label,
  variant,
}: {
  readonly workspaceId: string;
  readonly sender: EmailSender | null;
  readonly label: string;
  readonly variant: 'primary' | 'secondary';
}) {
  const t = useTranslations('integrations.messaging.email');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<'google' | 'manual' | null>(null);
  const [host, setHost] = useState(sender?.host ?? GMAIL_DEFAULTS.host);
  const [port, setPort] = useState(String(sender?.port ?? GMAIL_DEFAULTS.port));
  const [security, setSecurity] = useState<SmtpSecurity>(
    sender?.security ?? GMAIL_DEFAULTS.security,
  );
  const [username, setUsername] = useState(sender?.username ?? '');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState(sender?.from_name ?? '');
  const [fromAddress, setFromAddress] = useState(sender?.from_address ?? '');
  const [replyTo, setReplyTo] = useState(sender?.reply_to ?? '');

  const connectGoogle = async () => {
    setPending('google');
    try {
      const started = await api.post<{ authorization_url: string }>(
        '/integrations/oauth/authorizations',
        { workspace: workspaceId, body: { integration_type: 'CUSTOM_SMTP' } },
      );
      window.location.assign(started.authorization_url);
    } catch (error) {
      showError(error);
      setPending(null);
    }
  };

  const saveManual = async () => {
    setPending('manual');
    try {
      await api.put('/integrations/smtp', {
        workspace: workspaceId,
        body: {
          host: host.trim(),
          port: Number(port),
          security,
          username: username.trim(),
          password,
          from_address: fromAddress.trim(),
          from_name: fromName.trim(),
          ...(replyTo.trim() === '' ? {} : { reply_to: replyTo.trim() }),
        },
      });
      notify({ tone: 'success', title: t('connected') });
      setPassword('');
      setOpen(false);
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(null);
    }
  };

  const incomplete =
    host.trim() === '' ||
    username.trim() === '' ||
    password === '' ||
    fromAddress.trim() === '' ||
    fromName.trim() === '';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant={variant}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      <DialogContent
        title={t('dialogTitle')}
        description={t('dialogDescription')}
        closeLabel={t('close')}
        size="lg"
      >
        <div className="flex flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted px-4 py-4">
            <div>
              <p className="text-sm font-semibold text-text">{t('googleTitle')}</p>
              <p className="text-sm text-text-muted">{t('googleDescription')}</p>
            </div>
            <div>
              <Button
                variant="secondary"
                loading={pending === 'google'}
                disabled={pending !== null}
                onClick={() => {
                  void connectGoogle();
                }}
              >
                <GoogleMark />
                {t('googleButton')}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-text-muted">{t('or')}</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field id="smtp-host" label={t('host')} hint={t('hostHint')} required>
              <Input
                id="smtp-host"
                value={host}
                spellCheck={false}
                placeholder={GMAIL_DEFAULTS.host}
                onChange={(event) => {
                  setHost(event.target.value);
                }}
              />
            </Field>
            <Field id="smtp-port" label={t('port')} required>
              <Input
                id="smtp-port"
                type="number"
                value={port}
                placeholder={String(GMAIL_DEFAULTS.port)}
                onChange={(event) => {
                  setPort(event.target.value);
                }}
              />
            </Field>
            <Field id="smtp-security" label={t('security')} hint={t('securityHint')}>
              <NativeSelect
                id="smtp-security"
                value={security}
                onChange={(event) => {
                  setSecurity(event.target.value as SmtpSecurity);
                }}
              >
                {(['TLS', 'STARTTLS', 'NONE'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`securityOptions.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="smtp-username" label={t('username')} hint={t('usernameHint')} required>
              <Input
                id="smtp-username"
                value={username}
                spellCheck={false}
                autoComplete="off"
                placeholder="rendeles@gmail.com"
                onChange={(event) => {
                  setUsername(event.target.value);
                }}
              />
            </Field>
            <Field
              id="smtp-password"
              label={t('password')}
              hint={t('passwordHint')}
              required
              className="md:col-span-2"
            >
              <Input
                id="smtp-password"
                type="password"
                value={password}
                autoComplete="new-password"
                spellCheck={false}
                placeholder="abcd efgh ijkl mnop"
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </Field>
            <Field id="smtp-from-name" label={t('fromName')} hint={t('fromNameHint')} required>
              <Input
                id="smtp-from-name"
                value={fromName}
                onChange={(event) => {
                  setFromName(event.target.value);
                }}
              />
            </Field>
            <Field id="smtp-from-address" label={t('fromAddress')} required>
              <Input
                id="smtp-from-address"
                type="email"
                value={fromAddress}
                spellCheck={false}
                placeholder="rendeles@gmail.com"
                onChange={(event) => {
                  setFromAddress(event.target.value);
                }}
              />
            </Field>
            <Field
              id="smtp-reply-to"
              label={t('replyTo')}
              hint={t('replyToHint')}
              className="md:col-span-2"
            >
              <Input
                id="smtp-reply-to"
                type="email"
                value={replyTo}
                spellCheck={false}
                onChange={(event) => {
                  setReplyTo(event.target.value);
                }}
              />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <DialogClose asChild>
            <Button variant="ghost">{t('cancel')}</Button>
          </DialogClose>
          <Button
            loading={pending === 'manual'}
            disabled={pending !== null || incomplete}
            onClick={() => {
              void saveManual();
            }}
          >
            {t('save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EmailSenderCard({
  workspaceId,
  sender,
  canManage,
}: {
  readonly workspaceId: string;
  readonly sender: EmailSender | null;
  readonly canManage: boolean;
}) {
  const t = useTranslations('integrations.messaging.email');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [testing, setTesting] = useState(false);
  const connected = sender !== null && sender.status === 'CONNECTED';

  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-pink-tint text-pink-text">
              <Mail className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold text-text">{t('name')}</p>
              <p className="text-sm text-text-muted">{t('description')}</p>
            </div>
          </div>
          {canManage && !connected ? (
            <ConnectDialog
              workspaceId={workspaceId}
              sender={sender}
              label={t('connect')}
              variant="primary"
            />
          ) : null}
        </div>
        {connected ? (
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-text">
                {sender.from_address ?? sender.account ?? sender.host}
              </span>
              <span className="text-xs text-text-muted">
                {sender.auth_method === 'GOOGLE_OAUTH'
                  ? t('viaGoogle')
                  : t('viaSmtp', { host: sender.host ?? '' })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="success">{t('active')}</Badge>
              {canManage ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={testing}
                    disabled={testing}
                    onClick={async () => {
                      setTesting(true);
                      try {
                        const result = await api.post<{ sent_to: string }>(
                          '/integrations/smtp/test',
                          { workspace: workspaceId },
                        );
                        notify({
                          tone: 'success',
                          title: t('testSent', { email: result.sent_to }),
                        });
                      } catch (error) {
                        showError(error);
                      } finally {
                        setTesting(false);
                      }
                    }}
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    {t('test')}
                  </Button>
                  <ConnectDialog
                    workspaceId={workspaceId}
                    sender={sender}
                    label={t('change')}
                    variant="secondary"
                  />
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost">
                        <Unlink className="h-4 w-4" aria-hidden="true" />
                        {t('disconnect')}
                      </Button>
                    }
                    title={t('disconnectTitle')}
                    description={t('disconnectDescription')}
                    confirmLabel={t('disconnect')}
                    destructive
                    onConfirm={async () => {
                      try {
                        await api.delete('/integrations/smtp', { workspace: workspaceId });
                        notify({ tone: 'success', title: t('disconnected') });
                        router.refresh();
                        return true;
                      } catch (error) {
                        showError(error);
                        return false;
                      }
                    }}
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-auto rounded-md border border-border px-3 py-2.5 text-xs text-text-muted">
            {t('emptyHint')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
