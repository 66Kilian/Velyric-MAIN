import { sql } from 'kysely';
import Type from 'typebox';
import { inTenant, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { requireTenantActor } from '../principal.js';
import { Uuid } from './common.js';

const MAX_RANGE_DAYS = 92;
const RESOLVED_OUTCOMES = [
  'RESOLVED',
  'INFORMATION_PROVIDED',
  'BOOKING_CREATED',
  'BOOKING_CHANGED',
  'BOOKING_CANCELED',
  'WAITLISTED',
  'LEAD_CAPTURED',
  'CALLBACK_REQUESTED',
  'MESSAGE_TAKEN',
];
const FINISHED_STATUSES = ['COMPLETED', 'FAILED', 'REJECTED', 'ABANDONED', 'TRANSFERRED'];

const OverviewQuery = Type.Object(
  {
    from: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    to: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    location_id: Type.Optional(Uuid),
    agent_id: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

function dayNumber(value: string, path: string): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'date' }] });
  }
  return parsed / 86_400_000;
}

function ratio(part: number, total: number): number | null {
  return total === 0 ? null : Number((part / total).toFixed(4));
}

export const registerAnalyticsRoutes: RouteModule = (app, services) => {
  app.get('/v1/analytics/overview', { schema: { querystring: OverviewQuery } }, async (request) => {
    const query = request.query;
    const actor = requireTenantActor(
      request.principal,
      'analytics:read',
      query.location_id ?? undefined,
    );
    const from = dayNumber(query.from, '/querystring/from');
    const to = dayNumber(query.to, '/querystring/to');
    if (to < from || to - from + 1 > MAX_RANGE_DAYS) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: '/querystring/to', rule: `range_1_to_${String(MAX_RANGE_DAYS)}_days` }],
      });
    }
    return inTenant(services, actor, request, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select(['timezone'])
        .where('id', '=', actor.tenantId)
        .executeTakeFirstOrThrow();
      const zone = tenant.timezone;
      const locationFilter =
        query.location_id !== undefined
          ? sql`and c.location_id = ${query.location_id}::uuid`
          : actor.locationScope.length > 0
            ? sql`and c.location_id = any(${actor.locationScope}::uuid[])`
            : sql``;
      const agentFilter =
        query.agent_id === undefined ? sql`` : sql`and c.agent_id = ${query.agent_id}::uuid`;
      const window = sql`c.started_at >= (${query.from}::date::timestamp at time zone ${zone})
        and c.started_at < ((${query.to}::date + 1)::timestamp at time zone ${zone})
        and c.status = any(${FINISHED_STATUSES}::text[])
        ${locationFilter} ${agentFilter}`;

      const totals = await sql<{
        calls_total: string;
        resolved: string;
        transferred: string;
        abandoned: string;
        rejected: string;
        bookings: string;
        connected_seconds: string;
        avg_connected_seconds: string | null;
        cost_usd_micros: string;
        avg_quality: string | null;
        web_voice: string;
      }>`
        select count(*)::text as calls_total,
               count(*) filter (where c.outcome = any(${RESOLVED_OUTCOMES}::text[]))::text as resolved,
               count(*) filter (where c.outcome = 'TRANSFERRED_TO_HUMAN' or c.status = 'TRANSFERRED')::text as transferred,
               count(*) filter (where c.status = 'ABANDONED' or c.outcome = 'ABANDONED')::text as abandoned,
               count(*) filter (where c.status = 'REJECTED')::text as rejected,
               count(*) filter (where c.outcome = 'BOOKING_CREATED')::text as bookings,
               coalesce(sum(c.connected_seconds), 0)::text as connected_seconds,
               round(avg(c.connected_seconds) filter (where c.connected_seconds > 0), 1)::text as avg_connected_seconds,
               coalesce(sum(c.cost_usd_micros), 0)::text as cost_usd_micros,
               round(avg(c.quality_score), 2)::text as avg_quality,
               count(*) filter (where c.channel = 'WEB_VOICE')::text as web_voice
        from app.calls c
        where ${window}`.execute(trx);

      const daily = await sql<{
        day: string;
        calls_total: string;
        resolved: string;
        transferred: string;
        abandoned: string;
        avg_connected_seconds: string | null;
        avg_quality: string | null;
      }>`
        select to_char(timezone(${zone}, c.started_at)::date, 'YYYY-MM-DD') as day,
               count(*)::text as calls_total,
               count(*) filter (where c.outcome = any(${RESOLVED_OUTCOMES}::text[]))::text as resolved,
               count(*) filter (where c.outcome = 'TRANSFERRED_TO_HUMAN' or c.status = 'TRANSFERRED')::text as transferred,
               count(*) filter (where c.status = 'ABANDONED' or c.outcome = 'ABANDONED')::text as abandoned,
               round(avg(c.connected_seconds) filter (where c.connected_seconds > 0), 1)::text as avg_connected_seconds,
               round(avg(c.quality_score), 2)::text as avg_quality
        from app.calls c
        where ${window}
        group by 1
        order by 1`.execute(trx);

      const hours = await sql<{ hour: number; calls_total: string }>`
        select extract(hour from timezone(${zone}, c.started_at))::int as hour, count(*)::text as calls_total
        from app.calls c
        where ${window}
        group by 1
        order by 1`.execute(trx);

      const intents = await sql<{ intent: string | null; calls_total: string; resolved: string }>`
        select c.intent, count(*)::text as calls_total, count(*) filter (where c.outcome = any(${RESOLVED_OUTCOMES}::text[]))::text as resolved
        from app.calls c
        where ${window}
        group by c.intent
        order by count(*) desc
        limit 10`.execute(trx);

      const languages = await sql<{ language: string | null; calls_total: string }>`
        select c.language, count(*)::text as calls_total
        from app.calls c
        where ${window}
        group by c.language
        order by count(*) desc`.execute(trx);

      const tools = await sql<{
        tool_name: string;
        runs_total: string;
        runs_succeeded: string;
        latency_p95_ms: number | null;
      }>`
        select t.name as tool_name,
               count(*)::text as runs_total,
               count(*) filter (where r.status = 'SUCCEEDED')::text as runs_succeeded,
               percentile_cont(0.95) within group (order by r.latency_ms) as latency_p95_ms
        from app.tool_runs r
        join app.tool_definitions t on t.id = r.tool_definition_id
        join app.calls c on c.id = r.call_id
        where ${window}
        group by t.name
        order by count(*) desc
        limit 20`.execute(trx);

      const gaps = await trx
        .selectFrom('knowledge_gaps')
        .select(['id', 'question_example', 'occurrences', 'language', 'last_seen_at'])
        .where('status', '=', 'OPEN')
        .orderBy('occurrences', 'desc')
        .limit(5)
        .execute();

      const row = totals.rows[0];
      const callsTotal = Number(row?.calls_total ?? 0);
      const resolved = Number(row?.resolved ?? 0);
      const transferred = Number(row?.transferred ?? 0);
      const abandoned = Number(row?.abandoned ?? 0);
      return {
        range: { from: query.from, to: query.to, timezone: zone },
        totals: {
          calls_total: callsTotal,
          resolved_by_ai: resolved,
          transferred_to_human: transferred,
          abandoned,
          rejected: Number(row?.rejected ?? 0),
          web_voice_calls: Number(row?.web_voice ?? 0),
          bookings_created: Number(row?.bookings ?? 0),
          connected_minutes: Math.round(Number(row?.connected_seconds ?? 0) / 60),
          avg_connected_seconds:
            row?.avg_connected_seconds === null || row?.avg_connected_seconds === undefined
              ? null
              : Number(row.avg_connected_seconds),
          cost_usd_micros: Number(row?.cost_usd_micros ?? 0),
          avg_quality_score:
            row?.avg_quality === null || row?.avg_quality === undefined
              ? null
              : Number(row.avg_quality),
          containment_rate: ratio(resolved, callsTotal),
          transfer_rate: ratio(transferred, callsTotal),
          abandonment_rate: ratio(abandoned, callsTotal),
        },
        daily: daily.rows.map((entry) => ({
          date: entry.day,
          calls_total: Number(entry.calls_total),
          resolved_by_ai: Number(entry.resolved),
          transferred_to_human: Number(entry.transferred),
          abandoned: Number(entry.abandoned),
          avg_connected_seconds:
            entry.avg_connected_seconds === null ? null : Number(entry.avg_connected_seconds),
          avg_quality_score: entry.avg_quality === null ? null : Number(entry.avg_quality),
        })),
        hourly: hours.rows.map((entry) => ({
          hour: entry.hour,
          calls_total: Number(entry.calls_total),
        })),
        intents: intents.rows.map((entry) => ({
          intent: entry.intent ?? 'UNKNOWN',
          calls_total: Number(entry.calls_total),
          containment_rate: ratio(Number(entry.resolved), Number(entry.calls_total)),
        })),
        languages: languages.rows.map((entry) => ({
          language: entry.language ?? 'unknown',
          calls_total: Number(entry.calls_total),
        })),
        tools: tools.rows.map((entry) => ({
          tool_name: entry.tool_name,
          runs_total: Number(entry.runs_total),
          success_rate: ratio(Number(entry.runs_succeeded), Number(entry.runs_total)),
          latency_p95_ms: entry.latency_p95_ms === null ? null : Math.round(entry.latency_p95_ms),
        })),
        knowledge_gaps: gaps.map((gap) => ({
          id: gap.id,
          question: gap.question_example,
          occurrences: gap.occurrences,
          language: gap.language,
          last_seen_at: gap.last_seen_at.toISOString(),
        })),
      };
    });
  });
};
