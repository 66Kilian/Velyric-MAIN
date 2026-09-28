import type { Permission } from '@velyric/contracts';
import {
  BookOpen,
  Building2,
  CreditCard,
  FlaskConical,
  Phone,
  Plug,
  SlidersHorizontal,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export interface SettingsSection {
  /** Key under `navigation.app`. */
  readonly key: string;
  readonly segment: string;
  readonly icon: LucideIcon;
  readonly permission: Permission;
}

export interface SettingsGroup {
  readonly key: 'account' | 'assistant' | 'channels';
  readonly items: readonly SettingsSection[];
}

/**
 * Everything that lives under "Settings". The routes keep their original URLs
 * (`/app/:workspace/agents`, …); they only share the `(settings)` layout.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    key: 'account',
    items: [
      {
        key: 'settingsGeneral',
        segment: 'settings',
        icon: SlidersHorizontal,
        permission: 'workspace:read',
      },
      { key: 'billing', segment: 'billing', icon: CreditCard, permission: 'billing:read' },
      { key: 'security', segment: 'security', icon: ShieldCheck, permission: 'security:read' },
    ],
  },
  {
    key: 'assistant',
    items: [
      { key: 'agents', segment: 'agents', icon: UserRound, permission: 'agents:read' },
      { key: 'knowledge', segment: 'knowledge', icon: BookOpen, permission: 'knowledge:read' },
      {
        key: 'simulation',
        segment: 'simulation',
        icon: FlaskConical,
        permission: 'simulations:read',
      },
    ],
  },
  {
    key: 'channels',
    items: [
      {
        key: 'phoneNumbers',
        segment: 'phone-numbers',
        icon: Phone,
        permission: 'phone_numbers:read',
      },
      { key: 'integrations', segment: 'integrations', icon: Plug, permission: 'integrations:read' },
      { key: 'locations', segment: 'locations', icon: Building2, permission: 'locations:read' },
    ],
  },
];

export const SETTINGS_SEGMENTS: readonly string[] = SETTINGS_GROUPS.flatMap((group) =>
  group.items.map((item) => item.segment),
);
