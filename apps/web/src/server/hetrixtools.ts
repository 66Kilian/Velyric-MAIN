export interface HetrixLocationStatus {
  readonly uptimeStatus: 'up' | 'down';
  readonly responseTimeMs: number;
}

export interface HetrixMonitor {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly uptimeStatus: 'up' | 'down';
  readonly monitorStatus: string;
  readonly uptimePercent: number;
  readonly locations: ReadonlyMap<string, HetrixLocationStatus>;
}

interface RawMonitor {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly target?: unknown;
  readonly uptime_status?: unknown;
  readonly monitor_status?: unknown;
  readonly uptime?: unknown;
  readonly locations?: unknown;
}

interface RawListResponse {
  readonly monitors?: unknown;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asUptimeStatus(value: unknown): 'up' | 'down' {
  return value === 'up' ? 'up' : 'down';
}

function parseLocations(value: unknown): ReadonlyMap<string, HetrixLocationStatus> {
  const locations = new Map<string, HetrixLocationStatus>();
  if (typeof value !== 'object' || value === null) {
    return locations;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const entry = raw as { uptime_status?: unknown; response_time?: unknown };
    locations.set(key, {
      uptimeStatus: asUptimeStatus(entry.uptime_status),
      responseTimeMs: typeof entry.response_time === 'number' ? entry.response_time : 0,
    });
  }
  return locations;
}

function parseMonitor(raw: RawMonitor): HetrixMonitor | null {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null;
  }
  const uptimePercent = typeof raw.uptime === 'string' ? Number.parseFloat(raw.uptime) : 0;
  return {
    id: raw.id,
    name: raw.name,
    target: asString(raw.target, ''),
    uptimeStatus: asUptimeStatus(raw.uptime_status),
    monitorStatus: asString(raw.monitor_status, 'active'),
    uptimePercent: Number.isFinite(uptimePercent) ? uptimePercent : 0,
    locations: parseLocations(raw.locations),
  };
}

export async function fetchHetrixUptimeMonitors(apiKey: string): Promise<HetrixMonitor[]> {
  const response = await fetch(
    'https://api.hetrixtools.com/v3/uptime-monitors?per_page=100&order_by=name&order=asc',
    {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      next: { revalidate: 60 },
    },
  );
  if (!response.ok) {
    throw new Error(`hetrixtools uptime-monitors request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as RawListResponse;
  if (!Array.isArray(body.monitors)) {
    return [];
  }
  const monitors: HetrixMonitor[] = [];
  for (const raw of body.monitors) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const monitor = parseMonitor(raw as RawMonitor);
    if (monitor !== null) {
      monitors.push(monitor);
    }
  }
  return monitors;
}
