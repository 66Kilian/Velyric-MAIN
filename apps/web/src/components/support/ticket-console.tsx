'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Textarea,
  cn,
} from '@velyric/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { SupportTicketDetail, SupportTicketSummary } from '@/lib/api/support';

const CATEGORIES = ['TECHNICAL', 'BILLING', 'PHONE_NUMBERS', 'ACCOUNT', 'OTHER'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;

function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'pink' {
  if (status === 'PENDING_CUSTOMER') {
    return 'pink';
  }
  if (status === 'RESOLVED') {
    return 'success';
  }
  if (status === 'CLOSED') {
    return 'neutral';
  }
  return 'warning';
}

export function TicketConsole({
  workspaceId,
  initialTickets,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly initialTickets: readonly SupportTicketSummary[];
  readonly canWrite: boolean;
}) {
  const t = useTranslations('support');
  const ts = useTranslations('support.status');
  const tc = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const showError = useApiErrorToast();
  const queryClient = useQueryClient();
  const selected = params.get('ticket');
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('TECHNICAL');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('NORMAL');
  const [firstMessage, setFirstMessage] = useState('');
  const [reply, setReply] = useState('');

  const tickets = useQuery({
    queryKey: ['support-tickets', workspaceId],
    queryFn: () =>
      api.get<{ data: SupportTicketSummary[] }>('/support-tickets', { workspace: workspaceId }),
    initialData: { data: [...initialTickets] },
    refetchInterval: 15_000,
  });

  const thread = useQuery({
    queryKey: ['support-ticket', workspaceId, selected],
    queryFn: () =>
      api.get<SupportTicketDetail>(`/support-tickets/${selected ?? ''}`, {
        workspace: workspaceId,
      }),
    enabled: selected !== null,
    refetchInterval: 5_000,
  });

  const select = (id: string) => {
    router.replace(`/app/${workspaceId}/support?ticket=${id}`);
  };

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [thread.data?.messages.length]);

  useEffect(() => {
    const detail = thread.data;
    if (detail === undefined || detail.unread === 0) {
      return;
    }
    void api
      .post(`/support-tickets/${detail.id}/read`, {
        body: { seq: detail.message_count },
        workspace: workspaceId,
      })
      .then(() => queryClient.invalidateQueries({ queryKey: ['support-tickets', workspaceId] }))
      .catch(() => undefined);
  }, [thread.data, workspaceId, queryClient]);

  const createTicket = useMutation({
    mutationFn: () =>
      api.post<SupportTicketSummary>('/support-tickets', {
        workspace: workspaceId,
        body: { subject: subject.trim(), body: firstMessage.trim(), category, priority },
      }),
    onSuccess: async (created) => {
      setOpen(false);
      setSubject('');
      setFirstMessage('');
      await queryClient.invalidateQueries({ queryKey: ['support-tickets', workspaceId] });
      select(created.id);
    },
    onError: showError,
  });

  const sendReply = useMutation({
    mutationFn: () =>
      api.post(`/support-tickets/${selected ?? ''}/messages`, {
        workspace: workspaceId,
        body: { body: reply.trim() },
      }),
    onSuccess: async () => {
      setReply('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['support-ticket', workspaceId, selected] }),
        queryClient.invalidateQueries({ queryKey: ['support-tickets', workspaceId] }),
      ]);
    },
    onError: showError,
  });

  const changeStatus = useMutation({
    mutationFn: (status: 'OPEN' | 'RESOLVED' | 'CLOSED') =>
      api.post(`/support-tickets/${selected ?? ''}/status`, {
        workspace: workspaceId,
        body: { status },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['support-ticket', workspaceId, selected] }),
        queryClient.invalidateQueries({ queryKey: ['support-tickets', workspaceId] }),
      ]);
    },
    onError: showError,
  });

  const rows = tickets.data.data;
  const detail = thread.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-3">
        {canWrite ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="w-full">{t('new')}</Button>
            </DialogTrigger>
            <DialogContent
              title={t('newTitle')}
              description={t('newBody')}
              closeLabel={tc('actions.close')}
            >
              <div className="flex flex-col gap-4">
                <Field id="ticket-subject" label={t('subject')} required>
                  <Input
                    id="ticket-subject"
                    value={subject}
                    maxLength={200}
                    onChange={(event) => {
                      setSubject(event.target.value);
                    }}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="ticket-category" label={t('category')}>
                    <NativeSelect
                      id="ticket-category"
                      value={category}
                      onChange={(event) => {
                        setCategory(event.target.value as (typeof CATEGORIES)[number]);
                      }}
                    >
                      {CATEGORIES.map((entry) => (
                        <option key={entry} value={entry}>
                          {t(`categories.${entry}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field id="ticket-priority" label={t('priority')}>
                    <NativeSelect
                      id="ticket-priority"
                      value={priority}
                      onChange={(event) => {
                        setPriority(event.target.value as (typeof PRIORITIES)[number]);
                      }}
                    >
                      {PRIORITIES.map((entry) => (
                        <option key={entry} value={entry}>
                          {t(`priorities.${entry}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                <Field id="ticket-body" label={t('describe')} hint={t('describeHint')} required>
                  <Textarea
                    id="ticket-body"
                    rows={6}
                    value={firstMessage}
                    onChange={(event) => {
                      setFirstMessage(event.target.value);
                    }}
                  />
                </Field>
                <Button
                  loading={createTicket.isPending}
                  disabled={subject.trim().length < 3 || firstMessage.trim().length === 0}
                  onClick={() => {
                    createTicket.mutate();
                  }}
                >
                  {t('send')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
        <Card>
          <CardContent className="p-2">
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-text-muted">{t('empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {rows.map((ticket) => (
                  <li key={ticket.id}>
                    <button
                      type="button"
                      onClick={() => {
                        select(ticket.id);
                      }}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors',
                        ticket.id === selected
                          ? 'bg-pink-tint-strong'
                          : 'hover:bg-pink-tint focus-visible:bg-pink-tint',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                          {ticket.subject}
                        </span>
                        {ticket.unread > 0 ? (
                          <span className="rounded-full bg-pink px-1.5 text-xs font-semibold text-on-accent">
                            {ticket.unread}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-text-muted">
                        <Badge tone={statusTone(ticket.status)}>{ts(ticket.status)}</Badge>
                        {ticket.last_message_at === null
                          ? null
                          : format.relativeTime(new Date(ticket.last_message_at))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {detail === undefined ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState title={t('pickTitle')} description={t('pickBody')} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex h-full flex-col gap-4 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-text">{detail.subject}</p>
                <p className="text-xs text-text-muted">
                  {detail.reference} · {t(`categories.${detail.category}`)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(detail.status)}>{ts(detail.status)}</Badge>
                {canWrite && detail.status !== 'CLOSED' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={changeStatus.isPending}
                    onClick={() => {
                      changeStatus.mutate('CLOSED');
                    }}
                  >
                    {t('close')}
                  </Button>
                ) : null}
                {canWrite && detail.status === 'CLOSED' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={changeStatus.isPending}
                    onClick={() => {
                      changeStatus.mutate('OPEN');
                    }}
                  >
                    {t('reopen')}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
              {detail.messages.map((message) => {
                const fromStaff = message.author_kind === 'STAFF';
                return (
                  <div
                    key={message.id}
                    className={cn('flex flex-col gap-1', fromStaff ? 'items-start' : 'items-end')}
                  >
                    <div
                      className={cn(
                        'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm',
                        fromStaff
                          ? 'bg-surface-muted text-text'
                          : 'bg-pink-tint-strong text-pink-text',
                      )}
                    >
                      {message.body}
                    </div>
                    <span className="text-xs text-text-muted">
                      {fromStaff ? t('velyric') : (message.author_label ?? t('you'))} ·{' '}
                      {format.dateTime(new Date(message.created_at), {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>
                );
              })}
              <div ref={threadEnd} />
            </div>

            {detail.status === 'CLOSED' ? (
              <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-text-muted">
                {t('closedNotice')}
              </p>
            ) : canWrite ? (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <Textarea
                  rows={3}
                  value={reply}
                  placeholder={t('replyPlaceholder')}
                  aria-label={t('replyPlaceholder')}
                  onChange={(event) => {
                    setReply(event.target.value);
                  }}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    loading={sendReply.isPending}
                    disabled={reply.trim().length === 0}
                    onClick={() => {
                      sendReply.mutate();
                    }}
                  >
                    {t('send')}
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
