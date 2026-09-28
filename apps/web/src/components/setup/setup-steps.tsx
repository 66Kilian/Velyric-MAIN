'use client';

import type { AgentLocale } from '@velyric/contracts';
import {
  Button,
  Field,
  Input,
  NativeSelect,
  Switch,
  Textarea,
  VelyricLogo,
  cn,
  useToast,
} from '@velyric/ui';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileText,
  Globe,
  Loader2,
  Mic,
  Pause,
  PhoneOff,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ACCEPTED_FILE_TYPES } from '@/components/knowledge/upload';
import type { PhoneNumber } from '@/lib/api/agents';
import type { ConnectorType, Integration } from '@/lib/api/integrations';
import type { KnowledgeSource } from '@/lib/api/knowledge';
import { RUN_ACTIVE, type SimulationRun } from '@/lib/api/simulation';
import {
  ADDRESSING,
  AFTER_HOURS,
  CONVERSATION_STYLES,
  DURATIONS,
  NO_ANSWER,
  PACES,
  RECOMMENDED_PERSONA,
  VOICE_PERSONAS,
  normalizePhone,
  parseAddress,
  personaName,
  personaOf,
  setupScenarios,
  suggestedGreeting,
  type Addressing,
  type HoursRow,
  type Pace,
  type SetupDraft,
  type SetupStep,
  type VoicePersonaKey,
  CREDENTIAL_ERRORS,
  type Activation,
} from '@/lib/setup';
import type { WebCallState } from '@/lib/web-call';
import {
  CheckBadge,
  Collapsible,
  InfoNote,
  Panel,
  Pill,
  SelectableCard,
  VoiceOrb,
} from './setup-ui';

export const LIVE_INTEGRATION_STATUSES: ReadonlySet<string> = new Set(['CONNECTED', 'DEGRADED']);
export const SOURCE_IN_FLIGHT: ReadonlySet<string> = new Set([
  'PENDING_UPLOAD',
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
]);
const CALENDARS: readonly { readonly type: ConnectorType; readonly letter: string }[] = [
  { type: 'GOOGLE_CALENDAR', letter: 'G' },
  { type: 'MICROSOFT_365', letter: 'M' },
];
const BUFFERS = [0, 10, 15, 30, 60] as const;
const CANCELLATION_HOURS = [0, 2, 12, 24, 48] as const;
const CALL_MINUTES = [5, 10, 15, 20, 30, 45, 60] as const;

export interface SetupUpload {
  readonly name: string;
  readonly state: 'uploading' | 'done' | 'failed';
}

export interface SetupContext {
  readonly workspaceId: string;
  readonly timezone: string;
  readonly country: string;
  readonly website: KnowledgeSource | null;
  readonly websiteChunks: number | null;
  readonly uploads: readonly SetupUpload[];
  readonly integrations: readonly Integration[];
  readonly phoneNumbers: readonly PhoneNumber[];
  readonly run: SimulationRun | null;
  readonly scenarioKeys: Readonly<Record<string, string>>;
  readonly testing: boolean;
  readonly busy: boolean;
  readonly onUpload: (file: File) => void;
  readonly onResync: () => void;
  readonly onConnectCalendar: (type: ConnectorType) => void;
  readonly onStartTest: () => void;
  readonly onGoTo: (step: SetupStep) => void;
  readonly activation: Activation;
  readonly webCall: WebCallState;
  readonly webCallEnabled: boolean;
  readonly onStartWebCall: () => void;
  readonly onStopWebCall: () => void;
}

export interface StepProps {
  readonly draft: SetupDraft;
  readonly update: (patch: Partial<SetupDraft>) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly ctx: SetupContext;
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function weekdayName(day: number, locale: string): string {
  return capitalize(
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, day)),
    ),
  );
}

export function hoursSummary(hours: readonly HoursRow[], locale: string): string[] {
  const groups: { from: number; to: number; opens: string; closes: string }[] = [];
  for (const row of hours) {
    if (!row.open) {
      continue;
    }
    const last = groups.at(-1);
    if (
      last !== undefined &&
      last.to === row.iso_weekday - 1 &&
      last.opens === row.opens &&
      last.closes === row.closes
    ) {
      last.to = row.iso_weekday;
    } else {
      groups.push({
        from: row.iso_weekday,
        to: row.iso_weekday,
        opens: row.opens,
        closes: row.closes,
      });
    }
  }
  return groups.map((group) => {
    const days =
      group.from === group.to
        ? weekdayName(group.from, locale)
        : `${weekdayName(group.from, locale)}–${weekdayName(group.to, locale).toLocaleLowerCase()}`;
    return `${days} · ${group.opens}–${group.closes}`;
  });
}

function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

type PreviewState = 'idle' | 'loading' | 'playing';

function PreviewIcon({ state }: { readonly state: PreviewState }) {
  if (state === 'loading') {
    return (
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    );
  }
  return state === 'playing' ? (
    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
  ) : (
    <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
  );
}

