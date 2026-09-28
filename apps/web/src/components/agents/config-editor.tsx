'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type { AgentLocale } from '@velyric/contracts';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Field,
  Input,
  Label,
  NativeSelect,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@velyric/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, type FieldErrors, type Path } from 'react-hook-form';
import { useApiErrorToast, validationIssues } from '@/components/common/use-api-error';
import { agentConfigSchema, type AgentConfigForm } from '@/lib/agent-config-schema';
import { disclosureVersion, languageDefaults } from '@/lib/agent-defaults';
import { api } from '@/lib/api-client';
import type { AgentVersionDetail, ToolOption } from '@/lib/api/agents';

const LOCALES: readonly AgentLocale[] = ['hu', 'de', 'en'];
const VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;
const PERSONA_TRAITS = [
  'warmth',
  'formality',
  'energy',
  'pace',
  'brevity',
  'empathy',
  'humor',
  'assertiveness',
] as const;
const SPECIALIST_KINDS = [
  'RECEPTION_ROUTER',
  'BOOKING',
  'SUPPORT',
  'SALES',
  'BILLING',
  'HANDOFF_COMPLIANCE',
] as const;
const READ_ONLY_KINDS = new Set(['RECEPTION_ROUTER', 'SUPPORT']);

function errorAt(errors: FieldErrors<AgentConfigForm>, path: string): string | undefined {
  let cursor: unknown = errors;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (
    typeof cursor === 'object' &&
    cursor !== null &&
    typeof (cursor as { message?: unknown }).message === 'string'
  ) {
    return (cursor as { message: string }).message;
  }
  return undefined;
}

