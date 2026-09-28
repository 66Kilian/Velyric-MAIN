import { Permission, ROLE_PERMISSIONS, type Role } from '@velyric/contracts';
import { Card } from '@velyric/ui';
import { Check, Minus } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { permissionParts } from '@/lib/api/security';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('security.tabs');
  return { title: t('roles') };
}

const ROLES: readonly Role[] = [
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'ANALYST',
  'DEVELOPER',
  'BILLING',
  'VIEWER',
];

export default async function RolesPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  await requirePermission(workspaceId, 'security:read');
  const [t, tr, tp] = await Promise.all([
    getTranslations('security.roles'),
    getTranslations('enums.role'),
    getTranslations('security.permissions'),
  ]);
  const permissions = Object.values(Permission);
  const grants = new Map(ROLES.map((role) => [role, new Set<string>(ROLE_PERMISSIONS[role])]));
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-text-muted">{t('description')}</p>
      <Card className="overflow-hidden">
        <div className="max-h-[70dvh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 text-left font-medium text-text-muted">
                  {t('permission')}
                </th>
                {ROLES.map((role) => (
                  <th
                    key={role}
                    scope="col"
                    className="px-3 py-3 text-center font-medium text-text"
                  >
                    {tr(role)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((permission) => {
                const { resource, action } = permissionParts(permission);
                return (
                  <tr key={permission} className="border-b border-border last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal text-text">
                      {tp.has(`resources.${resource}`) ? tp(`resources.${resource}`) : resource} ·{' '}
                      <span className="text-text-muted">
                        {tp.has(`actions.${action}`) ? tp(`actions.${action}`) : action}
                      </span>
                    </th>
                    {ROLES.map((role) => (
                      <td key={role} className="px-3 py-2 text-center">
                        {grants.get(role)?.has(permission) === true ? (
                          <Check
                            className="mx-auto h-4 w-4 text-success"
                            aria-label={t('granted')}
                          />
                        ) : (
                          <Minus
                            className="mx-auto h-4 w-4 text-text-muted/50"
                            aria-label={t('notGranted')}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
