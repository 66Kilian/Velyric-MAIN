import { Slot } from 'radix-ui';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export function cn(...values: readonly (string | false | null | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'vly-gradient-cta shadow-cta hover:brightness-105 active:brightness-95',
  secondary: 'bg-surface text-text border border-border shadow-soft hover:bg-surface-muted',
  outline: 'bg-transparent text-pink-text border border-pink hover:bg-pink-tint',
  ghost: 'bg-transparent text-text hover:bg-pink-tint',
  danger: 'bg-danger text-on-accent hover:brightness-105',
};

const BUTTON_SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2',
  icon: 'h-9 w-9 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly asChild?: boolean;
  readonly loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    asChild = false,
    loading = false,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-md font-semibold transition-[filter,background-color,box-shadow,transform] duration-150 ease-standard disabled:pointer-events-none disabled:opacity-50 select-none',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

export function Spinner({
  className,
  label,
}: {
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      role={label === undefined ? undefined : 'status'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-lg border border-border bg-surface shadow-soft', className)}
      {...props}
    />
  );
});

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-5', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'text-[15px] font-semibold leading-snug tracking-[-0.01em] text-text',
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-text-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-5 py-3',
        className,
      )}
      {...props}
    />
  );
}

export type BadgeTone =
  'neutral' | 'pink' | 'sky' | 'peach' | 'mint' | 'violet' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-[var(--tag-neutral-bg)] text-[var(--tag-neutral-text)]',
  pink: 'bg-[var(--tag-pink-bg)] text-[var(--tag-pink-text)]',
  sky: 'bg-[var(--tag-sky-bg)] text-[var(--tag-sky-text)]',
  peach: 'bg-[var(--tag-peach-bg)] text-[var(--tag-peach-text)]',
  mint: 'bg-[var(--tag-mint-bg)] text-[var(--tag-mint-text)]',
  violet: 'bg-[var(--tag-violet-bg)] text-[var(--tag-violet-text)]',
  success: 'bg-[var(--tag-mint-bg)] text-success-text',
  warning: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warning-text',
  danger: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger-text',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { readonly tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium leading-5 whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function StatusDot({
  tone = 'success',
  pulse = false,
  className,
}: {
  readonly tone?: 'success' | 'warning' | 'danger' | 'neutral';
  readonly pulse?: boolean;
  readonly className?: string;
}) {
  const color =
    tone === 'success'
      ? 'bg-success'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'danger'
          ? 'bg-danger'
          : 'bg-text-muted';
  return (
    <span className={cn('relative inline-flex h-2 w-2', className)} aria-hidden="true">
      {pulse ? (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            color,
          )}
        />
      ) : null}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', color)} />
    </span>
  );
}

const FIELD_CLASSES =
  'w-full rounded-sm border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted/70 shadow-[0_1px_1px_rgb(7_19_39/0.03)] transition-colors duration-150 focus:border-pink focus:outline-none focus:ring-2 focus:ring-pink-tint-strong disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_CLASSES, 'h-10', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD_CLASSES, 'min-h-24 py-2 leading-relaxed', className)}
      {...props}
    />
  );
});

export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          FIELD_CLASSES,
          'h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235B6578' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-text', className)} {...props} />;
}

export interface FieldProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-0.5 text-pink-text" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error !== undefined && error !== null && error !== false ? (
        <p id={`${id}-error`} role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="text-[13px] text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-sm bg-skeleton', className)} aria-hidden="true" />
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center',
        className,
      )}
    >
      {icon === undefined ? null : (
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-pink-tint text-pink-text">
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-[15px] font-semibold text-text">{title}</p>
        {description === undefined ? null : (
          <p className="text-sm text-text-muted">{description}</p>
        )}
      </div>
      {action ?? null}
    </div>
  );
}

export function Avatar({
  name,
  src,
  size = 36,
  className,
}: {
  readonly name: string;
  readonly src?: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-muted text-[13px] font-semibold text-text-muted ring-1 ring-border',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {src === undefined ? (
        initials
      ) : (
        <img src={src} alt="" className="h-full w-full object-cover" />
      )}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow === undefined ? null : <span className="vly-eyebrow">{eyebrow}</span>}
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-text">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="text-sm text-text-muted">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded-xs border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
      {children}
    </kbd>
  );
}
