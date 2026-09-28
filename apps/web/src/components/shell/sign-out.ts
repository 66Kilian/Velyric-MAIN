import { api } from '@/lib/api-client';

export async function signOutAction(): Promise<void> {
  await api.post('/auth/logout', {});
  window.location.assign('/');
}
