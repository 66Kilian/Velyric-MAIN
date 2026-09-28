'use client';

import type { AgentConfig } from '@velyric/contracts';
import { Button, VelyricLogo, VelyricMark, cn, useToast } from '@velyric/ui';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import {
  fileSourceType,
  MAX_KNOWLEDGE_FILE_BYTES,
  sha256Hex,
  uploadToPresignedUrl,
} from '@/components/knowledge/upload';
import { api } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { Agent, AgentVersionDetail, PhoneNumber } from '@/lib/api/agents';
import type { ConnectorType, Integration } from '@/lib/api/integrations';
import type {
  KnowledgeSource,
  KnowledgeSourceDetail,
  KnowledgeSourceWithUpload,
} from '@/lib/api/knowledge';
import type { ProvisioningStatus } from '@/lib/api/provisioning';
import type { Location, Resource, Service } from '@/lib/api/scheduling';
import {
  RUN_ACTIVE,
  type SimulationRun,
  type SimulationScenario,
  type SimulationSuite,
} from '@/lib/api/simulation';
import {
  SETUP_STEPS,
  buildAgentConfig,
  formatAddress,
  normalizePhone,
  normalizeWebsite,
  openHours,
  parseAddress,
  personaName,
  setupScenarios,
  stableJson,
  activationOf,
  type Activation,
  type QaPair,
  type SetupDraft,
  type SetupStep,
} from '@/lib/setup';
import { type WorkspaceDetail } from '@/lib/types';
import {
  connectWebCall,
  WebCallError,
  type WebCallHandle,
  type WebCallState,
} from '@/lib/web-call';
import {
  BookingStep,
  BusinessStep,
  CallsStep,
  DoneScreen,
  KnowledgeStep,
  LaunchStep,
  LIVE_INTEGRATION_STATUSES,
  SOURCE_IN_FLIGHT,
  VoiceStep,
  type SetupContext,
  type SetupUpload,
  type StepProps,
} from './setup-steps';

export interface SetupWorkspace {
  readonly id: string;
  readonly displayName: string;
  readonly version: number;
  readonly timezone: string;
  readonly country: string;
}

export interface SetupInitial {
  readonly workspace: SetupWorkspace;
  readonly draft: SetupDraft;
  readonly step: SetupStep | 'done';
  readonly location: Location | null;
  readonly agent: Agent | null;
  readonly latestVersionId: string | null;
  readonly config: AgentConfig | null;
  readonly website: KnowledgeSource | null;
  readonly websiteChunks: number | null;
  readonly qaSource: { readonly id: string; readonly version: number } | null;
  readonly savedQa: readonly QaPair[];
  readonly integrations: readonly Integration[];
  readonly service: Service | null;
  readonly resource: Resource | null;
  readonly phoneNumbers: readonly PhoneNumber[];
  readonly suiteId: string | null;
  readonly run: SimulationRun | null;
  readonly scenarioKeys: Readonly<Record<string, string>>;
  readonly calendarResult: string | null;
  readonly helpEmail: string;
  readonly activation: Activation;
  readonly webCallEnabled: boolean;
}

interface StoredSetup {
  readonly draft?: Partial<SetupDraft>;
  readonly furthest?: number;
}