export function AgentConfigEditor({
  workspaceId,
  agentId,
  businessName,
  initial,
  basedOnVersionId,
  tools,
  timeZones,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly businessName: string;
  readonly initial: AgentConfigForm;
  readonly basedOnVersionId: string | null;
  readonly tools: readonly ToolOption[];
  readonly timeZones: readonly string[];
  readonly canWrite: boolean;
}) {
  const t = useTranslations('agents.editor');
  const te = useTranslations('enums');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [summary, setSummary] = useState('');
  const [serverIssues, setServerIssues] = useState<readonly string[]>([]);
  const form = useForm<AgentConfigForm>({
    resolver: zodResolver(agentConfigSchema),
    defaultValues: initial,
    mode: 'onBlur',
  });
  const { register, control, handleSubmit, watch, setValue, getValues, setError, formState } = form;
  const destinations = useFieldArray({ control, name: 'handoff.destinations' });
  const hours = useFieldArray({ control, name: 'business_hours' });
  const languages = watch('languages');
  const specialists = watch('specialists');
  const destinationLabels = watch('handoff.destinations')
    .map((destination) => destination.label)
    .filter((value) => /^[a-z0-9_-]{2,40}$/.test(value));
  const afterHours = watch('after_hours.behavior');
  const overloadPolicy = watch('overload.policy');
  const message = (path: string) => {
    const code = errorAt(formState.errors, path);
    if (code === undefined) {
      return undefined;
    }
    return /^[a-z0-9_]+$/.test(code) && t.has(`rules.${code}`)
      ? t(`rules.${code}`)
      : t('rules.invalid');
  };

  const toolsByName = useMemo(() => new Map(tools.map((tool) => [tool.name, tool])), [tools]);

  const toggleLanguage = (locale: AgentLocale, enabled: boolean) => {
    const current = getValues('languages');
    if (enabled) {
      const defaults = languageDefaults(locale, businessName);
      setValue(
        'languages',
        [
          ...current,
          {
            locale,
            greeting: defaults.greeting,
            fallback: defaults.fallback,
            closing: defaults.closing,
          },
        ],
        { shouldDirty: true },
      );
      if (getValues(`disclosure.texts.${locale}`) === undefined) {
        setValue(`disclosure.texts.${locale}`, defaults.disclosure, { shouldDirty: true });
      }
    } else if (current.length > 1) {
      setValue(
        'languages',
        current.filter((entry) => entry.locale !== locale),
        { shouldDirty: true },
      );
      if (getValues('default_locale') === locale) {
        setValue(
          'default_locale',
          current.find((entry) => entry.locale !== locale)?.locale ?? 'hu',
          { shouldDirty: true },
        );
      }
    }
  };

  const toggleSpecialist = (kind: (typeof SPECIALIST_KINDS)[number], enabled: boolean) => {
    const current = getValues('specialists');
    const existing = current.findIndex((specialist) => specialist.kind === kind);
    if (existing >= 0) {
      setValue(`specialists.${existing}.enabled`, enabled, { shouldDirty: true });
      return;
    }
    if (enabled && current.length < 6) {
      setValue(
        'specialists',
        [
          ...current,
          {
            kind,
            enabled: true,
            tool_allowlist: [],
            max_tool_executions: 0,
            model_tier: 'ROUTINE',
          },
        ],
        { shouldDirty: true },
      );
    }
  };

  const toggleTool = (index: number, name: string, enabled: boolean) => {
    const allowlist = getValues(`specialists.${index}.tool_allowlist`);
    setValue(
      `specialists.${index}.tool_allowlist`,
      enabled ? [...allowlist, name] : allowlist.filter((entry) => entry !== name),
      { shouldDirty: true },
    );
  };

  const submit = handleSubmit(async (values) => {
    setServerIssues([]);
    const initialTexts = JSON.stringify(initial.disclosure.texts);
    const config: AgentConfigForm =
      JSON.stringify(values.disclosure.texts) === initialTexts
        ? values
        : {
            ...values,
            disclosure: {
              ...values.disclosure,
              version: disclosureVersion(new Date(), values.disclosure.version),
            },
          };
    try {
      const created = await api.post<AgentVersionDetail>(`/agents/${agentId}/versions`, {
        workspace: workspaceId,
        body: {
          config,
          ...(summary.trim() === '' ? {} : { change_summary: summary.trim() }),
          ...(basedOnVersionId === null ? {} : { based_on_version_id: basedOnVersionId }),
        },
      });
      notify({ tone: 'success', title: t('saved', { version: created.version_number }) });
      router.push(`/app/${workspaceId}/agents/${agentId}/versions`);
      router.refresh();
    } catch (error) {
      const issues = validationIssues(error);
      if (issues.length > 0) {
        const unmatched: string[] = [];
        for (const issue of issues) {
          const path = issue.path
            .replace(/^\/body\/config\//, '')
            .split('/')
            .join('.');
          if (issue.path.startsWith('/body/config/')) {
            setError(path as Path<AgentConfigForm>, { type: 'server', message: issue.rule });
          }
          unmatched.push(
            `${path}: ${/^[a-z0-9_]+$/.test(issue.rule) && t.has(`rules.${issue.rule}`) ? t(`rules.${issue.rule}`) : issue.rule}`,
          );
        }
        setServerIssues(unmatched);
      }
      showError(error);
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {serverIssues.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-surface px-4 py-3 text-sm text-danger-text"
        >
          <p className="font-semibold">{t('serverIssues')}</p>
          <ul className="mt-1 list-disc pl-5">
            {serverIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Tabs defaultValue="voice">
        <TabsList>
          <TabsTrigger value="voice">{t('tabs.voice')}</TabsTrigger>
          <TabsTrigger value="behavior">{t('tabs.behavior')}</TabsTrigger>
          <TabsTrigger value="handoff">{t('tabs.handoff')}</TabsTrigger>
          <TabsTrigger value="hours">{t('tabs.hours')}</TabsTrigger>
        </TabsList>

        <TabsContent value="voice" className="pt-4">
          <Card>
            <CardContent className="flex flex-col gap-5 pt-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Field id="voice" label={t('voice')}>
                  <NativeSelect id="voice" {...register('voice')}>
                    {VOICES.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  id="default_locale"
                  label={t('defaultLanguage')}
                  error={message('default_locale')}
                >
                  <NativeSelect id="default_locale" {...register('default_locale')}>
                    {languages.map((language) => (
                      <option key={language.locale} value={language.locale}>
                        {t(`locales.${language.locale}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-[13px] font-medium text-text">{t('languages')}</legend>
                <div className="flex flex-wrap gap-4">
                  {LOCALES.map((locale) => {
                    const checked = languages.some((language) => language.locale === locale);
                    return (
                      <label key={locale} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          disabled={checked && languages.length === 1}
                          onCheckedChange={(value) => {
                            toggleLanguage(locale, value === true);
                          }}
                        />
                        {t(`locales.${locale}`)}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {languages.map((language, index) => (
                <div
                  key={language.locale}
                  className="flex flex-col gap-3 rounded-lg border border-border p-4"
                >
                  <p className="text-sm font-semibold text-text">
                    {t(`locales.${language.locale}`)}
                  </p>
                  <Field
                    id={`greeting-${language.locale}`}
                    label={t('greeting')}
                    error={message(`languages.${String(index)}.greeting`)}
                  >
                    <Textarea
                      id={`greeting-${language.locale}`}
                      lang={language.locale}
                      rows={2}
                      {...register(`languages.${index}.greeting`)}
                    />
                  </Field>
                  <Field
                    id={`fallback-${language.locale}`}
                    label={t('fallback')}
                    error={message(`languages.${String(index)}.fallback`)}
                  >
                    <Textarea
                      id={`fallback-${language.locale}`}
                      lang={language.locale}
                      rows={2}
                      {...register(`languages.${index}.fallback`)}
                    />
                  </Field>
                  <Field
                    id={`closing-${language.locale}`}
                    label={t('closing')}
                    error={message(`languages.${String(index)}.closing`)}
                  >
                    <Textarea
                      id={`closing-${language.locale}`}
                      lang={language.locale}
                      rows={2}
                      {...register(`languages.${index}.closing`)}
                    />
                  </Field>
                  <Field
                    id={`disclosure-${language.locale}`}
                    label={t('disclosure')}
                    hint={t('disclosureHint')}
                    error={message(`disclosure.texts.${language.locale}`)}
                  >
                    <Textarea
                      id={`disclosure-${language.locale}`}
                      lang={language.locale}
                      rows={2}
                      {...register(`disclosure.texts.${language.locale}`)}
                    />
                  </Field>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="behavior" className="flex flex-col gap-4 pt-4">
          <Card>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
              {PERSONA_TRAITS.map((trait) => (
                <Controller
                  key={trait}
                  control={control}
                  name={`persona.${trait}`}
                  render={({ field }) => (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-[13px]">
                        <Label htmlFor={`persona-${trait}`}>{t(`persona.${trait}`)}</Label>
                        <span className="tabular-nums text-text-muted">{field.value}</span>
                      </div>
                      <input
                        id={`persona-${trait}`}
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={field.value}
                        onChange={(event) => {
                          field.onChange(Number(event.target.value));
                        }}
                        className="accent-[var(--pink)]"
                      />
                    </div>
                  )}
                />
              ))}
            </CardContent>
          </Card>
          {SPECIALIST_KINDS.map((kind) => {
            const index = specialists.findIndex((specialist) => specialist.kind === kind);
            const specialist = index >= 0 ? specialists[index] : undefined;
            const enabled = specialist?.enabled === true;
            return (
              <Card key={kind}>
                <CardContent className="flex flex-col gap-4 pt-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-text">{t(`specialists.${kind}.title`)}</p>
                      <p className="text-sm text-text-muted">
                        {t(`specialists.${kind}.description`)}
                      </p>
                    </div>
                    <Switch
                      checked={enabled}
                      disabled={kind === 'RECEPTION_ROUTER'}
                      onCheckedChange={(value) => {
                        toggleSpecialist(kind, value);
                      }}
                      aria-label={t(`specialists.${kind}.title`)}
                    />
                  </div>
                  {specialist !== undefined && enabled ? (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Field
                          id={`tier-${kind}`}
                          label={t('modelTier')}
                          error={message(`specialists.${String(index)}.model_tier`)}
                        >
                          <NativeSelect
                            id={`tier-${kind}`}
                            {...register(`specialists.${index}.model_tier`)}
                          >
                            {(['ROUTINE', 'COMPLEX', 'ESCALATION', 'FRONTIER'] as const).map(
                              (tier) => (
                                <option key={tier} value={tier}>
                                  {t(`tiers.${tier}`)}
                                </option>
                              ),
                            )}
                          </NativeSelect>
                        </Field>
                        <Field
                          id={`max-tools-${kind}`}
                          label={t('maxToolExecutions')}
                          error={message(`specialists.${String(index)}.max_tool_executions`)}
                        >
                          <Input
                            id={`max-tools-${kind}`}
                            type="number"
                            min={0}
                            max={50}
                            {...register(`specialists.${index}.max_tool_executions`, {
                              valueAsNumber: true,
                            })}
                          />
                        </Field>
                      </div>
                      {kind === 'HANDOFF_COMPLIANCE' ? null : (
                        <fieldset>
                          <legend className="mb-2 text-[13px] font-medium text-text">
                            {t('tools')}
                          </legend>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {tools.map((tool) => {
                              const blocked =
                                READ_ONLY_KINDS.has(kind) && tool.sideEffectClass !== 'READ';
                              const checked = specialist.tool_allowlist.includes(tool.name);
                              return (
                                <label key={tool.name} className="flex items-center gap-2 text-sm">
                                  <Checkbox
                                    checked={checked}
                                    disabled={blocked && !checked}
                                    onCheckedChange={(value) => {
                                      toggleTool(index, tool.name, value === true);
                                    }}
                                  />
                                  <span className="font-mono text-xs">{tool.name}</span>
                                  <span className="text-xs text-text-muted">
                                    {te(`toolSideEffectClass.${tool.sideEffectClass}`)}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                          {specialist.tool_allowlist
                            .filter((name) => !toolsByName.has(name))
                            .map((name) => (
                              <p key={name} className="mt-2 text-xs text-warning-text">
                                {t('unknownTool', { name })}
                              </p>
                            ))}
                        </fieldset>
                      )}
                    </>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>{t('complexEscalation')}</span>
                <Controller
                  control={control}
                  name="model_routing.complex_escalation_enabled"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>{t('premiumReasoning')}</span>
                <Controller
                  control={control}
                  name="model_routing.premium_reasoning_enabled"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>{t('recording')}</span>
                <Controller
                  control={control}
                  name="recording.enabled"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </label>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="handoff" className="flex flex-col gap-4 pt-4">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-text">{t('destinations')}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={destinations.fields.length >= 20}
                  onClick={() => {
                    destinations.append({ label: '', e164: '', description: '' });
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('addDestination')}
                </Button>
              </div>
              {destinations.fields.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noDestinations')}</p>
              ) : null}
              {destinations.fields.map((field, index) => (
                <div
                  key={field.id}
                  className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end"
                >
                  <Field
                    id={`dest-label-${field.id}`}
                    label={t('destinationLabel')}
                    error={message(`handoff.destinations.${String(index)}.label`)}
                  >
                    <Input
                      id={`dest-label-${field.id}`}
                      {...register(`handoff.destinations.${index}.label`)}
                      placeholder="reception"
                    />
                  </Field>
                  <Field
                    id={`dest-phone-${field.id}`}
                    label={t('destinationPhone')}
                    error={message(`handoff.destinations.${String(index)}.e164`)}
                  >
                    <Input
                      id={`dest-phone-${field.id}`}
                      type="tel"
                      inputMode="tel"
                      {...register(`handoff.destinations.${index}.e164`)}
                      placeholder="+36"
                    />
                  </Field>
                  <Field
                    id={`dest-desc-${field.id}`}
                    label={t('destinationDescription')}
                    error={message(`handoff.destinations.${String(index)}.description`)}
                  >
                    <Input
                      id={`dest-desc-${field.id}`}
                      {...register(`handoff.destinations.${index}.description`)}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      destinations.remove(index);
                    }}
                    aria-label={t('removeDestination')}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {message('handoff.destinations') === undefined ? null : (
                <p className="text-sm text-danger-text">{message('handoff.destinations')}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
              <Field
                id="default-destination"
                label={t('defaultDestination')}
                error={message('handoff.default_destination_label')}
              >
                <Controller
                  control={control}
                  name="handoff.default_destination_label"
                  render={({ field }) => (
                    <NativeSelect
                      id="default-destination"
                      value={field.value ?? ''}
                      onChange={(event) => {
                        field.onChange(event.target.value === '' ? undefined : event.target.value);
                      }}
                    >
                      <option value="">{t('none')}</option>
                      {destinationLabels.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                />
              </Field>
              <Field
                id="failed-understandings"
                label={t('failedUnderstandings')}
                error={message('handoff.failed_understandings_before_offer')}
              >
                <Input
                  id="failed-understandings"
                  type="number"
                  min={1}
                  max={5}
                  {...register('handoff.failed_understandings_before_offer', {
                    valueAsNumber: true,
                  })}
                />
              </Field>
              <Field id="no-answer" label={t('noAnswer')}>
                <NativeSelect id="no-answer" {...register('handoff.no_answer_behavior')}>
                  {(['RETURN_TO_AI', 'CALLBACK_REQUEST', 'ALTERNATE_QUEUE'] as const).map(
                    (value) => (
                      <option key={value} value={value}>
                        {t(`noAnswerOptions.${value}`)}
                      </option>
                    ),
                  )}
                </NativeSelect>
              </Field>
              <label className="flex items-center justify-between gap-4 self-end text-sm">
                <span>{t('warmTransfer')}</span>
                <Controller
                  control={control}
                  name="handoff.warm_transfer"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </label>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-3">
              <Field id="overload-policy" label={t('overloadPolicy')}>
                <NativeSelect id="overload-policy" {...register('overload.policy')}>
                  {(
                    [
                      'SHORT_QUEUE',
                      'HUMAN_OVERFLOW',
                      'CALLBACK_REQUEST',
                      'VOICEMAIL',
                      'PAID_BURST',
                      'DEGRADED_MESSAGE',
                    ] as const
                  ).map((value) => (
                    <option key={value} value={value}>
                      {t(`overloadOptions.${value}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                id="overload-wait"
                label={t('maxWait')}
                error={message('overload.max_wait_seconds')}
              >
                <Input
                  id="overload-wait"
                  type="number"
                  min={0}
                  max={300}
                  {...register('overload.max_wait_seconds', { valueAsNumber: true })}
                />
              </Field>
              {overloadPolicy === 'HUMAN_OVERFLOW' ? (
                <Field
                  id="overflow-destination"
                  label={t('overflowDestination')}
                  error={message('overload.overflow_destination_label')}
                >
                  <Controller
                    control={control}
                    name="overload.overflow_destination_label"
                    render={({ field }) => (
                      <NativeSelect
                        id="overflow-destination"
                        value={field.value ?? ''}
                        onChange={(event) => {
                          field.onChange(
                            event.target.value === '' ? undefined : event.target.value,
                          );
                        }}
                      >
                        <option value="">{t('none')}</option>
                        {destinationLabels.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  />
                </Field>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hours" className="flex flex-col gap-4 pt-4">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              <Field id="timezone" label={t('timezone')} error={message('timezone')}>
                <NativeSelect id="timezone" {...register('timezone')}>
                  {timeZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-text">{t('businessHours')}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={hours.fields.length >= 21}
                  onClick={() => {
                    hours.append({ iso_weekday: 1, opens: '09:00', closes: '17:00' });
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('addHours')}
                </Button>
              </div>
              {hours.fields.length === 0 ? (
                <p className="text-sm text-text-muted">{t('alwaysClosed')}</p>
              ) : null}
              {hours.fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3">
                  <Field id={`day-${field.id}`} label={t('weekday')}>
                    <NativeSelect
                      id={`day-${field.id}`}
                      {...register(`business_hours.${index}.iso_weekday`, { valueAsNumber: true })}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                        <option key={day} value={day}>
                          {t(`weekdays.${String(day)}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field
                    id={`opens-${field.id}`}
                    label={t('opens')}
                    error={message(`business_hours.${String(index)}`)}
                  >
                    <Input
                      id={`opens-${field.id}`}
                      type="time"
                      {...register(`business_hours.${index}.opens`)}
                    />
                  </Field>
                  <Field id={`closes-${field.id}`} label={t('closes')}>
                    <Input
                      id={`closes-${field.id}`}
                      type="time"
                      {...register(`business_hours.${index}.closes`)}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      hours.remove(index);
                    }}
                    aria-label={t('removeHours')}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <div className="grid gap-4 md:grid-cols-2">
                <Field id="after-hours" label={t('afterHours')}>
                  <NativeSelect id="after-hours" {...register('after_hours.behavior')}>
                    {(['TAKE_MESSAGE', 'CALLBACK_REQUEST', 'TRANSFER_ON_CALL'] as const).map(
                      (value) => (
                        <option key={value} value={value}>
                          {t(`afterHoursOptions.${value}`)}
                        </option>
                      ),
                    )}
                  </NativeSelect>
                </Field>
                {afterHours === 'TRANSFER_ON_CALL' ? (
                  <Field
                    id="on-call"
                    label={t('onCallDestination')}
                    error={message('after_hours.on_call_destination_label')}
                  >
                    <Controller
                      control={control}
                      name="after_hours.on_call_destination_label"
                      render={({ field }) => (
                        <NativeSelect
                          id="on-call"
                          value={field.value ?? ''}
                          onChange={(event) => {
                            field.onChange(
                              event.target.value === '' ? undefined : event.target.value,
                            );
                          }}
                        >
                          <option value="">{t('none')}</option>
                          {destinationLabels.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    />
                  </Field>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
              <Field
                id="max-duration"
                label={t('maxDuration')}
                error={message('limits.max_call_duration_seconds')}
              >
                <Input
                  id="max-duration"
                  type="number"
                  min={60}
                  max={3600}
                  step={30}
                  {...register('limits.max_call_duration_seconds', { valueAsNumber: true })}
                />
              </Field>
              <Field
                id="silence-timeout"
                label={t('silenceTimeout')}
                error={message('limits.silence_timeout_seconds')}
              >
                <Input
                  id="silence-timeout"
                  type="number"
                  min={5}
                  max={60}
                  {...register('limits.silence_timeout_seconds', { valueAsNumber: true })}
                />
              </Field>
              <Field
                id="max-tools-call"
                label={t('maxToolsPerCall')}
                error={message('limits.max_tool_executions_per_call')}
              >
                <Input
                  id="max-tools-call"
                  type="number"
                  min={0}
                  max={100}
                  {...register('limits.max_tool_executions_per_call', { valueAsNumber: true })}
                />
              </Field>
              <Field
                id="max-spend"
                label={t('maxSpend')}
                hint={t('maxSpendHint')}
                error={message('limits.max_spend_usd_micros_per_call')}
              >
                <Controller
                  control={control}
                  name="limits.max_spend_usd_micros_per_call"
                  render={({ field }) => (
                    <Input
                      id="max-spend"
                      type="number"
                      min={0}
                      max={50}
                      step={0.1}
                      value={field.value / 1_000_000}
                      onChange={(event) => {
                        field.onChange(Math.round(Number(event.target.value) * 1_000_000));
                      }}
                    />
                  )}
                />
              </Field>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {canWrite ? (
        <Card className="sticky bottom-4 z-10 shadow-float">
          <CardContent className="flex flex-col gap-3 pt-5 md:flex-row md:items-end">
            <Field id="change-summary" label={t('changeSummary')} className="flex-1">
              <Input
                id="change-summary"
                value={summary}
                maxLength={500}
                onChange={(event) => {
                  setSummary(event.target.value);
                }}
              />
            </Field>
            <Button
              type="submit"
              loading={formState.isSubmitting}
              disabled={formState.isSubmitting}
            >
              {t('saveDraft')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </form>
  );
}
