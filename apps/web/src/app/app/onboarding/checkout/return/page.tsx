import { notFound } from 'next/navigation';
import { OrderStatusPoller } from '@/components/onboarding/onboarding-forms';
import type { CheckoutOrder } from '@/lib/api/billing';
import { serverGetOrNull } from '@/server/api';
import { getMe } from '@/server/session';
import { searchValue } from '@/server/workspace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function CheckoutReturnPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const workspaceId = searchValue(search['workspace']);
  const orderId = searchValue(search['order']);
  if (
    workspaceId === undefined ||
    orderId === undefined ||
    !UUID.test(workspaceId) ||
    !UUID.test(orderId)
  ) {
    notFound();
  }
  const me = await getMe();
  if (!me.workspaces.some((workspace) => workspace.id === workspaceId)) {
    notFound();
  }
  const order = await serverGetOrNull<CheckoutOrder>(`/billing/orders/${orderId}`, {
    workspace: workspaceId,
  });
  if (order === null) {
    notFound();
  }
  return (
    <div className="mx-auto w-full max-w-xl pt-8">
      <OrderStatusPoller workspaceId={workspaceId} initial={order} />
    </div>
  );
}
