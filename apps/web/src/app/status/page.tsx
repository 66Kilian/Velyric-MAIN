import { VelyricLogo } from '@velyric/ui';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { webConfig } from '@/server/config';
import { fetchHetrixUptimeMonitors, type HetrixMonitor } from '@/server/hetrixtools';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.status');
  return { title: t('title'), robots: { index: false, follow: true } };
}

const LOCATION_LABELS: Record<string, string> = {
  new_york: 'New York',
  san_francisco: 'San Francisco',
  dallas: 'Dallas',
  amsterdam: 'Amsterdam',
  london: 'London',
  frankfurt: 'Frankfurt',
  singapore: 'Singapore',
  sydney: 'Sydney',
  sao_paulo: 'São Paulo',
  tokyo: 'Tokyo',
  mumbai: 'Mumbai',
  warsaw: 'Warsaw',
};

function locationLabel(key: string): string {
  return LOCATION_LABELS[key] ?? key;
}

function StatusPill({ up, label }: { readonly up: boolean; readonly label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold ${
        up ? 'bg-success/15 text-success-text' : 'bg-danger/15 text-danger-text'
      }`}
    >
      {up ? (
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
      ) : (
        <XCircle className="h-4 w-4" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

function MonitorCard({
  monitor,
  upLabel,
  downLabel,
  uptimeLabel,
}: {
  readonly monitor: HetrixMonitor;
  readonly upLabel: string;
  readonly downLabel: string;
  readonly uptimeLabel: string;
}) {
  const up = monitor.uptimeStatus === 'up';
  const locations = Array.from(monitor.locations.entries());
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-text">{monitor.name}</h2>
        </div>
        <StatusPill up={up} label={up ? upLabel : downLabel} />
      </div>
      <div className="mt-4 flex items-center gap-2 text-[13px] text-text-muted">
        <span>{uptimeLabel}</span>
        <span className="font-mono font-semibold text-text">{monitor.uptimePercent.toFixed(2)}%</span>
      </div>
      {locations.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 sm:grid-cols-4">
          {locations.map(([key, location]) => (
            <div key={key} className="flex items-center gap-2 text-[12px] text-text-muted">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  location.uptimeStatus === 'up' ? 'bg-success' : 'bg-danger'
                }`}
                aria-hidden="true"
              />
              <span>{locationLabel(key)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default async function StatusPage() {
  const config = webConfig();
  if (config.hetrixtoolsApiKey === null && config.statusPageUrl !== null) {
    redirect(config.statusPageUrl);
  }
  const t = await getTranslations('legal.status');

  let monitors: HetrixMonitor[] = [];
  let fetchFailed = false;
  if (config.hetrixtoolsApiKey !== null) {
    try {
      monitors = await fetchHetrixUptimeMonitors(config.hetrixtoolsApiKey);
    } catch {
      fetchFailed = true;
    }
  }

  if (config.hetrixtoolsApiKey === null || fetchFailed || monitors.length === 0) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg px-4 text-center">
        <VelyricLogo />
        <h1 className="text-2xl font-bold text-text">{t('title')}</h1>
        <p className="max-w-md text-text-muted">{t('body')}</p>
      </main>
    );
  }

  const allUp = monitors.every((monitor) => monitor.uptimeStatus === 'up');

  return (
    <main className="min-h-dvh bg-bg px-4 py-16">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 text-center">
        <VelyricLogo />
        <h1 className="text-2xl font-bold text-text">{t('title')}</h1>
        <StatusPill up={allUp} label={allUp ? t('overallOperational') : t('overallIssues')} />
      </div>
      <div className="mx-auto mt-10 flex w-full max-w-3xl flex-col gap-4">
        {monitors.map((monitor) => (
          <MonitorCard
            key={monitor.id}
            monitor={monitor}
            upLabel={t('monitorUp')}
            downLabel={t('monitorDown')}
            uptimeLabel={t('uptime')}
          />
        ))}
      </div>
    </main>
  );
}
