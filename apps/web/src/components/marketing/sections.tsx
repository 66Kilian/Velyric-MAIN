import { cn } from '@velyric/ui';
import { ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

export type MarketingHref = ComponentProps<typeof Link>['href'];

export type SectionWidth = 'wide' | 'content' | 'narrow';

const WIDTHS: Readonly<Record<SectionWidth, string>> = {
  wide: 'max-w-7xl',
  content: 'max-w-5xl',
  narrow: 'max-w-3xl',
};

export function Section({
  children,
  width = 'content',
  className,
  labelledBy,
}: {
  readonly children: ReactNode;
  readonly width?: SectionWidth;
  readonly className?: string;
  readonly labelledBy?: string;
}) {
  return (
    <section
      {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
      className={cn('mx-auto w-full px-4 py-12 md:px-8', WIDTHS[width], className)}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  id,
  eyebrow,
  title,
  body,
}: {
  readonly id: string;
  readonly eyebrow?: string;
  readonly title: string;
  readonly body?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {eyebrow === undefined ? null : <span className="vly-eyebrow">{eyebrow}</span>}
      <h2 id={id} className="text-[28px] font-bold tracking-[-0.02em] text-text md:text-[34px]">
        {title}
      </h2>
      {body === undefined ? null : <p className="max-w-3xl text-text-muted">{body}</p>}
    </div>
  );
}

export interface BreadcrumbEntry {
  readonly label: string;
  readonly href: MarketingHref;
}

export function Breadcrumbs({
  items,
  current,
  label,
}: {
  readonly items: readonly BreadcrumbEntry[];
  readonly current: string;
  readonly label: string;
}) {
  return (
    <nav aria-label={label} className="mx-auto w-full max-w-5xl px-4 pt-8 md:px-8">
      <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-text-muted">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <Link href={item.href} className="hover:text-text">
              {item.label}
            </Link>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </li>
        ))}
        <li aria-current="page" className="text-text">
          {current}
        </li>
      </ol>
    </nav>
  );
}

export function AnswerBlock({
  id,
  question,
  answer,
  children,
  level = 'h2',
}: {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly children?: ReactNode;
  readonly level?: 'h2' | 'h3';
}) {
  const Heading = level;
  return (
    <div className="flex flex-col gap-3">
      <Heading
        id={id}
        className={cn(
          'font-bold tracking-[-0.02em] text-text',
          level === 'h2' ? 'text-[24px] md:text-[28px]' : 'text-[19px]',
        )}
      >
        {question}
      </Heading>
      <p className="max-w-3xl text-[17px] leading-relaxed text-text">{answer}</p>
      {children}
    </div>
  );
}

export function Prose({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-4 text-[16px] leading-relaxed text-text-muted">
      {children}
    </div>
  );
}

export function FeatureCard({
  title,
  body,
  icon,
}: {
  readonly title: string;
  readonly body: string;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft">
      {icon === undefined ? null : (
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pink-tint text-pink-text">
          {icon}
        </span>
      )}
      <h3 className="text-lg font-semibold text-text">{title}</h3>
      <p className="text-sm text-text-muted">{body}</p>
    </div>
  );
}

export function CardGrid({
  children,
  columns = 3,
}: {
  readonly children: ReactNode;
  readonly columns?: 2 | 3;
}) {
  return (
    <div
      className={cn(
        'mt-8 grid gap-4 sm:grid-cols-2',
        columns === 3 ? 'lg:grid-cols-3' : undefined,
      )}
    >
      {children}
    </div>
  );
}

export interface WorkflowStep {
  readonly title: string;
  readonly body: string;
}

export function StepList({ steps }: { readonly steps: readonly WorkflowStep[] }) {
  return (
    <ol className="mt-8 flex flex-col gap-4">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="flex gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pink-tint font-mono text-sm font-semibold text-pink-text">
            {index + 1}
          </span>
          <span className="flex flex-col gap-1">
            <span className="font-semibold text-text">{step.title}</span>
            <span className="text-sm text-text-muted">{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

export function FaqList({
  items,
  headingId,
  heading,
}: {
  readonly items: readonly FaqEntry[];
  readonly headingId: string;
  readonly heading: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <h2 id={headingId} className="text-[28px] font-bold tracking-[-0.02em] text-text">
        {heading}
      </h2>
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {items.map((item) => (
          <details key={item.question} className="group px-5 py-4 open:bg-surface-muted">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-semibold text-text">
              {item.question}
              <ChevronRight
                className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-text-muted">
              {item.answer}
            </p>
          </details>
        ))}
      </div>
    </div>
  );
}

export interface ComparisonRow {
  readonly criterion: string;
  readonly values: readonly string[];
}

export function ComparisonTable({
  caption,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly ComparisonRow[];
}) {
  return (
    <div className="mt-8 w-full overflow-x-auto rounded-xl border border-border bg-surface shadow-soft">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
              {columns[0]}
            </th>
            {columns.slice(1).map((column) => (
              <th
                key={column}
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.criterion}>
              <th scope="row" className="px-4 py-3 align-top font-semibold text-text">
                {row.criterion}
              </th>
              {row.values.map((value, index) => (
                <td
                  key={`${row.criterion}-${String(index)}`}
                  className="px-4 py-3 align-top text-text-muted"
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KeyFacts({
  items,
}: {
  readonly items: readonly { readonly term: string; readonly value: string }[];
}) {
  return (
    <dl className="mt-8 grid gap-x-8 gap-y-4 rounded-xl border border-border bg-surface p-6 shadow-soft sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.term} className="flex flex-col gap-1">
          <dt className="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
            {item.term}
          </dt>
          <dd className="text-[15px] text-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface RelatedLink {
  readonly label: string;
  readonly description: string;
  readonly href: MarketingHref;
}

export function RelatedLinks({
  heading,
  headingId,
  links,
}: {
  readonly heading: string;
  readonly headingId: string;
  readonly links: readonly RelatedLink[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <h2 id={headingId} className="text-[28px] font-bold tracking-[-0.02em] text-text">
        {heading}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.label}>
            <Link
              href={link.href}
              className="flex h-full flex-col gap-1 rounded-xl border border-border bg-surface p-5 shadow-soft transition-colors hover:border-pink/40"
            >
              <span className="font-semibold text-text">{link.label}</span>
              <span className="text-sm text-text-muted">{link.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PrimaryCta({
  href,
  children,
}: {
  readonly href: MarketingHref;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="vly-gradient-cta inline-flex h-12 items-center rounded-full px-6 text-[15px] font-semibold shadow-cta"
    >
      {children}
    </Link>
  );
}

export function SecondaryCta({
  href,
  children,
}: {
  readonly href: MarketingHref;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-12 items-center rounded-full border border-border bg-surface px-6 text-[15px] font-semibold text-text shadow-soft hover:border-pink/40"
    >
      {children}
    </Link>
  );
}
