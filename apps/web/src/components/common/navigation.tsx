'use client';

import { cn } from '@velyric/ui';
import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';

export function SectionTabs({
  items,
  label,
}: {
  readonly items: readonly {
    readonly href: string;
    readonly label: string;
    readonly exact?: boolean;
  }[];
  readonly label: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mb-px flex gap-1 overflow-x-auto border-b border-border">
      {items.map((item) => {
        const active =
          item.exact === true
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors',
              active
                ? 'border-pink text-text'
                : 'border-transparent text-text-muted hover:text-text',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function CursorPager({ nextCursor }: { readonly nextCursor: string | null }) {
  const t = useTranslations('common.pagination');
  const pathname = usePathname();
  const params = useSearchParams();
  const hasPrevious = params.has('cursor');
  if (nextCursor === null && !hasPrevious) {
    return null;
  }
  const first = new URLSearchParams(params.toString());
  first.delete('cursor');
  const next = new URLSearchParams(params.toString());
  if (nextCursor !== null) {
    next.set('cursor', nextCursor);
  }
  const linkClass =
    'inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-surface-muted';
  return (
    <div className="flex items-center justify-end gap-2 pt-4">
      {hasPrevious ? (
        <Link
          className={linkClass}
          href={`${pathname}${first.size === 0 ? '' : `?${first.toString()}`}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {t('first')}
        </Link>
      ) : null}
      {nextCursor === null ? null : (
        <Link className={linkClass} href={`${pathname}?${next.toString()}`}>
          {t('next')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

export function CopyButton({
  value,
  label,
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly className?: string;
}) {
  const t = useTranslations('common.actions');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-text-muted hover:bg-pink-tint hover:text-text',
        className,
      )}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1800);
      }}
    >
      {copied ? (
        <Check className="h-4 w-4 text-success" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? t('copied') : t('copy')}
    </button>
  );
}
