import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { KnowledgeChunk, KnowledgeSourceDetail } from '@/lib/api/knowledge';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string; versionId: string }>;
}): Promise<Metadata> {
  const { workspace, id } = await params;
  const source = await serverGetOrNull<KnowledgeSourceDetail>(`/knowledge-sources/${id}`, {
    workspace,
  });
  const t = await getTranslations('knowledge');
  return {
    title: source === null ? t('chunksPage.title') : `${source.title} · ${t('chunksPage.title')}`,
  };
}

export default async function KnowledgeSourceVersionChunksPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string; versionId: string }>;
}) {
  const { workspace: workspaceId, id, versionId } = await params;
  await requirePermission(workspaceId, 'knowledge:read');
  const [t, source, chunks] = await Promise.all([
    getTranslations('knowledge'),
    serverGetOrNull<KnowledgeSourceDetail>(`/knowledge-sources/${id}`, { workspace: workspaceId }),
    serverGetOrNull<{ chunks: readonly KnowledgeChunk[] }>(
      `/knowledge-sources/${id}/versions/${versionId}/chunks`,
      { workspace: workspaceId },
    ),
  ]);
  if (source === null || chunks === null) {
    notFound();
  }
  const version = source.versions.find((candidate) => candidate.id === versionId);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/knowledge/${id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {source.title}
      </Link>
      <PageHeader
        eyebrow={version === undefined ? undefined : `v${version.version_number}`}
        title={t('chunksPage.title')}
        description={t('chunksPage.description', { count: chunks.chunks.length })}
      />
      {chunks.chunks.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted">{t('chunksPage.empty')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {chunks.chunks.map((chunk) => (
            <Card key={chunk.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                  <span className="text-text-muted">#{chunk.chunk_index + 1}</span>
                  {chunk.heading_path.length === 0 ? null : (
                    <span>{chunk.heading_path.join(' / ')}</span>
                  )}
                  {chunk.pii_flags.length === 0 ? null : (
                    <Badge tone="warning">{chunk.pii_flags.join(', ')}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-text">{chunk.content}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
