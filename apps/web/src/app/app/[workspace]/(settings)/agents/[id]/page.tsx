import { BUILT_IN_TOOLS, type AgentLocale } from '@velyric/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  PageHeader,
} from '@velyric/ui';
import { ArrowLeft, History } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentStatusControls, PhoneBindings } from '@/components/agents/agent-actions';
import { AgentConfigEditor } from '@/components/agents/config-editor';
import type { AgentConfigForm } from '@/lib/agent-config-schema';
import { defaultAgentConfig } from '@/lib/agent-defaults';
import type { Page } from '@/lib/api-types';
import type {
  AgentDetail,
  AgentVersionDetail,
  AgentVersionSummary,
  CustomToolSummary,
  PhoneNumber,
  ToolOption,
} from '@/lib/api/agents';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}): Promise<Metadata> {
  const { workspace, id } = await params;
  const agent = await serverGetOrNull<AgentDetail>(`/agents/${id}`, { workspace });
  const t = await getTranslations('navigation.app');
  return { title: agent?.name ?? t('agents') };
}

function agentLocale(value: string): AgentLocale {
  return value === 'de' || value === 'en' ? value : 'hu';
}

export default async function AgentDetailPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'agents:read');
  const [t, te, format, workspace, agent] = await Promise.all([
    getTranslations('agents'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<AgentDetail>(`/agents/${id}`, { workspace: workspaceId }),
  ]);
  if (agent === null) {
    notFound();
  }
  const [versions, numbers, customTools] = await Promise.all([
    serverGet<Page<AgentVersionSummary>>(`/agents/${id}/versions`, {
      workspace: workspaceId,
      query: { limit: 1 },
    }),
    permissions.has('phone_numbers:read')
      ? serverGetOrNull<{ data: PhoneNumber[] }>('/phone-numbers', { workspace: workspaceId })
      : Promise.resolve(null),
    permissions.has('integrations:read')
      ? serverGetOrNull<Page<CustomToolSummary>>('/integrations/custom-tools', {
          workspace: workspaceId,
          query: { limit: 200 },
        })
      : Promise.resolve(null),
  ]);
  const latestId = versions.data[0]?.id ?? null;
  const latest =
    latestId === null
      ? null
      : await serverGetOrNull<AgentVersionDetail>(`/agent-versions/${latestId}`, {
          workspace: workspaceId,
        });
  const initial: AgentConfigForm =
    latest?.config ??
    defaultAgentConfig({
      locale: agentLocale(workspace.default_locale),
      timezone: workspace.timezone,
      businessName: workspace.display_name,
      now: new Date(),
    });
  const tools: ToolOption[] = [
    ...BUILT_IN_TOOLS.map((tool) => ({
      name: tool.name,
      sideEffectClass: tool.sideEffectClass,
      custom: false,
    })),
    ...(customTools?.data ?? [])
      .filter((tool) => tool.status === 'ACTIVE')
      .map((tool) => ({ name: tool.name, sideEffectClass: tool.side_effect_class, custom: true })),
  ];
  const timeZones = Intl.supportedValuesOf('timeZone');
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: workspace.timezone,
        });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/agents`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('detail.back')}
      </Link>
      <PageHeader
        title={agent.name}
        description={t('detail.description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                agent.status === 'ACTIVE'
                  ? 'success'
                  : agent.status === 'PAUSED'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {te(`agentStatus.${agent.status}`)}
            </Badge>
            {permissions.has('agents:write') ? (
              <AgentStatusControls workspaceId={workspaceId} agent={agent} />
            ) : null}
            <Link
              href={`/app/${workspaceId}/agents/${agent.id}/versions`}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-[13px] font-medium text-text shadow-soft hover:bg-surface-muted"
            >
              <History className="h-4 w-4" aria-hidden="true" />
              {t('detail.versions')}
            </Link>
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.release')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: t('production'),
                  description:
                    agent.production_version === null
                      ? t('notPublished')
                      : t('detail.versionLabel', {
                          version: agent.production_version.version_number,
                        }),
                },
                {
                  term: t('detail.publishedAt'),
                  description: dateTime(agent.production_version?.published_at ?? null),
                },
                {
                  term: t('detail.canary'),
                  description:
                    agent.canary_version === null
                      ? '–'
                      : t('detail.canaryLabel', {
                          version: agent.canary_version.version_number,
                          percent: agent.canary_version.rollout_percent ?? 0,
                        }),
                },
                {
                  term: t('detail.latestDraft'),
                  description:
                    latest === null
                      ? t('detail.noVersions')
                      : t('detail.versionLabel', { version: latest.version_number }),
                },
              ]}
            />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('phones.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {numbers === null ? (
              <p className="text-sm text-text-muted">{t('phones.restricted')}</p>
            ) : (
              <PhoneBindings
                workspaceId={workspaceId}
                agentId={agent.id}
                numbers={numbers.data}
                canManage={permissions.has('phone_numbers:manage')}
              />
            )}
          </CardContent>
        </Card>
      </div>
      <section aria-labelledby="agent-config-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="agent-config-heading" className="text-lg font-semibold text-text">
            {t('editor.title')}
          </h2>
          <p className="text-sm text-text-muted">
            {latest === null
              ? t('editor.startingPoint')
              : t('editor.basedOn', { version: latest.version_number })}
          </p>
        </div>
        <AgentConfigEditor
          workspaceId={workspaceId}
          agentId={agent.id}
          businessName={workspace.display_name}
          initial={initial}
          basedOnVersionId={latest?.id ?? null}
          tools={tools}
          timeZones={timeZones}
          canWrite={permissions.has('agents:write') && agent.status !== 'ARCHIVED'}
        />
      </section>
    </div>
  );
}
