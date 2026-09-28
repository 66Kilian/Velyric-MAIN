'use client';

import {
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
import { Plus, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { PRIVACY_CHANNELS, type ContactListItem, type PrivacyChannel } from '@/lib/api/contacts';
import type { LegalHold, PrivacyRequest } from '@/lib/api/settings';
import { ExportContactButton } from '@/components/contacts/contact-actions';

const REQUEST_TYPES = ['EXPORT', 'RECTIFY', 'RESTRICT', 'DELETE'] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

function useAction() {
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
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
  return { pending, run };
}

function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  disabled,
  pending,
  destructive = false,
  onSubmit,
  children,
}: {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly destructive?: boolean;
  readonly onSubmit: () => Promise<boolean>;
  readonly children: ReactNode;
}) {
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title={title}
        {...(description === undefined ? {} : { description })}
        closeLabel={tc('close')}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onSubmit()) {
              setOpen(false);
            }
          }}
        >
          {children}
          <Button
            type="submit"
            variant={destructive ? 'danger' : 'primary'}
            className="self-end"
            loading={pending}
            disabled={disabled}
          >
            {submitLabel}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreatePrivacyRequestDialog({ workspaceId }: { readonly workspaceId: string }) {
  const t = useTranslations('settings.privacy');
  const showError = useApiErrorToast();
  const { pending, run } = useAction();
  const [term, setTerm] = useState('');
  const [candidates, setCandidates] = useState<readonly ContactListItem[] | null>(null);
  const [personId, setPersonId] = useState('');
  const [requestType, setRequestType] = useState<RequestType>('EXPORT');
  const [channel, setChannel] = useState<PrivacyChannel>('EMAIL');
  const [verification, setVerification] = useState('');

  const search = async () => {
    if (term.trim() === '') {
      return;
    }
    try {
      const page = await api.get<Page<ContactListItem>>('/contacts', {
        workspace: workspaceId,
        query: { q: term.trim(), limit: 10 },
      });
      setCandidates(page.data);
      setPersonId(page.data[0]?.id ?? '');
    } catch (error) {
      showError(error);
    }
  };

  return (
    <ActionDialog
      trigger={
        <Button size="sm">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('create')}
        </Button>
      }
      title={t('createTitle')}
      description={t('createDescription')}
      submitLabel={t('create')}
      pending={pending}
      disabled={personId === '' || (verification.trim() !== '' && verification.trim().length < 3)}
      onSubmit={() =>
        run(
          () =>
            api.post('/privacy-requests', {
              workspace: workspaceId,
              body: {
                person_id: personId,
                request_type: requestType,
                received_via: channel,
                ...(verification.trim() === '' ? {} : { verification_method: verification.trim() }),
              },
            }),
          t('created'),
        )
      }
    >
      <Field id="privacy-person" label={t('person')} required>
        <div className="flex gap-2">
          <Input
            id="privacy-person"
            type="search"
            value={term}
            maxLength={120}
            placeholder={t('personPlaceholder')}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={term.trim() === ''}
            onClick={() => void search()}
          >
            {t('find')}
          </Button>
        </div>
      </Field>
      {candidates === null ? null : candidates.length === 0 ? (
        <p className="text-sm text-text-muted">{t('noPeople')}</p>
      ) : (
        <NativeSelect
          aria-label={t('person')}
          value={personId}
          onChange={(event) => {
            setPersonId(event.target.value);
          }}
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {[
                candidate.display_name ?? t('unnamed'),
                ...candidate.identities.map((identity) => identity.value),
              ].join(' · ')}
            </option>
          ))}
        </NativeSelect>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="privacy-type" label={t('type')}>
          <NativeSelect
            id="privacy-type"
            value={requestType}
            onChange={(event) => {
              setRequestType(event.target.value as RequestType);
            }}
          >
            {REQUEST_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {t(`types.${entry}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="privacy-channel" label={t('channel')}>
          <NativeSelect
            id="privacy-channel"
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
      </div>
      <Field id="privacy-verification" label={t('verification')} hint={t('verificationOptional')}>
        <Input
          id="privacy-verification"
          value={verification}
          maxLength={120}
          onChange={(event) => {
            setVerification(event.target.value);
          }}
        />
      </Field>
    </ActionDialog>
  );
}

export function PrivacyRequestActions({
  workspaceId,
  request,
}: {
  readonly workspaceId: string;
  readonly request: PrivacyRequest;
}) {
  const t = useTranslations('settings.privacy');
  const { pending, run } = useAction();
  const [verification, setVerification] = useState('');
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('');
  const awaitingVerification = request.status === 'RECEIVED' || request.status === 'VERIFYING';
  const manual = request.status === 'IN_PROGRESS' && request.request_type !== 'DELETE';
  if (!awaitingVerification && !manual) {
    return null;
  }
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {manual && request.request_type === 'EXPORT' && request.person_id !== null ? (
        <ExportContactButton workspaceId={workspaceId} contactId={request.person_id} />
      ) : null}
      {awaitingVerification ? (
        <>
          <ActionDialog
            trigger={
              <Button variant="ghost" size="sm">
                {t('verify')}
              </Button>
            }
            title={t('verifyTitle')}
            description={t('verifyDescription')}
            submitLabel={t('verify')}
            pending={pending}
            disabled={verification.trim().length < 3}
            onSubmit={() =>
              run(
                () =>
                  api.post(`/privacy-requests/${request.id}/verify`, {
                    workspace: workspaceId,
                    body: { verification_method: verification.trim() },
                  }),
                t('verified'),
              )
            }
          >
            <Field id={`verify-${request.id}`} label={t('verification')} required>
              <Input
                id={`verify-${request.id}`}
                value={verification}
                maxLength={120}
                onChange={(event) => {
                  setVerification(event.target.value);
                }}
              />
            </Field>
          </ActionDialog>
          <ActionDialog
            trigger={
              <Button variant="ghost" size="sm">
                {t('reject')}
              </Button>
            }
            title={t('rejectTitle')}
            submitLabel={t('reject')}
            destructive
            pending={pending}
            disabled={reason.trim().length < 10}
            onSubmit={() =>
              run(
                () =>
                  api.post(`/privacy-requests/${request.id}/reject`, {
                    workspace: workspaceId,
                    body: { reason: reason.trim() },
                  }),
                t('rejected'),
              )
            }
          >
            <Field id={`reject-${request.id}`} label={t('reason')} hint={t('reasonHint')} required>
              <Textarea
                id={`reject-${request.id}`}
                value={reason}
                maxLength={500}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </Field>
          </ActionDialog>
        </>
      ) : null}
      {manual ? (
        <ActionDialog
          trigger={
            <Button variant="ghost" size="sm">
              {t('complete')}
            </Button>
          }
          title={t('completeTitle')}
          description={t(`completeDescription.${request.request_type}`)}
          submitLabel={t('complete')}
          pending={pending}
          disabled={resolution.trim().length < 10}
          onSubmit={() =>
            run(
              () =>
                api.post(`/privacy-requests/${request.id}/complete`, {
                  workspace: workspaceId,
                  body: { resolution: resolution.trim() },
                }),
              t('completed'),
            )
          }
        >
          <Field
            id={`complete-${request.id}`}
            label={t('resolution')}
            hint={t('reasonHint')}
            required
          >
            <Textarea
              id={`complete-${request.id}`}
              value={resolution}
              maxLength={500}
              onChange={(event) => {
                setResolution(event.target.value);
              }}
            />
          </Field>
        </ActionDialog>
      ) : null}
    </div>
  );
}

export function CreateLegalHoldDialog({ workspaceId }: { readonly workspaceId: string }) {
  const t = useTranslations('settings.privacy.holds');
  const { pending, run } = useAction();
  const [scope, setScope] = useState<'TENANT' | 'PERSON' | 'CALL'>('PERSON');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [basis, setBasis] = useState('');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    reference.trim(),
  );
  return (
    <ActionDialog
      trigger={
        <Button size="sm" variant="secondary">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {t('create')}
        </Button>
      }
      title={t('createTitle')}
      description={t('createDescription')}
      submitLabel={t('create')}
      pending={pending}
      disabled={
        (scope !== 'TENANT' && !uuid) || reason.trim().length < 10 || basis.trim().length < 3
      }
      onSubmit={() =>
        run(
          () =>
            api.post('/legal-holds', {
              workspace: workspaceId,
              body: {
                scope_type: scope,
                ...(scope === 'TENANT' ? {} : { scope_ref: reference.trim().toLowerCase() }),
                reason: reason.trim(),
                legal_basis: basis.trim(),
              },
            }),
          t('created'),
        )
      }
    >
      <Field id="hold-scope" label={t('scope')}>
        <NativeSelect
          id="hold-scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as 'TENANT' | 'PERSON' | 'CALL');
          }}
        >
          {(['PERSON', 'CALL', 'TENANT'] as const).map((entry) => (
            <option key={entry} value={entry}>
              {t(`scopes.${entry}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {scope === 'TENANT' ? null : (
        <Field
          id="hold-reference"
          label={t(`references.${scope}`)}
          hint={t('referenceHint')}
          required
        >
          <Input
            id="hold-reference"
            value={reference}
            maxLength={36}
            className="font-mono"
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
        </Field>
      )}
      <Field id="hold-basis" label={t('basis')} hint={t('basisHint')} required>
        <Input
          id="hold-basis"
          value={basis}
          maxLength={200}
          onChange={(event) => {
            setBasis(event.target.value);
          }}
        />
      </Field>
      <Field id="hold-reason" label={t('reason')} required>
        <Textarea
          id="hold-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </ActionDialog>
  );
}

export function ReleaseLegalHoldButton({
  workspaceId,
  hold,
}: {
  readonly workspaceId: string;
  readonly hold: LegalHold;
}) {
  const t = useTranslations('settings.privacy.holds');
  const { pending, run } = useAction();
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      trigger={
        <Button variant="ghost" size="sm">
          <ShieldOff className="h-4 w-4" aria-hidden="true" />
          {t('release')}
        </Button>
      }
      title={t('releaseTitle')}
      description={t('releaseDescription')}
      submitLabel={t('release')}
      destructive
      pending={pending}
      disabled={reason.trim().length < 10}
      onSubmit={() =>
        run(
          () =>
            api.post(`/legal-holds/${hold.id}/release`, {
              workspace: workspaceId,
              body: { reason: reason.trim() },
            }),
          t('released'),
        )
      }
    >
      <Field id={`release-${hold.id}`} label={t('releaseReason')} required>
        <Textarea
          id={`release-${hold.id}`}
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </ActionDialog>
  );
}
