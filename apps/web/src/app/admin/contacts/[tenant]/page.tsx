import { Badge, Card, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { UsersRound } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CursorPager } from '@/components/common/navigation';
import { ContactSearch } from '@/components/contacts/contact-actions';
import type { ContactListItem } from '@/lib/api/contacts';
import type { Page } from '@/lib/api-types';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('contacts') };
}

export default async function ContactsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ tenant: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ tenant: workspaceId }, search] = await Promise.all([params, searchParams]);
  await requirePermission(workspaceId, 'contacts:read');
  const term = searchValue(search['q']);
  const [t, tl, format, workspace, contacts] = await Promise.all([
    getTranslations('contacts'),
    getTranslations('common.language'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<Page<ContactListItem>>('/contacts', {
      workspace: workspaceId,
      query: { q: term, cursor: searchValue(search['cursor']), limit: 50 },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ContactSearch />
      <Card className="overflow-hidden">
        {contacts.data.length === 0 ? (
          <EmptyState
            icon={<UsersRound className="h-5 w-5" aria-hidden="true" />}
            title={term === undefined ? t('empty') : t('noMatches')}
            description={term === undefined ? t('emptyDescription') : t('noMatchesDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.name')}</Th>
                  <Th>{t('columns.identities')}</Th>
                  <Th>{t('columns.language')}</Th>
                  <Th>{t('columns.trust')}</Th>
                  <Th>{t('columns.lastInteraction')}</Th>
                </Tr>
              </THead>
              <TBody>
                {contacts.data.map((contact) => (
                  <Tr key={contact.id}>
                    <Td>
                      <Link
                        href={`/admin/contacts/${workspaceId}/${contact.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {contact.display_name ?? t('unnamed')}
                      </Link>
                      {contact.shared_phone_suspected ? (
                        <Badge tone="warning" className="ml-2">
                          {t('sharedPhone')}
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="max-w-80 truncate tabular-nums text-text-muted">
                      {contact.identities.length === 0
                        ? '–'
                        : contact.identities.map((identity) => identity.value).join(' · ')}
                    </Td>
                    <Td>
                      {contact.preferred_language === null ? '–' : tl(contact.preferred_language)}
                    </Td>
                    <Td>
                      <Badge tone={contact.trust_level === 'VERIFIED' ? 'success' : 'neutral'}>
                        {t.has(`trust.${contact.trust_level}`)
                          ? t(`trust.${contact.trust_level}`)
                          : contact.trust_level}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {contact.last_interaction_at === null
                        ? '–'
                        : format.dateTime(new Date(contact.last_interaction_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            timeZone: workspace.timezone,
                          })}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={contacts.page.next_cursor} />
    </div>
  );
}
