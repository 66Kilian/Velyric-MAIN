'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@velyric/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';

interface UsageRow {
  readonly metric: string;
  readonly quantity: number;
  readonly adjusted_quantity: number;
  readonly cost_usd_micros: number;
  readonly adjusted_cost_usd_micros: number;
  readonly event_count: number;
}

interface FinanceResponse {
  readonly balances: readonly { currency: string; balance_minor: number; entry_count: number }[];
  readonly entries: readonly {
    id: string;
    kind: string;
    amount_minor: number;
    currency: string;
    reason: string;
    staff_label: string | null;
    created_at: string | null;
  }[];
  readonly budget: {
    id: string;
    period_budget_usd_micros: number;
    consumed_usd_micros: number;
    daily_cap_usd_micros: number;
    monthly_cap_usd_micros: number;
    hard_cap_reached_at: string | null;
  } | null;
  readonly subscription: {
    status: string;
    plan_code: string;
    currency: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  readonly documents: readonly {
    id: string;
    document_type: string;
    status: string;
    invoice_number: string | null;
    total_minor: number;
    currency: string;
    issued_at: string | null;
  }[];
  readonly profile: {
    billing_email: string;
    legal_name: string;
    country: string;
    tax_number: string | null;
  } | null;
}

interface NumbersResponse {
  readonly numbers: readonly { id: string; e164: string; status: string; provider: string }[];
  readonly orders: readonly { id: string; status: string; provider: string }[];
  readonly provisioning: readonly {
    id: string;
    state: string;
    blocking_reason: string | null;
    manual_review_reason: string | null;
    attempt: number;
  }[];
}

interface SecretsResponse {
  readonly data: readonly {
    id: string;
    kind: string;
    provider: string;
    status: string;
    external_key_id: string | null;
    activated_at: string | null;
    revoked_at: string | null;
  }[];
}

const STATUSES = ['ACTIVE', 'RESTRICTED', 'SUSPENDED_ADMIN', 'SUSPENDED_RISK'] as const;
const BALANCE_KINDS = ['CREDIT', 'DEBIT', 'ADJUSTMENT', 'REFUND', 'GOODWILL'] as const;
const NUMBER_STATUSES = ['ACTIVE', 'SUSPENDED', 'RELEASE_PENDING'] as const;

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export function TenantWorkbench({
  tenantId,
  currentStatus,
  can,
}: {
  readonly tenantId: string;
  readonly currentStatus: string;
  readonly can: {
    readonly suspend: boolean;
    readonly usage: boolean;
    readonly balance: boolean;
    readonly billing: boolean;
    readonly numbers: boolean;
    readonly secrets: boolean;
  };
}) {
  const t = useTranslations('admin.workbench');
  const tc = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const showError = useApiErrorToast();
  const queryClient = useQueryClient();

  const [statusOpen, setStatusOpen] = useState(false);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('ACTIVE');
  const [statusReason, setStatusReason] = useState('');

  const [period, setPeriod] = useState<string | null>(null);
  const [metric, setMetric] = useState('');
  const [delta, setDelta] = useState('');
  const [deltaCost, setDeltaCost] = useState('');
  const [usageReason, setUsageReason] = useState('');

  const [kind, setKind] = useState<(typeof BALANCE_KINDS)[number]>('CREDIT');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('HUF');
  const [balanceReason, setBalanceReason] = useState('');

  const [budgetValue, setBudgetValue] = useState('');
  const [monthlyCap, setMonthlyCap] = useState('');
  const [budgetReason, setBudgetReason] = useState('');

  const usage = useQuery({
    queryKey: ['admin-usage', tenantId, period],
    queryFn: () =>
      api.get<{ period: string | null; periods: string[]; data: UsageRow[] }>(
        `/admin/tenants/${tenantId}/usage`,
        { query: period === null ? {} : { period } },
      ),
  });

  const finance = useQuery({
    queryKey: ['admin-finance', tenantId],
    queryFn: () => api.get<FinanceResponse>(`/admin/tenants/${tenantId}/finance`),
  });

  const numbers = useQuery({
    queryKey: ['admin-numbers', tenantId],
    queryFn: () => api.get<NumbersResponse>(`/admin/tenants/${tenantId}/numbers`),
  });

  const secrets = useQuery({
    queryKey: ['admin-secrets', tenantId],
    queryFn: () => api.get<SecretsResponse>(`/admin/tenants/${tenantId}/secrets`),
    enabled: can.secrets,
  });

  const changeStatus = useMutation({
    mutationFn: () =>
      api.post(`/admin/tenants/${tenantId}/status`, {
        body: { status, reason: statusReason.trim() },
      }),
    onSuccess: () => {
      setStatusOpen(false);
      setStatusReason('');
      router.refresh();
    },
    onError: showError,
  });

  const adjustUsage = useMutation({
    mutationFn: () =>
      api.post(`/admin/tenants/${tenantId}/usage-adjustments`, {
        body: {
          billing_period_start: usage.data?.period ?? new Date().toISOString(),
          metric: metric.trim(),
          delta_quantity: Number(delta),
          ...(deltaCost === '' ? {} : { delta_cost_usd_micros: Number(deltaCost) }),
          reason: usageReason.trim(),
        },
      }),
    onSuccess: async () => {
      setMetric('');
      setDelta('');
      setDeltaCost('');
      setUsageReason('');
      await queryClient.invalidateQueries({ queryKey: ['admin-usage', tenantId] });
    },
    onError: showError,
  });

  const addBalance = useMutation({
    mutationFn: () =>
      api.post(`/admin/tenants/${tenantId}/balance-entries`, {
        body: {
          kind,
          amount_minor: Math.round(Number(amount) * 100),
          currency,
          reason: balanceReason.trim(),
        },
      }),
    onSuccess: async () => {
      setAmount('');
      setBalanceReason('');
      await queryClient.invalidateQueries({ queryKey: ['admin-finance', tenantId] });
    },
    onError: showError,
  });

  const updateBudget = useMutation({
    mutationFn: (clearHardCap: boolean) =>
      api.patch(`/admin/tenants/${tenantId}/budget`, {
        body: {
          ...(budgetValue === ''
            ? {}
            : { period_budget_usd_micros: Math.round(Number(budgetValue) * 1_000_000) }),
          ...(monthlyCap === ''
            ? {}
            : { monthly_cap_usd_micros: Math.round(Number(monthlyCap) * 1_000_000) }),
          ...(clearHardCap ? { clear_hard_cap: true } : {}),
          reason: budgetReason.trim() === '' ? t('budgetDefaultReason') : budgetReason.trim(),
        },
      }),
    onSuccess: async () => {
      setBudgetValue('');
      setMonthlyCap('');
      setBudgetReason('');
      await queryClient.invalidateQueries({ queryKey: ['admin-finance', tenantId] });
    },
    onError: showError,
  });

  const setNumberStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      api.post(`/admin/tenants/${tenantId}/numbers/${input.id}/status`, {
        body: { status: input.status, reason: t('numberStatusReason') },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-numbers', tenantId] });
    },
    onError: showError,
  });

