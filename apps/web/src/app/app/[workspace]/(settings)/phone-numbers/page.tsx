import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { Phone } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { PhoneNumberRow } from '@/components/phone-numbers/phone-number-row';
import type { Page } from '@/lib/api-types';
import type { Agent, PhoneNumber } from '@/lib/api/agents';
import type { ProvisioningStatus } from '@/lib/api/provisioning';
import type { Location } from '@/lib/api/scheduling';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('phoneNumbers') };
}

export default async function PhoneNumbersPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'phone_numbers:read');
  const [t, te] = await Promise.all([getTranslations('phoneNumbers'), getTranslations('enums')]);
  const [numbers, agents, locations, provisioning] = await Promise.all([
    serverGet<{ data: PhoneNumber[] }>('/phone-numbers', { workspace: workspaceId }),
    permissions.has('agents:read')
      ? serverGetOrNull<Page<Agent>>('/agents', { workspace: workspaceId, query: { limit: 200 } })
      : Promise.resolve(null),
    permissions.has('locations:read')
      ? serverGetOrNull<{ data: Location[] }>('/locations', { workspace: workspaceId })
      : Promise.resolve(null),
    permissions.has('provisioning:read')
      ? serverGetOrNull<ProvisioningStatus>('/provisioning', { workspace: workspaceId })
      : Promise.resolve(null),
  ]);
  const pendingOrders = (provisioning?.phone_orders ?? []).filter(
    (order) =>
      order.phone_number_id === null && order.status !== 'FAILED' && order.status !== 'CANCELED',
  );
  const kycNeeded = pendingOrders.some((order) =>
    order.requirements.some(
      (requirement) => requirement.status === 'REQUIRED' || requirement.status === 'DECLINED',
    ),
  );
  const agentOptions = (agents?.data ?? [])
    .filter((agent) => agent.status !== 'ARCHIVED')
    .map((agent) => ({ id: agent.id, name: agent.name }));
  const locationOptions = (locations?.data ?? [])
    .filter((location) => location.status === 'ACTIVE')
    .map((location) => ({ id: location.id, name: location.name }));
  const canManage = permissions.has('phone_numbers:manage');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {pendingOrders.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-text">{t('orders.title')}</p>
                <p className="text-sm text-text-muted">
                  {kycNeeded ? t('orders.kycNeeded') : t('orders.inProgress')}
                </p>
              </div>
              {kycNeeded ? (
                <Link
                  href="/app/onboarding"
                  className="vly-gradient-cta inline-flex h-9 items-center rounded-md px-4 text-sm font-semibold shadow-cta"
                >
                  {t('orders.completeKyc')}
                </Link>
              ) : null}
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {pendingOrders.map((order) => (
                <li
                  key={order.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="tabular-nums text-text">
                    {order.e164 ?? t('orders.numberPending')} · {order.country}
                  </span>
                  <span className="flex gap-2">
                    <Badge tone="sky">
                      {te.has(`phoneOrderStatus.${order.status}`)
                        ? te(`phoneOrderStatus.${order.status}`)
                        : order.status}
                    </Badge>
                    {order.decline_reason === null ? null : (
                      <Badge tone="danger">{order.decline_reason}</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <Card className="overflow-hidden">
        {numbers.data.length === 0 ? (
          <EmptyState
            icon={<Phone className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.number')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.agent')}</Th>
                  <Th>{t('columns.location')}</Th>
                  <Th>{t('columns.maxCalls')}</Th>
                  <Th>
                    <span className="sr-only">{t('save')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {numbers.data.map((number) => (
                  <PhoneNumberRow
                    key={`${number.id}-${String(number.version)}-${number.agent?.id ?? ''}`}
                    workspaceId={workspaceId}
                    number={number}
                    agents={agentOptions}
                    locations={locationOptions}
                    canManage={canManage}
                  />
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
