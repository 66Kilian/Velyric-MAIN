import { Badge, StatusDot, type BadgeTone } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import type { RunStatus } from '@/lib/api/simulation';

const TONES: Readonly<Record<RunStatus, BadgeTone>> = {
  QUEUED: 'sky',
  RUNNING: 'pink',
  PASSED: 'success',
  FAILED: 'danger',
  ERRORED: 'warning',
  CANCELED: 'neutral',
};

export async function RunStatusBadge({ status }: { readonly status: RunStatus }) {
  const t = await getTranslations('simulation.statuses');
  return (
    <Badge tone={TONES[status]}>
      {status === 'RUNNING' || status === 'QUEUED' ? (
        <StatusDot pulse tone={status === 'RUNNING' ? 'success' : 'neutral'} />
      ) : null}
      {t(status)}
    </Badge>
  );
}
