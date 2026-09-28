import type { AgentConfig, ToolSideEffectClass } from '@velyric/contracts';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export interface ConfigIssue {
  readonly path: string;
  readonly rule: string;
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly sideEffectClass: ToolSideEffectClass;
  readonly status: 'ACTIVE' | 'DISABLED' | 'KILLED';
}

const BLOCKED_DESTINATION_TYPES = new Set(['PREMIUM_RATE', 'SHARED_COST', 'UAN', 'VOIP', 'PAGER']);

function minutes(hhmm: string): number {
  const [hours = '0', mins = '0'] = hhmm.split(':');
  return Number(hours) * 60 + Number(mins);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function transferDestinationIssue(
  e164: string,
  allowedCountries: readonly string[] | null,
): string | null {
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed === undefined || !parsed.isValid()) {
    return 'invalid_number';
  }
  const type = parsed.getType();
  if (type !== undefined && BLOCKED_DESTINATION_TYPES.has(type)) {
    return 'blocked_number_type';
  }
  if (
    allowedCountries !== null &&
    (parsed.country === undefined || !allowedCountries.includes(parsed.country))
  ) {
    return 'country_not_allowed';
  }
  return null;
}

export function agentConfigIssues(
  config: AgentConfig,
  tools: ReadonlyMap<string, ToolCatalogEntry> | null,
  allowedTransferCountries: readonly string[] | null = null,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, rule: string): void => {
    issues.push({ path, rule });
  };

  const locales = config.languages.map((language) => language.locale);
  if (new Set(locales).size !== locales.length) {
    add('/languages', 'unique_locale');
  }
  if (!locales.includes(config.default_locale)) {
    add('/default_locale', 'must_be_configured_language');
  }
  for (const locale of locales) {
    if (config.disclosure.texts[locale] === undefined) {
      add(`/disclosure/texts/${locale}`, 'required_for_configured_language');
    }
  }
  if (!isValidTimeZone(config.timezone)) {
    add('/timezone', 'iana_time_zone');
  }

  const kinds = config.specialists.map((specialist) => specialist.kind);
  if (new Set(kinds).size !== kinds.length) {
    add('/specialists', 'unique_kind');
  }
  const router = config.specialists.find((specialist) => specialist.kind === 'RECEPTION_ROUTER');
  if (router === undefined || !router.enabled) {
    add('/specialists', 'reception_router_required');
  }

  config.specialists.forEach((specialist, index) => {
    const base = `/specialists/${String(index)}`;
    if (specialist.max_tool_executions > config.limits.max_tool_executions_per_call) {
      add(`${base}/max_tool_executions`, 'exceeds_call_limit');
    }
    if (specialist.kind === 'HANDOFF_COMPLIANCE' && specialist.tool_allowlist.length > 0) {
      add(`${base}/tool_allowlist`, 'handoff_specialist_is_transfer_only');
    }
    if (specialist.model_tier === 'COMPLEX' && !config.model_routing.complex_escalation_enabled) {
      add(`${base}/model_tier`, 'complex_escalation_disabled');
    }
    if (
      (specialist.model_tier === 'ESCALATION' || specialist.model_tier === 'FRONTIER') &&
      !config.model_routing.premium_reasoning_enabled
    ) {
      add(`${base}/model_tier`, 'premium_reasoning_disabled');
    }
    if (tools === null) {
      return;
    }
    specialist.tool_allowlist.forEach((toolName, toolIndex) => {
      const tool = tools.get(toolName);
      const path = `${base}/tool_allowlist/${String(toolIndex)}`;
      if (tool === undefined) {
        add(path, 'unknown_tool');
      } else if (tool.status !== 'ACTIVE') {
        add(path, 'tool_not_active');
      } else if (specialist.kind === 'RECEPTION_ROUTER' && tool.sideEffectClass !== 'READ') {
        add(path, 'router_read_only');
      } else if (specialist.kind === 'SUPPORT' && tool.sideEffectClass !== 'READ') {
        add(path, 'support_read_only');
      }
    });
  });

  const labels = config.handoff.destinations.map((destination) => destination.label);
  if (new Set(labels).size !== labels.length) {
    add('/handoff/destinations', 'unique_label');
  }
  config.handoff.destinations.forEach((destination, index) => {
    const problem = transferDestinationIssue(destination.e164, allowedTransferCountries);
    if (problem !== null) {
      add(`/handoff/destinations/${String(index)}/e164`, problem);
    }
  });
  const hasLabel = (label: string | undefined): boolean =>
    label !== undefined && labels.includes(label);
  if (
    config.handoff.default_destination_label !== undefined &&
    !hasLabel(config.handoff.default_destination_label)
  ) {
    add('/handoff/default_destination_label', 'unknown_destination');
  }
  const sequences = config.handoff.dtmf.map((binding) => binding.sequence);
  if (new Set(sequences).size !== sequences.length) {
    add('/handoff/dtmf', 'unique_sequence');
  }
  config.handoff.dtmf.forEach((binding, index) => {
    if (binding.action !== 'HUMAN_TRANSFER') {
      return;
    }
    const label = binding.destination_label ?? config.handoff.default_destination_label;
    if (!hasLabel(label)) {
      add(`/handoff/dtmf/${String(index)}/destination_label`, 'unknown_destination');
    }
  });
  if (
    config.after_hours.behavior === 'TRANSFER_ON_CALL' &&
    !hasLabel(config.after_hours.on_call_destination_label)
  ) {
    add('/after_hours/on_call_destination_label', 'unknown_destination');
  }
  if (
    config.overload.policy === 'HUMAN_OVERFLOW' &&
    !hasLabel(config.overload.overflow_destination_label)
  ) {
    add('/overload/overflow_destination_label', 'unknown_destination');
  }
  if (config.overload.policy === 'SHORT_QUEUE' && config.overload.max_wait_seconds === 0) {
    add('/overload/max_wait_seconds', 'queue_requires_wait');
  }

  config.business_hours.forEach((entry, index) => {
    if (minutes(entry.closes) <= minutes(entry.opens)) {
      add(`/business_hours/${String(index)}`, 'closes_after_opens');
    }
  });

  return issues;
}
