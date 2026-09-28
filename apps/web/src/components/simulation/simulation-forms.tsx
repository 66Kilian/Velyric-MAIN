'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@velyric/ui';
import { Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  ASSERTION_TYPES,
  SCENARIO_CLASSES,
  type AssertionType,
  type ScenarioAssertion,
  type ScenarioClass,
  type SimulationRun,
  type SimulationScenario,
  type SimulationSuite,
} from '@/lib/api/simulation';

const TOOL = /^[a-z][a-z0-9_]{2,63}$/;
const KEY = /^[a-z0-9][a-z0-9_.-]{2,119}$/;
const CODE = /^[A-Z_]{4,30}$/;

function useSubmit() {
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setPending(true);
    try {
      await action();
      notify({ tone: 'success', title: success });
      router.refresh();
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

function FormDialog({
  trigger,
  title,
  submitLabel,
  disabled,
  pending,
  onSubmit,
  children,
  size = 'md',
}: {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSubmit: () => Promise<boolean>;
  readonly children: ReactNode;
  readonly size?: 'md' | 'lg';
}) {
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={title} closeLabel={tc('close')} size={size}>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onSubmit()) {
              setOpen(false);
            }
          }}
        >
          {children}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={pending || disabled}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SuiteDialog({
  workspaceId,
  agents,
  suite,
}: {
  readonly workspaceId: string;
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly suite?: SimulationSuite;
}) {
  const t = useTranslations('simulation.suite');
  const { pending, run } = useSubmit();
  const [agentId, setAgentId] = useState(suite?.agent_id ?? agents[0]?.id ?? '');
  const [name, setName] = useState(suite?.name ?? '');
  const [description, setDescription] = useState(suite?.description ?? '');
  const [gate, setGate] = useState(suite?.is_release_gate ?? true);
  const [ratio, setRatio] = useState(String(Math.round((suite?.min_pass_ratio ?? 1) * 100)));
  const ratioValue = Number(ratio);
  const valid =
    agentId !== '' &&
    name.trim() !== '' &&
    Number.isFinite(ratioValue) &&
    ratioValue >= 0 &&
    ratioValue <= 100;
  const submit = () => {
    const common = { name: name.trim(), is_release_gate: gate, min_pass_ratio: ratioValue / 100 };
    if (suite === undefined) {
      return run(
        () =>
          api.post('/simulation-suites', {
            workspace: workspaceId,
            body: {
              ...common,
              agent_id: agentId,
              ...(description.trim() === '' ? {} : { description: description.trim() }),
            },
          }),
        t('created'),
      );
    }
    return run(
      () =>
        api.patch(`/simulation-suites/${suite.id}`, {
          workspace: workspaceId,
          ifMatch: suite.version,
          body: { ...common, description: description.trim() === '' ? null : description.trim() },
        }),
      t('saved'),
    );
  };
  return (
    <FormDialog
      trigger={
        suite === undefined ? (
          <Button disabled={agents.length === 0}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('create')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {t('edit')}
          </Button>
        )
      }
      title={suite === undefined ? t('create') : t('edit')}
      submitLabel={suite === undefined ? t('create') : t('save')}
      disabled={!valid}
      pending={pending}
      onSubmit={submit}
    >
      {suite === undefined ? (
        <Field id="suite-agent" label={t('agent')} required>
          <NativeSelect
            id="suite-agent"
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
            }}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field id="suite-name" label={t('name')} required>
        <Input
          id="suite-name"
          value={name}
          maxLength={160}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field id="suite-description" label={t('description')}>
        <Textarea
          id="suite-description"
          rows={2}
          value={description}
          maxLength={1000}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={gate}
          onCheckedChange={(value) => {
            setGate(value === true);
          }}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium text-text">{t('releaseGate')}</span>
          <span className="text-text-muted">{t('releaseGateHint')}</span>
        </span>
      </label>
      <Field id="suite-ratio" label={t('passRatio')} hint={t('passRatioHint')}>
        <Input
          id="suite-ratio"
          type="number"
          min={0}
          max={100}
          value={ratio}
          onChange={(event) => {
            setRatio(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

interface AssertionDraft {
  type: AssertionType;
  value: string;
}

function draftOf(assertion: ScenarioAssertion): AssertionDraft {
  switch (assertion.type) {
    case 'OUTCOME_IN':
      return { type: assertion.type, value: assertion.values.join(',') };
    case 'INTENT_IS':
      return { type: assertion.type, value: assertion.value };
    case 'TOOL_CALLED':
    case 'TOOL_NOT_CALLED':
      return { type: assertion.type, value: assertion.tool };
    case 'PHRASE_PRESENT':
    case 'PHRASE_ABSENT':
      return { type: assertion.type, value: assertion.phrase };
    case 'MAX_AGENT_TURNS':
      return { type: assertion.type, value: String(assertion.value) };
    case 'TRANSFERRED':
    case 'NOT_TRANSFERRED':
      return { type: assertion.type, value: '' };
  }
}

function toAssertion(draft: AssertionDraft): ScenarioAssertion | null {
  const value = draft.value.trim();
  switch (draft.type) {
    case 'OUTCOME_IN': {
      const values = [
        ...new Set(
          value
            .split(',')
            .map((entry) => entry.trim().toUpperCase())
            .filter(Boolean),
        ),
      ];
      return values.length > 0 && values.every((entry) => CODE.test(entry))
        ? { type: draft.type, values }
        : null;
    }
    case 'INTENT_IS':
      return CODE.test(value.toUpperCase())
        ? { type: draft.type, value: value.toUpperCase() }
        : null;
    case 'TOOL_CALLED':
    case 'TOOL_NOT_CALLED':
      return TOOL.test(value) ? { type: draft.type, tool: value } : null;
    case 'PHRASE_PRESENT':
    case 'PHRASE_ABSENT':
      return value.length >= 1 && value.length <= 200 ? { type: draft.type, phrase: value } : null;
    case 'MAX_AGENT_TURNS': {
      const turns = Number(value);
      return Number.isInteger(turns) && turns >= 1 && turns <= 30
        ? { type: draft.type, value: turns }
        : null;
    }
    case 'TRANSFERRED':
    case 'NOT_TRANSFERRED':
      return { type: draft.type };
  }
}

function parseFacts(text: string): Record<string, string> | null {
  const facts: Record<string, string> = {};
  for (const line of text
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (separator <= 0 || !/^[a-z][a-z0-9_]{0,39}$/.test(key) || value.length > 200) {
      return null;
    }
    facts[key] = value;
  }
  return Object.keys(facts).length <= 20 ? facts : null;
}

function parseFixtures(text: string): unknown[] | null {
  if (text.trim() === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length <= 20 ? parsed : null;
  } catch {
    return null;
  }
}

export function ScenarioDialog({
  workspaceId,
  suiteId,
  scenario,
}: {
  readonly workspaceId: string;
  readonly suiteId: string;
  readonly scenario?: SimulationScenario;
}) {
  const t = useTranslations('simulation.scenario');
  const { pending, run } = useSubmit();
  const definition = scenario?.definition;
  const [key, setKey] = useState(scenario?.scenario_key ?? '');
  const [scenarioClass, setScenarioClass] = useState<ScenarioClass>(
    scenario?.scenario_class ?? 'HAPPY_PATH',
  );
  const [language, setLanguage] = useState<'hu' | 'de' | 'en'>(scenario?.language ?? 'hu');
  const [goal, setGoal] = useState(definition?.caller_goal ?? '');
  const [persona, setPersona] = useState(definition?.caller_persona ?? '');
  const [opening, setOpening] = useState(definition?.opening_line ?? '');
  const [facts, setFacts] = useState(
    Object.entries(definition?.caller_facts ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  );
  const [maxTurns, setMaxTurns] = useState(String(definition?.max_turns ?? 8));
  const [fixtures, setFixtures] = useState(
    definition?.tool_fixtures === undefined || definition.tool_fixtures.length === 0
      ? ''
      : JSON.stringify(definition.tool_fixtures, null, 2),
  );
  const [assertions, setAssertions] = useState<AssertionDraft[]>(
    (scenario?.deterministic_assertions ?? [{ type: 'NOT_TRANSFERRED' }]).map(draftOf),
  );
  const [active, setActive] = useState(scenario?.active ?? true);

  const parsedFacts = parseFacts(facts);
  const parsedFixtures = parseFixtures(fixtures);
  const parsedAssertions = assertions.map(toAssertion);
  const turns = Number(maxTurns);
  const valid =
    (scenario !== undefined || KEY.test(key)) &&
    goal.trim().length >= 1 &&
    opening.trim().length >= 1 &&
    Number.isInteger(turns) &&
    turns >= 2 &&
    turns <= 30 &&
    parsedFacts !== null &&
    parsedFixtures !== null &&
    parsedAssertions.every((entry) => entry !== null) &&
    assertions.length <= 20;

  const submit = () => {
    const body = {
      scenario_class: scenarioClass,
      language,
      definition: {
        caller_goal: goal.trim(),
        opening_line: opening.trim(),
        caller_facts: parsedFacts ?? {},
        max_turns: turns,
        ...(persona.trim() === '' ? {} : { caller_persona: persona.trim() }),
        ...(parsedFixtures === null || parsedFixtures.length === 0
          ? {}
          : { tool_fixtures: parsedFixtures }),
      },
      deterministic_assertions: parsedAssertions.filter(
        (entry): entry is ScenarioAssertion => entry !== null,
      ),
    };
    if (scenario === undefined) {
      return run(
        () =>
          api.post(`/simulation-suites/${suiteId}/scenarios`, {
            workspace: workspaceId,
            body: { ...body, scenario_key: key },
          }),
        t('created'),
      );
    }
    return run(
      () =>
        api.patch(`/simulation-scenarios/${scenario.id}`, {
          workspace: workspaceId,
          body: { ...body, active },
        }),
      t('saved'),
    );
  };

  return (
    <FormDialog
      trigger={
        scenario === undefined ? (
          <Button variant="secondary" size="sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('create')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {t('edit')}
          </Button>
        )
      }
      title={scenario === undefined ? t('create') : t('editTitle', { key: scenario.scenario_key })}
      submitLabel={scenario === undefined ? t('create') : t('save')}
      disabled={!valid}
      pending={pending}
      onSubmit={submit}
      size="lg"
    >
      <div className="grid gap-4 md:grid-cols-3">
        {scenario === undefined ? (
          <Field
            id="scenario-key"
            label={t('key')}
            hint={t('keyHint')}
            required
            error={key !== '' && !KEY.test(key) ? t('keyInvalid') : undefined}
          >
            <Input
              id="scenario-key"
              value={key}
              maxLength={120}
              spellCheck={false}
              onChange={(event) => {
                setKey(event.target.value.toLowerCase());
              }}
            />
          </Field>
        ) : null}
        <Field id="scenario-class" label={t('class')}>
          <NativeSelect
            id="scenario-class"
            value={scenarioClass}
            onChange={(event) => {
              setScenarioClass(event.target.value as ScenarioClass);
            }}
          >
            {SCENARIO_CLASSES.map((value) => (
              <option key={value} value={value}>
                {t(`classes.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="scenario-language" label={t('language')}>
          <NativeSelect
            id="scenario-language"
            value={language}
            onChange={(event) => {
              setLanguage(
                event.target.value === 'de' || event.target.value === 'en'
                  ? event.target.value
                  : 'hu',
              );
            }}
          >
            <option value="hu">Magyar</option>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </NativeSelect>
        </Field>
      </div>
      <Field id="scenario-goal" label={t('goal')} required>
        <Textarea
          id="scenario-goal"
          rows={2}
          value={goal}
          maxLength={500}
          onChange={(event) => {
            setGoal(event.target.value);
          }}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="scenario-opening" label={t('opening')} required>
          <Input
            id="scenario-opening"
            value={opening}
            maxLength={300}
            onChange={(event) => {
              setOpening(event.target.value);
            }}
          />
        </Field>
        <Field id="scenario-persona" label={t('persona')}>
          <Input
            id="scenario-persona"
            value={persona}
            maxLength={300}
            onChange={(event) => {
              setPersona(event.target.value);
            }}
          />
        </Field>
        <Field
          id="scenario-facts"
          label={t('facts')}
          hint={t('factsHint')}
          error={parsedFacts === null ? t('factsInvalid') : undefined}
        >
          <Textarea
            id="scenario-facts"
            rows={3}
            className="font-mono text-xs"
            value={facts}
            onChange={(event) => {
              setFacts(event.target.value);
            }}
          />
        </Field>
        <Field id="scenario-turns" label={t('maxTurns')}>
          <Input
            id="scenario-turns"
            type="number"
            min={2}
            max={30}
            value={maxTurns}
            onChange={(event) => {
              setMaxTurns(event.target.value);
            }}
          />
        </Field>
      </div>
      <Field
        id="scenario-fixtures"
        label={t('fixtures')}
        hint={t('fixturesHint')}
        error={parsedFixtures === null ? t('fixturesInvalid') : undefined}
      >
        <Textarea
          id="scenario-fixtures"
          rows={4}
          className="font-mono text-xs"
          spellCheck={false}
          value={fixtures}
          onChange={(event) => {
            setFixtures(event.target.value);
          }}
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[13px] font-medium text-text">{t('assertions')}</legend>
        {assertions.map((assertion, index) => {
          const needsValue =
            assertion.type !== 'TRANSFERRED' && assertion.type !== 'NOT_TRANSFERRED';
          return (
            <div key={String(index)} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
              <NativeSelect
                aria-label={t('assertionType')}
                value={assertion.type}
                onChange={(event) => {
                  setAssertions((current) =>
                    current.map((entry, position) =>
                      position === index
                        ? { type: event.target.value as AssertionType, value: '' }
                        : entry,
                    ),
                  );
                }}
              >
                {ASSERTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`assertionTypes.${value}`)}
                  </option>
                ))}
              </NativeSelect>
              {needsValue ? (
                <Input
                  aria-label={t('assertionValue')}
                  aria-invalid={parsedAssertions[index] === null}
                  value={assertion.value}
                  placeholder={t(`assertionPlaceholders.${assertion.type}`)}
                  onChange={(event) => {
                    setAssertions((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    );
                  }}
                />
              ) : (
                <span />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeAssertion')}
                onClick={() => {
                  setAssertions((current) => current.filter((_, position) => position !== index));
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={assertions.length >= 20}
          onClick={() => {
            setAssertions((current) => [...current, { type: 'TOOL_CALLED', value: '' }]);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('addAssertion')}
        </Button>
      </fieldset>
      {scenario === undefined ? null : (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={active}
            onCheckedChange={(value) => {
              setActive(value === true);
            }}
          />
          {t('active')}
        </label>
      )}
    </FormDialog>
  );
}

export function StartRunDialog({
  workspaceId,
  suiteId,
  versions,
  disabled,
}: {
  readonly workspaceId: string;
  readonly suiteId: string;
  readonly versions: readonly { readonly id: string; readonly label: string }[];
  readonly disabled: boolean;
}) {
  const t = useTranslations('simulation.run');
  const router = useRouter();
  const { pending, run } = useSubmit();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  return (
    <FormDialog
      trigger={
        <Button disabled={disabled || versions.length === 0}>
          <Play className="h-4 w-4" aria-hidden="true" />
          {t('start')}
        </Button>
      }
      title={t('startTitle')}
      submitLabel={t('start')}
      disabled={versionId === ''}
      pending={pending}
      onSubmit={() =>
        run(async () => {
          const created = await api.post<SimulationRun>(`/simulation-suites/${suiteId}/runs`, {
            workspace: workspaceId,
            body: { agent_version_id: versionId },
          });
          router.push(`/app/${workspaceId}/simulation/runs/${created.id}`);
        }, t('started'))
      }
    >
      <Field id="run-version" label={t('version')} hint={t('versionHint')}>
        <NativeSelect
          id="run-version"
          value={versionId}
          onChange={(event) => {
            setVersionId(event.target.value);
          }}
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </FormDialog>
  );
}

export function CancelRunButton({
  workspaceId,
  runId,
}: {
  readonly workspaceId: string;
  readonly runId: string;
}) {
  const t = useTranslations('simulation.run');
  const { run } = useSubmit();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary" size="sm">
          <Square className="h-4 w-4" aria-hidden="true" />
          {t('cancel')}
        </Button>
      }
      title={t('cancelTitle')}
      confirmLabel={t('cancel')}
      destructive
      onConfirm={() =>
        run(
          () => api.post(`/simulation-runs/${runId}/cancel`, { workspace: workspaceId }),
          t('canceled'),
        )
      }
    />
  );
}
