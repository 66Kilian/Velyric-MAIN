import 'server-only';
import { cookies, headers } from 'next/headers';

export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_COOKIE = 'vly_theme';

export async function resolveTheme(): Promise<{
  readonly preference: ThemePreference;
  readonly attribute: 'light' | 'dark' | 'system';
}> {
  const store = await cookies();
  const raw = store.get(THEME_COOKIE)?.value;
  const preference: ThemePreference = raw === 'light' || raw === 'dark' ? raw : 'system';
  if (preference !== 'system') {
    return { preference, attribute: preference };
  }
  const hint = (await headers()).get('sec-ch-prefers-color-scheme');
  return { preference, attribute: hint === 'dark' || hint === 'light' ? hint : 'system' };
}
