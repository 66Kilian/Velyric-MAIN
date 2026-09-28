'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Switch,
  useToast,
} from '@velyric/ui';
import { Download, GitMerge, Plus, Search, ShieldX, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type SubmitEvent } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  PRIVACY_CHANNELS,
  type Contact,
  type ContactLanguage,
  type ContactListItem,
  type IdentityType,
  type PrivacyChannel,
} from '@/lib/api/contacts';
import type { Page } from '@/lib/api-types';
import { parseError } from '@/lib/api-types';

const LANGUAGES: readonly ContactLanguage[] = ['hu', 'de', 'en'];
const IDENTITY_TYPES: readonly IdentityType[] = ['PHONE', 'EMAIL', 'EXTERNAL_ID'];

export function ContactSearch() {
  const t = useTranslations('contacts');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('q');
    const term = typeof value === 'string' ? value.trim() : '';
    startTransition(() => {
      router.push(term === '' ? pathname : `${pathname}?q=${encodeURIComponent(term)}`);
    });
  };

  return (
    <form onSubmit={submit} role="search" className="flex max-w-xl gap-2">
      <Input
        name="q"
        type="search"
        defaultValue={params.get('q') ?? ''}
        maxLength={120}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        <Search className="h-4 w-4" aria-hidden="true" />
        {tc('search')}
      </Button>
    </form>
  );
}

export function ContactProfileForm({
  workspaceId,
  contact,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly contact: Contact;
  readonly canWrite: boolean;
}) {
  const t = useTranslations('contacts.profile');
  const tc = useTranslations('common.actions');
  const tl = useTranslations('common.language');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [name, setName] = useState(contact.display_name ?? '');
  const [language, setLanguage] = useState<ContactLanguage | ''>(contact.preferred_language ?? '');
  const [memory, setMemory] = useState(contact.memory_enabled);
  const [pending, setPending] = useState(false);
  const changes = {
    ...(name.trim() === (contact.display_name ?? '')
      ? {}
      : { display_name: name.trim() === '' ? null : name.trim() }),
    ...(language === (contact.preferred_language ?? '')
      ? {}
      : { preferred_language: language === '' ? null : language }),
    ...(memory === contact.memory_enabled ? {} : { memory_enabled: memory }),
  };
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        try {
          await api.patch(`/contacts/${contact.id}`, {
            workspace: workspaceId,
            ifMatch: contact.version,
            body: changes,
          });
          notify({ tone: 'success', title: t('saved') });
          router.refresh();
        } catch (error) {
          showError(error);
        } finally {
          setPending(false);
        }
      }}
    >
      <Field
        id="contact-name"
        label={t('displayName')}
        {...(contact.display_name_verification !== null &&
        t.has(`verification.${contact.display_name_verification}`)
          ? { hint: t(`verification.${contact.display_name_verification}`) }
          : {})}
      >
        <Input
          id="contact-name"
          value={name}
          maxLength={160}
          disabled={!canWrite}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field id="contact-language" label={t('preferredLanguage')}>
        <NativeSelect
          id="contact-language"
          value={language}
          disabled={!canWrite}
          onChange={(event) => {
            setLanguage(event.target.value as ContactLanguage | '');
          }}
        >
          <option value="">{t('languageUnknown')}</option>
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {tl(code)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <label className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-text">{t('memory')}</span>
          <span className="text-sm text-text-muted">{t('memoryHint')}</span>
        </span>
        <Switch
          checked={memory}
          disabled={!canWrite}
          onCheckedChange={setMemory}
          aria-label={t('memory')}
        />
      </label>
      {canWrite ? (
        <Button type="submit" className="self-start" disabled={!dirty || pending}>
          {tc('saveChanges')}
        </Button>
      ) : null}
    </form>
  );
}