function useVoicePreview() {
  const t = useTranslations('onboarding.setup.voice');
  const { notify } = useToast();
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const urlsRef = useRef(new Map<string, string>());
  const stop = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    setLoading(null);
    setPlaying(null);
  }, []);
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      stop();
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, [stop]);
  const start = (id: string, url: string) => {
    const audio = new Audio(url);
    const finish = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlaying(null);
      }
    };
    audioRef.current = audio;
    audio.onended = finish;
    setPlaying(id);
    void audio.play().catch(finish);
  };
  const play = (
    id: string,
    options: {
      readonly voice: string;
      readonly locale: AgentLocale;
      readonly pace: Pace;
      readonly text: string;
    },
  ) => {
    if (playing === id || loading === id) {
      stop();
      return;
    }
    stop();
    const text = options.text.trim();
    const key = JSON.stringify([options.voice, options.locale, options.pace, text]);
    const cached = urlsRef.current.get(key);
    if (cached !== undefined) {
      start(id, cached);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(id);
    void (async () => {
      try {
        const response = await fetch('/api/voice-preview', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...options, text }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`voice_preview_${String(response.status)}`);
        }
        const url = URL.createObjectURL(await response.blob());
        urlsRef.current.set(key, url);
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoading(null);
          start(id, url);
        }
      } catch {
        if (!controller.signal.aborted) {
          requestRef.current = null;
          setLoading(null);
          notify({ tone: 'error', title: t('previewUnavailable') });
        }
      }
    })();
  };
  const stateOf = (id: string): PreviewState =>
    loading === id ? 'loading' : playing === id ? 'playing' : 'idle';
  return { loading, play, stateOf };
}

function StepHeading({ title, body }: { readonly title: string; readonly body?: string }) {
  return (
    <div>
      <h2 className="text-[18px] font-semibold text-text">{title}</h2>
      {body === undefined ? null : <p className="mt-1 text-sm text-text-muted">{body}</p>}
    </div>
  );
}

export function BusinessStep({ draft, update, errors, ctx }: StepProps) {
  const t = useTranslations('onboarding.setup.business');
  const tl = useTranslations('onboarding.setup.languages');
  const persona = personaOf(draft.persona);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-6">
        <Field id="setup-name" label={t('name')} error={errors['businessName']} required>
          <Input
            id="setup-name"
            value={draft.businessName}
            maxLength={120}
            autoComplete="organization"
            onChange={(event) => {
              update({ businessName: event.target.value });
            }}
          />
        </Field>
        <Field
          id="setup-website"
          label={t('website')}
          hint={t('websiteHint')}
          error={errors['website']}
        >
          <Input
            id="setup-website"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={draft.website}
            onChange={(event) => {
              update({ website: event.target.value });
            }}
          />
        </Field>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-4 text-[18px] font-semibold text-text">{t('goals')}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectableCard
              selected={draft.reception}
              onClick={() => {
                update({ reception: !draft.reception });
              }}
              title={t('reception')}
              description={t('receptionHint')}
            />
            <SelectableCard
              selected={draft.bookings}
              onClick={() => {
                update({ bookings: !draft.bookings });
              }}
              title={t('bookings')}
              description={t('bookingsHint')}
            />
          </div>
          {errors['goals'] === undefined ? null : (
            <p role="alert" className="text-sm text-danger-text">
              {errors['goals']}
            </p>
          )}
        </fieldset>
        <Field
          id="setup-address"
          label={t('address')}
          hint={t('addressHint')}
          error={errors['address']}
        >
          <Input
            id="setup-address"
            value={draft.address}
            maxLength={300}
            autoComplete="street-address"
            placeholder={t('addressPlaceholder')}
            onChange={(event) => {
              update({ address: event.target.value });
            }}
          />
        </Field>
      </div>
      <Panel className="flex h-fit flex-col gap-4 p-7 md:p-7">
        <VoiceOrb tone={persona.orb} size={112} className="mx-auto my-2" />
        <h2 className="text-[20px] font-semibold text-text">{t('asideTitle')}</h2>
        <p className="text-sm text-text-muted">{t('asideBody')}</p>
        <ul className="flex flex-col gap-3 border-t border-border pt-5 text-sm text-text">
          {[tl(draft.defaultLocale), t('timezone', { zone: ctx.timezone }), t('editableLater')].map(
            (item) => (
              <li key={item} className="flex items-center gap-2">
                <Check className="h-4 w-4 shrink-0 text-pink-text" aria-hidden="true" />
                {item}
              </li>
            ),
          )}
        </ul>
      </Panel>
    </div>
  );
}

