import { Avatar, Badge, Card, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { InviteMemberDialog, MemberActions } from '@/components/security/security-actions';
import type { Location } from '@/lib/api/scheduling';
import type { Member } from '@/lib/api/security';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('security.tabs');
  return { title: t('members') };
}

const STATUS_TONES = {
  INVITED: 'sky',
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  REMOVED: 'neutral',
} as const;

export default async function MembersPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { me, permissions } = await requirePermission(workspaceId, 'security:read');
  if (!permissions.has('members:read')) {
    redirect(`/app/${workspaceId}/security/roles`);
  }
  const [t, tr, format, workspace, members, locations] = await Promise.all([
    getTranslations('security.members'),
    getTranslations('enums.role'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<{ data: Member[] }>('/members', { workspace: workspaceId }),
    permissions.has('locations:read')
      ? serverGetOrNull<{ data: Location[] }>('/locations', { workspace: workspaceId })
      : Promise.resolve(null),
  ]);
  const canManage = permissions.has('members:manage');
  const locationOptions = (locations?.data ?? []).map((location) => ({
    id: location.id,
    name: location.name,
  }));
  const locationNames = new Map(locationOptions.map((location) => [location.id, location.name]));
  const visible = members.data.filter((member) => member.status !== 'REMOVED');
  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex justify-end">
          <InviteMemberDialog workspaceId={workspaceId} locations={locationOptions} />
        </div>
      ) : null}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>{t('member')}</Th>
                <Th>{t('role')}</Th>
                <Th>{t('status')}</Th>
                <Th>{t('locationScope')}</Th>
                <Th>{t('joined')}</Th>
                <Th>
                  <span className="sr-only">{t('actions')}</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {visible.map((member) => (
                <Tr key={member.id}>
                  <Td>
                    <span className="flex items-center gap-3">
                      <Avatar name={member.display_name ?? member.email ?? '?'} size={32} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-text">
                          {member.display_name ?? member.email ?? '–'}
                        </span>
                        {member.display_name === null ? null : (
                          <span className="truncate text-xs text-text-muted">{member.email}</span>
                        )}
                      </span>
                      {member.user_id === me.user.id ? <Badge tone="pink">{t('you')}</Badge> : null}
                    </span>
                  </Td>
                  <Td>{tr(member.role)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONES[member.status]}>
                      {t(`statuses.${member.status}`)}
                    </Badge>
                    {member.status === 'INVITED' && member.invitation_expires_at !== null ? (
                      <span className="block text-xs text-text-muted">
                        {t('expires', {
                          date: format.dateTime(new Date(member.invitation_expires_at), {
                            dateStyle: 'medium',
                            timeZone: workspace.timezone,
                          }),
                        })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="max-w-56 truncate">
                    {member.location_scope.length === 0
                      ? t('allLocations')
                      : member.location_scope.map((id) => locationNames.get(id) ?? '–').join(', ')}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(new Date(member.created_at), {
                      dateStyle: 'medium',
                      timeZone: workspace.timezone,
                    })}
                  </Td>
                  <Td>
                    {canManage ? (
                      <MemberActions
                        workspaceId={workspaceId}
                        member={member}
                        isSelf={member.user_id === me.user.id}
                        locations={locationOptions}
                      />
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
