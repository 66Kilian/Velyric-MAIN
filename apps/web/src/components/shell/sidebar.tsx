'use client';

import { cn } from '@velyric/ui';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function SidebarGroupLabel({ children }: { readonly children: ReactNode }) {
  return (
    <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted/70">
      {children}
    </p>
  );
}

export function SidebarLink({
  href,
  icon: Icon,
  label,
  active,
  onNavigate,
}: {
  readonly href: string;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active: boolean;
  readonly onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link
      href={href}
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-10 items-center gap-3 rounded-lg px-2 text-[14px] font-medium transition-colors duration-150',
        active
          ? 'bg-pink-tint-strong text-pink-text'
          : 'text-text-muted hover:bg-pink-tint hover:text-text',
      )}
    >
      {active ? (
        <span
          className="absolute -left-3 top-2 bottom-2 w-[3px] rounded-r-full bg-pink"
          aria-hidden="true"
        />
      ) : null}
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-surface text-pink-text shadow-soft'
            : 'text-text-muted group-hover:text-text',
        )}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}
