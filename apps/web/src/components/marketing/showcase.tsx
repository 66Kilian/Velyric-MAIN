import { PLAN_CATALOG } from '@velyric/contracts';
import { Badge, KpiCard, StatusDot, VelyricMark, cn } from '@velyric/ui';
import {
  BarChart3,
  Bot,
  CalendarCheck,
  Check,
  Globe2,
  LayoutDashboard,
  Link2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Settings,
  ShieldCheck,
  Users,
  Volume2,
  Grid3x3,
  type LucideIcon,
} from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ComponentProps } from 'react';
import { Link } from '@/i18n/navigation';
import { formatMinor } from '@/lib/format';
import { webConfig } from '@/server/config';

function Waveform({ className }: { readonly className?: string }) {
  const bars = [
    6, 14, 22, 30, 18, 36, 26, 44, 30, 20, 38, 48, 34, 22, 40, 28, 16, 32, 24, 12, 26, 18, 10, 6,
  ];
  return (
    <svg viewBox="0 0 240 60" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vly-wave" x1="0" x2="1">
          <stop offset="0" stopColor="#E600FF" />
          <stop offset="1" stopColor="#FF1740" />
        </linearGradient>
      </defs>
      {bars.map((height, index) => (
        <rect
          key={index}
          x={index * 10 + 2}
          y={30 - height / 2}
          width="4"
          height={height}
          rx="2"
          fill="url(#vly-wave)"
        />
      ))}
    </svg>
  );
}

export async function HeroVisual() {
  const t = await getTranslations('marketing.hero.visual');
  return (
    <div className="relative mx-auto h-[520px] w-full max-w-[520px]" aria-hidden="true">
      <div className="absolute left-1/2 top-4 h-[480px] w-[250px] -translate-x-1/2 rotate-[8deg] rounded-[44px] border-[6px] border-[#1b1c24] bg-[#0b0b10] p-5 shadow-float">
        <div className="flex h-full flex-col items-center justify-between rounded-[32px] bg-gradient-to-b from-[#16121d] to-[#0b0b10] py-10">
          <div className="flex flex-col items-center gap-2">
            <VelyricMark className="h-10" />
            <span className="text-lg font-semibold text-white">Velyric</span>
            <span className="text-xs tabular-nums text-white/70">00:24</span>
          </div>
          <Waveform className="h-16 w-48" />
          <div className="flex flex-col items-center gap-5">
            <div className="flex gap-4 text-white/80">
              {[MicOff, Grid3x3, Volume2].map((Icon, index) => (
                <span
                  key={index}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10"
                >
                  <Icon className="h-5 w-5" />
                </span>
              ))}
            </div>
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#FF3B4E] text-white">
              <PhoneOff className="h-5 w-5" />
            </span>
          </div>
        </div>
      </div>
      <div className="vly-glass absolute left-0 top-16 w-52 -rotate-3 rounded-xl p-3 text-sm">
        <div className="flex items-center gap-2">
          <VelyricMark className="h-5" />
          <span className="font-semibold text-text">Velyric</span>
        </div>
        <p className="mt-1 text-text">{t('greeting')}</p>
      </div>
      <div className="vly-glass absolute right-0 top-40 w-60 rotate-2 rounded-xl p-3 text-sm">
        <div className="flex items-center gap-2 text-text-muted">
          <Mic className="h-4 w-4 text-pink" />
          {t('caller')}
        </div>
        <p className="mt-1 text-text">{t('request')}</p>
      </div>
      <div className="vly-glass absolute bottom-10 right-4 w-60 rounded-xl p-4 text-sm">
        <p className="flex items-center gap-2 font-semibold text-text">
          <CalendarCheck className="h-4 w-4 text-success" />
          {t('booked')}
        </p>
        <p className="mt-1 text-text-muted">{t('bookedDetail')}</p>
      </div>
    </div>
  );
}

const FEATURES: readonly {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly href: ComponentProps<typeof Link>['href'] | null;
}[] = [
  { key: 'multilingual', icon: Globe2, href: { pathname: '/multilingual' } },
  { key: 'conversation', icon: Mic, href: { pathname: '/ai-receptionist' } },
  { key: 'booking', icon: CalendarCheck, href: { pathname: '/appointment-booking' } },
  { key: 'integrations', icon: Link2, href: { pathname: '/integrations' } },
  { key: 'handoff', icon: Users, href: { pathname: '/call-transfer' } },
  { key: 'analytics', icon: BarChart3, href: null },
];

