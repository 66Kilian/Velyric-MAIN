'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  NativeSelect,
  Textarea,
  cn,
} from '@velyric/ui';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { AdminTicketDetail, AdminTicketSummary } from '@/lib/api/support';

const STATUSES = ['OPEN', 'PENDING_STAFF', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'pink' {
  if (status === 'PENDING_STAFF') {
    return 'warning';
  }
  if (status === 'PENDING_CUSTOMER') {
    return 'pink';
  }
  if (status === 'RESOLVED') {
    return 'success';
  }
  return 'neutral';
}

export function TicketQueue({
  initialQueue,
  staffUserId,
  canManage,
}: {
  readonly initialQueue: readonly AdminTicketSummary[];
  readonly staffUserId: string;
  readonly canManage: boolean;
}) {
  const t = useTranslations('admin.tickets');
  const ts = useTranslations('support.status');
  const tp = useTranslations('support.priorities');
  const tcat = useTranslations('support.categories');
  const format = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const showError = useApiErrorToast();
  const queryClient = useQueryClient();
  const selected = params.get('ticket');
  const filter = params.get('status') ?? '';
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);

  const queue = useQuery({
    queryKey: ['admin-tickets', filter],
    queryFn: () =>
      api.get<{ data: AdminTicketSummary[]; total: number }>('/admin/tickets', {
        query: { limit: 50, ...(filter === '' ? {} : { status: filter }) },
      }),
    initialData: { data: [...initialQueue], total: initialQueue.length },
    refetchInterval: 15_000,
  });

  const thread = useQuery({
    queryKey: ['admin-ticket', selected],
    queryFn: () => api.get<AdminTicketDetail>(`/admin/tickets/${selected ?? ''}`),
    enabled: selected !== null,
    refetchInterval: 5_000,
  });

  const navigate = (next: { ticket?: string | null; status?: string | null }) => {
    const search = new URLSearchParams();
    const ticket = next.ticket === undefined ? selected : next.ticket;
    const status = next.status === undefined ? filter : next.status;
    if (ticket !== null && ticket !== '') {
      search.set('ticket', ticket);
    }
    if (status !== null && status !== '') {
      search.set('status', status);
    }
    const query = search.toString();
    router.replace(query === '' ? '/admin/tickets' : `/admin/tickets?${query}`);
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-tickets'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-ticket', selected] }),
    ]);
  };

  const sendReply = useMutation({
    mutationFn: () =>
      api.post(`/admin/tickets/${selected ?? ''}/messages`, {
        body: { body: reply.trim(), internal },
      }),
    onSuccess: async () => {
      setReply('');
      await refresh();
    },
    onError: showError,
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      api.post(`/admin/tickets/${selected ?? ''}/assign`, { body: { staff_user_id: userId } }),
    onSuccess: refresh,
    onError: showError,
  });

  const update = useMutation({
    mutationFn: (body: { status?: string; priority?: string }) =>
      api.post(`/admin/tickets/${selected ?? ''}/status`, { body }),
    onSuccess: refresh,
    onError: showError,
  });

  const detail = thread.data;

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
      <div className="flex flex-col gap-3">
        <NativeSelect
          aria-label={t('filter')}
          value={filter}
          onChange={(event) => {
            navigate({ status: event.target.value, ticket: null });
          }}
        >
          <option value="">{t('allStatuses')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {ts(status)}
            </option>
          ))}
        </NativeSelect>
        <Card>
          <CardContent className="p-2">
            {queue.data.data.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-text-muted">{t('empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {queue.data.data.map((ticket) => (
                  <li key={ticket.id}>
                    <button
                      type="button"
                      onClick={() => {
                        navigate({ ticket: ticket.id });
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
                        {ticket.priority === 'URGENT' || ticket.priority === 'HIGH' ? (
                          <Badge tone={ticket.priority === 'URGENT' ? 'danger' : 'warning'}>
                            {tp(ticket.priority)}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-text-muted">
                        {ticket.workspace_name} · {ticket.reference}
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
          <CardContent className="flex flex-col gap-4 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-text">{detail.subject}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                  <span>{detail.reference}</span>
                  <span>·</span>
                  <span>{tcat(detail.category)}</span>
                  <span>·</span>
                  <Link
                    href={`/admin/tenants/${detail.tenant_id}`}
                    className="text-violet-text hover:underline"
                  >
                    {detail.workspace_name}
                  </Link>
                  {detail.opened_by === null ? null : (
                    <>
                      <span>·</span>
                      <span>{detail.opened_by}</span>
                    </>
                  )}
                </p>
              </div>
              {canManage ? (
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    aria-label={t('status')}
                    value={detail.status}
                    onChange={(event) => {
                      update.mutate({ status: event.target.value });
                    }}
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {ts(status)}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect
                    aria-label={t('priority')}
                    value={detail.priority}
                    onChange={(event) => {
                      update.mutate({ priority: event.target.value });
                    }}
                  >
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {tp(priority)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    size="sm"
                    variant={detail.assigned_staff_user_id === staffUserId ? 'ghost' : 'secondary'}
                    loading={assign.isPending}
                    onClick={() => {
                      assign.mutate(
                        detail.assigned_staff_user_id === staffUserId ? null : staffUserId,
                      );
                    }}
                  >
                    {detail.assigned_staff_user_id === staffUserId ? t('unassign') : t('assignMe')}
                  </Button>
                </div>
              ) : (
                <Badge tone={statusTone(detail.status)}>{ts(detail.status)}</Badge>
              )}
            </div>

            <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
              {detail.messages.map((message) => {
                const note = message.visibility === 'INTERNAL_NOTE';
                const fromStaff = message.author_kind === 'STAFF';
                return (
                  <div
                    key={message.id}
                    className={cn('flex flex-col gap-1', fromStaff ? 'items-end' : 'items-start')}
                  >
                    <div
                      className={cn(
                        'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm',
                        note
                          ? 'border border-dashed border-warning bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-warning-text'
                          : fromStaff
                            ? 'bg-pink-tint-strong text-pink-text'
                            : 'bg-surface-muted text-text',
                      )}
                    >
                      {message.body}
                    </div>
                    <span className="flex items-center gap-2 text-xs text-text-muted">
                      {note ? <Badge tone="warning">{t('internal')}</Badge> : null}
                      {message.author_label ?? message.author_kind} ·{' '}
                      {format.dateTime(new Date(message.created_at), {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>
                );
              })}
            </div>

            {canManage ? (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <Textarea
                  rows={3}
                  value={reply}
                  placeholder={internal ? t('notePlaceholder') : t('replyPlaceholder')}
                  aria-label={internal ? t('notePlaceholder') : t('replyPlaceholder')}
                  onChange={(event) => {
                    setReply(event.target.value);
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm text-text-muted">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(event) => {
                        setInternal(event.target.checked);
                      }}
                    />
                    {t('internalNote')}
                  </label>
                  <Button
                    size="sm"
                    loading={sendReply.isPending}
                    disabled={reply.trim().length === 0}
                    onClick={() => {
                      sendReply.mutate();
                    }}
                  >
                    {internal ? t('saveNote') : t('send')}
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
