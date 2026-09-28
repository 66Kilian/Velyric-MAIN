import { FeatureFlagKey, KillSwitchKey } from './enums.js';
import type { FeatureFlagScope } from './enums.js';

export interface FeatureFlagDefinition {
  readonly key: FeatureFlagKey;
  readonly allowedScopes: readonly FeatureFlagScope[];
  readonly defaultEnabled: boolean;
}

export interface KillSwitchDefinition {
  readonly key: KillSwitchKey;
  readonly allowedScopes: readonly FeatureFlagScope[];
  readonly targeted: boolean;
}

function feature(
  key: FeatureFlagKey,
  allowedScopes: readonly FeatureFlagScope[],
  defaultEnabled: boolean,
): FeatureFlagDefinition {
  return Object.freeze({ key, allowedScopes: Object.freeze([...allowedScopes]), defaultEnabled });
}

function killSwitch(
  key: KillSwitchKey,
  allowedScopes: readonly FeatureFlagScope[],
  targeted: boolean,
): KillSwitchDefinition {
  return Object.freeze({ key, allowedScopes: Object.freeze([...allowedScopes]), targeted });
}

const FF = FeatureFlagKey;
const KS = KillSwitchKey;

export const FEATURE_FLAG_DEFINITIONS: Readonly<Record<FeatureFlagKey, FeatureFlagDefinition>> =
  Object.freeze({
    [FF.AGENT_CANARY_ROLLOUT]: feature(FF.AGENT_CANARY_ROLLOUT, ['TENANT', 'AGENT'], true),
    [FF.ROUTING_COMPLEX_ESCALATION]: feature(
      FF.ROUTING_COMPLEX_ESCALATION,
      ['GLOBAL', 'TENANT', 'AGENT'],
      true,
    ),
    [FF.ROUTING_PREMIUM_REASONING]: feature(
      FF.ROUTING_PREMIUM_REASONING,
      ['GLOBAL', 'TENANT', 'AGENT'],
      false,
    ),
    [FF.ROUTING_FRONTIER_REASONING]: feature(
      FF.ROUTING_FRONTIER_REASONING,
      ['GLOBAL', 'TENANT', 'AGENT'],
      false,
    ),
    [FF.CALLER_MEMORY]: feature(FF.CALLER_MEMORY, ['TENANT', 'LOCATION'], false),
    [FF.WEB_VOICE_WIDGET]: feature(FF.WEB_VOICE_WIDGET, ['GLOBAL', 'TENANT'], false),
    [FF.WAITLIST]: feature(FF.WAITLIST, ['TENANT', 'LOCATION'], false),
    [FF.WARM_TRANSFER]: feature(FF.WARM_TRANSFER, ['GLOBAL', 'TENANT', 'LOCATION'], true),
    [FF.OUTBOUND_CALLS]: feature(FF.OUTBOUND_CALLS, ['GLOBAL', 'TENANT'], false),
    [FF.CALL_RECORDING]: feature(FF.CALL_RECORDING, ['TENANT', 'LOCATION'], false),
    [FF.KNOWLEDGE_WEBSITE_SYNC]: feature(FF.KNOWLEDGE_WEBSITE_SYNC, ['GLOBAL', 'TENANT'], true),
    [FF.ONBOARDING_WEBSITE_IMPORT]: feature(
      FF.ONBOARDING_WEBSITE_IMPORT,
      ['GLOBAL', 'TENANT'],
      true,
    ),
    [FF.SIMULATION_LAB]: feature(FF.SIMULATION_LAB, ['GLOBAL', 'TENANT'], true),
    [FF.QUALITY_AUTO_ROLLBACK_RECOMMENDATION]: feature(
      FF.QUALITY_AUTO_ROLLBACK_RECOMMENDATION,
      ['TENANT', 'AGENT'],
      true,
    ),
    [FF.PCI_PAYMENT_MODE]: feature(FF.PCI_PAYMENT_MODE, ['TENANT'], false),
    [FF.ANALYST_TRANSCRIPT_ACCESS]: feature(FF.ANALYST_TRANSCRIPT_ACCESS, ['TENANT'], false),
  });

export const KILL_SWITCH_DEFINITIONS: Readonly<Record<KillSwitchKey, KillSwitchDefinition>> =
  Object.freeze({
    [KS.GLOBAL_NEW_CALLS]: killSwitch(KS.GLOBAL_NEW_CALLS, ['GLOBAL', 'REGION'], false),
    [KS.TENANT_TRAFFIC]: killSwitch(KS.TENANT_TRAFFIC, ['TENANT'], false),
    [KS.OUTBOUND_CALLS]: killSwitch(KS.OUTBOUND_CALLS, ['GLOBAL', 'TENANT'], false),
    [KS.CALL_TRANSFER]: killSwitch(KS.CALL_TRANSFER, ['GLOBAL', 'TENANT', 'LOCATION'], false),
    [KS.PROVIDER]: killSwitch(KS.PROVIDER, ['GLOBAL', 'REGION', 'TENANT'], true),
    [KS.MODEL]: killSwitch(KS.MODEL, ['GLOBAL', 'TENANT', 'AGENT'], true),
    [KS.TOOL]: killSwitch(KS.TOOL, ['GLOBAL', 'TENANT', 'TOOL'], true),
    [KS.RECORDING]: killSwitch(KS.RECORDING, ['GLOBAL', 'TENANT', 'LOCATION'], false),
    [KS.PAYMENT]: killSwitch(KS.PAYMENT, ['GLOBAL', 'TENANT'], false),
    [KS.AGENT_PUBLISH]: killSwitch(KS.AGENT_PUBLISH, ['GLOBAL', 'TENANT', 'LOCATION'], false),
  });

export const FLAG_SCOPE_PRECEDENCE: readonly FeatureFlagScope[] = Object.freeze([
  'TOOL',
  'AGENT',
  'LOCATION',
  'TENANT',
  'REGION',
  'GLOBAL',
]);
