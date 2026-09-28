import { Button, Card, EmptyState, Input, NativeSelect } from '@velyric/ui';
import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CursorPager } from '@/components/common/navigation';
import type { Page } from '@/lib/api-types';
import { zonedInstant } from '@/lib/api/scheduling';
import type { AuditLogEntry } from '@/lib/api/security';
import { addDays } from '@/lib/dates';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('security.tabs');
  return { title: t('auditLog') };
}

const ACTOR_TYPES = [
  'USER',
  'API_KEY',
  'SERVICE',
  'SUPPORT_STAFF',
  'PROVIDER_WEBHOOK',
  'SYSTEM',
] as const;
const AUTOMATIC_ACTORS: ReadonlySet<string> = new Set(['SERVICE', 'SYSTEM', 'PROVIDER_WEBHOOK']);
const CATEGORY_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  agents: ['agent.', 'agent_version.', 'call.'],
  bookings: [
    'booking.',
    'service.',
    'resource.',
    'availability_exception.',
    'waitlist_entry.',
    'location.',
  ],
  knowledge: ['knowledge_source.'],
  integrations: ['integration.', 'integrations.', 'custom_tool.'],
  messaging: ['messaging.', 'notification_preferences.'],
  team: ['member.', 'api_key.'],
  privacy: ['contact.', 'privacy_request.', 'legal_hold.', 'retention_policy.'],
  billing: ['billing_profile.', 'checkout.', 'provisioning.', 'phone_order.', 'phone_number.'],
  webhooks: ['outbound_webhook.'],
  simulations: ['simulation_run.', 'simulation_scenario.', 'simulation_suite.'],
  workspace: ['tenant.'],
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function AuditLogPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  await requirePermission(workspaceId, 'audit_logs:read');
  const [t, tc, format, workspace] = await Promise.all([
    getTranslations('security.audit'),
    getTranslations('common.actions'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const category = searchValue(search['category']);
  const actorType = searchValue(search['actor_type']);
  const objectType = searchValue(search['object_type']);
  const from = searchValue(search['from']);
  const to = searchValue(search['to']);
  const categoryActions = category === undefined ? undefined : CATEGORY_ACTIONS[category];
  const entries = await serverGet<Page<AuditLogEntry>>('/audit-logs', {
    workspace: workspaceId,
    query: {
      limit: 50,
      cursor: searchValue(search['cursor']),
      action: categoryActions?.join(','),
      actor_type: actorType,
      object_type:
        objectType !== undefined && /^[a-z][a-z_]{1,60}$/.test(objectType) ? objectType : undefined,
      from:
        from !== undefined && DAY.test(from)
          ? zonedInstant(`${from}T00:00`, workspace.timezone)
          : undefined,
      to:
        to !== undefined && DAY.test(to)
          ? zonedInstant(`${addDays(to, 1)}T00:00`, workspace.timezone)
          : undefined,
    },
  });
  const describe = (entry: AuditLogEntry): string =>
    t.has(`actions.${entry.action}`) ? t(`actions.${entry.action}`) : entry.action;
  const objectLabel = (type: string | null): string | null =>
    type === null ? null : t.has(`objectTypes.${type}`) ? t(`objectTypes.${type}`) : type;
  const performer = (entry: AuditLogEntry): string => {
    const name = entry.actor.name ?? null;
    const email = entry.actor.email ?? null;
    if (entry.actor.type === 'USER') {
      return name !== null && email !== null
        ? `${name} (${email})`
        : (name ?? email ?? t('unknownPerson'));
    }
    if (entry.actor.type === 'API_KEY') {
      return name === null ? t('actorTypes.API_KEY') : `${t('actorTypes.API_KEY')}: ${name}`;
    }
    if (AUTOMATIC_ACTORS.has(entry.actor.type)) {
      return t('automatic');
    }
    const type = t.has(`actorTypes.${entry.actor.type}`)
      ? t(`actorTypes.${entry.actor.type}`)
      : entry.actor.type;
    return entry.actor.label === null ? type : `${type}: ${entry.actor.label}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        method="get"
        className="grid grid-cols-2 gap-3 md:grid-cols-6"
        aria-label={t('filters')}
      >
        <NativeSelect
          name="category"
          defaultValue={categoryActions === undefined ? '' : category}
          aria-label={t('category')}
          className="md:col-span-2"
        >
          <option value="">{t('anyCategory')}</option>
          {Object.keys(CATEGORY_ACTIONS).map((value) => (
            <option key={value} value={value}>
              {t(`categories.${value}`)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="actor_type" defaultValue={actorType ?? ''} aria-label={t('actor')}>
          <option value="">{t('anyActor')}</option>
          {ACTOR_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`actorTypes.${value}`)}
            </option>
          ))}
        </NativeSelect>
        <Input type="date" name="from" defaultValue={from ?? ''} aria-label={t('from')} />
        <Input type="date" name="to" defaultValue={to ?? ''} aria-label={t('to')} />
        <Button type="submit" variant="secondary">
          {tc('filter')}
        </Button>
      </form>
      <Card className="overflow-hidden">
        {entries.data.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            className="m-4 border-none"
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {entries.data.map((entry) => (
              <li key={entry.id}>
                <details className="group px-4 py-3 open:bg-surface-muted">
                  <summary className="grid cursor-pointer list-none gap-x-4 gap-y-1 text-sm md:grid-cols-[11rem_minmax(0,1fr)_minmax(0,16rem)]">
                    <span className="tabular-nums text-text-muted">
                      {format.dateTime(new Date(entry.occurred_at), {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                        timeZone: workspace.timezone,
                      })}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-text">{describe(entry)}</span>
                      {entry.object.type === null ? null : (
                        <span className="ml-2 text-xs text-text-muted">
                          {objectLabel(entry.object.type)}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-text-muted md:text-right">
                      {performer(entry)}
                    </span>
                  </summary>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[10rem_1fr]">
                    <dt className="text-text-muted">{t('actor')}</dt>
                    <dd>{performer(entry)}</dd>
                    <dt className="text-text-muted">{t('object')}</dt>
                    <dd>{objectLabel(entry.object.type) ?? '–'}</dd>
                    {entry.object.id === null ? null : (
                      <>
                        <dt className="text-text-muted">{t('objectId')}</dt>
                        <dd className="break-all font-mono text-xs">{entry.object.id}</dd>
                      </>
                    )}
                    <dt className="text-text-muted">{t('ip')}</dt>
                    <dd className="font-mono text-xs">{entry.ip ?? '–'}</dd>
                    <dt className="text-text-muted">{t('userAgent')}</dt>
                    <dd className="break-all text-xs">{entry.user_agent ?? '–'}</dd>
                    {entry.support_grant_id === null ? null : (
                      <>
                        <dt className="text-text-muted">{t('supportGrant')}</dt>
                        <dd className="font-mono text-xs">{entry.support_grant_id}</dd>
                      </>
                    )}
                  </dl>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
                      {t('technical')}
                    </summary>
                    <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[10rem_1fr]">
                      <dt className="text-text-muted">{t('eventCode')}</dt>
                      <dd className="font-mono text-xs">{entry.action}</dd>
                      <dt className="text-text-muted">{t('trace')}</dt>
                      <dd className="font-mono text-xs">{entry.trace_id ?? '–'}</dd>
                      <dt className="text-text-muted">{t('metadata')}</dt>
                      <dd>
                        <pre className="max-h-64 overflow-auto rounded-sm bg-surface p-2 font-mono text-xs text-text">
                          {JSON.stringify(entry.metadata ?? {}, null, 2)}
                        </pre>
                      </dd>
                    </dl>
                  </details>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CursorPager nextCursor={entries.page.next_cursor} />
    </div>
  );
}