function readStored(key: string): StoredSetup | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as StoredSetup);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredSetup | null): boolean {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

function activeChunks(detail: KnowledgeSourceDetail): number | null {
  return (
    detail.versions.find((version) => version.id === detail.active_version_id)?.chunk_count ?? null
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function SetupWizard({ initial }: { readonly initial: SetupInitial }) {
  const t = useTranslations('onboarding.setup');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const workspaceId = initial.workspace.id;
  const storageKey = `vly_setup_${workspaceId}`;
  const [draft, setDraft] = useState<SetupDraft>(initial.draft);
  const [step, setStep] = useState<SetupStep | 'done'>(initial.step);
  const [furthest, setFurthest] = useState(
    initial.step === 'done' ? SETUP_STEPS.length - 1 : SETUP_STEPS.indexOf(initial.step),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [location, setLocation] = useState(initial.location);
  const [agent, setAgent] = useState(initial.agent);
  const [latestVersionId, setLatestVersionId] = useState(initial.latestVersionId);
  const [config, setConfig] = useState(initial.config);
  const [website, setWebsite] = useState(initial.website);
  const [websiteChunks, setWebsiteChunks] = useState(initial.websiteChunks);
  const [qaSource, setQaSource] = useState(initial.qaSource);
  const [savedQa, setSavedQa] = useState(initial.savedQa);
  const [service, setService] = useState(initial.service);
  const [resource, setResource] = useState(initial.resource);
  const [savedRules, setSavedRules] = useState<string | null>(null);
  const [suiteId, setSuiteId] = useState(initial.suiteId);
  const [run, setRun] = useState(initial.run);
  const [scenarioKeys, setScenarioKeys] = useState(initial.scenarioKeys);
  const [uploads, setUploads] = useState<readonly SetupUpload[]>([]);
  const [activation, setActivation] = useState(initial.activation);
  const [webCall, setWebCall] = useState<WebCallState>('idle');
  const webCallRef = useRef<WebCallHandle | null>(null);
  const webCallIdRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      webCallRef.current?.stop();
      webCallRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (activation === 'ready') {
      return;
    }
    const timer = window.setInterval(() => {
      void api.get<ProvisioningStatus>('/provisioning', { workspace: workspaceId }).then(
        (status) => {
          setActivation(activationOf('', status));
        },
        () => undefined,
      );
    }, 15000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activation, workspaceId]);
  const announced = useRef(false);
  const workspaceOption = { workspace: workspaceId };

  useEffect(() => {
    const stored = readStored(storageKey);
    if (stored?.draft !== undefined) {
      const storedDraft = stored.draft;
      setDraft((current) => ({ ...current, ...storedDraft }));
    }
    if (typeof stored?.furthest === 'number') {
      const storedFurthest = stored.furthest;
      setFurthest((current) => Math.max(current, Math.min(storedFurthest, SETUP_STEPS.length - 1)));
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated || step === 'done') {
      return;
    }
    const timer = window.setTimeout(() => {
      setSaved(writeStored(storageKey, { draft, furthest }));
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, furthest, hydrated, step, storageKey]);

  useEffect(() => {
    window.history.replaceState(null, '', `/app/setup/${workspaceId}?step=${step}`);
  }, [step, workspaceId]);

  useEffect(() => {
    if (announced.current || initial.calendarResult === null) {
      return;
    }
    announced.current = true;
    notify(
      initial.calendarResult === 'connected'
        ? { tone: 'success', title: t('bookings.calendarConnected') }
        : { tone: 'error', title: t('bookings.calendarFailed') },
    );
  }, [initial.calendarResult, notify, t]);

  useEffect(() => {
    const awaitingCredentials =
      website?.status === 'FAILED' &&
      (website.last_error_code === 'embedding_credentials_missing' ||
        website.last_error_code === 'embedding_credentials_unavailable');
    if (website === null || (!SOURCE_IN_FLIGHT.has(website.status) && !awaitingCredentials)) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        void api
          .get<KnowledgeSourceDetail>(`/knowledge-sources/${website.id}`, {
            workspace: workspaceId,
          })
          .then(
            (detail) => {
              setWebsite(detail);
              setWebsiteChunks(activeChunks(detail));
            },
            () => {
              setWebsite({ ...website });
            },
          );
      },
      awaitingCredentials ? 15000 : 5000,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [website, workspaceId]);

  useEffect(() => {
    if (run === null || !RUN_ACTIVE.has(run.status)) {
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .get<SimulationRun>(`/simulation-runs/${run.id}`, { workspace: workspaceId })
        .then(setRun, () => {
          setRun({ ...run });
        });
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [run, workspaceId]);

  const update = useCallback((patch: Partial<SetupDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);

  const perform = async (action: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const nextConfig = () =>
    buildAgentConfig(draft, config, {
      timezone: workspace.timezone,
      country: workspace.country,
      now: new Date(),
    });

  const saveBusiness = async (): Promise<boolean> => {
    const found: Record<string, string> = {};
    const name = draft.businessName.trim();
    const site = normalizeWebsite(draft.website);
    const address = parseAddress(draft.address);
    if (name === '') {
      found['businessName'] = t('errors.businessName');
    }
    if (draft.website.trim() !== '' && site === null) {
      found['website'] = t('errors.website');
    }
    if (!draft.reception && !draft.bookings) {
      found['goals'] = t('errors.goals');
    }
    if (draft.address.trim() !== '' && address === null) {
      found['address'] = t('errors.address');
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return false;
    }
    if (name !== workspace.displayName) {
      const updated = await api.patch<WorkspaceDetail>(`/workspaces/${workspaceId}`, {
        ...workspaceOption,
        ifMatch: workspace.version,
        body: { display_name: name },
      });
      setWorkspace((current) => ({
        ...current,
        displayName: updated.display_name,
        version: updated.version,
      }));
    }
    let current = location;
    if (current === null) {
      current = await api.post<Location>('/locations', {
        ...workspaceOption,
        body: {
          name,
          timezone: workspace.timezone,
          country: workspace.country,
          business_hours: openHours(draft.hours),
          ...(address === null ? {} : { address }),
        },
      });
      setLocation(current);
    } else if (
      current.name !== name ||
      (address !== null && formatAddress(current.address) !== formatAddress(address))
    ) {
      current = await api.patch<Location>(`/locations/${current.id}`, {
        ...workspaceOption,
        ifMatch: current.version,
        body: { name, ...(address === null ? {} : { address }) },
      });
      setLocation(current);
    }
    if (site !== null && website?.uri !== site) {
      const created = await api.post<KnowledgeSource>('/knowledge-sources', {
        ...workspaceOption,
        body: {
          source_type: 'URL',
          uri: site,
          title: name.slice(0, 300),
          language: draft.defaultLocale,
          location_id: current.id,
        },
      });
      if (website !== null) {
        await api
          .post(`/knowledge-sources/${website.id}/archive`, {
            ...workspaceOption,
            ifMatch: website.version,
          })
          .catch(() => undefined);
      }
      setWebsite(created);
      setWebsiteChunks(null);
    }
    return true;
  };

  const saveKnowledge = async (): Promise<boolean> => {
    const pairs = draft.qa
      .map((pair) => ({ question: pair.question.trim(), answer: pair.answer.trim() }))
      .filter((pair) => pair.question !== '' || pair.answer !== '');
    if (pairs.some((pair) => pair.question.length < 3 || pair.answer === '')) {
      setErrors({ qa: t('errors.qa') });
      return false;
    }
    const address = parseAddress(draft.address);
    if (draft.address.trim() !== '' && address === null) {
      setErrors({ address: t('errors.address') });
      return false;
    }
    if (location !== null) {
      const hours = openHours(draft.hours);
      const current = location.business_hours.map((entry) => ({
        iso_weekday: entry.iso_weekday,
        opens: entry.opens,
        closes: entry.closes,
      }));
      const addressChanged =
        address !== null && formatAddress(location.address) !== formatAddress(address);
      if (stableJson(hours) !== stableJson(current) || addressChanged) {
        setLocation(
          await api.patch<Location>(`/locations/${location.id}`, {
            ...workspaceOption,
            ifMatch: location.version,
            body: { business_hours: hours, ...(addressChanged ? { address } : {}) },
          }),
        );
      }
    }
    if (stableJson(pairs) === stableJson(savedQa)) {
      return true;
    }
    if (pairs.length === 0) {
      if (qaSource !== null) {
        await api.post(`/knowledge-sources/${qaSource.id}/archive`, {
          ...workspaceOption,
          ifMatch: qaSource.version,
        });
        setQaSource(null);
      }
    } else if (qaSource === null) {
      const created = await api.post<KnowledgeSource>('/knowledge-sources', {
        ...workspaceOption,
        body: {
          source_type: 'MANUAL_QA',
          title: t('knowledge.qaSourceTitle'),
          entries: pairs,
          language: draft.defaultLocale,
          ...(location === null ? {} : { location_id: location.id }),
        },
      });
      setQaSource({ id: created.id, version: created.version });
    } else {
      const updated = await api.put<KnowledgeSource>(`/knowledge-sources/${qaSource.id}/entries`, {
        ...workspaceOption,
        ifMatch: qaSource.version,
        body: { entries: pairs },
      });
      setQaSource({ id: qaSource.id, version: updated.version });
    }
    setSavedQa(pairs);
    return true;
  };

  const saveBookings = async (): Promise<boolean> => {
    if (!draft.bookings) {
      return true;
    }
    const found: Record<string, string> = {};
    const serviceName = draft.serviceName.trim();
    if (serviceName === '') {
      found['serviceName'] = t('errors.serviceName');
    }
    if (draft.minParty > draft.maxParty) {
      found['party'] = t('errors.party');
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return false;
    }
    if (location === null) {
      notify({ tone: 'error', title: t('errors.locationMissing') });
      setStep('business');
      return false;
    }
    let current = resource;
    if (current === null) {
      const resourceName = (draft.businessName.trim() || serviceName).slice(0, 160);
      const listed = await api.get<Page<Resource>>('/resources', {
        ...workspaceOption,
        query: { location_id: location.id, limit: 100 },
      });
      current =
        listed.data.find((entry) => entry.name === resourceName) ??
        (await api.post<Resource>('/resources', {
          ...workspaceOption,
          body: {
            location_id: location.id,
            name: resourceName,
            resource_type: 'SERVICE_POINT',
            parallel_slots: draft.capacity,
          },
        }));
      setResource(current);
    }
    if (current.parallel_slots !== draft.capacity || !current.active) {
      current = await api.patch<Resource>(`/resources/${current.id}`, {
        ...workspaceOption,
        ifMatch: current.version,
        body: { parallel_slots: draft.capacity, ...(current.active ? {} : { active: true }) },
      });
      setResource(current);
    }
    const calendar = initial.integrations.find(
      (entry) =>
        (entry.integration_type === 'GOOGLE_CALENDAR' ||
          entry.integration_type === 'MICROSOFT_365') &&
        LIVE_INTEGRATION_STATUSES.has(entry.status),
    );
    if (calendar !== undefined && current.calendar_integration_id !== calendar.id) {
      try {
        const calendars = await api.get<{
          data: readonly { id: string; name: string; primary: boolean }[];
        }>(`/integrations/${calendar.id}/calendars`, workspaceOption);
        const target = calendars.data.find((entry) => entry.primary) ?? calendars.data.at(0);
        if (target !== undefined) {
          current = await api.patch<Resource>(`/resources/${current.id}`, {
            ...workspaceOption,
            ifMatch: current.version,
            body: { calendar_integration_id: calendar.id, external_calendar_ref: target.id },
          });
          setResource(current);
        }
      } catch {
        notify({ tone: 'error', title: t('bookings.calendarLinkFailed') });
      }
    }
    const rules = openHours(draft.hours).map((entry) => ({
      iso_weekday: entry.iso_weekday,
      start_local: entry.opens,
      end_local: entry.closes,
    }));
    const rulesKey = stableJson(rules);
    if (rules.length > 0 && rulesKey !== savedRules) {
      const resourceId = current.id;
      await api.put(`/resources/${resourceId}/availability-rules`, {
        ...workspaceOption,
        ifMatch: current.version,
        body: { timezone: workspace.timezone, rules },
      });
      const refreshed = await api.get<Page<Resource>>('/resources', {
        ...workspaceOption,
        query: { location_id: location.id, limit: 100 },
      });
      current = refreshed.data.find((entry) => entry.id === resourceId) ?? current;
      setSavedRules(rulesKey);
    }
    setResource(current);
    const serviceBody = {
      name: serviceName,
      duration_minutes: draft.durationMinutes,
      buffer_after_minutes: draft.bufferMinutes,
      min_party_size: draft.minParty,
      max_party_size: draft.maxParty,
      cancellation_window_minutes: draft.cancellationHours * 60,
    };
    if (service === null) {
      setService(
        await api.post<Service>('/services', {
          ...workspaceOption,
          body: {
            ...serviceBody,
            location_id: location.id,
            required_resource_types: [current.resource_type],
          },
        }),
      );
    } else if (
      stableJson(serviceBody) !==
      stableJson({
        name: service.name,
        duration_minutes: service.duration_minutes,
        buffer_after_minutes: service.buffer_after_minutes,
        min_party_size: service.min_party_size,
        max_party_size: service.max_party_size,
        cancellation_window_minutes: service.cancellation_window_minutes,
      })
    ) {
      setService(
        await api.patch<Service>(`/services/${service.id}`, {
          ...workspaceOption,
          ifMatch: service.version,
          body: serviceBody,
        }),
      );
    }
    return true;
  };

  const ensureVersion = async (): Promise<{ agentId: string; versionId: string }> => {
    const next = nextConfig();
    const agentName = personaName(draft.persona, draft.defaultLocale);
    let current = agent;
    if (current === null) {
      current = await api.post<Agent>('/agents', {
        ...workspaceOption,
        body: { name: agentName, ...(location === null ? {} : { location_id: location.id }) },
      });
      setAgent(current);
    } else if (current.name !== agentName) {
      current = await api.patch<Agent>(`/agents/${current.id}`, {
        ...workspaceOption,
        ifMatch: current.version,
        body: { name: agentName },
      });
      setAgent(current);
    }
    if (latestVersionId !== null && config !== null && stableJson(next) === stableJson(config)) {
      return { agentId: current.id, versionId: latestVersionId };
    }
    const created = await api.post<AgentVersionDetail>(`/agents/${current.id}/versions`, {
      ...workspaceOption,
      body: {
        config: next,
        change_summary: t('changeSummary'),
        ...(latestVersionId === null ? {} : { based_on_version_id: latestVersionId }),
      },
    });
    setLatestVersionId(created.id);
    setConfig(created.config);
    setRun(null);
    return { agentId: current.id, versionId: created.id };
  };

  const saveCalls = async (): Promise<boolean> => {
    if (
      draft.transferNumber.trim() !== '' &&
      normalizePhone(draft.transferNumber, workspace.country) === null
    ) {
      setErrors({ transferNumber: t('errors.transferNumber') });
      return false;
    }
    await ensureVersion();
    return true;
  };

  const savers: Readonly<Record<SetupStep, () => Promise<boolean>>> = {
    business: saveBusiness,
    voice: () => Promise.resolve(true),
    knowledge: saveKnowledge,
    bookings: saveBookings,
    calls: saveCalls,
    launch: () => Promise.resolve(true),
  };

  const index = step === 'done' ? SETUP_STEPS.length - 1 : SETUP_STEPS.indexOf(step);

  const move = (target: SetupStep) => {
    setErrors({});
    setStep(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goTo = (target: SetupStep) => {
    if (!busy && SETUP_STEPS.indexOf(target) <= furthest) {
      move(target);
    }
  };

  const finishWebCall = (handle: WebCallHandle, callId: string) => {
    const transcript = handle.transcript();
    handle.stop();
    void api
      .post(`/web-test-calls/${callId}/end`, {
        ...workspaceOption,
        body: { transcript: transcript.slice(0, 400) },
      })
      .catch(() => undefined);
  };

  const stopWebCall = () => {
    const handle = webCallRef.current;
    const callId = webCallIdRef.current;
    webCallRef.current = null;
    webCallIdRef.current = null;
    setWebCall('idle');
    if (handle !== null && callId !== null) {
      finishWebCall(handle, callId);
    } else {
      handle?.stop();
    }
  };

  const startWebCall = () => {
    if (!initial.webCallEnabled || activation !== 'ready' || webCall !== 'idle') {
      return;
    }
    setWebCall('connecting');
    void perform(async () => {
      try {
        const { agentId } = await ensureVersion();
        const rejected: string[] = [];
        for (;;) {
          const session = await api.post<{
            client_secret: string;
            model: string;
            call_id: string;
            tools: readonly { name: string; specialist: string }[];
          }>(`/agents/${agentId}/web-test-session`, {
            ...workspaceOption,
            body: { rejected_models: rejected },
          });
          const specialists = new Map(session.tools.map((tool) => [tool.name, tool.specialist]));
          try {
            webCallIdRef.current = session.call_id;
            webCallRef.current = await connectWebCall({
              clientSecret: session.client_secret,
              onToolCall: async (name, args) => {
                const result = await api.post<{
                  status: string;
                  result: unknown;
                  error_code: string | null;
                }>(`/web-test-calls/${session.call_id}/tools`, {
                  ...workspaceOption,
                  body: {
                    tool_name: name,
                    specialist: specialists.get(name) ?? 'RECEPTION_ROUTER',
                    arguments: args,
                    conversation_state: 'TOOL_EXECUTION',
                    provider_call_id: `${session.call_id}:${String(Date.now())}`,
                  },
                });
                return result.status === 'SUCCEEDED'
                  ? { status: 'SUCCEEDED', result: result.result }
                  : { status: result.status, error_code: result.error_code };
              },
              onState: (state) => {
                setWebCall(state);
                if (state === 'ended') {
                  const handle = webCallRef.current;
                  const callId = webCallIdRef.current;
                  webCallRef.current = null;
                  webCallIdRef.current = null;
                  if (handle !== null && callId !== null) {
                    finishWebCall(handle, callId);
                  }
                }
              },
            });
            return true;
          } catch (error) {
            if (
              !(error instanceof WebCallError) ||
              error.code !== 'realtime_invalid_model' ||
              rejected.length >= 4
            ) {
              throw error;
            }
            rejected.push(session.model);
          }
        }
      } catch (error) {
        setWebCall('idle');
        notify({
          tone: 'error',
          title:
            error instanceof WebCallError && error.code === 'microphone_denied'
              ? t('launch.webCallMicDenied')
              : t('launch.webCallFailed'),
        });
        return false;
      }
    });
  };

  const startTest = () => {
    if (activation !== 'ready') {
      return;
    }
    void perform(async () => {
      setTesting(true);
      try {
        const { agentId, versionId } = await ensureVersion();
        let id = suiteId;
        if (id === null) {
          const suites = await api.get<Page<SimulationSuite>>('/simulation-suites', {
            ...workspaceOption,
            query: { agent_id: agentId, limit: 50 },
          });
          id = suites.data.find((suite) => suite.is_release_gate)?.id ?? null;
          if (id === null) {
            const created = await api.post<SimulationSuite>('/simulation-suites', {
              ...workspaceOption,
              body: {
                agent_id: agentId,
                name: t('launch.suiteName'),
                description: t('launch.suiteDescription'),
                is_release_gate: true,
              },
            });
            id = created.id;
          }
          setSuiteId(id);
        }
        const gateSuite = id;
        const suite = await api.get<SimulationSuite>(
          `/simulation-suites/${gateSuite}`,
          workspaceOption,
        );
        const wanted = setupScenarios(draft, workspace.country);
        const existing = suite.scenarios ?? [];
        const keys: Record<string, string> = {};
        await Promise.all(
          existing.map(async (scenario) => {
            keys[scenario.id] = scenario.scenario_key;
            if (!scenario.scenario_key.startsWith('setup.')) {
              return;
            }
            const desired = wanted.find((entry) => entry.scenario_key === scenario.scenario_key);
            await api.patch(`/simulation-scenarios/${scenario.id}`, {
              ...workspaceOption,
              body:
                desired === undefined
                  ? { active: false }
                  : {
                      active: true,
                      language: desired.language,
                      definition: desired.definition,
                      deterministic_assertions: desired.deterministic_assertions,
                    },
            });
          }),
        );
        const created = await Promise.all(
          wanted
            .filter(
              (entry) => !existing.some((scenario) => scenario.scenario_key === entry.scenario_key),
            )
            .map((entry) =>
              api.post<SimulationScenario>(`/simulation-suites/${gateSuite}/scenarios`, {
                ...workspaceOption,
                body: entry,
              }),
            ),
        );
        for (const scenario of created) {
          keys[scenario.id] = scenario.scenario_key;
        }
        setScenarioKeys(keys);
        setRun(
          await api.post<SimulationRun>(`/simulation-suites/${gateSuite}/runs`, {
            ...workspaceOption,
            body: { agent_version_id: versionId },
          }),
        );
        return true;
      } finally {
        setTesting(false);
      }
    });
  };

  const canLaunch =
    run !== null &&
    run.status === 'PASSED' &&
    run.gate_passed === true &&
    run.agent_version_id === latestVersionId;

  const launch = () => {
    void perform(async () => {
      if (config === null || stableJson(nextConfig()) !== stableJson(config)) {
        setRun(null);
        notify({ tone: 'error', title: t('launch.retestNeeded') });
        return false;
      }
      const { agentId, versionId } = await ensureVersion();
      if (agent?.production_version_id !== versionId) {
        await api.post(`/agent-versions/${versionId}/publish`, {
          ...workspaceOption,
          body: { rollout_percent: 100 },
        });
      }
      await Promise.all(
        initial.phoneNumbers
          .filter((number) => number.agent === null && number.status === 'ACTIVE')
          .map((number) =>
            api.put(`/phone-numbers/${number.id}/agent`, {
              ...workspaceOption,
              body: { agent_id: agentId },
            }),
          ),
      );
      writeStored(storageKey, null);
      setStep('done');
      window.scrollTo({ top: 0 });
      return true;
    });
  };

  const next = () => {
    if (step === 'done') {
      return;
    }
    if (step === 'launch') {
      launch();
      return;
    }
    void perform(async () => {
      if (!(await savers[step]())) {
        return false;
      }
      const target = SETUP_STEPS[index + 1];
      if (target !== undefined) {
        setFurthest((current) => Math.max(current, index + 1));
        move(target);
      }
      return true;
    });
  };

  const exit = () => {
    writeStored(storageKey, { draft, furthest });
    void perform(async () => {
      if (step !== 'done') {
        await savers[step]();
      }
      router.push(`/app/${workspaceId}/dashboard`);
      return true;
    });
  };

  const upload = (file: File) => {
    const sourceType = fileSourceType(file);
    if (sourceType === null || file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      notify({ tone: 'error', title: t('knowledge.fileInvalid') });
      return;
    }
    const position = uploads.length;
    const mark = (state: SetupUpload['state']) => {
      setUploads((current) =>
        current.map((entry, entryIndex) => (entryIndex === position ? { ...entry, state } : entry)),
      );
    };
    setUploads((current) => [...current, { name: file.name, state: 'uploading' }]);
    void (async () => {
      try {
        const created = await api.post<KnowledgeSourceWithUpload>('/knowledge-sources', {
          ...workspaceOption,
          body: {
            source_type: sourceType,
            title: file.name.slice(0, 300),
            size_bytes: file.size,
            sha256: await sha256Hex(file),
            language: draft.defaultLocale,
            ...(location === null ? {} : { location_id: location.id }),
          },
        });
        if (created.upload === undefined) {
          throw new Error('upload_unavailable');
        }
        await uploadToPresignedUrl(created.upload, file, () => undefined);
        await api.post(`/knowledge-sources/${created.id}/upload-complete`, workspaceOption);
        mark('done');
      } catch (error) {
        mark('failed');
        showError(error);
      }
    })();
  };

  const resync = () => {
    if (website === null) {
      return;
    }
    void perform(async () => {
      await api.post(`/knowledge-sources/${website.id}/sync`, {
        ...workspaceOption,
        ifMatch: website.version,
      });
      const detail = await api.get<KnowledgeSourceDetail>(
        `/knowledge-sources/${website.id}`,
        workspaceOption,
      );
      setWebsite(detail);
      setWebsiteChunks(activeChunks(detail));
      return true;
    });
  };

  const connectCalendar = (type: ConnectorType) => {
    writeStored(storageKey, { draft, furthest });
    void perform(async () => {
      const result = await api.post<{ authorization_url: string }>(
        '/integrations/oauth/authorizations',
        {
          ...workspaceOption,
          body: {
            integration_type: type,
            return_to: 'setup',
            ...(location === null ? {} : { location_id: location.id }),
          },
        },
      );
      window.location.assign(result.authorization_url);
      return true;
    });
  };

  if (step === 'done') {
    return (
      <DoneScreen
        workspaceId={workspaceId}
        agentId={agent?.id ?? null}
        draft={draft}
        phone={initial.phoneNumbers.find((number) => number.status === 'ACTIVE')?.e164 ?? null}
      />
    );
  }

  const ctx: SetupContext = {
    workspaceId,
    timezone: workspace.timezone,
    country: workspace.country,
    website,
    websiteChunks,
    uploads,
    integrations: initial.integrations,
    phoneNumbers: initial.phoneNumbers,
    run,
    scenarioKeys,
    testing,
    busy,
    onUpload: upload,
    onResync: resync,
    onConnectCalendar: connectCalendar,
    onStartTest: startTest,
    onGoTo: goTo,
    activation,
    webCall,
    webCallEnabled: initial.webCallEnabled,
    onStartWebCall: startWebCall,
    onStopWebCall: stopWebCall,
  };
  const props: StepProps = { draft, update, errors, ctx };

  return (
    <div className="min-h-dvh bg-bg lg:grid lg:grid-cols-[282px_minmax(0,1fr)]">
      <aside className="hidden border-r border-border bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto lg:px-5 lg:py-9">
        <Link href={`/app/${workspaceId}/dashboard`} className="w-fit px-3">
          <VelyricLogo />
        </Link>
        <div className="mt-12 px-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            {t('shell.eyebrow')}
          </p>
          <p className="mt-3 text-[22px] font-bold text-text">{t('shell.title')}</p>
          <p className="mt-1 text-[13px] text-text-muted">{t('shell.subtitle')}</p>
        </div>
        <nav aria-label={t('shell.progress')} className="mt-8">
          <ol className="flex flex-col gap-2">
            {SETUP_STEPS.map((entry, position) => {
              const current = entry === step;
              const reachable = position <= furthest;
              const complete = position < furthest && !current;
              return (
                <li key={entry}>
                  <button
                    type="button"
                    disabled={!reachable || busy}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => {
                      goTo(entry);
                    }}
                    className={cn(
                      'flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left text-[15px] transition-colors duration-150',
                      current
                        ? 'border-pink/40 bg-pink-tint font-semibold text-text'
                        : 'border-transparent',
                      !current && reachable && 'text-text hover:bg-surface-muted',
                      !reachable && 'text-text-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                        current
                          ? 'bg-pink text-on-accent'
                          : complete
                            ? 'bg-pink-tint-strong text-pink-text'
                            : 'bg-surface-muted text-text-muted',
                      )}
                    >
                      {complete ? (
                        <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                      ) : (
                        position + 1
                      )}
                    </span>
                    {t(`steps.${entry}`)}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="mt-auto flex flex-col gap-4 pt-8">
          <div className="rounded-2xl border border-border p-5">
            <p className="text-[15px] font-semibold text-text">{t('shell.helpTitle')}</p>
            <p className="mt-2 text-[13px] text-text-muted">{t('shell.helpBody')}</p>
            {initial.helpEmail === '' ? null : (
              <a
                href={`mailto:${initial.helpEmail}`}
                className="mt-4 inline-block text-sm font-semibold text-pink-text hover:underline"
              >
                {t('shell.helpAction')}
              </a>
            )}
          </div>
          <p
            className="flex items-center gap-1.5 px-3 text-[12px] text-text-muted"
            aria-live="polite"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            {saved ? t('shell.saved') : t('shell.autosave')}
          </p>
        </div>
      </aside>
      <div className="flex min-h-dvh min-w-0 flex-col px-4 md:px-12">
        <header className="flex h-20 items-center justify-between gap-4 border-b border-border">
          <div className="flex min-w-0 items-center gap-3">
            <VelyricMark className="h-7 w-7 lg:hidden" />
            <p className="truncate text-sm text-text">{workspace.displayName}</p>
          </div>
          <button
            type="button"
            onClick={exit}
            disabled={busy}
            className="h-9 shrink-0 rounded-full border border-border px-5 text-[13px] text-text transition-colors hover:bg-surface-muted disabled:opacity-50"
          >
            {t('shell.saveExit')}
          </button>
        </header>
        <div className="pt-5 lg:hidden">
          <div
            className="h-1 rounded-full bg-surface-muted"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={SETUP_STEPS.length}
            aria-valuenow={index + 1}
            aria-label={t('shell.progress')}
          >
            <div
              className="h-1 rounded-full bg-pink transition-[width] duration-300"
              style={{ width: `${String(((index + 1) / SETUP_STEPS.length) * 100)}%` }}
            />
          </div>
        </div>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 py-8 md:py-10">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-pink-text">
            {pad(index + 1)} / {pad(SETUP_STEPS.length)} · {t(`steps.${step}`)}
          </p>
          <h1 className="mt-3 text-[30px] font-bold leading-tight tracking-[-0.02em] text-text md:text-[36px]">
            {t(`headings.${step}.title`)}
          </h1>
          <p className="mt-2 text-[15px] text-text-muted">{t(`headings.${step}.description`)}</p>
          {activation === 'ready' ? null : (
            <div
              role="status"
              className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-warning/40 bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text">
                  {t(`activation.${activation}.title`)}
                </p>
                <p className="mt-1 text-[13px] text-text-muted">
                  {t(`activation.${activation}.body`)}
                </p>
              </div>
              <Link
                href={`/app/onboarding?workspace=${workspaceId}&step=${activation === 'payment' ? 'plan' : 'provisioning'}`}
                className="inline-flex h-9 shrink-0 items-center rounded-full border border-border px-4 text-[13px] font-medium text-text transition-colors hover:bg-surface-muted"
              >
                {t(`activation.${activation}.action`)}
              </Link>
            </div>
          )}
          <div className="mt-8">
            {step === 'business' ? (
              <BusinessStep {...props} />
            ) : step === 'voice' ? (
              <VoiceStep {...props} />
            ) : step === 'knowledge' ? (
              <KnowledgeStep {...props} />
            ) : step === 'bookings' ? (
              <BookingStep {...props} />
            ) : step === 'calls' ? (
              <CallsStep {...props} />
            ) : (
              <LaunchStep {...props} />
            )}
          </div>
        </main>
        <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 border-t border-border py-6">
          <button
            type="button"
            onClick={() => {
              const target = SETUP_STEPS[index - 1];
              if (target !== undefined) {
                move(target);
              }
            }}
            disabled={index === 0 || busy}
            className="inline-flex items-center gap-1.5 text-[15px] text-text disabled:invisible"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('actions.back')}
          </button>
          <p className="order-last w-full text-center text-[12px] text-text-muted md:order-none md:w-auto">
            {step === 'launch' ? t('shell.launchHint') : t('shell.hint')}
          </p>
          <Button
            type="button"
            size="lg"
            className="min-w-52 rounded-xl"
            disabled={busy || (step === 'launch' && !canLaunch)}
            onClick={next}
          >
            {busy && !testing ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {t(`actions.${step}`)}
            {step === 'launch' ? null : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </footer>
      </div>
    </div>
  );
}