export function AddIdentityDialog({
  workspaceId,
  contactId,
}: {
  readonly workspaceId: string;
  readonly contactId: string;
}) {
  const t = useTranslations('contacts.identities');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<IdentityType>('PHONE');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const trimmed = value.trim();
  const valid =
    type === 'PHONE'
      ? /^\+[1-9][0-9 ]{6,18}$/.test(trimmed)
      : type === 'EMAIL'
        ? /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/.test(trimmed)
        : trimmed.length >= 3;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('add')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('addTitle')}
        description={t('addDescription')}
        closeLabel={tc('close')}
        size="sm"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            try {
              await api.post(`/contacts/${contactId}/identities`, {
                workspace: workspaceId,
                body: { identity_type: type, value: trimmed },
              });
              notify({ tone: 'success', title: t('added') });
              setOpen(false);
              setValue('');
              router.refresh();
            } catch (error) {
              showError(error);
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="identity-type" label={t('type')}>
            <NativeSelect
              id="identity-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as IdentityType);
              }}
            >
              {IDENTITY_TYPES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`types.${entry}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="identity-value" label={t('value')} hint={t(`hints.${type}`)} required>
            <Input
              id="identity-value"
              value={value}
              maxLength={254}
              inputMode={type === 'PHONE' ? 'tel' : type === 'EMAIL' ? 'email' : 'text'}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" className="self-end" disabled={!valid || pending}>
            {tc('add')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveIdentityButton({
  workspaceId,
  contactId,
  identityId,
  value,
}: {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly identityId: string;
  readonly value: string;
}) {
  const t = useTranslations('contacts.identities');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const showError = useApiErrorToast();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon" aria-label={t('remove')}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      }
      title={t('removeTitle')}
      description={t('removeDescription', { value })}
      confirmLabel={tc('remove')}
      destructive
      onConfirm={async () => {
        try {
          await api.delete(`/contacts/${contactId}/identities/${identityId}`, {
            workspace: workspaceId,
          });
          router.refresh();
          return true;
        } catch (error) {
          showError(error);
          return false;
        }
      }}
    />
  );
}

export function MergeContactDialog({
  workspaceId,
  contactId,
}: {
  readonly workspaceId: string;
  readonly contactId: string;
}) {
  const t = useTranslations('contacts.merge');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<readonly ContactListItem[] | null>(null);
  const [target, setTarget] = useState<ContactListItem | null>(null);
  const [pending, setPending] = useState(false);

  const search = async () => {
    const query = term.trim();
    if (query === '') {
      return;
    }
    setPending(true);
    try {
      const page = await api.get<Page<ContactListItem>>('/contacts', {
        workspace: workspaceId,
        query: { q: query, limit: 10 },
      });
      setResults(page.data.filter((candidate) => candidate.id !== contactId));
      setTarget(null);
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <GitMerge className="h-4 w-4" aria-hidden="true" />
          {t('action')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('title')} description={t('description')} closeLabel={tc('close')}>
        <div className="flex flex-col gap-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Input
              type="search"
              value={term}
              maxLength={120}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              onChange={(event) => {
                setTerm(event.target.value);
              }}
            />
            <Button type="submit" variant="secondary" disabled={pending || term.trim() === ''}>
              {tc('search')}
            </Button>
          </form>
          {results === null ? null : results.length === 0 ? (
            <p className="text-sm text-text-muted">{t('noResults')}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label={t('results')}>
              {results.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(candidate);
                    }}
                    aria-pressed={target?.id === candidate.id}
                    className={`flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left text-sm ${target?.id === candidate.id ? 'border-pink bg-pink-soft' : 'border-border hover:bg-surface-muted'}`}
                  >
                    <span className="font-medium text-text">
                      {candidate.display_name ?? t('unnamed')}
                    </span>
                    <span className="text-xs text-text-muted">
                      {candidate.identities.map((identity) => identity.value).join(' · ') ||
                        t('noIdentities')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {target === null ? null : (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-text">
              {t('warning', { name: target.display_name ?? t('unnamed') })}
            </p>
          )}
          <Button
            className="self-end"
            disabled={target === null || pending}
            onClick={async () => {
              if (target === null) {
                return;
              }
              setPending(true);
              try {
                const merged = await api.post<{ id: string }>(`/contacts/${contactId}/merge`, {
                  workspace: workspaceId,
                  body: { target_id: target.id },
                });
                notify({ tone: 'success', title: t('merged') });
                setOpen(false);
                router.push(`/admin/contacts/${workspaceId}/${merged.id}`);
                router.refresh();
              } catch (error) {
                showError(error);
              } finally {
                setPending(false);
              }
            }}
          >
            {t('confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ExportContactButton({
  workspaceId,
  contactId,
}: {
  readonly workspaceId: string;
  readonly contactId: string;
}) {
  const t = useTranslations('contacts');
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const response = await fetch(`/v1/contacts/${contactId}/export`, {
            headers: { accept: 'application/json', 'x-velyric-workspace': workspaceId },
            credentials: 'same-origin',
          });
          if (!response.ok) {
            throw await parseError(response);
          }
          const url = URL.createObjectURL(await response.blob());
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `contact-${contactId}.json`;
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (error) {
          showError(error);
        } finally {
          setPending(false);
        }
      }}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {t('export')}
    </Button>
  );
}

export function ErasureDialog({
  workspaceId,
  contactId,
}: {
  readonly workspaceId: string;
  readonly contactId: string;
}) {
  const t = useTranslations('contacts.erasure');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<PrivacyChannel>('EMAIL');
  const [method, setMethod] = useState('');
  const [pending, setPending] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="danger">
          <ShieldX className="h-4 w-4" aria-hidden="true" />
          {t('action')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('title')} description={t('description')} closeLabel={tc('close')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            try {
              const created = await api.post<{ status: string }>(`/contacts/${contactId}/erasure`, {
                workspace: workspaceId,
                body: { received_via: channel, verification_method: method.trim() },
              });
              notify({
                tone: created.status === 'ON_LEGAL_HOLD' ? 'info' : 'success',
                title: created.status === 'ON_LEGAL_HOLD' ? t('onHold') : t('requested'),
              });
              setOpen(false);
              router.refresh();
            } catch (error) {
              showError(error);
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="erasure-channel" label={t('channel')}>
            <NativeSelect
              id="erasure-channel"
              value={channel}
              onChange={(event) => {
                setChannel(event.target.value as PrivacyChannel);
              }}
            >
              {PRIVACY_CHANNELS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`channels.${entry}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id="erasure-method"
            label={t('verification')}
            hint={t('verificationHint')}
            required
          >
            <Input
              id="erasure-method"
              value={method}
              minLength={3}
              maxLength={120}
              onChange={(event) => {
                setMethod(event.target.value);
              }}
            />
          </Field>
          <Button
            type="submit"
            variant="danger"
            className="self-end"
            disabled={method.trim().length < 3 || pending}
          >
            {t('confirm')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
