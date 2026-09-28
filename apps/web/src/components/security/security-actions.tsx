'use client';

import { LOCATION_SCOPABLE_ROLES, type Role } from '@velyric/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  useToast,
} from '@velyric/ui';
import { KeyRound, Plus, ShieldAlert, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/navigation';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  NON_DELEGABLE_SCOPES,
  permissionParts,
  type ApiKey,
  type Member,
} from '@/lib/api/security';

const ROLES: readonly Role[] = [
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'ANALYST',
  'DEVELOPER',
  'BILLING',
  'VIEWER',
];
const SCOPED_ROLES: ReadonlySet<Role> = new Set(LOCATION_SCOPABLE_ROLES);

function usePermissionLabel() {
  const t = useTranslations('security.permissions');
  return (permission: string) => {
    const { resource, action } = permissionParts(permission);
    return `${t.has(`resources.${resource}`) ? t(`resources.${resource}`) : resource} · ${t.has(`actions.${action}`) ? t(`actions.${action}`) : action}`;
  };
}

function LocationScopePicker({
  locations,
  value,
  onChange,
  idPrefix,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('security.members');
  if (locations.length === 0) {
    return null;
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[13px] font-medium text-text">{t('locationScope')}</legend>
      <p className="text-[13px] text-text-muted">{t('locationScopeHint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {locations.map((location) => (
          <label
            key={location.id}
            htmlFor={`${idPrefix}-${location.id}`}
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id={`${idPrefix}-${location.id}`}
              checked={value.includes(location.id)}
              onCheckedChange={(checked) => {
                onChange(
                  checked === true
                    ? [...value, location.id]
                    : value.filter((entry) => entry !== location.id),
                );
              }}
            />
            {location.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function InviteMemberDialog({
  workspaceId,
  locations,
}: {
  readonly workspaceId: string;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('security.members');
  const tc = useTranslations('common.actions');
  const tr = useTranslations('enums.role');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [scope, setScope] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {t('invite')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('inviteTitle')}
        description={t('inviteDescription')}
        closeLabel={tc('close')}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            try {
              await api.post('/members/invitations', {
                workspace: workspaceId,
                body: {
                  email: email.trim(),
                  role,
                  ...(SCOPED_ROLES.has(role) && scope.length > 0 ? { location_scope: scope } : {}),
                },
              });
              notify({ tone: 'success', title: t('invited', { email: email.trim() }) });
              setOpen(false);
              setEmail('');
              setScope([]);
              router.refresh();
            } catch (error) {
              showError(error);
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="invite-email" label={t('email')} required>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              value={email}
              maxLength={254}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </Field>
          <Field id="invite-role" label={t('role')} hint={t(`roleHints.${role}`)}>
            <NativeSelect
              id="invite-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as Role);
              }}
            >
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {tr(value)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {SCOPED_ROLES.has(role) ? (
            <LocationScopePicker
              locations={locations}
              value={scope}
              onChange={setScope}
              idPrefix="invite-scope"
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={pending || !valid}>
              {t('sendInvite')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberActions({
  workspaceId,
  member,
  isSelf,
  locations,
}: {
  readonly workspaceId: string;
  readonly member: Member;
  readonly isSelf: boolean;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('security.members');
  const tr = useTranslations('enums.role');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [role, setRole] = useState<Role>(member.role);
  const [scope, setScope] = useState<string[]>([...member.location_scope]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify({ tone: 'success', title: success });
      router.refresh();
      return true;
    } catch (error) {
      showError(error);
      return false;
    }
  };
  const label = member.display_name ?? member.email ?? member.id;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {member.status !== 'REMOVED' ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={isSelf}>
              {t('changeRole')}
            </Button>
          }
          title={t('changeRoleTitle', { name: label })}
          confirmLabel={t('saveRole')}
          confirmDisabled={
            role === member.role && JSON.stringify(scope) === JSON.stringify(member.location_scope)
          }
          onConfirm={() =>
            run(
              () =>
                api.patch(`/members/${member.id}`, {
                  workspace: workspaceId,
                  ifMatch: member.version,
                  body: {
                    ...(role === member.role ? {} : { role }),
                    ...(SCOPED_ROLES.has(role)
                      ? { location_scope: scope }
                      : role !== member.role
                        ? {}
                        : { location_scope: [] }),
                  },
                }),
              t('roleChanged'),
            )
          }
        >
          <div className="flex flex-col gap-4">
            <Field id={`role-${member.id}`} label={t('role')} hint={t(`roleHints.${role}`)}>
              <NativeSelect
                id={`role-${member.id}`}
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as Role);
                }}
              >
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {tr(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {SCOPED_ROLES.has(role) ? (
              <LocationScopePicker
                locations={locations}
                value={scope}
                onChange={setScope}
                idPrefix={`scope-${member.id}`}
              />
            ) : null}
          </div>
        </ConfirmDialog>
      ) : null}
      {member.status === 'ACTIVE' || member.status === 'SUSPENDED' ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={isSelf}
          onClick={() =>
            void run(
              () =>
                api.patch(`/members/${member.id}`, {
                  workspace: workspaceId,
                  ifMatch: member.version,
                  body: { status: member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' },
                }),
              member.status === 'ACTIVE' ? t('suspended') : t('reactivated'),
            )
          }
        >
          {member.status === 'ACTIVE' ? t('suspend') : t('reactivate')}
        </Button>
      ) : null}
      {member.status !== 'REMOVED' ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={isSelf}>
              {member.status === 'INVITED' ? t('revokeInvite') : t('remove')}
            </Button>
          }
          title={
            member.status === 'INVITED'
              ? t('revokeInviteTitle', { name: label })
              : t('removeTitle', { name: label })
          }
          description={t('removeDescription')}
          confirmLabel={member.status === 'INVITED' ? t('revokeInvite') : t('remove')}
          destructive
          onConfirm={() =>
            run(
              () =>
                api.delete(`/members/${member.id}`, {
                  workspace: workspaceId,
                  ifMatch: member.version,
                }),
              t('removed'),
            )
          }
        />
      ) : null}
    </div>
  );
}

export function CreateApiKeyDialog({
  workspaceId,
  grantable,
}: {
  readonly workspaceId: string;
  readonly grantable: readonly string[];
}) {
  const t = useTranslations('security.apiKeys');
  const tc = useTranslations('common.actions');
  const label = usePermissionLabel();
  const router = useRouter();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState('90');
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectable = grantable.filter((permission) => !NON_DELEGABLE_SCOPES.has(permission));
  const close = (next: boolean) => {
    if (pending) {
      return;
    }
    setOpen(next);
    if (!next) {
      setSecret(null);
      setName('');
      setScopes([]);
      router.refresh();
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('create')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={secret === null ? t('createTitle') : t('secretTitle')}
        description={secret === null ? t('createDescription') : undefined}
        closeLabel={tc('close')}
        size="lg"
      >
        {secret === null ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              try {
                const created = await api.post<ApiKey & { secret: string }>('/api-keys', {
                  workspace: workspaceId,
                  body: {
                    name: name.trim(),
                    scopes,
                    ...(expires === '' ? {} : { expires_in_days: Number(expires) }),
                  },
                });
                setSecret(created.secret);
              } catch (error) {
                showError(error);
              } finally {
                setPending(false);
              }
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="key-name" label={t('name')} required>
                <Input
                  id="key-name"
                  value={name}
                  maxLength={120}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
              <Field id="key-expiry" label={t('expiry')}>
                <NativeSelect
                  id="key-expiry"
                  value={expires}
                  onChange={(event) => {
                    setExpires(event.target.value);
                  }}
                >
                  {['30', '90', '180', '365'].map((days) => (
                    <option key={days} value={days}>
                      {t('days', { days: Number(days) })}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-text">{t('scopes')}</legend>
              <div className="grid max-h-72 gap-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2">
                {selectable.map((permission) => (
                  <label key={permission} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={scopes.includes(permission)}
                      disabled={!scopes.includes(permission) && scopes.length >= 40}
                      onCheckedChange={(checked) => {
                        setScopes((current) =>
                          checked === true
                            ? [...current, permission]
                            : current.filter((entry) => entry !== permission),
                        );
                      }}
                    />
                    {label(permission)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  close(false);
                }}
              >
                {tc('cancel')}
              </Button>
              <Button
                type="submit"
                loading={pending}
                disabled={pending || name.trim() === '' || scopes.length === 0}
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {t('createKey')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div
              role="alert"
              className="flex gap-3 rounded-md border border-warning/50 bg-surface px-4 py-3 text-sm text-warning-text"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('secretWarning')}
            </div>
            <div className="flex items-center gap-2 rounded-md bg-surface-muted p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm text-text">{secret}</code>
              <CopyButton value={secret} label={t('copySecret')} />
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  close(false);
                }}
              >
                {t('done')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RevokeApiKeyButton({
  workspaceId,
  apiKey,
}: {
  readonly workspaceId: string;
  readonly apiKey: ApiKey;
}) {
  const t = useTranslations('security.apiKeys');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm">
          {t('revoke')}
        </Button>
      }
      title={t('revokeTitle', { name: apiKey.name })}
      description={t('revokeDescription')}
      confirmLabel={t('revoke')}
      destructive
      onConfirm={async () => {
        try {
          await api.post(`/api-keys/${apiKey.id}/revoke`, { workspace: workspaceId });
          notify({ tone: 'success', title: t('revoked') });
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
