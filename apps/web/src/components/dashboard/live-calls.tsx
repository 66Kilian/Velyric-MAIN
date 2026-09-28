'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusDot,
  cn,
} from '@velyric/ui';
import { ArrowRight, PhoneIncoming } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { clock, INTENT_TONES } from '@/lib/format';
import type { CallListItem } from '@/lib/types';

const ROW = '-mx-2 flex items-center gap-3 rounded-md px-2 py-3';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

export function LiveCalls({
  workspaceId,
  initial,
  callsHref = null,
}: {
  readonly workspaceId: string;
  readonly initial: Page<CallListItem>;
  /** Base path of the call pages; only staff get one, customers see an unlinked list. */
  readonly callsHref?: string | null;
}) {
  const t = useTranslations('dashboard.live');
  const te = useTranslations('enums');
  const now = useNow(1000);
  const query = useQuery({
    queryKey: ['calls', workspaceId, 'active'],
    queryFn: ({ signal }) =>
      api.get<Page<CallListItem>>('/calls', {
        workspace: workspaceId,
        query: { status: 'ACTIVE', limit: 6 },
        signal,
      }),
    initialData: initial,
    refetchInterval: 5000,
  });
  const calls = query.data.data;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {t('title')}
          {calls.length > 0 ? <Badge tone="pink">{calls.length}</Badge> : null}
        </CardTitle>
        {callsHref === null ? null : (
          <Link
            href={`${callsHref}?status=ACTIVE`}
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-violet-text hover:underline"
          >
            {t('viewAll')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        {calls.length === 0 ? (
          <EmptyState
            icon={<PhoneIncoming className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            className="h-full border-none py-10"
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-live="polite">
            {calls.map((call) => {
              const since = Date.parse(call.answered_at ?? call.started_at);
              const elapsed = Number.isNaN(since) ? 0 : Math.max(0, (now - since) / 1000);
              const caller =
                call.caller_e164 ??
                (call.channel === 'WEB_VOICE' ? t('webVisitor') : t('unknownCaller'));
              const body = (
                <>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pink-tint text-pink-text ring-1 ring-border">
                    <PhoneIncoming className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] font-medium tabular-nums text-text">
                      {caller}
                    </span>
                    <span className="flex items-center gap-1.5 text-[13px] text-text-muted">
                      <StatusDot
                        tone={call.status === 'TRANSFERRING' ? 'warning' : 'success'}
                        pulse
                      />
                      {te(`callStatus.${call.status}`)} ·{' '}
                      <span className="tabular-nums">{clock(elapsed)}</span>
                    </span>
                  </span>
                  {call.intent === null ? null : (
                    <Badge tone={INTENT_TONES[call.intent] ?? 'neutral'}>
                      {te(`callIntent.${call.intent}`)}
                    </Badge>
                  )}
                </>
              );
              return (
                <li key={call.id}>
                  {callsHref === null ? (
                    <div className={ROW}>{body}</div>
                  ) : (
                    <Link
                      href={`${callsHref}/${call.id}`}
                      className={cn(ROW, 'hover:bg-surface-muted')}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
