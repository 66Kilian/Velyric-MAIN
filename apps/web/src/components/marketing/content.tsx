import type { ReactNode } from 'react';

export function MarketingHero({
  eyebrow,
  title,
  body,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly children?: ReactNode;
}) {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-5 px-4 pb-8 pt-14 text-center md:px-8">
      <span className="vly-eyebrow">{eyebrow}</span>
      <h1 className="text-[36px] font-bold leading-tight tracking-[-0.03em] text-text md:text-[48px]">
        {title}
      </h1>
      <p className="max-w-2xl text-lg text-text-muted">{body}</p>
      {children}
    </section>
  );
}

export function FeatureBlocks({
  items,
}: {
  readonly items: readonly {
    readonly title: string;
    readonly body: string;
    readonly icon: ReactNode;
  }[];
}) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-8 sm:grid-cols-2 md:px-8 lg:grid-cols-3">
      {items.map((item) => (
        <div
          key={item.title}
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pink-tint text-pink-text">
            {item.icon}
          </span>
          <h2 className="text-lg font-semibold text-text">{item.title}</h2>
          <p className="text-sm text-text-muted">{item.body}</p>
        </div>
      ))}
    </section>
  );
}
