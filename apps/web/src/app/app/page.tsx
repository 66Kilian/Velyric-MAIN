import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMe } from '@/server/session';

export default async function AppIndex() {
  const me = await getMe();
  const last = (await cookies()).get('vly_last_workspace')?.value;
  const target = me.workspaces.find((workspace) => workspace.id === last) ?? me.workspaces[0];
  if (target === undefined) {
    redirect('/app/onboarding');
  }
  redirect(`/app/${target.id}/dashboard`);
}
