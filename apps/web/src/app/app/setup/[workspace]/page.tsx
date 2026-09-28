import type { AgentLocale } from '@velyric/contracts';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SetupWizard } from '@/components/setup/setup-wizard';
import type { Page } from '@/lib/api-types';
import type {
  Agent,
  AgentDetail,
  AgentVersionDetail,
  AgentVersionSummary,
  PhoneNumber,
} from '@/lib/api/agents';
import type { Integration } from '@/lib/api/integrations';
import type { FaqEntry, KnowledgeSource, KnowledgeSourceDetail } from '@/lib/api/knowledge';
import type { ProvisioningStatus } from '@/lib/api/provisioning';
import type { Location, Resource, Service } from '@/lib/api/scheduling';
import type { SimulationRun, SimulationSuite } from '@/lib/api/simulation';
import {
  AGENT_LOCALES,
  activationOf,
  HANDOFF_LABEL,
  RECOMMENDED_PERSONA,
  SETUP_STEPS,
  VOICE_PERSONAS,
  formatAddress,
  hoursFromEntries,
  paceFromPersona,
  styleFromPersona,
  suggestedGreeting,
  type SetupStep,
} from '@/lib/setup';
import { serverGet, serverGetOrNull } from '@/server/api';
import { webConfig } from '@/server/config';
import { getWorkspaceContext } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

const ZONE_COUNTRIES: Readonly<Record<string, string>> = {
  'Europe/Budapest': 'HU',
  'Europe/Vienna': 'AT',
  'Europe/Berlin': 'DE',
  'Europe/Zurich': 'CH',
  'Europe/Bratislava': 'SK',
  'Europe/Bucharest': 'RO',
  'Europe/Ljubljana': 'SI',
  'Europe/Zagreb': 'HR',
  'Europe/Prague': 'CZ',
  'Europe/Warsaw': 'PL',
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding.setup');
  return { title: t('metaTitle') };
}