export async function FeatureGrid() {
  const t = await getTranslations('marketing.features');
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map((feature) => {
        const inner = (
          <>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-pink-tint text-pink-text">
              <feature.icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-semibold text-text">{t(`${feature.key}.title`)}</h3>
              <p className="mt-1 text-sm text-text-muted">{t(`${feature.key}.body`)}</p>
            </div>
          </>
        );
        const classes = 'flex gap-4 rounded-xl border border-border bg-surface/90 p-5 shadow-soft';
        return feature.href === null ? (
          <div key={feature.key} className={classes}>
            {inner}
          </div>
        ) : (
          <Link
            key={feature.key}
            href={feature.href}
            className={`${classes} transition-colors hover:border-pink/40`}
          >
            {inner}
          </Link>
        );
      })}
    </div>
  );
}

export async function DashboardShowcase() {
  const t = await getTranslations('marketing.showcase');
  const nav: readonly { readonly key: string; readonly icon: LucideIcon }[] = [
    { key: 'dashboard', icon: LayoutDashboard },
    { key: 'calls', icon: PhoneCall },
    { key: 'agents', icon: Bot },
    { key: 'contacts', icon: Users },
    { key: 'integrations', icon: Link2 },
    { key: 'analytics', icon: BarChart3 },
    { key: 'settings', icon: Settings },
  ];
  const calls = [
    { number: '+36 30 *** **12', tag: 'booking', time: '02:14', tone: 'violet' },
    { number: '+49 176 *** **89', tag: 'support', time: '01:03', tone: 'sky' },
    { number: '+36 1 *** **45', tag: 'lead', time: '00:48', tone: 'peach' },
  ] as const;
  return (
    <figure className="overflow-hidden rounded-2xl border border-border bg-surface shadow-float">
      <div className="flex">
        <div className="hidden w-44 shrink-0 flex-col gap-1 border-r border-border p-3 md:flex">
          <div className="mb-3 flex items-center gap-2 px-2">
            <VelyricMark className="h-6" />
            <span className="font-bold text-text">Velyric</span>
          </div>
          {nav.map((item, index) => (
            <span
              key={item.key}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
                index === 0 ? 'bg-pink-tint-strong text-pink-text' : 'text-text-muted',
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {t(`nav.${item.key}`)}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-5">
          <div>
            <p className="text-lg font-bold text-text">{t('welcome')}</p>
            <p className="text-xs text-text-muted">{t('subtitle')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiCard
              label={t('kpi.calls')}
              value="248"
              delta={12}
              trend={[4, 6, 5, 8, 7, 11, 9, 12]}
              color="pink"
              className="px-3 pt-3"
            />
            <KpiCard
              label={t('kpi.duration')}
              value="4:12"
              delta={8}
              trend={[5, 4, 6, 5, 7, 6, 8, 7]}
              color="violet"
              className="px-3 pt-3"
            />
            <KpiCard
              label={t('kpi.resolution')}
              value="89%"
              delta={6}
              trend={[6, 7, 6, 8, 8, 9, 8, 9]}
              color="magenta"
              className="px-3 pt-3"
            />
            <KpiCard
              label={t('kpi.quality')}
              value="4.8"
              suffix="/5"
              delta={4}
              trend={[3, 4, 3, 5, 4, 5, 6, 5]}
              color="coral"
              className="px-3 pt-3"
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-border p-3">
              <p className="mb-2 text-sm font-semibold text-text">{t('liveCalls')}</p>
              <ul className="flex flex-col gap-2.5">
                {calls.map((call) => (
                  <li key={call.number} className="flex items-center gap-2 text-[13px]">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-tint text-pink-text">
                      <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="flex flex-1 flex-col">
                      <span className="tabular-nums text-text">{call.number}</span>
                      <span className="flex items-center gap-1 text-[11px] text-text-muted">
                        <StatusDot pulse />
                        {t('inProgress')} · {call.time}
                      </span>
                    </span>
                    <Badge tone={call.tone}>{t(`tags.${call.tag}`)}</Badge>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-border p-3 text-[13px]">
              <p className="mb-2 text-sm font-semibold text-text">{t('summary')}</p>
              <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5">
                <dt className="text-text-muted">{t('duration')}</dt>
                <dd className="text-text">4:12</dd>
                <dt className="text-text-muted">{t('outcome')}</dt>
                <dd>
                  <Badge tone="success">{t('booked')}</Badge>
                </dd>
              </dl>
              <p className="mt-2 text-text">{t('summaryText')}</p>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="border-t border-border px-4 py-2 text-center text-xs text-text-muted">
        {t('caption')}
      </figcaption>
    </figure>
  );
}

export async function PricingCards({ compact = false }: { readonly compact?: boolean }) {
  const t = await getTranslations('marketing.pricing');
  const locale = await getLocale();
  const plans = (['START', 'BUSINESS', 'PRO'] as const).map((code) => ({
    code,
    plan: PLAN_CATALOG[code],
    price: PLAN_CATALOG[code].prices.find((entry) => entry.market === 'HU') ?? null,
  }));
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {plans.map(({ code, plan, price }) => (
        <div
          key={code}
          className={cn(
            'flex flex-col gap-4 rounded-2xl border bg-surface p-6 shadow-soft',
            code === 'BUSINESS' ? 'border-pink ring-2 ring-pink-tint-strong' : 'border-border',
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-text">{t(`plans.${code}.name`)}</h3>
            {code === 'BUSINESS' ? <Badge tone="pink">{t('popular')}</Badge> : null}
          </div>
          {price === null ? null : (
            <p className="flex items-baseline gap-1">
              <span className="text-3xl font-bold tabular-nums text-text">
                {formatMinor(price.monthlyNetMinor, price.currency, locale)}
              </span>
              <span className="text-sm text-text-muted">{t('perMonth')}</span>
            </p>
          )}
          <p className="text-sm text-text-muted">{t(`plans.${code}.description`)}</p>
          <ul className="flex flex-col gap-2 text-sm text-text">
            {[
              t('minutes', { minutes: Math.round((plan.includedVoiceSeconds ?? 0) / 60) }),
              t('concurrent', { count: plan.concurrentCalls }),
              t('numbers', { count: plan.includedPhoneNumbers }),
              ...(price === null
                ? []
                : [
                    t('overage', {
                      price: formatMinor(price.overagePerMinuteNetMinor, price.currency, locale),
                    }),
                  ]),
              ...(compact ? [] : [t(`plans.${code}.highlight`)]),
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-pink" aria-hidden="true" />
                {line}
              </li>
            ))}
          </ul>
          <Link
            href="/signup"
            className={cn(
              'mt-auto inline-flex h-11 items-center justify-center rounded-full text-sm font-semibold',
              code === 'BUSINESS'
                ? 'vly-gradient-cta shadow-cta'
                : 'border border-pink text-pink-text hover:bg-pink-tint',
            )}
          >
            {t('cta')}
          </Link>
        </div>
      ))}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-soft">
        <h3 className="text-lg font-semibold text-text">{t('plans.ENTERPRISE.name')}</h3>
        <p className="text-3xl font-bold text-text">{t('custom')}</p>
        <p className="text-sm text-text-muted">{t('plans.ENTERPRISE.description')}</p>
        <ul className="flex flex-col gap-2 text-sm text-text">
          {['sso', 'sla', 'redundancy', 'byok'].map((key) => (
            <li key={key} className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-pink" aria-hidden="true" />
              {t(`enterprise.${key}`)}
            </li>
          ))}
        </ul>
        <a
          href={`mailto:${webConfig().legalEntity.salesEmail}`}
          className="mt-auto inline-flex h-11 items-center justify-center rounded-full border border-pink text-sm font-semibold text-pink-text hover:bg-pink-tint"
        >
          {t('contactSales')}
        </a>
      </div>
    </div>
  );
}

export async function BottomCta() {
  const t = await getTranslations('marketing.cta');
  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-16 md:px-8">
      <div className="vly-gradient-banner flex flex-col items-start gap-6 rounded-[28px] px-8 py-10 md:flex-row md:items-center md:px-12">
        <VelyricMark className="hidden h-16 md:block" />
        <div className="flex-1">
          <h2 className="text-2xl font-bold md:text-3xl">{t('title')}</h2>
          <p className="mt-2 max-w-2xl text-white/90">{t('body')}</p>
        </div>
        <Link
          href="/signup"
          className="inline-flex h-12 items-center rounded-full bg-white px-6 text-sm font-semibold text-[#8E0069] shadow-soft"
        >
          {t('button')}
        </Link>
      </div>
    </section>
  );
}
