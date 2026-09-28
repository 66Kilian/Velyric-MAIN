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
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import type { AdminStaffRow } from '@/lib/api/admin';
import { api } from '@/lib/api-client';

const ROLES = [
  'SUPPORT_AGENT',
  'SUPPORT_LEAD',
  'PLATFORM_OPS',
  'FINANCE_OPS',
  'PLATFORM_ADMIN',
] as const;

interface LookupResult {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly platform_role: string | null;
  readonly active: boolean;
}

export function StaffManager({
  rows,
  currentUserId,
  canEdit,
}: {
  readonly rows: readonly AdminStaffRow[];
  readonly currentUserId: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations('admin.staff');
  const tr = useTranslations('admin.roles');
  const tc = useTranslations('common');
  const router = useRouter();
  const showError = useApiErrorToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<LookupResult | null>(null);
  const [role, setRole] = useState<(typeof ROLES)[number]>('SUPPORT_AGENT');
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const lookup = async () => {
    setBusy(true);
    try {
      const result = await api.get<LookupResult>('/admin/staff/lookup', {
        query: { email: email.trim() },
      });
      setFound(result);
      if (result.platform_role !== null) {
        setRole(result.platform_role as (typeof ROLES)[number]);
        setActive(result.active);
      }
    } catch (error) {
      setFound(null);
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const save = async (userId: string, nextRole: string, nextActive: boolean, why: string) => {
    setBusy(true);
    try {
      await api.put(`/admin/staff/${userId}`, {
        body: { platform_role: nextRole, active: nextActive, reason: why },
      });
      setOpen(false);
      setEmail('');
      setFound(null);
      setReason('');
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">{t('addStaff')}</Button>
            </DialogTrigger>
            <DialogContent
              title={t('addStaff')}
              description={t('addStaffBody')}
              closeLabel={tc('actions.close')}
            >
              <div className="flex flex-col gap-4">
                <Field id="staff-email" label={t('emailLabel')} hint={t('emailHint')}>
                  <div className="flex gap-2">
                    <Input
                      id="staff-email"
                      type="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setFound(null);
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      loading={busy}
                      disabled={email.trim() === ''}
                      onClick={() => {
                        void lookup();
                      }}
                    >
                      {t('lookup')}
                    </Button>
                  </div>
                </Field>
                {found === null ? null : (
                  <>
                    <p className="text-sm text-text-muted">
                      {found.display_name ?? found.email}
                      {found.platform_role === null ? '' : ` · ${tr(found.platform_role)}`}
                    </p>
                    <Field id="staff-role" label={t('roleLabel')}>
                      <NativeSelect
                        id="staff-role"
                        value={role}
                        onChange={(event) => {
                          setRole(event.target.value as (typeof ROLES)[number]);
                        }}
                      >
                        {ROLES.map((entry) => (
                          <option key={entry} value={entry}>
                            {tr(entry)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <label className="flex items-center justify-between gap-3 text-sm">
                      <span>{t('activeLabel')}</span>
                      <Switch checked={active} onCheckedChange={setActive} />
                    </label>
                    <Field
                      id="staff-reason"
                      label={t('reasonLabel')}
                      hint={t('reasonHint')}
                      required
                    >
                      <Input
                        id="staff-reason"
                        value={reason}
                        onChange={(event) => {
                          setReason(event.target.value);
                        }}
                      />
                    </Field>
                    <Button
                      loading={busy}
                      disabled={reason.trim().length < 10 || found.user_id === currentUserId}
                      onClick={() => {
                        void save(found.user_id, role, active, reason.trim());
                      }}
                    >
                      {t('save')}
                    </Button>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
      <Table>
        <THead>
          <Tr>
            <Th>{t('columns.person')}</Th>
            <Th>{t('columns.rank')}</Th>
            <Th>{t('columns.state')}</Th>
            {canEdit ? <Th>{t('columns.actions')}</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.user_id}>
              <Td>
                <span className="font-medium text-text">{row.display_name ?? row.email}</span>
                <span className="block text-xs text-text-muted">{row.email}</span>
              </Td>
              <Td>{tr.has(row.platform_role) ? tr(row.platform_role) : row.platform_role}</Td>
              <Td>
                <Badge tone={row.active ? 'success' : 'neutral'}>
                  {row.active ? t('stateActive') : t('stateDisabled')}
                </Badge>
              </Td>
              {canEdit ? (
                <Td>
                  {row.user_id === currentUserId ? (
                    <span className="text-xs text-text-muted">{t('self')}</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setFound({
                          user_id: row.user_id,
                          email: row.email,
                          display_name: row.display_name,
                          platform_role: row.platform_role,
                          active: row.active,
                        });
                        setEmail(row.email);
                        setRole(row.platform_role as (typeof ROLES)[number]);
                        setActive(row.active);
                        setReason('');
                        setOpen(true);
                      }}
                    >
                      {t('edit')}
                    </Button>
                  )}
                </Td>
              ) : null}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
