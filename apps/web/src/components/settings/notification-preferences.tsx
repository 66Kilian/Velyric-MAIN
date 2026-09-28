'use client';

import {
  Badge,
  Button,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type {
  NotificationPreference,
  NotificationPreferences,
  NotificationRule,
} from '@/lib/api/settings';

type Scope = 'WORKSPACE' | 'USER';
const CHANNELS = ['EMAIL', 'IN_APP', 'SMS'] as const;

function key(type: string, channel: string): string {
  return `${type}:${channel}`;
}

function lookup(entries: readonly NotificationPreference[]): ReadonlyMap<string, boolean> {
  return new Map(
    entries.map((entry) => [key(entry.notification_type, entry.channel), entry.enabled]),
  );
}

function ScopeEditor({
  workspaceId,
  scope,
  rules,
  stored,
  workspaceStored,
  editable,
}: {
  readonly workspaceId: string;
  readonly scope: Scope;
  readonly rules: readonly NotificationRule[];
  readonly stored: ReadonlyMap<string, boolean>;
  readonly workspaceStored: ReadonlyMap<string, boolean>;
  readonly editable: boolean;
}) {
  const t = useTranslations('settings.notifications');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [changes, setChanges] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [pending, setPending] = useState(false);

  const effective = (rule: NotificationRule, channel: string): boolean => {
    const id = key(rule.notification_type, channel);
    if (rule.mandatory) {
      return true;
    }
    const changed = changes.get(id);
    if (changed !== undefined) {
      return changed;
    }
    if (scope === 'USER' && workspaceStored.get(id) === false) {
      return false;
    }
    return (
      stored.get(id) ??
      (scope === 'USER' ? workspaceStored.get(id) : undefined) ??
      rule.default_enabled
    );
  };

  const save = async () => {
    setPending(true);
    try {
      await api.put('/notification-preferences', {
        workspace: workspaceId,
        body: {
          scope,
          preferences: [...changes.entries()].map(([id, enabled]) => {
            const [notificationType = '', channel = ''] = id.split(':');
            return { notification_type: notificationType, channel, enabled };
          }),
        },
      });
      notify({ tone: 'success', title: t('saved') });
      setChanges(new Map());
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  const groups = [
    { id: 'workspace', rules: rules.filter((rule) => rule.audience === 'WORKSPACE') },
    ...(scope === 'WORKSPACE'
      ? [{ id: 'caller', rules: rules.filter((rule) => rule.audience === 'CALLER') }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section
          key={group.id}
          className="overflow-hidden rounded-xl border border-border bg-surface"
        >
          <header className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">{t(`groups.${group.id}`)}</h3>
            <p className="text-sm text-text-muted">{t(`groups.${group.id}Hint`)}</p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-5 py-2 font-medium">{t('columns.notification')}</th>
                  {CHANNELS.map((channel) => (
                    <th key={channel} className="px-3 py-2 text-center font-medium">
                      {t(`channels.${channel}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {group.rules.map((rule) => (
                  <tr key={rule.notification_type}>
                    <td className="px-5 py-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text">
                          {t.has(`types.${rule.notification_type}`)
                            ? t(`types.${rule.notification_type}`)
                            : rule.notification_type}
                        </span>
                        {rule.mandatory ? <Badge tone="neutral">{t('mandatory')}</Badge> : null}
                      </span>
                    </td>
                    {CHANNELS.map((channel) => {
                      if (!rule.channels.includes(channel)) {
                        return (
                          <td key={channel} className="px-3 py-3 text-center text-text-muted">
                            –
                          </td>
                        );
                      }
                      const lockedByWorkspace =
                        scope === 'USER' &&
                        workspaceStored.get(key(rule.notification_type, channel)) === false;
                      const label = `${t.has(`types.${rule.notification_type}`) ? t(`types.${rule.notification_type}`) : rule.notification_type} – ${t(`channels.${channel}`)}`;
                      return (
                        <td key={channel} className="px-3 py-3 text-center">
                          <Switch
                            checked={effective(rule, channel)}
                            disabled={!editable || rule.mandatory || lockedByWorkspace || pending}
                            aria-label={label}
                            title={lockedByWorkspace ? t('lockedByWorkspace') : undefined}
                            onCheckedChange={(enabled) => {
                              setChanges((current) =>
                                new Map(current).set(key(rule.notification_type, channel), enabled),
                              );
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {editable ? (
        <div className="flex items-center justify-end gap-3">
          {changes.size > 0 ? (
            <span className="text-sm text-text-muted">{t('unsaved', { count: changes.size })}</span>
          ) : null}
          <Button
            variant="secondary"
            disabled={changes.size === 0 || pending}
            onClick={() => {
              setChanges(new Map());
            }}
          >
            {tc('cancel')}
          </Button>
          <Button disabled={changes.size === 0} loading={pending} onClick={save}>
            {tc('saveChanges')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t('readOnly')}</p>
      )}
    </div>
  );
}

export function NotificationPreferencesEditor({
  workspaceId,
  preferences,
  canManageWorkspace,
}: {
  readonly workspaceId: string;
  readonly preferences: NotificationPreferences;
  readonly canManageWorkspace: boolean;
}) {
  const t = useTranslations('settings.notifications');
  const workspaceStored = useMemo(() => lookup(preferences.workspace), [preferences.workspace]);
  const personalStored = useMemo(() => lookup(preferences.personal), [preferences.personal]);
  return (
    <Tabs defaultValue="personal">
      <TabsList aria-label={t('scopeLabel')}>
        <TabsTrigger value="personal">{t('scopes.personal')}</TabsTrigger>
        <TabsTrigger value="workspace">{t('scopes.workspace')}</TabsTrigger>
      </TabsList>
      <TabsContent value="personal" className="pt-4">
        <p className="mb-4 text-sm text-text-muted">{t('personalHint')}</p>
        <ScopeEditor
          workspaceId={workspaceId}
          scope="USER"
          rules={preferences.rules}
          stored={personalStored}
          workspaceStored={workspaceStored}
          editable
        />
      </TabsContent>
      <TabsContent value="workspace" className="pt-4">
        <p className="mb-4 text-sm text-text-muted">{t('workspaceHint')}</p>
        <ScopeEditor
          workspaceId={workspaceId}
          scope="WORKSPACE"
          rules={preferences.rules}
          stored={workspaceStored}
          workspaceStored={workspaceStored}
          editable={canManageWorkspace}
        />
      </TabsContent>
    </Tabs>
  );
}
