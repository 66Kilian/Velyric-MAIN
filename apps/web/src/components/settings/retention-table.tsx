'use client';

import { Badge, Button, Input, Table, TBody, Td, Th, THead, Tr, useToast } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { RetentionPolicy } from '@/lib/api/settings';

function RetentionRow({
  workspaceId,
  policy,
  canManage,
}: {
  readonly workspaceId: string;
  readonly policy: RetentionPolicy;
  readonly canManage: boolean;
}) {
  const t = useTranslations('settings.retention');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [days, setDays] = useState(String(policy.retain_days));
  const [pending, setPending] = useState(false);
  const parsed = Number(days);
  const valid =
    Number.isInteger(parsed) && parsed >= policy.min_days && parsed <= policy.platform_max_days;
  const dirty = parsed !== policy.retain_days;
  const label = t.has(`classes.${policy.retention_class}`)
    ? t(`classes.${policy.retention_class}`)
    : policy.retention_class;

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setPending(true);
    try {
      await action();
      notify({ tone: 'success', title: success });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Tr>
      <Td>
        <span className="flex flex-col">
          <span className="font-medium text-text">{label}</span>
          <span className="text-xs text-text-muted">{t(`anchors.${policy.anchor}`)}</span>
        </span>
      </Td>
      <Td className="tabular-nums">
        {policy.anchor === 'NOT_STORED'
          ? t('notStored')
          : t('days', { count: policy.default_days })}
      </Td>
      <Td>
        {policy.tenant_configurable && canManage ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={policy.min_days}
              max={policy.platform_max_days}
              value={days}
              aria-label={t('retainFor', { label })}
              aria-invalid={!valid}
              className="w-24"
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
            <span className="whitespace-nowrap text-xs text-text-muted">
              {t('range', { min: policy.min_days, max: policy.platform_max_days })}
            </span>
          </div>
        ) : policy.tenant_configurable ? (
          <span className="tabular-nums">{t('days', { count: policy.retain_days })}</span>
        ) : (
          <Badge tone="neutral">{t('fixed')}</Badge>
        )}
      </Td>
      <Td className="text-right">
        {policy.tenant_configurable && canManage ? (
          <div className="flex justify-end gap-2">
            {policy.customized ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  void mutate(
                    () =>
                      api.delete(`/retention-policies/${policy.retention_class}`, {
                        workspace: workspaceId,
                      }),
                    t('reset'),
                  );
                }}
              >
                {t('useDefault')}
              </Button>
            ) : null}
            <Button
              size="sm"
              loading={pending}
              disabled={!valid || !dirty}
              onClick={() => {
                void mutate(
                  () =>
                    api.put(`/retention-policies/${policy.retention_class}`, {
                      workspace: workspaceId,
                      ...(policy.version === null ? {} : { ifMatch: policy.version }),
                      body: { retain_days: parsed },
                    }),
                  t('saved'),
                );
              }}
            >
              {tc('save')}
            </Button>
          </div>
        ) : null}
      </Td>
    </Tr>
  );
}

export function RetentionTable({
  workspaceId,
  policies,
  canManage,
}: {
  readonly workspaceId: string;
  readonly policies: readonly RetentionPolicy[];
  readonly canManage: boolean;
}) {
  const t = useTranslations('settings.retention');
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <Tr>
            <Th>{t('columns.class')}</Th>
            <Th>{t('columns.platform')}</Th>
            <Th>{t('columns.workspace')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {policies.map((policy) => (
            <RetentionRow
              key={`${policy.retention_class}:${String(policy.version)}`}
              workspaceId={workspaceId}
              policy={policy}
              canManage={canManage}
            />
          ))}
        </TBody>
      </Table>
    </div>
  );
}
