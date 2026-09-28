'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  cn,
} from '@velyric/ui';
import { Check, Languages, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

function writeCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function readTheme(): Theme {
  const raw = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('vly_theme='))
    ?.split('=')[1];
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function applyTheme(theme: Theme): void {
  writeCookie('vly_theme', theme);
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

const THEME_OPTIONS: readonly { readonly value: Theme; readonly icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

export function ThemeMenu({ className }: { readonly className?: string }) {
  const t = useTranslations('common.theme');
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === 'undefined' ? 'system' : readTheme(),
  );
  const Current = THEME_OPTIONS.find((option) => option.value === theme)?.icon ?? Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-pink-tint hover:text-text',
          className,
        )}
        aria-label={t('label')}
      >
        <Current className="h-4 w-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('label')}</DropdownMenuLabel>
        {THEME_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => {
              setTheme(option.value);
              applyTheme(option.value);
            }}
          >
            <option.icon className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1">{t(option.value)}</span>
            {theme === option.value ? (
              <Check className="h-4 w-4 text-pink-text" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LanguageMenu({
  mode,
  className,
}: {
  readonly mode: 'app' | 'marketing';
  readonly className?: string;
}) {
  const t = useTranslations('common.language');
  const locale = useLocale();
  const router = useRouter();
  const select = (next: 'hu' | 'de' | 'en') => {
    writeCookie('NEXT_LOCALE', next);
    if (mode === 'marketing') {
      const segments = window.location.pathname.split('/');
      segments[1] = next;
      router.push(`${segments.join('/')}${window.location.search}`);
    } else {
      router.refresh();
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium uppercase text-text-muted hover:bg-pink-tint hover:text-text',
          className,
        )}
        aria-label={t('label')}
      >
        <Languages className="h-4 w-4" aria-hidden="true" />
        {locale}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {(['hu', 'de', 'en'] as const).map((option) => (
          <DropdownMenuItem
            key={option}
            onSelect={() => {
              select(option);
            }}
            lang={option}
          >
            <span className="flex-1">{t(option)}</span>
            {locale === option ? (
              <Check className="h-4 w-4 text-pink-text" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
