'use server';

import { cookies } from 'next/headers';

export async function rememberWorkspace(workspaceId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) {
    return;
  }
  const secure =
    process.env['VELYRIC_ENV'] === 'staging' || process.env['VELYRIC_ENV'] === 'production';
  (await cookies()).set('vly_last_workspace', workspaceId, {
    path: '/app',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 31_536_000,
    secure,
  });
}
