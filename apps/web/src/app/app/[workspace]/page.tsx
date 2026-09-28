import { redirect } from 'next/navigation';

export default async function WorkspaceIndex({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${workspace}/dashboard`);
}
