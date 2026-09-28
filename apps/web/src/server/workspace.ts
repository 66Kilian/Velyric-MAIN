import 'server-only';
import { cache } from 'react';
import type { WorkspaceDetail } from '@/lib/types';
import { serverGet } from './api';

export const getWorkspaceDetail = cache((workspaceId: string): Promise<WorkspaceDetail> =>
  serverGet<WorkspaceDetail>(`/workspaces/${workspaceId}`, { workspace: workspaceId }),
);

export function searchValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : single;
}
