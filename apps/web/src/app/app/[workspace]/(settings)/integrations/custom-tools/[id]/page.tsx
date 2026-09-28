import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  PageHeader,
} from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomToolSettings } from '@/components/integrations/integration-actions';
import type { CustomTool } from '@/lib/api/integrations';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}): Promise<Metadata> {
  const { workspace, id } = await params;
  const tool = await serverGetOrNull<CustomTool>(`/integrations/custom-tools/${id}`, { workspace });
  const t = await getTranslations('integrations.tools');
  return { title: tool?.name ?? t('title') };
}

export default async function CustomToolPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'integrations:read');
  const [t, te, tool] = await Promise.all([
    getTranslations('integrations.tools'),
    getTranslations('enums'),
    serverGetOrNull<CustomTool>(`/integrations/custom-tools/${id}`, { workspace: workspaceId }),
  ]);
  if (tool === null) {
    notFound();
  }
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/integrations`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader
        title={<span className="font-mono">{tool.name}</span>}
        description={tool.description}
        actions={
          <Badge
            tone={
              tool.status === 'ACTIVE' ? 'success' : tool.status === 'KILLED' ? 'danger' : 'neutral'
            }
          >
            {t(`status.${tool.status}`)}
          </Badge>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.endpoint')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                { term: t('form.method'), description: tool.http_method },
                {
                  term: t('form.baseUrl'),
                  description: <code className="break-all font-mono text-xs">{tool.base_url}</code>,
                },
                {
                  term: t('form.path'),
                  description: (
                    <code className="break-all font-mono text-xs">{tool.path_template}</code>
                  ),
                },
                { term: t('detail.allowedHosts'), description: tool.allowed_hosts.join(', ') },
                {
                  term: t('form.sideEffect'),
                  description: te(`toolSideEffectClass.${tool.side_effect_class}`),
                },
                { term: t('form.auth'), description: t(`form.authTypes.${tool.auth_type}`) },
                {
                  term: t('detail.credential'),
                  description:
                    tool.auth_type === 'NONE'
                      ? '–'
                      : tool.credential_configured
                        ? t('detail.configured')
                        : t('detail.missing'),
                },
                {
                  term: t('form.idempotency'),
                  description: tool.idempotency_supported ? t('detail.yes') : t('detail.no'),
                },
                {
                  term: t('detail.responseLimit'),
                  description: `${String(Math.round(tool.response_max_bytes / 1024))} KB`,
                },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.schemas')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[13px] font-medium text-text">{t('form.inputSchema')}</p>
            <pre className="max-h-56 overflow-auto rounded-md bg-surface-muted p-3 font-mono text-xs text-text">
              {JSON.stringify(tool.input_schema, null, 2)}
            </pre>
            <p className="text-[13px] font-medium text-text">{t('form.outputSchema')}</p>
            <pre className="max-h-56 overflow-auto rounded-md bg-surface-muted p-3 font-mono text-xs text-text">
              {JSON.stringify(tool.output_schema, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>
      <CustomToolSettings
        workspaceId={workspaceId}
        tool={tool}
        canManage={permissions.has('custom_tools:manage') && tool.status !== 'KILLED'}
      />
    </div>
  );
}
