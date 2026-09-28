import type { AgentConfig } from '@velyric/contracts';
import { agentConfigFixture } from '@velyric/testkit';
import { describe, expect, it } from 'vitest';
import {
  agentConfigIssues,
  isValidTimeZone,
  transferDestinationIssue,
  type ToolCatalogEntry,
} from '../src/agent-config.js';

function rules(
  config: AgentConfig,
  tools: ReadonlyMap<string, ToolCatalogEntry> | null = null,
  countries: readonly string[] | null = null,
): string[] {
  return agentConfigIssues(config, tools, countries).map((issue) => `${issue.path}:${issue.rule}`);
}

const base = agentConfigFixture();

describe('agentConfigIssues', () => {
  it('accepts the reference configuration', () => {
    expect(rules(base)).toEqual([]);
  });

  it('requires consistent languages and disclosure texts for every configured language', () => {
    expect(rules({ ...base, default_locale: 'de' })).toContain(
      '/default_locale:must_be_configured_language',
    );
    expect(
      rules({
        ...base,
        disclosure: { ...base.disclosure, texts: { hu: base.disclosure.texts.hu ?? '' } },
      }),
    ).toContain('/disclosure/texts/en:required_for_configured_language');
    const duplicated = [...base.languages, ...base.languages.slice(0, 1)];
    expect(rules({ ...base, languages: duplicated })).toContain('/languages:unique_locale');
    expect(rules({ ...base, timezone: 'Mars/Olympus_Mons' })).toContain('/timezone:iana_time_zone');
  });

  it('enforces specialist structure, budgets and model routing switches', () => {
    const [router, handoff] = base.specialists;
    if (router === undefined || handoff === undefined) {
      throw new Error('fixture changed');
    }
    expect(rules({ ...base, specialists: [handoff] })).toContain(
      '/specialists:reception_router_required',
    );
    expect(rules({ ...base, specialists: [{ ...router, enabled: false }, handoff] })).toContain(
      '/specialists:reception_router_required',
    );
    expect(rules({ ...base, specialists: [router, router] })).toContain('/specialists:unique_kind');
    expect(
      rules({ ...base, specialists: [router, { ...handoff, tool_allowlist: ['create_booking'] }] }),
    ).toContain('/specialists/1/tool_allowlist:handoff_specialist_is_transfer_only');
    expect(
      rules({ ...base, specialists: [{ ...router, max_tool_executions: 11 }, handoff] }),
    ).toContain('/specialists/0/max_tool_executions:exceeds_call_limit');
    const noEscalation = {
      ...base,
      model_routing: { complex_escalation_enabled: false, premium_reasoning_enabled: false },
    };
    expect(
      rules({ ...noEscalation, specialists: [{ ...router, model_tier: 'COMPLEX' }, handoff] }),
    ).toContain('/specialists/0/model_tier:complex_escalation_disabled');
    expect(
      rules({ ...base, specialists: [{ ...router, model_tier: 'FRONTIER' }, handoff] }),
    ).toContain('/specialists/0/model_tier:premium_reasoning_disabled');
  });

  it('checks tool allowlists against the live tool catalog', () => {
    const [router, handoff] = base.specialists;
    if (router === undefined || handoff === undefined) {
      throw new Error('fixture changed');
    }
    const catalog = new Map<string, ToolCatalogEntry>([
      [
        'lookup_availability',
        { name: 'lookup_availability', sideEffectClass: 'READ', status: 'ACTIVE' },
      ],
      ['create_booking', { name: 'create_booking', sideEffectClass: 'WRITE', status: 'ACTIVE' }],
      ['legacy_sync', { name: 'legacy_sync', sideEffectClass: 'READ', status: 'DISABLED' }],
    ]);
    const booking = {
      kind: 'BOOKING' as const,
      enabled: true,
      tool_allowlist: ['lookup_availability', 'create_booking'],
      max_tool_executions: 5,
      model_tier: 'ROUTINE' as const,
    };
    expect(rules({ ...base, specialists: [router, handoff, booking] }, catalog)).toEqual([]);
    expect(
      rules(
        { ...base, specialists: [{ ...router, tool_allowlist: ['create_booking'] }, handoff] },
        catalog,
      ),
    ).toContain('/specialists/0/tool_allowlist/0:router_read_only');
    expect(
      rules(
        {
          ...base,
          specialists: [
            router,
            handoff,
            { ...booking, kind: 'SUPPORT', tool_allowlist: ['create_booking'] },
          ],
        },
        catalog,
      ),
    ).toContain('/specialists/2/tool_allowlist/0:support_read_only');
    expect(
      rules(
        {
          ...base,
          specialists: [
            router,
            handoff,
            { ...booking, tool_allowlist: ['missing_tool', 'legacy_sync'] },
          ],
        },
        catalog,
      ),
    ).toEqual([
      '/specialists/2/tool_allowlist/0:unknown_tool',
      '/specialists/2/tool_allowlist/1:tool_not_active',
    ]);
  });

  it('keeps every handoff reference resolvable and blocks toll-fraud destinations', () => {
    const handoff = base.handoff;
    expect(
      rules({
        ...base,
        handoff: { ...handoff, destinations: [...handoff.destinations, ...handoff.destinations] },
      }),
    ).toContain('/handoff/destinations:unique_label');
    expect(
      rules({ ...base, handoff: { ...handoff, default_destination_label: 'nobody' } }),
    ).toContain('/handoff/default_destination_label:unknown_destination');
    expect(
      rules({ ...base, handoff: { ...handoff, dtmf: [...handoff.dtmf, ...handoff.dtmf] } }),
    ).toContain('/handoff/dtmf:unique_sequence');
    const premium = { label: 'premium', e164: '+3690123456', description: 'Premium line' };
    expect(
      rules({ ...base, handoff: { ...handoff, destinations: [...handoff.destinations, premium] } }),
    ).toContain('/handoff/destinations/1/e164:blocked_number_type');
    expect(rules(base, null, ['DE', 'AT'])).toContain(
      '/handoff/destinations/0/e164:country_not_allowed',
    );
    const withoutDefault = {
      ...handoff,
      default_destination_label: undefined,
      dtmf: [{ sequence: '0', action: 'HUMAN_TRANSFER' as const }],
    };
    const stripped = Object.fromEntries(
      Object.entries(withoutDefault).filter(([key]) => key !== 'default_destination_label'),
    ) as Omit<typeof withoutDefault, 'default_destination_label'>;
    expect(rules({ ...base, handoff: stripped })).toContain(
      '/handoff/dtmf/0/destination_label:unknown_destination',
    );
  });

  it('validates after-hours, overload and business-hour settings', () => {
    expect(rules({ ...base, after_hours: { behavior: 'TRANSFER_ON_CALL' } })).toContain(
      '/after_hours/on_call_destination_label:unknown_destination',
    );
    expect(
      rules({ ...base, overload: { policy: 'HUMAN_OVERFLOW', max_wait_seconds: 0 } }),
    ).toContain('/overload/overflow_destination_label:unknown_destination');
    expect(rules({ ...base, overload: { policy: 'SHORT_QUEUE', max_wait_seconds: 0 } })).toContain(
      '/overload/max_wait_seconds:queue_requires_wait',
    );
    expect(
      rules({ ...base, business_hours: [{ iso_weekday: 3, opens: '18:00', closes: '09:00' }] }),
    ).toContain('/business_hours/0:closes_after_opens');
    expect(
      rules({
        ...base,
        overload: {
          policy: 'HUMAN_OVERFLOW',
          max_wait_seconds: 30,
          overflow_destination_label: 'front-desk',
        },
      }),
    ).toEqual([]);
  });
});

describe('helpers', () => {
  it('recognizes IANA time zones', () => {
    expect(isValidTimeZone('Europe/Budapest')).toBe(true);
    expect(isValidTimeZone('Invalid/Zone')).toBe(false);
  });

  it('classifies transfer destinations', () => {
    expect(transferDestinationIssue('+3612345678', null)).toBeNull();
    expect(transferDestinationIssue('+36123', null)).toBe('invalid_number');
    expect(transferDestinationIssue('+3690123456', null)).toBe('blocked_number_type');
    expect(transferDestinationIssue('+4930123456', ['HU'])).toBe('country_not_allowed');
  });
});
