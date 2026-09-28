'use client';

import { cn } from '@velyric/ui';
import { Check, ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { OrbTone } from '@/lib/setup';

const ORB_GRADIENTS: Readonly<Record<OrbTone, string>> = {
  violet:
    'radial-gradient(circle at 32% 26%, #ffffff 0%, #f5d0fe 10%, #d946ef 38%, #9333ea 64%, #6d28d9 82%, #ec4899 100%)',
  blue: 'radial-gradient(circle at 32% 26%, #ffffff 0%, #bae6fd 12%, #38bdf8 36%, #2563eb 68%, #1e3a8a 100%)',
  peach:
    'radial-gradient(circle at 32% 26%, #ffffff 0%, #fed7aa 14%, #fb923c 36%, #f472b6 66%, #be185d 100%)',
  emerald:
    'radial-gradient(circle at 32% 26%, #ffffff 0%, #bbf7d0 12%, #34d399 36%, #059669 66%, #064e3b 100%)',
  rose: 'radial-gradient(circle at 32% 26%, #ffffff 0%, #fecdd3 12%, #fb7185 38%, #e11d48 68%, #881337 100%)',
  indigo:
    'radial-gradient(circle at 32% 26%, #ffffff 0%, #c7d2fe 12%, #818cf8 36%, #4f46e5 66%, #312e81 100%)',
  teal: 'radial-gradient(circle at 32% 26%, #ffffff 0%, #99f6e4 12%, #2dd4bf 36%, #0d9488 66%, #134e4a 100%)',
  amber:
    'radial-gradient(circle at 32% 26%, #ffffff 0%, #fde68a 12%, #fbbf24 36%, #f97316 66%, #9a3412 100%)',
};

const ORB_GLOW: Readonly<Record<OrbTone, string>> = {
  violet: 'rgb(217 70 239 / 0.35)',
  blue: 'rgb(56 189 248 / 0.3)',
  peach: 'rgb(251 146 60 / 0.3)',
  emerald: 'rgb(52 211 153 / 0.3)',
  rose: 'rgb(251 113 133 / 0.3)',
  indigo: 'rgb(129 140 248 / 0.32)',
  teal: 'rgb(45 212 191 / 0.3)',
  amber: 'rgb(251 191 36 / 0.3)',
};

export function VoiceOrb({
  tone,
  size,
  muted = false,
  checked = false,
  className,
}: {
  readonly tone: OrbTone;
  readonly size: number;
  readonly muted?: boolean;
  readonly checked?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn('relative shrink-0 rounded-full', muted && 'opacity-60 saturate-75', className)}
      style={{
        width: size,
        height: size,
        backgroundImage: ORB_GRADIENTS[tone],
        boxShadow: `0 ${String(Math.round(size / 8))}px ${String(Math.round(size / 2))}px ${ORB_GLOW[tone]}, inset -${String(Math.round(size / 14))}px -${String(Math.round(size / 12))}px ${String(Math.round(size / 5))}px rgb(0 0 0 / 0.25)`,
      }}
    >
      <span
        className="absolute rounded-[50%] border border-white/30"
        style={{ inset: '18% 8% 22% 14%', transform: 'rotate(-28deg)' }}
      />
      {checked ? (
        <span
          className="absolute flex items-center justify-center rounded-full border-2 border-bg bg-[#14532d] text-[#86efac]"
          style={{
            width: size * 0.3,
            height: size * 0.3,
            right: -size * 0.02,
            bottom: -size * 0.02,
          }}
        >
          <Check className="h-1/2 w-1/2" strokeWidth={3} />
        </span>
      ) : null}
    </div>
  );
}

export function Pill({
  selected,
  onClick,
  children,
  disabled = false,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 min-w-24 items-center justify-center gap-1.5 rounded-full border px-4 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-pink/60 bg-pink-tint-strong font-medium text-text'
          : 'border-border bg-surface text-text-muted hover:border-pink/40 hover:text-text',
      )}
    >
      {selected ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Panel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('rounded-2xl border border-border bg-surface p-5 md:p-6', className)}>
      {children}
    </div>
  );
}

export function SelectableCard({
  selected,
  onClick,
  title,
  description,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-start justify-between gap-3 rounded-2xl border p-5 text-left transition-colors duration-150',
        selected ? 'border-pink/60 bg-pink-tint' : 'border-border bg-surface hover:border-pink/40',
      )}
    >
      <span className="flex flex-col gap-2">
        <span className="text-[16px] font-semibold text-text">{title}</span>
        <span className="text-[13px] text-text-muted">{description}</span>
      </span>
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-pink bg-pink text-on-accent' : 'border-border',
        )}
      >
        {selected ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" /> : null}
      </span>
    </button>
  );
}

export function Collapsible({
  label,
  children,
  defaultOpen = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-text-muted hover:text-text"
      >
        {label}
        <ChevronDown
          className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function InfoNote({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="rounded-2xl border border-pink/25 bg-pink-tint px-5 py-4">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-pink-text">
        <Check className="h-4 w-4" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1.5 text-[13px] text-text-muted">{body}</p>
    </div>
  );
}

export function CheckBadge({ done }: { readonly done: boolean }) {
  return (
    <span
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
        done ? 'bg-success/20 text-success-text' : 'border border-border text-text-muted',
      )}
      aria-hidden="true"
    >
      {done ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  );
}
