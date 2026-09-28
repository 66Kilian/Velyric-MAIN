import { Badge, Card, EmptyState, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { KeyRound } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CreateApiKeyDialog, RevokeApiKeyButton } from '@/components/security/security-actions';
import type { ApiKey } from '@/lib/api/security';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('security.tabs');
  return { title: t('apiKeys') };
}

export default async function ApiKeysPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'api_keys:manage');
  const [t, format, workspace, keys] = await Promise.all([
    getTranslations('security.apiKeys'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<{ data: ApiKey[] }>('/api-keys', { workspace: workspaceId }),
  ]);
  const date = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), { dateStyle: 'medium', timeZone: workspace.timezone });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">{t('description')}</p>
        <CreateApiKeyDialog workspaceId={workspaceId} grantable={[...permissions]} />
      </div>
      <Card className="overflow-hidden">
        {keys.data.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('name')}</Th>
                  <Th>{t('prefix')}</Th>
                  <Th>{t('scopes')}</Th>
                  <Th>{t('status')}</Th>
                  <Th>{t('lastUsed')}</Th>
                  <Th>{t('expires')}</Th>
                  <Th>
                    <span className="sr-only">{t('revoke')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {keys.data.map((key) => (
                  <Tr key={key.id}>
                    <Td className="font-medium">{key.name}</Td>
                    <Td className="font-mono text-xs">{key.prefix}…</Td>
                    <Td className="tabular-nums">
                      {t('scopeCount', { count: key.scopes.length })}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          key.status === 'ACTIVE'
                            ? 'success'
                            : key.status === 'EXPIRED'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {t(`statuses.${key.status}`)}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{date(key.last_used_at)}</Td>
                    <Td className="whitespace-nowrap">{date(key.expires_at)}</Td>
                    <Td className="text-right">
                      {key.status === 'ACTIVE' ? (
                        <RevokeApiKeyButton workspaceId={workspaceId} apiKey={key} />
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