  const revokeSecret = useMutation({
    mutationFn: (id: string) =>
      api.post(`/admin/tenants/${tenantId}/secrets/${id}/revoke`, {
        body: { reason: t('secretRevokeReason') },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-secrets', tenantId] });
    },
    onError: showError,
  });

  return (
    <Tabs defaultValue="usage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList aria-label={t('tabs')}>
          <TabsTrigger value="usage">{t('usage')}</TabsTrigger>
          <TabsTrigger value="finance">{t('finance')}</TabsTrigger>
          <TabsTrigger value="numbers">{t('numbers')}</TabsTrigger>
          {can.secrets ? <TabsTrigger value="secrets">{t('secrets')}</TabsTrigger> : null}
        </TabsList>
        {can.suspend ? (
          <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="secondary">
                {t('changeStatus')}
              </Button>
            </DialogTrigger>
            <DialogContent
              title={t('changeStatus')}
              description={t('changeStatusBody', { status: currentStatus })}
              closeLabel={tc('actions.close')}
            >
              <div className="flex flex-col gap-4">
                <Field id="tenant-status" label={t('newStatus')}>
                  <NativeSelect
                    id="tenant-status"
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value as (typeof STATUSES)[number]);
                    }}
                  >
                    {STATUSES.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  id="tenant-status-reason"
                  label={t('reason')}
                  hint={t('reasonHint')}
                  required
                >
                  <Input
                    id="tenant-status-reason"
                    value={statusReason}
                    onChange={(event) => {
                      setStatusReason(event.target.value);
                    }}
                  />
                </Field>
                <Button
                  loading={changeStatus.isPending}
                  disabled={statusReason.trim().length < 10}
                  onClick={() => {
                    changeStatus.mutate();
                  }}
                >
                  {tc('actions.save')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <TabsContent value="usage" className="pt-4">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{t('usage')}</CardTitle>
              {usage.data === undefined || usage.data.periods.length === 0 ? null : (
                <NativeSelect
                  aria-label={t('period')}
                  value={period ?? usage.data.period ?? ''}
                  onChange={(event) => {
                    setPeriod(event.target.value);
                  }}
                >
                  {usage.data.periods.map((entry) => (
                    <option key={entry} value={entry}>
                      {format.dateTime(new Date(entry), { dateStyle: 'medium' })}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
            {usage.data === undefined || usage.data.data.length === 0 ? (
              <p className="text-sm text-text-muted">{t('noUsage')}</p>
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('metric')}</Th>
                    <Th>{t('measured')}</Th>
                    <Th>{t('effective')}</Th>
                    <Th>{t('cost')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {usage.data.data.map((row) => (
                    <Tr key={row.metric}>
                      <Td>{row.metric}</Td>
                      <Td className="tabular-nums">{row.quantity.toLocaleString()}</Td>
                      <Td className="tabular-nums">
                        {row.adjusted_quantity.toLocaleString()}
                        {row.adjusted_quantity === row.quantity ? null : (
                          <Badge tone="warning" className="ml-2">
                            {t('adjusted')}
                          </Badge>
                        )}
                      </Td>
                      <Td className="tabular-nums">{usd(row.adjusted_cost_usd_micros)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
            {can.usage ? (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <CardTitle>{t('adjustUsage')}</CardTitle>
                <p className="text-sm text-text-muted">{t('adjustUsageHint')}</p>
                <div className="grid gap-3 md:grid-cols-4">
                  <Field id="usage-metric" label={t('metric')}>
                    <Input
                      id="usage-metric"
                      value={metric}
                      placeholder="billable_voice_seconds"
                      onChange={(event) => {
                        setMetric(event.target.value);
                      }}
                    />
                  </Field>
                  <Field id="usage-delta" label={t('delta')}>
                    <Input
                      id="usage-delta"
                      inputMode="numeric"
                      value={delta}
                      onChange={(event) => {
                        setDelta(event.target.value);
                      }}
                    />
                  </Field>
                  <Field id="usage-delta-cost" label={t('deltaCost')}>
                    <Input
                      id="usage-delta-cost"
                      inputMode="numeric"
                      value={deltaCost}
                      onChange={(event) => {
                        setDeltaCost(event.target.value);
                      }}
                    />
                  </Field>
                  <Field id="usage-reason" label={t('reason')}>
                    <Input
                      id="usage-reason"
                      value={usageReason}
                      onChange={(event) => {
                        setUsageReason(event.target.value);
                      }}
                    />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    loading={adjustUsage.isPending}
                    disabled={
                      metric.trim() === '' ||
                      delta.trim() === '' ||
                      Number.isNaN(Number(delta)) ||
                      usageReason.trim().length < 10
                    }
                    onClick={() => {
                      adjustUsage.mutate();
                    }}
                  >
                    {t('record')}
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="finance" className="pt-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('balance')}</CardTitle>
              {finance.data === undefined || finance.data.balances.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noBalance')}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {finance.data.balances.map((row) => (
                    <li key={row.currency} className="flex items-center justify-between">
                      <span className="text-text-muted">{row.currency}</span>
                      <span className="font-semibold tabular-nums text-text">
                        {money(row.balance_minor, row.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {can.balance ? (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field id="balance-kind" label={t('kind')}>
                      <NativeSelect
                        id="balance-kind"
                        value={kind}
                        onChange={(event) => {
                          setKind(event.target.value as (typeof BALANCE_KINDS)[number]);
                        }}
                      >
                        {BALANCE_KINDS.map((entry) => (
                          <option key={entry} value={entry}>
                            {t(`kinds.${entry}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field id="balance-amount" label={t('amount')}>
                      <Input
                        id="balance-amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                        }}
                      />
                    </Field>
                    <Field id="balance-currency" label={t('currency')}>
                      <NativeSelect
                        id="balance-currency"
                        value={currency}
                        onChange={(event) => {
                          setCurrency(event.target.value);
                        }}
                      >
                        {['HUF', 'EUR', 'USD'].map((entry) => (
                          <option key={entry} value={entry}>
                            {entry}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </div>
                  <Field id="balance-reason" label={t('reason')} hint={t('reasonHint')}>
                    <Input
                      id="balance-reason"
                      value={balanceReason}
                      onChange={(event) => {
                        setBalanceReason(event.target.value);
                      }}
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      loading={addBalance.isPending}
                      disabled={
                        amount.trim() === '' ||
                        Number.isNaN(Number(amount)) ||
                        Number(amount) === 0 ||
                        balanceReason.trim().length < 10
                      }
                      onClick={() => {
                        addBalance.mutate();
                      }}
                    >
                      {t('record')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('budget')}</CardTitle>
              {finance.data?.budget === null || finance.data?.budget === undefined ? (
                <p className="text-sm text-text-muted">{t('noBudget')}</p>
              ) : (
                <>
                  <ul className="flex flex-col gap-1 text-sm">
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('budgetAmount')}</span>
                      <span className="tabular-nums">
                        {usd(finance.data.budget.period_budget_usd_micros)}
                      </span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('consumed')}</span>
                      <span className="tabular-nums">
                        {usd(finance.data.budget.consumed_usd_micros)}
                      </span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-text-muted">{t('monthlyCap')}</span>
                      <span className="tabular-nums">
                        {usd(finance.data.budget.monthly_cap_usd_micros)}
                      </span>
                    </li>
                    {finance.data.budget.hard_cap_reached_at === null ? null : (
                      <li className="flex justify-between">
                        <span className="text-text-muted">{t('hardCap')}</span>
                        <Badge tone="danger">{t('hardCapReached')}</Badge>
                      </li>
                    )}
                  </ul>
                  {can.billing ? (
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field id="budget-amount" label={t('budgetAmountUsd')}>
                          <Input
                            id="budget-amount"
                            inputMode="decimal"
                            value={budgetValue}
                            onChange={(event) => {
                              setBudgetValue(event.target.value);
                            }}
                          />
                        </Field>
                        <Field id="budget-monthly" label={t('monthlyCapUsd')}>
                          <Input
                            id="budget-monthly"
                            inputMode="decimal"
                            value={monthlyCap}
                            onChange={(event) => {
                              setMonthlyCap(event.target.value);
                            }}
                          />
                        </Field>
                      </div>
                      <Field id="budget-reason" label={t('reason')}>
                        <Input
                          id="budget-reason"
                          value={budgetReason}
                          onChange={(event) => {
                            setBudgetReason(event.target.value);
                          }}
                        />
                      </Field>
                      <div className="flex flex-wrap justify-end gap-2">
                        {finance.data.budget.hard_cap_reached_at === null ? null : (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={updateBudget.isPending}
                            onClick={() => {
                              updateBudget.mutate(true);
                            }}
                          >
                            {t('clearHardCap')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          loading={updateBudget.isPending}
                          disabled={budgetValue === '' && monthlyCap === ''}
                          onClick={() => {
                            updateBudget.mutate(false);
                          }}
                        >
                          {tc('actions.save')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('ledger')}</CardTitle>
              {finance.data === undefined || finance.data.entries.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noEntries')}</p>
              ) : (
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('when')}</Th>
                      <Th>{t('kind')}</Th>
                      <Th>{t('amount')}</Th>
                      <Th>{t('reason')}</Th>
                      <Th>{t('who')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {finance.data.entries.map((entry) => (
                      <Tr key={entry.id}>
                        <Td>
                          {entry.created_at === null
                            ? '—'
                            : format.dateTime(new Date(entry.created_at), {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
                        </Td>
                        <Td>{t(`kinds.${entry.kind}`)}</Td>
                        <Td className="tabular-nums">
                          {money(entry.amount_minor, entry.currency)}
                        </Td>
                        <Td>{entry.reason}</Td>
                        <Td>{entry.staff_label ?? '—'}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('invoices')}</CardTitle>
              {finance.data === undefined || finance.data.documents.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noInvoices')}</p>
              ) : (
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('number')}</Th>
                      <Th>{t('type')}</Th>
                      <Th>{t('state')}</Th>
                      <Th>{t('amount')}</Th>
                      <Th>{t('issued')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {finance.data.documents.map((doc) => (
                      <Tr key={doc.id}>
                        <Td>{doc.invoice_number ?? '—'}</Td>
                        <Td>{doc.document_type}</Td>
                        <Td>{doc.status}</Td>
                        <Td className="tabular-nums">{money(doc.total_minor, doc.currency)}</Td>
                        <Td>
                          {doc.issued_at === null
                            ? '—'
                            : format.dateTime(new Date(doc.issued_at), { dateStyle: 'short' })}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="numbers" className="pt-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('numbers')}</CardTitle>
              {numbers.data === undefined || numbers.data.numbers.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noNumbers')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {numbers.data.numbers.map((number) => (
                    <li
                      key={number.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="font-medium tabular-nums">{number.e164}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone={number.status === 'ACTIVE' ? 'success' : 'neutral'}>
                          {number.status}
                        </Badge>
                        {can.numbers && number.status !== 'RELEASED' ? (
                          <NativeSelect
                            aria-label={t('numberStatus')}
                            value={number.status}
                            onChange={(event) => {
                              setNumberStatus.mutate({
                                id: number.id,
                                status: event.target.value,
                              });
                            }}
                          >
                            {NUMBER_STATUSES.map((entry) => (
                              <option key={entry} value={entry}>
                                {entry}
                              </option>
                            ))}
                          </NativeSelect>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('provisioning')}</CardTitle>
              {numbers.data === undefined || numbers.data.provisioning.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noProvisioning')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {numbers.data.provisioning.map((flow) => (
                    <li key={flow.id} className="flex flex-col gap-1 py-2">
                      <span className="font-medium">{flow.state}</span>
                      {flow.manual_review_reason === null ? null : (
                        <span className="text-xs text-warning-text">
                          {flow.manual_review_reason}
                        </span>
                      )}
                      {flow.blocking_reason === null ? null : (
                        <span className="text-xs text-text-muted">{flow.blocking_reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      {can.secrets ? (
        <TabsContent value="secrets" className="pt-4">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <CardTitle>{t('secrets')}</CardTitle>
              <p className="text-sm text-text-muted">{t('secretsHint')}</p>
              {secrets.data === undefined || secrets.data.data.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noSecrets')}</p>
              ) : (
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('secretKind')}</Th>
                      <Th>{t('state')}</Th>
                      <Th>{t('keyId')}</Th>
                      <Th> </Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {secrets.data.data.map((secret) => (
                      <Tr key={secret.id}>
                        <Td>{secret.kind}</Td>
                        <Td>
                          <Badge tone={secret.status === 'ACTIVE' ? 'success' : 'neutral'}>
                            {secret.status}
                          </Badge>
                        </Td>
                        <Td className="font-mono text-xs">{secret.external_key_id ?? '—'}</Td>
                        <Td>
                          {secret.status === 'REVOKED' ? null : (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={revokeSecret.isPending}
                              onClick={() => {
                                revokeSecret.mutate(secret.id);
                              }}
                            >
                              {t('revoke')}
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