export default async function SetupPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: workspaceId } = await params;
  const search = await searchParams;
  await getWorkspaceContext(workspaceId);
  const scope = { workspace: workspaceId };
  const [detail, locations, agents, sources, integrations, phoneNumbers, provisioning] =
    await Promise.all([
      getWorkspaceDetail(workspaceId),
      serverGet<Page<Location>>('/locations', scope),
      serverGet<Page<Agent>>('/agents', { ...scope, query: { limit: 50 } }),
      serverGet<Page<KnowledgeSource>>('/knowledge-sources', { ...scope, query: { limit: 100 } }),
      serverGet<Page<Integration>>('/integrations', { ...scope, query: { limit: 50 } }),
      serverGet<Page<PhoneNumber>>('/phone-numbers', scope),
      serverGetOrNull<ProvisioningStatus>('/provisioning', scope),
    ]);
  const location =
    locations.data.find((entry) => entry.is_primary && entry.status === 'ACTIVE') ??
    locations.data.find((entry) => entry.status === 'ACTIVE') ??
    null;
  const agent = agents.data.filter((entry) => entry.status !== 'ARCHIVED').at(-1) ?? null;
  const websiteSummary =
    sources.data.find((entry) => entry.source_type === 'URL' && entry.status !== 'ARCHIVED') ??
    null;
  const qaSummary =
    sources.data.find(
      (entry) => entry.source_type === 'MANUAL_QA' && entry.status !== 'ARCHIVED',
    ) ?? null;

  const [agentDetail, versions, website, qaEntries, services, resources, suites] =
    await Promise.all([
      agent === null
        ? Promise.resolve(null)
        : serverGetOrNull<AgentDetail>(`/agents/${agent.id}`, scope),
      agent === null
        ? Promise.resolve(null)
        : serverGet<Page<AgentVersionSummary>>(`/agents/${agent.id}/versions`, {
            ...scope,
            query: { limit: 1 },
          }),
      websiteSummary === null
        ? Promise.resolve(null)
        : serverGetOrNull<KnowledgeSourceDetail>(`/knowledge-sources/${websiteSummary.id}`, scope),
      qaSummary === null
        ? Promise.resolve(null)
        : serverGetOrNull<{ entries: readonly FaqEntry[] }>(
            `/knowledge-sources/${qaSummary.id}/entries`,
            scope,
          ),
      location === null
        ? Promise.resolve(null)
        : serverGet<Page<Service>>('/services', {
            ...scope,
            query: { location_id: location.id, limit: 100 },
          }),
      location === null
        ? Promise.resolve(null)
        : serverGet<Page<Resource>>('/resources', {
            ...scope,
            query: { location_id: location.id, limit: 100 },
          }),
      agent === null
        ? Promise.resolve(null)
        : serverGet<Page<SimulationSuite>>('/simulation-suites', {
            ...scope,
            query: { agent_id: agent.id, limit: 50 },
          }),
    ]);

  const latest = versions?.data[0] ?? null;
  const suite = suites?.data.find((entry) => entry.is_release_gate) ?? null;
  const [version, runs, suiteDetail] = await Promise.all([
    latest === null
      ? Promise.resolve(null)
      : serverGetOrNull<AgentVersionDetail>(`/agent-versions/${latest.id}`, scope),
    latest === null || suite === null
      ? Promise.resolve(null)
      : serverGet<Page<SimulationRun>>('/simulation-runs', {
          ...scope,
          query: { suite_id: suite.id, agent_version_id: latest.id, limit: 1 },
        }),
    suite === null
      ? Promise.resolve(null)
      : serverGetOrNull<SimulationSuite>(`/simulation-suites/${suite.id}`, scope),
  ]);

  const config = version?.config ?? null;
  const service = services?.data.find((entry) => entry.active) ?? null;
  const resource = resources?.data.find((entry) => entry.active) ?? null;
  const calendars = integrations.data.filter(
    (entry) =>
      entry.integration_type === 'GOOGLE_CALENDAR' || entry.integration_type === 'MICROSOFT_365',
  );
  const workspaceLocale = AGENT_LOCALES.find((entry) => entry === detail.default_locale);
  const defaultLocale: AgentLocale = config?.default_locale ?? workspaceLocale ?? 'hu';
  const persona =
    VOICE_PERSONAS.find((entry) => entry.voice === config?.voice)?.key ?? RECOMMENDED_PERSONA;
  const addressing = config !== null && config.persona.formality < 50 ? 'informal' : 'formal';
  const businessName = detail.display_name;
  const country = location?.country ?? ZONE_COUNTRIES[detail.timezone] ?? 'HU';
  const requested = searchValue(search['step']);
  const step: SetupStep | 'done' =
    requested === 'done' && (agentDetail?.production_version_id ?? null) !== null
      ? 'done'
      : (SETUP_STEPS.find((entry) => entry === requested) ?? 'business');
  const greeting = config?.languages.find((entry) => entry.locale === defaultLocale)?.greeting;
  const scenarioKeys: Record<string, string> = {};
  for (const scenario of suiteDetail?.scenarios ?? []) {
    scenarioKeys[scenario.id] = scenario.scenario_key;
  }

  return (
    <SetupWizard
      initial={{
        workspace: {
          id: detail.id,
          displayName: detail.display_name,
          version: detail.version,
          timezone: location?.timezone ?? detail.timezone,
          country,
        },
        step,
        draft: {
          businessName,
          website: website?.uri ?? '',
          reception: true,
          bookings: config?.specialists.find((entry) => entry.kind === 'BOOKING')?.enabled ?? true,
          address: formatAddress(location?.address ?? null),
          defaultLocale,
          persona,
          style: config === null ? 'friendly' : styleFromPersona(config.persona),
          addressing,
          pace: config === null ? 'natural' : paceFromPersona(config.persona),
          greeting: greeting ?? suggestedGreeting(defaultLocale, businessName, persona, addressing),
          greetingEdited: greeting !== undefined,
          hours: hoursFromEntries(
            location !== null && location.business_hours.length > 0
              ? location.business_hours
              : (config?.business_hours ?? []),
          ),
          qa: qaEntries?.entries ?? [],
          serviceName: service?.name ?? '',
          durationMinutes: service?.duration_minutes ?? 60,
          minParty: service?.min_party_size ?? 1,
          maxParty: service?.max_party_size ?? 8,
          capacity: resource?.parallel_slots ?? 1,
          bufferMinutes: service?.buffer_after_minutes ?? 0,
          cancellationHours: Math.round((service?.cancellation_window_minutes ?? 1440) / 60),
          transferNumber:
            config?.handoff.destinations.find((entry) => entry.label === HANDOFF_LABEL)?.e164 ?? '',
          afterHours: config?.after_hours.behavior ?? 'TAKE_MESSAGE',
          noAnswer:
            config?.handoff.no_answer_behavior === 'RETURN_TO_AI'
              ? 'RETURN_TO_AI'
              : 'CALLBACK_REQUEST',
          maxCallMinutes:
            config === null ? 15 : Math.round(config.limits.max_call_duration_seconds / 60),
          recording: config?.recording.enabled ?? false,
        },
        location,
        agent: agentDetail ?? agent,
        latestVersionId: latest?.id ?? null,
        config,
        website: website ?? websiteSummary,
        websiteChunks:
          website?.versions.find((entry) => entry.id === website.active_version_id)?.chunk_count ??
          null,
        qaSource: qaSummary === null ? null : { id: qaSummary.id, version: qaSummary.version },
        savedQa: qaEntries?.entries ?? [],
        integrations: calendars,
        service,
        resource,
        phoneNumbers: phoneNumbers.data,
        suiteId: suite?.id ?? null,
        run: runs?.data[0] ?? null,
        scenarioKeys,
        calendarResult: searchValue(search['status']) ?? null,
        helpEmail: webConfig().legalEntity.salesEmail,
        webCallEnabled: webConfig().webTestCallEnabled,
        activation: activationOf(detail.status, provisioning),
      }}
    />
  );
}