export function VoiceStep({ draft, update }: StepProps) {
  const t = useTranslations('onboarding.setup.voice');
  const tl = useTranslations('onboarding.setup.languages');
  const preview = useVoicePreview();
  const locale = draft.defaultLocale;
  const count = VOICE_PERSONAS.length;
  const index = Math.max(
    0,
    VOICE_PERSONAS.findIndex((entry) => entry.key === draft.persona),
  );
  const at = (offset: number) =>
    VOICE_PERSONAS[(index + offset + count) % count] ?? VOICE_PERSONAS[0];
  const current = at(0);
  const previous = at(-1);
  const next = at(1);
  const greetingText =
    draft.greeting.trim() === ''
      ? suggestedGreeting(locale, draft.businessName, current.key, draft.addressing)
      : draft.greeting;
  const greetingFor = (persona: VoicePersonaKey, addressing: Addressing) =>
    draft.greetingEdited
      ? {}
      : { greeting: suggestedGreeting(locale, draft.businessName, persona, addressing) };
  const select = (persona: VoicePersonaKey) => {
    update({ persona, ...greetingFor(persona, draft.addressing) });
  };
  return (
    <div className="flex flex-col gap-7">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-muted">
        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-pink-text" aria-hidden="true" />
        <span>{t('anyLanguage', { language: tl(draft.defaultLocale) })}</span>
      </p>
      <Panel className="relative flex flex-col items-center gap-5 px-3 py-7 md:px-8">
        <span className="rounded-full border border-pink/40 bg-pink-tint px-4 py-1 text-[12px] font-medium uppercase tracking-wide text-text">
          {current.key === RECOMMENDED_PERSONA
            ? t('recommended')
            : t(`personas.${current.key}.tag`)}
        </span>
        <div
          className="flex w-full items-center justify-between gap-2"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              select(previous.key);
            } else if (event.key === 'ArrowRight') {
              select(next.key);
            }
          }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => {
              select(previous.key);
            }}
            className="hidden w-32 flex-col items-center gap-3 md:flex"
          >
            <VoiceOrb tone={previous.orb} size={92} muted />
            <span className="text-[15px] text-text-muted">{personaName(previous.key, locale)}</span>
          </button>
          <button
            type="button"
            aria-label={t('previous')}
            onClick={() => {
              select(previous.key);
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-text transition-colors hover:border-pink/50"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-col items-center text-center" aria-live="polite">
            <VoiceOrb key={current.key} tone={current.orb} size={196} />
            <p className="mt-3 text-[28px] font-bold leading-tight text-text">
              {personaName(current.key, locale)}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {t(`personas.${current.key}.description`)}
            </p>
            <button
              type="button"
              onClick={() => {
                preview.play(current.key, {
                  voice: current.voice,
                  locale,
                  pace: draft.pace,
                  text: greetingText,
                });
              }}
              aria-busy={preview.loading === current.key}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-full border border-pink/40 bg-pink-tint px-5 text-[13px] text-text transition-colors hover:bg-pink-tint-strong"
            >
              <PreviewIcon state={preview.stateOf(current.key)} />
              {preview.stateOf(current.key) === 'idle' ? t('listen') : t('stop')}
            </button>
          </div>
          <button
            type="button"
            aria-label={t('next')}
            onClick={() => {
              select(next.key);
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-text transition-colors hover:border-pink/50"
          >
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => {
              select(next.key);
            }}
            className="hidden w-32 flex-col items-center gap-3 md:flex"
          >
            <VoiceOrb tone={next.orb} size={92} muted />
            <span className="text-[15px] text-text-muted">{personaName(next.key, locale)}</span>
          </button>
        </div>
        <div
          className="flex flex-wrap items-center justify-center gap-1.5"
          role="radiogroup"
          aria-label={t('allVoices')}
        >
          {VOICE_PERSONAS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="radio"
              aria-checked={entry.key === current.key}
              aria-label={personaName(entry.key, locale)}
              onClick={() => {
                select(entry.key);
              }}
              className={cn(
                'rounded-full p-1 ring-2 transition-shadow',
                entry.key === current.key ? 'ring-pink' : 'ring-transparent hover:ring-border',
              )}
            >
              <VoiceOrb tone={entry.orb} size={22} />
            </button>
          ))}
        </div>
        <span className="text-[12px] tabular-nums text-text-muted md:absolute md:bottom-6 md:right-8">
          {index + 1} / {count}
        </span>
      </Panel>
      <div className="flex flex-col gap-4">
        <StepHeading title={t('styleTitle')} />
        <div className="flex flex-wrap gap-2">
          {CONVERSATION_STYLES.map((style) => (
            <Pill
              key={style}
              selected={draft.style === style}
              onClick={() => {
                update({ style });
              }}
            >
              {t(`styles.${style}`)}
            </Pill>
          ))}
        </div>
      </div>
      <Collapsible label={t('fineTune')}>
        <div className="flex flex-col gap-2">
          <Field id="setup-greeting" label={t('greeting')}>
            <Textarea
              id="setup-greeting"
              rows={3}
              maxLength={500}
              value={draft.greeting}
              onChange={(event) => {
                update({ greeting: event.target.value, greetingEdited: true });
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => {
                preview.play('greeting', {
                  voice: current.voice,
                  locale,
                  pace: draft.pace,
                  text: greetingText,
                });
              }}
              aria-busy={preview.loading === 'greeting'}
              className="inline-flex items-center gap-2 text-[13px] font-medium text-pink-text hover:underline"
            >
              <PreviewIcon state={preview.stateOf('greeting')} />
              {preview.stateOf('greeting') === 'idle' ? t('listenGreeting') : t('stop')}
            </button>
            {draft.greetingEdited ? (
              <button
                type="button"
                onClick={() => {
                  update({
                    greetingEdited: false,
                    greeting: suggestedGreeting(
                      locale,
                      draft.businessName,
                      draft.persona,
                      draft.addressing,
                    ),
                  });
                }}
                className="text-[13px] text-text-muted hover:text-text"
              >
                {t('resetGreeting')}
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text">{t('addressing')}</p>
          <div className="flex flex-wrap gap-2">
            {ADDRESSING.map((addressing) => (
              <Pill
                key={addressing}
                selected={draft.addressing === addressing}
                onClick={() => {
                  update({ addressing, ...greetingFor(draft.persona, addressing) });
                }}
              >
                {t(`addressingOptions.${addressing}`)}
              </Pill>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text">{t('pace')}</p>
          <div className="flex flex-wrap gap-2">
            {PACES.map((pace) => (
              <Pill
                key={pace}
                selected={draft.pace === pace}
                onClick={() => {
                  update({ pace });
                }}
              >
                {t(`paces.${pace}`)}
              </Pill>
            ))}
          </div>
        </div>
        <InfoNote title={t('transparencyTitle')} body={t('transparencyBody')} />
      </Collapsible>
    </div>
  );
}

function HoursEditor({
  hours,
  onChange,
}: {
  readonly hours: readonly HoursRow[];
  readonly onChange: (hours: HoursRow[]) => void;
}) {
  const t = useTranslations('onboarding.setup.knowledge');
  const locale = useLocale();
  const set = (day: number, patch: Partial<HoursRow>) => {
    onChange(hours.map((row) => (row.iso_weekday === day ? { ...row, ...patch } : row)));
  };
  const monday = hours.find((row) => row.iso_weekday === 1);
  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-4">
      {hours.map((row) => {
        const name = weekdayName(row.iso_weekday, locale);
        return (
          <div key={row.iso_weekday} className="flex flex-wrap items-center gap-3">
            <Switch
              checked={row.open}
              aria-label={name}
              onCheckedChange={(open) => {
                set(row.iso_weekday, { open });
              }}
            />
            <span className="w-24 text-sm text-text">{name}</span>
            {row.open ? (
              <span className="flex items-center gap-2">
                <Input
                  type="time"
                  aria-label={t('opens', { day: name })}
                  className="w-28"
                  value={row.opens}
                  onChange={(event) => {
                    set(row.iso_weekday, { opens: event.target.value });
                  }}
                />
                <span className="text-text-muted">–</span>
                <Input
                  type="time"
                  aria-label={t('closes', { day: name })}
                  className="w-28"
                  value={row.closes}
                  onChange={(event) => {
                    set(row.iso_weekday, { closes: event.target.value });
                  }}
                />
              </span>
            ) : (
              <span className="text-sm text-text-muted">{t('closed')}</span>
            )}
          </div>
        );
      })}
      {monday?.open === true ? (
        <button
          type="button"
          onClick={() => {
            onChange(
              hours.map((row) =>
                row.iso_weekday <= 5
                  ? { ...row, open: true, opens: monday.opens, closes: monday.closes }
                  : row,
              ),
            );
          }}
          className="w-fit text-[13px] font-medium text-pink-text hover:underline"
        >
          {t('copyMonday')}
        </button>
      ) : null}
    </div>
  );
}

function ReviewRow({
  title,
  value,
  done,
  open,
  onToggle,
  children,
}: {
  readonly title: string;
  readonly value: string;
  readonly done: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations('onboarding.setup.knowledge');
  return (
    <div className="rounded-2xl border border-border bg-surface px-5 py-4">
      <div className="flex items-center gap-4">
        {done ? (
          <Check
            className="h-4 w-4 shrink-0 text-success-text"
            strokeWidth={3}
            aria-hidden="true"
          />
        ) : (
          <CircleAlert className="h-4 w-4 shrink-0 text-warning-text" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-text">{title}</p>
          <p className="mt-1 truncate text-sm text-text-muted">{value}</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="text-[13px] font-medium text-pink-text hover:underline"
        >
          {open ? t('done') : t('edit')}
        </button>
      </div>
      {open ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

export function KnowledgeStep({ draft, update, errors, ctx }: StepProps) {
  const t = useTranslations('onboarding.setup.knowledge');
  const locale = useLocale();
  const format = useFormatter();
  const [editing, setEditing] = useState<'hours' | 'address' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const website = ctx.website;
  const websiteState =
    website === null
      ? 'none'
      : website.status === 'ACTIVE' || website.status === 'READY'
        ? 'ready'
        : SOURCE_IN_FLIGHT.has(website.status)
          ? 'processing'
          : website.last_error_code === 'embedding_credentials_missing' ||
              website.last_error_code === 'embedding_credentials_unavailable'
            ? 'waiting'
            : 'failed';
  const websiteDetail =
    websiteState === 'ready' && ctx.websiteChunks !== null && website?.last_synced_at
      ? t('websiteMeta', {
          chunks: ctx.websiteChunks,
          when: format.relativeTime(new Date(website.last_synced_at)),
        })
      : websiteState === 'waiting'
        ? t('websiteWaiting')
        : websiteState === 'failed'
          ? t('websiteFailed')
          : t('websiteProcessing');
  const summary = hoursSummary(draft.hours, locale);
  const sample = draft.qa.find(
    (pair) => pair.question.trim().length >= 3 && pair.answer.trim() !== '',
  );
  const name = personaName(draft.persona, draft.defaultLocale);
  const toggle = (value: 'hours' | 'address') => {
    setEditing((currentValue) => (currentValue === value ? null : value));
  };
  const setQa = (index: number, patch: { question?: string; answer?: string }) => {
    update({
      qa: draft.qa.map((pair, position) => (position === index ? { ...pair, ...patch } : pair)),
    });
  };
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-6">
        <Panel className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-text">{t('website')}</h2>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]',
                websiteState === 'failed'
                  ? 'border-danger/40 text-danger-text'
                  : 'border-border text-text',
              )}
            >
              {websiteState === 'processing' || websiteState === 'waiting' ? (
                <Loader2
                  className="h-3 w-3 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : websiteState === 'ready' ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : null}
              {t(`websiteStatus.${websiteState}`)}
            </span>
          </div>
          {website === null ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-text-muted">{t('noWebsite')}</p>
              <button
                type="button"
                onClick={() => {
                  ctx.onGoTo('business');
                }}
                className="text-[13px] font-medium text-pink-text hover:underline"
              >
                {t('addWebsite')}
              </button>
            </div>
          ) : (
            <>
              <p className="break-all text-[15px] text-text">{website.uri}</p>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-text-muted">
                <span className={cn(websiteState === 'failed' && 'text-danger-text')}>
                  {websiteDetail}
                </span>
                <button
                  type="button"
                  disabled={websiteState === 'processing' || ctx.busy}
                  onClick={ctx.onResync}
                  className="inline-flex items-center gap-1 font-medium text-pink-text hover:underline disabled:opacity-50"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  {t('resync')}
                </button>
              </div>
            </>
          )}
        </Panel>
        <StepHeading title={t('reviewTitle')} />
        <div className="-mt-2 flex flex-col gap-3">
          <ReviewRow
            title={t('hours')}
            value={summary.length === 0 ? t('noHours') : summary.join(', ')}
            done={summary.length > 0}
            open={editing === 'hours'}
            onToggle={() => {
              toggle('hours');
            }}
          >
            <HoursEditor
              hours={draft.hours}
              onChange={(hours) => {
                update({ hours });
              }}
            />
          </ReviewRow>
          <ReviewRow
            title={t('location')}
            value={draft.address.trim() === '' ? t('noAddress') : draft.address}
            done={parseAddress(draft.address) !== null}
            open={editing === 'address'}
            onToggle={() => {
              toggle('address');
            }}
          >
            <Field id="setup-knowledge-address" label={t('location')} error={errors['address']}>
              <Input
                id="setup-knowledge-address"
                value={draft.address}
                maxLength={300}
                onChange={(event) => {
                  update({ address: event.target.value });
                }}
              />
            </Field>
          </ReviewRow>
        </div>
        {draft.qa.length === 0 ? null : (
          <div className="flex flex-col gap-3">
            <StepHeading title={t('qaTitle')} body={t('qaBody')} />
            {draft.qa.map((pair, position) => (
              <div
                key={position}
                className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={t('question')}
                    placeholder={t('questionPlaceholder')}
                    maxLength={1000}
                    value={pair.question}
                    onChange={(event) => {
                      setQa(position, { question: event.target.value });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('removeQa')}
                    onClick={() => {
                      update({ qa: draft.qa.filter((_, index) => index !== position) });
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                <Textarea
                  aria-label={t('answer')}
                  placeholder={t('answerPlaceholder')}
                  rows={2}
                  maxLength={8000}
                  value={pair.answer}
                  onChange={(event) => {
                    setQa(position, { answer: event.target.value });
                  }}
                />
              </div>
            ))}
            {errors['qa'] === undefined ? null : (
              <p role="alert" className="text-sm text-danger-text">
                {errors['qa']}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={ctx.busy}
            onClick={() => fileRef.current?.click()}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('uploadFile')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={draft.qa.length >= 50}
            onClick={() => {
              update({ qa: [...draft.qa, { question: '', answer: '' }] });
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('addQa')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept={ACCEPTED_FILE_TYPES}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) {
                ctx.onUpload(file);
              }
            }}
          />
        </div>
        {ctx.uploads.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {ctx.uploads.map((upload, position) => (
              <li
                key={`${upload.name}-${String(position)}`}
                className="flex items-center gap-2 text-sm"
              >
                <FileText className="h-4 w-4 text-text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-text">{upload.name}</span>
                <span
                  className={cn(
                    'text-[12px]',
                    upload.state === 'failed' ? 'text-danger-text' : 'text-text-muted',
                  )}
                >
                  {t(`uploadState.${upload.state}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Panel className="flex h-fit flex-col gap-5">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-text">
          {t('previewTitle')}
        </p>
        <div className="rounded-xl border border-border bg-surface-muted px-4 py-4 text-[15px] text-text">
          „{sample?.question ?? t('sampleQuestion')}”
        </div>
        <div className="rounded-xl border border-border px-4 py-4">
          <p className="text-sm font-medium text-pink-text">{name}</p>
          <p className="mt-2 text-[15px] leading-relaxed text-text">
            „
            {sample?.answer ??
              (summary.length === 0
                ? t('sampleAnswerUnknown')
                : t('sampleAnswer', { hours: summary.join('; ') }))}
            ”
          </p>
        </div>
        <p className="text-[13px] text-text-muted">{t('previewNote')}</p>
        <p className="text-[11px] text-text-muted">{t('previewIllustrative')}</p>
      </Panel>
    </div>
  );
}

export function BookingStep({ draft, update, errors, ctx }: StepProps) {
  const t = useTranslations('onboarding.setup.bookings');
  if (!draft.bookings) {
    return (
      <Panel className="flex flex-col items-start gap-3">
        <h2 className="text-[18px] font-semibold text-text">{t('disabledTitle')}</h2>
        <p className="text-sm text-text-muted">{t('disabledBody')}</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            update({ bookings: true });
          }}
        >
          {t('enable')}
        </Button>
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-7">
      <StepHeading title={t('calendarTitle')} body={t('calendarBody')} />
      <div className="-mt-2 grid gap-4 md:grid-cols-2">
        {CALENDARS.map(({ type, letter }) => {
          const integration = ctx.integrations.find(
            (entry) =>
              entry.integration_type === type && LIVE_INTEGRATION_STATUSES.has(entry.status),
          );
          return (
            <div
              key={type}
              className={cn(
                'flex items-center gap-4 rounded-2xl border p-5',
                integration === undefined
                  ? 'border-border bg-surface'
                  : 'border-pink/50 bg-pink-tint',
              )}
            >
              <span
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-[22px] font-bold text-violet-text"
                aria-hidden="true"
              >
                {letter}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold text-text">{t(`providers.${type}.name`)}</p>
                <p
                  className={cn(
                    'mt-1 text-[13px]',
                    integration === undefined ? 'text-text-muted' : 'text-success-text',
                  )}
                >
                  {integration === undefined ? t(`providers.${type}.hint`) : t('connected')}
                </p>
              </div>
              {integration === undefined ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={ctx.busy}
                  onClick={() => {
                    ctx.onConnectCalendar(type);
                  }}
                >
                  {t('connect')}
                </Button>
              ) : (
                <Check className="h-5 w-5 text-success-text" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      <p className="-mt-3 text-[13px] text-text-muted">{t('calendarOptional')}</p>
      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        <Field id="setup-service" label={t('service')} error={errors['serviceName']} required>
          <Input
            id="setup-service"
            maxLength={160}
            placeholder={t('servicePlaceholder')}
            value={draft.serviceName}
            onChange={(event) => {
              update({ serviceName: event.target.value });
            }}
          />
        </Field>
        <Field id="setup-duration" label={t('duration')}>
          <NativeSelect
            id="setup-duration"
            value={String(draft.durationMinutes)}
            onChange={(event) => {
              update({ durationMinutes: Number(event.target.value) });
            }}
          >
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('minutes', { count: minutes })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="setup-party-min" label={t('partySize')} error={errors['party']}>
          <div className="flex items-center gap-2">
            <Input
              id="setup-party-min"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={draft.minParty}
              onChange={(event) => {
                update({ minParty: clampNumber(event.target.value, 1, 500) });
              }}
            />
            <span className="text-text-muted">–</span>
            <Input
              type="number"
              inputMode="numeric"
              aria-label={t('partyMax')}
              min={1}
              max={500}
              value={draft.maxParty}
              onChange={(event) => {
                update({ maxParty: clampNumber(event.target.value, 1, 500) });
              }}
            />
          </div>
        </Field>
        <Field id="setup-capacity" label={t('capacity')} hint={t('capacityHint')}>
          <Input
            id="setup-capacity"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={draft.capacity}
            onChange={(event) => {
              update({ capacity: clampNumber(event.target.value, 1, 100) });
            }}
          />
        </Field>
      </div>
      <InfoNote title={t('confirmTitle')} body={t('confirmBody')} />
      <Collapsible label={t('more')}>
        <div className="grid gap-5 md:grid-cols-2">
          <Field id="setup-buffer" label={t('buffer')}>
            <NativeSelect
              id="setup-buffer"
              value={String(draft.bufferMinutes)}
              onChange={(event) => {
                update({ bufferMinutes: Number(event.target.value) });
              }}
            >
              {BUFFERS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? t('noBuffer') : t('minutes', { count: minutes })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="setup-cancellation" label={t('cancellation')}>
            <NativeSelect
              id="setup-cancellation"
              value={String(draft.cancellationHours)}
              onChange={(event) => {
                update({ cancellationHours: Number(event.target.value) });
              }}
            >
              {CANCELLATION_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {hours === 0 ? t('anytime') : t('hoursBefore', { count: hours })}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </Collapsible>
    </div>
  );
}

export function CallsStep({ draft, update, errors, ctx }: StepProps) {
  const t = useTranslations('onboarding.setup.calls');
  const locale = useLocale();
  const hasTransfer = normalizePhone(draft.transferNumber, ctx.country) !== null;
  const summary = hoursSummary(draft.hours, locale);
  return (
    <div className="flex flex-col gap-7">
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel className="flex flex-col gap-5">
          <StepHeading title={t('humanTitle')} body={t('humanBody')} />
          <Field
            id="setup-transfer"
            label={t('transferNumber')}
            hint={t('transferHint')}
            error={errors['transferNumber']}
          >
            <Input
              id="setup-transfer"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={ctx.country === 'HU' ? '+36 30 123 4567' : '+49 30 1234567'}
              value={draft.transferNumber}
              onChange={(event) => {
                update({ transferNumber: event.target.value });
              }}
            />
          </Field>
          <Field id="setup-no-answer" label={t('noAnswer')}>
            <NativeSelect
              id="setup-no-answer"
              disabled={!hasTransfer}
              value={draft.noAnswer}
              onChange={(event) => {
                update({
                  noAnswer:
                    event.target.value === 'RETURN_TO_AI' ? 'RETURN_TO_AI' : 'CALLBACK_REQUEST',
                });
              }}
            >
              {NO_ANSWER.map((value) => (
                <option key={value} value={value}>
                  {t(`noAnswerOptions.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </Panel>
        <Panel className="flex flex-col gap-5">
          <StepHeading title={t('afterHoursTitle')} body={t('afterHoursBody')} />
          <Field id="setup-after-hours" label={t('afterHours')}>
            <NativeSelect
              id="setup-after-hours"
              value={
                draft.afterHours === 'TRANSFER_ON_CALL' && !hasTransfer
                  ? 'TAKE_MESSAGE'
                  : draft.afterHours
              }
              onChange={(event) => {
                const value = AFTER_HOURS.find((entry) => entry === event.target.value);
                if (value !== undefined) {
                  update({ afterHours: value });
                }
              }}
            >
              {AFTER_HOURS.map((value) => (
                <option
                  key={value}
                  value={value}
                  disabled={value === 'TRANSFER_ON_CALL' && !hasTransfer}
                >
                  {t(`afterHoursOptions.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-muted px-4 py-3 text-[13px]">
            <span className="text-text-muted">
              {summary.length === 0 ? t('noHours') : t('openHours', { hours: summary.join(', ') })}
            </span>
            <button
              type="button"
              onClick={() => {
                ctx.onGoTo('knowledge');
              }}
              className="font-medium text-pink-text hover:underline"
            >
              {t('editHours')}
            </button>
          </div>
        </Panel>
      </div>
      <Collapsible label={t('more')}>
        <div className="grid gap-5 md:grid-cols-2">
          <Field id="setup-max-call" label={t('maxCall')} hint={t('maxCallHint')}>
            <NativeSelect
              id="setup-max-call"
              value={String(draft.maxCallMinutes)}
              onChange={(event) => {
                update({ maxCallMinutes: Number(event.target.value) });
              }}
            >
              {CALL_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t('minutes', { count: minutes })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-surface p-4">
            <div>
              <p className="text-sm font-medium text-text">{t('recording')}</p>
              <p className="mt-1 text-[13px] text-text-muted">{t('recordingHint')}</p>
            </div>
            <Switch
              checked={draft.recording}
              aria-label={t('recording')}
              onCheckedChange={(recording) => {
                update({ recording });
              }}
            />
          </div>
        </div>
      </Collapsible>
    </div>
  );
}

function hostOf(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function LaunchStep({ draft, ctx }: StepProps) {
  const t = useTranslations('onboarding.setup.launch');
  const tv = useTranslations('onboarding.setup.voice');
  const tb = useTranslations('onboarding.setup.bookings');
  const persona = personaOf(draft.persona);
  const name = personaName(draft.persona, draft.defaultLocale);
  const run = ctx.run;
  const results = run?.scores?.results ?? [];
  const active = ctx.testing || (run !== null && RUN_ACTIVE.has(run.status));
  const passed = run !== null && run.status === 'PASSED' && run.gate_passed === true;
  const failed = run !== null && !active && !passed;
  const calendar = ctx.integrations.find(
    (entry) =>
      (entry.integration_type === 'GOOGLE_CALENDAR' ||
        entry.integration_type === 'MICROSOFT_365') &&
      LIVE_INTEGRATION_STATUSES.has(entry.status),
  );
  const phone = ctx.phoneNumbers.find((number) => number.status === 'ACTIVE');
  const hasTransfer = normalizePhone(draft.transferNumber, ctx.country) !== null;
  const checklist: readonly {
    readonly step: SetupStep;
    readonly title: string;
    readonly detail: string;
    readonly done: boolean;
  }[] = [
    {
      step: 'business',
      title: t('check.business'),
      detail: [draft.businessName.trim(), parseAddress(draft.address)?.city]
        .filter((part) => part !== undefined && part !== '')
        .join(' · '),
      done: draft.businessName.trim() !== '',
    },
    {
      step: 'voice',
      title: t('check.voice'),
      detail: [name, tv(`styles.${draft.style}`), tv('anyLanguageShort')].join(' · '),
      done: true,
    },
    {
      step: 'knowledge',
      title: t('check.knowledge'),
      detail: [
        hostOf(ctx.website?.uri ?? null) ?? t('check.noWebsite'),
        t('check.qaCount', { count: draft.qa.length }),
      ].join(' · '),
      done:
        ctx.website?.status === 'ACTIVE' ||
        ctx.website?.status === 'READY' ||
        draft.qa.some((pair) => pair.answer.trim() !== ''),
    },
    {
      step: draft.bookings ? 'bookings' : 'calls',
      title: t('check.calls'),
      detail: [
        draft.bookings
          ? calendar === undefined
            ? t('check.noCalendar')
            : tb(
                `providers.${calendar.integration_type === 'MICROSOFT_365' ? 'MICROSOFT_365' : 'GOOGLE_CALENDAR'}.name`,
              )
          : tb('disabledTitle'),
        hasTransfer ? t('check.transfer') : t('check.noTransfer'),
      ].join(' · '),
      done: true,
    },
  ];
  const planned = setupScenarios(draft, ctx.country);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel className="flex flex-col items-center gap-4 px-6 py-9 text-center md:px-10">
        <VoiceOrb tone={persona.orb} size={148} checked={passed} />
        <h2 className="mt-2 text-[26px] font-bold text-text">{t('hello', { name })}</h2>
        <p className="max-w-sm text-[15px] text-text-muted">{t('testBody')}</p>
        <Button
          type="button"
          size="lg"
          className="mt-2 min-w-64"
          disabled={active || ctx.busy || ctx.activation !== 'ready'}
          onClick={ctx.onStartTest}
        >
          {active ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
          )}
          {active ? t('testing') : run === null ? t('startTest') : t('retest')}
        </Button>
        <p className="text-[12px] text-text-muted">
          {ctx.activation === 'ready' ? t('testHint') : t('activationRequired')}
        </p>
        {ctx.webCallEnabled ? (
          <div className="mt-4 w-full rounded-2xl border border-border bg-surface-muted/40 px-5 py-4 text-left">
            <p className="text-[15px] font-semibold text-text">{t('webCallTitle')}</p>
            <p className="mt-1 text-[13px] text-text-muted">{t('webCallBody', { name })}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant={ctx.webCall === 'live' ? 'danger' : 'secondary'}
                disabled={ctx.webCall === 'connecting' || ctx.activation !== 'ready'}
                onClick={ctx.webCall === 'live' ? ctx.onStopWebCall : ctx.onStartWebCall}
              >
                {ctx.webCall === 'connecting' ? (
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : ctx.webCall === 'live' ? (
                  <PhoneOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden="true" />
                )}
                {ctx.webCall === 'connecting'
                  ? t('webCallConnecting')
                  : ctx.webCall === 'live'
                    ? t('webCallStop')
                    : t('webCallStart')}
              </Button>
              {ctx.webCall === 'live' ? (
                <span className="inline-flex items-center gap-2 text-[13px] text-success-text">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                  {t('webCallLive')}
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-[12px] text-text-muted">{t('webCallHint')}</p>
          </div>
        ) : null}
        <div className="mt-3 w-full border-t border-border pt-5 text-left" aria-live="polite">
          {results.length === 0 ? (
            <ul className="flex flex-col gap-2.5">
              {planned.map((scenario) => (
                <li key={scenario.scenario_key} className="flex items-start gap-3 text-[13px]">
                  {active ? (
                    <Loader2
                      className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-text-muted motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckBadge done={false} />
                  )}
                  <span>
                    <span className="block font-medium text-text">
                      {t(`scenarios.${scenario.scenario_key.replace('setup.', '')}`)}
                    </span>
                    <span className="block text-text-muted">
                      „{scenario.definition.opening_line}”
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-3">
              {results.map((result) => {
                const key = (ctx.scenarioKeys[result.scenario_id] ?? '').replace('setup.', '');
                return (
                  <li key={result.scenario_id} className="flex items-start gap-3">
                    {result.verdict === 'PASSED' ? (
                      <CircleCheck
                        className="mt-0.5 h-4 w-4 shrink-0 text-success-text"
                        aria-hidden="true"
                      />
                    ) : (
                      <CircleAlert
                        className="mt-0.5 h-4 w-4 shrink-0 text-danger-text"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">
                        {t.has(`scenarios.${key}`) ? t(`scenarios.${key}`) : t('scenarioFallback')}
                      </p>
                      {result.judge_notes === undefined ? null : (
                        <p className="mt-0.5 line-clamp-2 text-[12px] text-text-muted">
                          {result.judge_notes}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {passed ? (
            <p className="mt-4 text-sm font-medium text-success-text">{t('passed', { name })}</p>
          ) : failed ? (
            <p role="alert" className="mt-4 text-sm text-danger-text">
              {CREDENTIAL_ERRORS.has(run.scores?.error_code ?? '')
                ? t('failedActivation')
                : t('failed')}
            </p>
          ) : null}
        </div>
      </Panel>
      <div className="flex flex-col gap-5">
        <h2 className="text-[22px] font-semibold text-text">{t('readyTitle')}</h2>
        <ul className="flex flex-col">
          {checklist.map((item) => (
            <li key={item.title} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => {
                  ctx.onGoTo(item.step);
                }}
                className="flex w-full items-start gap-3 py-4 text-left"
              >
                <CheckBadge done={item.done} />
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold text-text">{item.title}</span>
                  <span className="mt-1 block text-[13px] text-text-muted">{item.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="rounded-2xl border border-pink/25 bg-pink-tint px-5 py-4">
          <p className="font-semibold text-pink-text">{t('controlTitle')}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
            {phone === undefined
              ? t('controlBodyNoNumber', { name })
              : t('controlBody', { name, number: phone.e164 })}
          </p>
        </div>
      </div>
    </div>
  );
}

export function DoneScreen({
  workspaceId,
  agentId,
  draft,
  phone,
}: {
  readonly workspaceId: string;
  readonly agentId: string | null;
  readonly draft: SetupDraft;
  readonly phone: string | null;
}) {
  const t = useTranslations('onboarding.setup.done');
  const persona = personaOf(draft.persona);
  const name = personaName(draft.persona, draft.defaultLocale);
  const cards = [
    { key: 'calls', href: `/app/${workspaceId}/dashboard` },
    { key: 'bookings', href: `/app/${workspaceId}/bookings` },
    {
      key: 'assistant',
      href:
        agentId === null ? `/app/${workspaceId}/agents` : `/app/${workspaceId}/agents/${agentId}`,
    },
  ] as const;
  return (
    <div className="min-h-dvh bg-bg px-4 md:px-16">
      <header className="mx-auto flex h-24 max-w-6xl items-center justify-between border-b border-border">
        <VelyricLogo />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-pink/40 bg-pink-tint px-4 py-1.5 text-[13px] text-text">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {t('badge')}
        </span>
      </header>
      <main id="main" className="mx-auto flex max-w-4xl flex-col items-center py-14 text-center">
        <VoiceOrb tone={persona.orb} size={180} checked />
        <h1 className="mt-9 text-[32px] font-bold tracking-[-0.02em] text-text md:text-[44px]">
          {t('title', { name })}
        </h1>
        <p className="mt-3 text-[17px] text-text-muted">{t('body')}</p>
        <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-pink/40 bg-pink-tint px-6 py-1.5 text-[13px] text-text">
          <span className="h-2 w-2 rounded-full bg-pink" aria-hidden="true" />
          {phone === null ? t('activePending') : t('activeNumber', { number: phone })}
        </span>
        <div className="mt-12 grid w-full gap-8 rounded-2xl border border-border bg-surface p-7 text-left md:grid-cols-3">
          {cards.map((card) => (
            <div key={card.key} className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold text-text">
                {t(`cards.${card.key}.title`)}
              </h2>
              <p className="flex-1 text-[13px] leading-relaxed text-text-muted">
                {t(`cards.${card.key}.body`)}
              </p>
              <Link
                href={card.href}
                className="text-sm font-semibold text-pink-text hover:underline"
              >
                {t('open')}
              </Link>
            </div>
          ))}
        </div>
        <Link
          href={`/app/${workspaceId}/dashboard`}
          className="vly-gradient-cta mt-12 inline-flex h-12 items-center gap-2 rounded-xl px-10 text-[15px] font-semibold shadow-cta"
        >
          {t('cta')}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        <p className="mt-12 text-[13px] text-text-muted">{t('tagline')}</p>
      </main>
    </div>
  );
}
