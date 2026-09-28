import { PageHeader } from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CustomToolForm } from '@/components/integrations/integration-actions';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('integrations.tools');
  return { title: t('create') };
}

export default async function NewCustomToolPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  await requirePermission(workspaceId, 'custom_tools:manage');
  const t = await getTranslations('integrations.tools');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/integrations`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader title={t('create')} description={t('createDescription')} />
      <CustomToolForm workspaceId={workspaceId} />
    </div>
  );
}
