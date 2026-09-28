import type { Locale } from '@velyric/contracts';

export const MESSAGE_NAMESPACES = [
  'admin',
  'common',
  'errors',
  'enums',
  'navigation',
  'marketing',
  'legal',
  'auth',
  'checkout',
  'onboarding',
  'dashboard',
  'calls',
  'agents',
  'knowledge',
  'contacts',
  'bookings',
  'integrations',
  'analytics',
  'phoneNumbers',
  'locations',
  'simulation',
  'billing',
  'settings',
  'security',
  'support',
  'marketingCapabilities',
  'marketingIntegrations',
  'marketingCompare',
  'marketingSolutions',
  'marketingGlossary',
  'marketingContact',
] as const;

export type MessageNamespace = (typeof MESSAGE_NAMESPACES)[number];

export type MessageTree = { readonly [key: string]: string | MessageTree };

export type MessageLoader = (
  locale: Locale,
  namespace: MessageNamespace,
) => Promise<MessageTree | null>;

export async function loadMessages(
  locale: Locale,
  loader: MessageLoader,
  namespaces: readonly MessageNamespace[] = MESSAGE_NAMESPACES,
): Promise<Record<string, MessageTree>> {
  const entries = await Promise.all(
    namespaces.map(async (namespace) => [namespace, await loader(locale, namespace)] as const),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [MessageNamespace, MessageTree] => entry[1] !== null),
  );
}

export function flattenMessages(tree: MessageTree, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      flat.set(path, value);
    } else {
      for (const [nestedKey, nestedValue] of flattenMessages(value, path)) {
        flat.set(nestedKey, nestedValue);
      }
    }
  }
  return flat;
}
