'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@velyric/ui';
import { Eye, ImageUp, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  CALLER_TEMPLATE_ORDER,
  TEMPLATE_LOCALES,
  type CallerNotificationType,
  type EmailPreview,
  type EmailSender,
  type EmailTemplate,
  type MessagingSettings,
} from '@/lib/api/messaging';

const LOGO_MAX_BYTES = 262_144;
const STORED_FIELD = /\{\{\s*([a-z_]{1,40})\s*\}\}/g;
const SHOWN_FIELD = /\{\{([^{}]{1,80})\}\}/g;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

export function EmailBrandingCard({
  workspaceId,
  settings,
  canManage,
}: {
  readonly workspaceId: string;
  readonly settings: MessagingSettings;
  readonly canManage: boolean;
}) {
  const t = useTranslations('settings.notifications.branding');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState(settings.brand_color);
  const [footer, setFooter] = useState(settings.brand_footer ?? '');
  const [logo, setLogo] = useState(settings.brand_logo);
  const [pending, setPending] = useState(false);

  const save = async () => {
    setPending(true);
    try {
      await api.put('/messaging-settings', {
        workspace: workspaceId,
        body: {
          sms_enabled: settings.sms_enabled,
          sms_sender_label: settings.sms_sender_label,
          brand_color: color,
          brand_footer: footer.trim() === '' ? null : footer.trim(),
        },
        ...(settings.version === 0 ? {} : { ifMatch: settings.version }),
      });
      notify({ tone: 'success', title: t('saved') });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  const upload = async (file: File) => {
    if (!LOGO_TYPES.includes(file.type) || file.size > LOGO_MAX_BYTES) {
      notify({ tone: 'error', title: t('logoInvalid') });
      return;
    }
    setPending(true);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCodePoint(byte);
      }
      const updated = await api.put<MessagingSettings>('/messaging-settings/logo', {
        workspace: workspaceId,
        body: { content_type: file.type, data_base64: btoa(binary) },
      });
      setLogo(updated.brand_logo);
      notify({ tone: 'success', title: t('logoUploaded') });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-5">
        <div>
          <h3 className="text-base font-semibold text-text">{t('title')}</h3>
          <p className="text-sm text-text-muted">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-40 items-center justify-center rounded-md border border-border bg-surface-muted p-2">
            {logo === null ? (
              <span className="text-xs text-text-muted">{t('noLogo')}</span>
            ) : (
              <img src={logo} alt={t('logoAlt')} className="max-h-16 max-w-36 object-contain" />
            )}
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={LOGO_TYPES.join(',')}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) {
                    void upload(file);
                  }
                }}
              />
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                <ImageUp className="h-4 w-4" aria-hidden="true" />
                {t('uploadLogo')}
              </Button>
              {logo === null ? null : (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={async () => {
                    setPending(true);
                    try {
                      await api.delete('/messaging-settings/logo', { workspace: workspaceId });
                      setLogo(null);
                      notify({ tone: 'success', title: t('logoRemoved') });
                      router.refresh();
                    } catch (error) {
                      showError(error);
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('removeLogo')}
                </Button>
              )}
            </div>
          ) : null}
          <p className="w-full text-xs text-text-muted">{t('logoHint')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="brand-color" label={t('color')} hint={t('colorHint')}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t('color')}
                value={color}
                disabled={!canManage}
                className="h-10 w-12 cursor-pointer rounded-md border border-border bg-surface"
                onChange={(event) => {
                  setColor(event.target.value.toUpperCase());
                }}
              />
              <Input
                id="brand-color"
                value={color}
                spellCheck={false}
                disabled={!canManage}
                onChange={(event) => {
                  setColor(event.target.value.toUpperCase());
                }}
              />
            </div>
          </Field>
          <Field id="brand-footer" label={t('footer')} hint={t('footerHint')}>
            <Textarea
              id="brand-footer"
              rows={3}
              value={footer}
              maxLength={500}
              disabled={!canManage}
              onChange={(event) => {
                setFooter(event.target.value);
              }}
            />
          </Field>
        </div>
        {canManage ? (
          <div className="flex justify-end">
            <Button
              loading={pending}
              disabled={pending || !/^#[0-9A-F]{6}$/.test(color)}
              onClick={() => {
                void save();
              }}
            >
              {t('save')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function EmailTemplateEditor({
  workspaceId,
  templates,
  sender,
  canManage,
}: {
  readonly workspaceId: string;
  readonly templates: readonly EmailTemplate[];
  readonly sender: EmailSender | null;
  readonly canManage: boolean;
}) {
  const t = useTranslations('settings.notifications.templates');
  const te = useTranslations('settings.notifications.types');
  const tf = useTranslations('settings.notifications.templates.fields');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [type, setType] = useState<CallerNotificationType>('CALLER_BOOKING_CONFIRMATION');
  const [locale, setLocale] = useState<'hu' | 'de' | 'en'>('hu');
  const current = templates.find(
    (entry) => entry.notification_type === type && entry.locale === locale,
  );
  const key = `${type}:${locale}`;
  const fields = current?.placeholders ?? [];
  const fieldLabel = (field: string): string => (tf.has(field) ? tf(field) : field);
  const toShown = (text: string): string =>
    text.replace(STORED_FIELD, (match, field: string) =>
      fields.includes(field) ? `{{${fieldLabel(field)}}}` : match,
    );
  const toStored = (text: string): { text: string; unknown: string[] } => {
    const unknown: string[] = [];
    const stored = text.replace(SHOWN_FIELD, (match, inner: string) => {
      const name = inner.trim();
      if (fields.includes(name)) {
        return `{{${name}}}`;
      }
      const field = fields.find(
        (candidate) => fieldLabel(candidate).toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (field === undefined) {
        unknown.push(name);
        return match;
      }
      return `{{${field}}}`;
    });
    return { text: stored, unknown };
  };
  const [draft, setDraft] = useState<{ key: string; subject: string; body: string }>({
    key,
    subject: toShown(current?.subject ?? ''),
    body: toShown(current?.body ?? ''),
  });
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [pending, setPending] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const subject = draft.key === key ? draft.subject : toShown(current?.subject ?? '');
  const body = draft.key === key ? draft.body : toShown(current?.body ?? '');
  const storedSubject = toStored(subject);
  const storedBody = toStored(body);
  const unknownFields = [...new Set([...storedSubject.unknown, ...storedBody.unknown])];
  const update = (next: { subject?: string; body?: string }) => {
    setDraft({ key, subject: next.subject ?? subject, body: next.body ?? body });
    setPreview(null);
  };

  const insertPlaceholder = (placeholder: string) => {
    const textarea = bodyRef.current;
    const token = `{{${fieldLabel(placeholder)}}}`;
    if (textarea === null) {
      update({ body: `${body}${token}` });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    update({ body: `${body.slice(0, start)}${token}${body.slice(end)}` });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const dirty =
    current !== undefined &&
    (storedSubject.text !== current.subject || storedBody.text !== current.body);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-text">{t('title')}</h3>
            <p className="text-sm text-text-muted">{t('description')}</p>
          </div>
          {current?.customized === true ? <Badge tone="sky">{t('customized')}</Badge> : null}
        </div>
        {sender === null || sender.status !== 'CONNECTED' ? (
          <p className="rounded-md border border-warning/40 bg-surface px-4 py-3 text-sm text-warning-text">
            {t('senderMissing')}
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="template-type" label={t('type')}>
            <NativeSelect
              id="template-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as CallerNotificationType);
                setPreview(null);
              }}
            >
              {CALLER_TEMPLATE_ORDER.map((value) => (
                <option key={value} value={value}>
                  {te(value)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="template-locale" label={t('locale')}>
            <NativeSelect
              id="template-locale"
              value={locale}
              onChange={(event) => {
                setLocale(event.target.value as 'hu' | 'de' | 'en');
                setPreview(null);
              }}
            >
              {TEMPLATE_LOCALES.map((value) => (
                <option key={value} value={value}>
                  {t(`locales.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field id="template-subject" label={t('subject')} required>
          <Input
            id="template-subject"
            value={subject}
            maxLength={200}
            disabled={!canManage}
            onChange={(event) => {
              update({ subject: event.target.value });
            }}
          />
        </Field>
        <Field id="template-body" label={t('body')} hint={t('bodyHint')} required>
          <Textarea
            id="template-body"
            ref={bodyRef}
            rows={12}
            value={body}
            maxLength={4000}
            disabled={!canManage}
            onChange={(event) => {
              update({ body: event.target.value });
            }}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-text-muted">{t('placeholders')}</p>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((placeholder) => (
              <button
                key={placeholder}
                type="button"
                disabled={!canManage}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:border-pink hover:text-pink-text disabled:opacity-50"
                onClick={() => {
                  insertPlaceholder(placeholder);
                }}
              >
                {fieldLabel(placeholder)}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            {t('fieldsHint', { example: `{{${fieldLabel('caller_name')}}}` })}
          </p>
          {unknownFields.length === 0 ? null : (
            <p role="alert" className="text-xs text-danger-text">
              {t('unknownFields', { fields: unknownFields.join(', ') })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                const rendered = await api.post<EmailPreview>(
                  `/email-templates/${type}/${locale}/preview`,
                  {
                    workspace: workspaceId,
                    body: { subject: storedSubject.text, body: storedBody.text },
                  },
                );
                setPreview(rendered);
              } catch (error) {
                showError(error);
              } finally {
                setPending(false);
              }
            }}
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            {t('preview')}
          </Button>
          {canManage && current?.customized === true ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  await api.delete(`/email-templates/${type}/${locale}`, {
                    workspace: workspaceId,
                  });
                  setDraft({ key: '', subject: '', body: '' });
                  setPreview(null);
                  notify({ tone: 'success', title: t('reset') });
                  router.refresh();
                } catch (error) {
                  showError(error);
                } finally {
                  setPending(false);
                }
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {t('resetToDefault')}
            </Button>
          ) : null}
          {canManage ? (
            <Button
              loading={pending}
              disabled={
                pending ||
                !dirty ||
                unknownFields.length > 0 ||
                subject.trim() === '' ||
                body.trim() === ''
              }
              onClick={async () => {
                setPending(true);
                try {
                  await api.put(`/email-templates/${type}/${locale}`, {
                    workspace: workspaceId,
                    body: { subject: storedSubject.text, body: storedBody.text },
                  });
                  setDraft({ key: '', subject: '', body: '' });
                  notify({ tone: 'success', title: t('saved') });
                  router.refresh();
                } catch (error) {
                  showError(error);
                } finally {
                  setPending(false);
                }
              }}
            >
              {t('save')}
            </Button>
          ) : null}
        </div>
        {preview === null ? null : (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-text">{preview.subject}</p>
            <iframe
              title={t('preview')}
              srcDoc={preview.html}
              sandbox=""
              className="h-96 w-full rounded-md border border-border bg-white"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
