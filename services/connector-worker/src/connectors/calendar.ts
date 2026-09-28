import type { VelyricEnvironment } from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import type { Occupation } from '@velyric/domain';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  safeRequest,
  type EgressPolicy,
  type HostResolver,
} from '@velyric/security';
import type { Kysely } from 'kysely';
import type { BookingRecord, ServiceContext, TimeWindow } from '../booking-engine.js';
import type { CalendarProviderConfig } from '../config.js';
import { ToolExecutionError, readTenantSecret } from '../errors.js';
import type { TenantSecretReader } from '@velyric/tenant-secrets';
import type { CalendarEventSummary, CalendarSync } from '../tools/booking.js';

export type CalendarProvider = 'google' | 'microsoft';

const INTEGRATION_TYPE: Readonly<Record<CalendarProvider, string>> = {
  google: 'GOOGLE_CALENDAR',
  microsoft: 'MICROSOFT_365',
};
const PROVIDER_HOSTS: Readonly<Record<CalendarProvider, readonly string[]>> = {
  google: ['www.googleapis.com', 'oauth2.googleapis.com'],
  microsoft: ['graph.microsoft.com', 'login.microsoftonline.com'],
};
const MICROSOFT_SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite offline_access';
const MICROSOFT_BUSY_STATUSES = new Set(['busy', 'tentative', 'oof', 'workingElsewhere']);

interface HttpResult {
  readonly status: number;
  readonly json: unknown;
}

interface LinkedCalendar {
  readonly resourceId: string;
  readonly integrationId: string;
  readonly calendarRef: string;
}

export interface CalendarConnectorOptions {
  readonly provider: CalendarProvider;
  readonly config: CalendarProviderConfig;
  readonly db: Kysely<DB>;
  readonly secrets: TenantSecretReader;
  readonly environment: VelyricEnvironment;
  readonly allowHttp: boolean;
  readonly resolver?: HostResolver;
  readonly now?: () => number;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function graphDateTime(instant: Date): string {
  return instant.toISOString().slice(0, 19);
}

function parseGraphDateTime(value: unknown): number {
  const record = asRecord(value);
  const dateTime = asText(record['dateTime']);
  if (dateTime === null || (record['timeZone'] !== undefined && record['timeZone'] !== 'UTC')) {
    return Number.NaN;
  }
  return Date.parse(`${dateTime.slice(0, 23)}Z`);
}

export function buildCalendarEgressPolicy(
  provider: CalendarProvider,
  config: CalendarProviderConfig,
  allowHttp: boolean,
): EgressPolicy {
  const hosts = new Set(PROVIDER_HOSTS[provider]);
  const ports = new Set<number>([443]);
  for (const raw of [config.apiBaseUrl, config.tokenUrl]) {
    const url = new URL(raw);
    hosts.add(url.hostname);
    ports.add(url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port));
  }
  const simulator = config.mode === 'simulator';
  return {
    ...DEFAULT_EGRESS_POLICY,
    allowedHosts: [...hosts],
    allowHttp: allowHttp && simulator,
    allowedPorts: [...ports],
    allowedContentTypes: [],
    maxResponseBytes: 1_048_576,
    totalTimeoutMs: 8_000,
    trustedPrivateCidrs: simulator ? ['127.0.0.0/8', '::1/128'] : [],
  };
}

export class CalendarConnector implements CalendarSync {
  readonly #options: CalendarConnectorOptions;
  readonly #policy: EgressPolicy;
  readonly #tokens = new Map<
    string,
    { readonly accessToken: string; readonly expiresAt: number }
  >();
  readonly #now: () => number;

  constructor(options: CalendarConnectorOptions) {
    this.#options = options;
    this.#policy = buildCalendarEgressPolicy(options.provider, options.config, options.allowHttp);
    this.#now = options.now ?? Date.now;
  }

  get provider(): CalendarProvider {
    return this.#options.provider;
  }

  async #http(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Readonly<Record<string, string>>,
    body?: string,
  ): Promise<HttpResult> {
    try {
      const response = await safeRequest(
        {
          url,
          method,
          headers: { accept: 'application/json', ...headers },
          ...(body === undefined ? {} : { body }),
        },
        {
          policy: this.#policy,
          environment: this.#options.environment,
          ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
        },
      );
      const raw = new TextDecoder().decode(response.body);
      let json: unknown = null;
      if (raw !== '') {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        const timedOut = /timeout/i.test(error.reason);
        throw new ToolExecutionError(
          timedOut ? 'UPSTREAM_TIMEOUT' : 'EGRESS_BLOCKED',
          'calendar request was blocked or timed out',
          { retryable: timedOut, cause: error },
        );
      }
      throw new ToolExecutionError('PROVIDER_UNAVAILABLE', 'calendar provider is unreachable', {
        retryable: true,
        cause: error,
      });
    }
  }

  #failure(result: HttpResult, operation: string): ToolExecutionError {
    if (result.status === 429 || result.status >= 500) {
      return new ToolExecutionError('PROVIDER_UNAVAILABLE', `${operation} failed`, {
        retryable: true,
        httpStatus: result.status,
      });
    }
    if (result.status === 401) {
      return new ToolExecutionError('INTEGRATION_AUTH_EXPIRED', `${operation} was not authorized`, {
        httpStatus: result.status,
      });
    }
    if (result.status === 403) {
      return new ToolExecutionError(
        'PROVIDER_FORBIDDEN',
        `${operation} is not permitted for this calendar`,
        { httpStatus: result.status },
      );
    }
    return new ToolExecutionError('PROVIDER_ERROR', `${operation} was rejected`, {
      httpStatus: result.status,
    });
  }

  #tenantContext(tenantId: string, traceId: string) {
    return { tenantId, actorType: 'SERVICE' as const, actorId: 'connector-worker', traceId };
  }

  async #linkedCalendars(context: ServiceContext, traceId: string): Promise<LinkedCalendar[]> {
    const linked = context.resources.flatMap((resource) =>
      resource.calendarIntegrationId !== null && resource.externalCalendarRef !== null
        ? [
            {
              resourceId: resource.id,
              integrationId: resource.calendarIntegrationId,
              calendarRef: resource.externalCalendarRef,
            },
          ]
        : [],
    );
    if (linked.length === 0) {
      return [];
    }
    const integrationIds = [...new Set(linked.map((entry) => entry.integrationId))];
    const rows = await withTenantTransaction(
      this.#options.db,
      this.#tenantContext(context.tenantId, traceId),
      (trx) =>
        trx
          .selectFrom('integrations')
          .select(['id', 'integration_type'])
          .where('id', 'in', integrationIds)
          .execute(),
    );
    const matching = new Set(
      rows
        .filter((row) => row.integration_type === INTEGRATION_TYPE[this.#options.provider])
        .map((row) => row.id),
    );
    return linked.filter((entry) => matching.has(entry.integrationId));
  }

  async #accessToken(tenantId: string, integrationId: string, traceId: string): Promise<string> {
    const cached = this.#tokens.get(integrationId);
    if (cached !== undefined && cached.expiresAt - 60_000 > this.#now()) {
      return cached.accessToken;
    }
    const integration = await withTenantTransaction(
      this.#options.db,
      this.#tenantContext(tenantId, traceId),
      (trx) =>
        trx
          .selectFrom('integrations')
          .leftJoin('tenant_secret_refs', 'tenant_secret_refs.id', 'integrations.secret_ref_id')
          .select([
            'integrations.integration_type',
            'integrations.status',
            'tenant_secret_refs.secret_ref',
            'tenant_secret_refs.status as secret_status',
          ])
          .where('integrations.id', '=', integrationId)
          .executeTakeFirst(),
    );
    if (
      integration === undefined ||
      integration.integration_type !== INTEGRATION_TYPE[this.#options.provider] ||
      (integration.status !== 'CONNECTED' && integration.status !== 'DEGRADED') ||
      integration.secret_ref === null ||
      integration.secret_status !== 'ACTIVE'
    ) {
      throw new ToolExecutionError(
        'INTEGRATION_UNAVAILABLE',
        'calendar integration is not connected',
        { details: { integration_id: integrationId } },
      );
    }
    const client = this.#options.config.client;
    if (client === null) {
      throw new ToolExecutionError(
        'INTEGRATION_UNAVAILABLE',
        'OAuth client credentials are not configured for this provider',
      );
    }
    const stored = await readTenantSecret(this.#options.secrets, integration.secret_ref);
    let refreshToken: string | null;
    try {
      refreshToken = asText(asRecord(JSON.parse(stored))['refresh_token']);
    } catch (error) {
      throw new ToolExecutionError('SECRET_INVALID', 'stored OAuth credential is not valid JSON', {
        cause: error,
      });
    }
    if (refreshToken === null) {
      throw new ToolExecutionError(
        'SECRET_INVALID',
        'stored OAuth credential has no refresh token',
      );
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (this.#options.provider === 'microsoft') {
      form.set('scope', MICROSOFT_SCOPE);
    }
    const result = await this.#http(
      'POST',
      this.#options.config.tokenUrl,
      { 'content-type': 'application/x-www-form-urlencoded' },
      form.toString(),
    );
    const body = asRecord(result.json);
    if ((result.status === 400 || result.status === 401) && body['error'] === 'invalid_grant') {
      await withTenantTransaction(this.#options.db, this.#tenantContext(tenantId, traceId), (trx) =>
        trx
          .updateTable('integrations')
          .set((eb) => ({
            status: 'AUTH_EXPIRED',
            last_error_code: 'invalid_grant',
            version: eb('version', '+', 1),
          }))
          .where('id', '=', integrationId)
          .execute(),
      );
      throw new ToolExecutionError(
        'INTEGRATION_AUTH_EXPIRED',
        'calendar authorization has expired and must be renewed',
        { details: { integration_id: integrationId } },
      );
    }
    const accessToken = asText(body['access_token']);
    if (result.status !== 200 || accessToken === null) {
      throw this.#failure(
        result.status === 200 ? { status: 502, json: null } : result,
        'token refresh',
      );
    }
    const expiresIn =
      typeof body['expires_in'] === 'number' && body['expires_in'] > 0 ? body['expires_in'] : 3_600;
    this.#tokens.set(integrationId, { accessToken, expiresAt: this.#now() + expiresIn * 1000 });
    return accessToken;
  }

  async #authorized(
    tenantId: string,
    integrationId: string,
    traceId: string,
    method: 'POST' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<HttpResult> {
    const token = await this.#accessToken(tenantId, integrationId, traceId);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.#options.provider === 'microsoft') {
      headers['prefer'] = 'outlook.timezone="UTC"';
    }
    const result = await this.#http(
      method,
      url,
      headers,
      body === undefined ? undefined : JSON.stringify(body),
    );
    if (result.status === 401) {
      this.#tokens.delete(integrationId);
    }
    return result;
  }

  async busy(context: ServiceContext, window: TimeWindow, traceId: string): Promise<Occupation[]> {
    const calendars = await this.#linkedCalendars(context, traceId);
    const occupations: Occupation[] = [];
    const api = this.#options.config.apiBaseUrl;
    for (const integrationId of new Set(calendars.map((entry) => entry.integrationId))) {
      const entries = calendars.filter((entry) => entry.integrationId === integrationId);
      if (this.#options.provider === 'google') {
        const result = await this.#authorized(
          context.tenantId,
          integrationId,
          traceId,
          'POST',
          `${api}/freeBusy`,
          {
            timeMin: window.from.toISOString(),
            timeMax: window.to.toISOString(),
            items: entries.map((entry) => ({ id: entry.calendarRef })),
          },
        );
        if (result.status !== 200) {
          throw this.#failure(result, 'calendar free/busy lookup');
        }
        const calendarsBody = asRecord(asRecord(result.json)['calendars']);
        for (const entry of entries) {
          const calendar = asRecord(calendarsBody[entry.calendarRef]);
          if (asArray(calendar['errors']).length > 0) {
            throw new ToolExecutionError(
              'PROVIDER_ERROR',
              'calendar free/busy returned an error for a linked calendar',
              { details: { resource_id: entry.resourceId } },
            );
          }
          for (const item of asArray(calendar['busy'])) {
            const start = Date.parse(asText(asRecord(item)['start']) ?? '');
            const end = Date.parse(asText(asRecord(item)['end']) ?? '');
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
              occupations.push({
                resourceId: entry.resourceId,
                slotIndex: null,
                startsAt: new Date(start),
                endsAt: new Date(end),
              });
            }
          }
        }
        continue;
      }
      for (const entry of entries) {
        const result = await this.#authorized(
          context.tenantId,
          integrationId,
          traceId,
          'POST',
          `${api}/users/${encodeURIComponent(entry.calendarRef)}/calendar/getSchedule`,
          {
            schedules: [entry.calendarRef],
            startTime: { dateTime: graphDateTime(window.from), timeZone: 'UTC' },
            endTime: { dateTime: graphDateTime(window.to), timeZone: 'UTC' },
            availabilityViewInterval: 15,
          },
        );
        if (result.status !== 200) {
          throw this.#failure(result, 'calendar schedule lookup');
        }
        for (const schedule of asArray(asRecord(result.json)['value'])) {
          const scheduleRecord = asRecord(schedule);
          if (scheduleRecord['error'] !== undefined) {
            throw new ToolExecutionError(
              'PROVIDER_ERROR',
              'calendar schedule returned an error for a linked calendar',
              { details: { resource_id: entry.resourceId } },
            );
          }
          for (const item of asArray(scheduleRecord['scheduleItems'])) {
            const itemRecord = asRecord(item);
            const status = asText(itemRecord['status']);
            const start = parseGraphDateTime(itemRecord['start']);
            const end = parseGraphDateTime(itemRecord['end']);
            if (
              status !== null &&
              MICROSOFT_BUSY_STATUSES.has(status) &&
              Number.isFinite(start) &&
              Number.isFinite(end) &&
              end > start
            ) {
              occupations.push({
                resourceId: entry.resourceId,
                slotIndex: null,
                startsAt: new Date(start),
                endsAt: new Date(end),
              });
            }
          }
        }
      }
    }
    return occupations;
  }

  async createEvent(
    context: ServiceContext,
    booking: BookingRecord,
    summary: CalendarEventSummary,
    traceId: string,
  ): Promise<string | null> {
    const calendars = await this.#linkedCalendars(context, traceId);
    const target = calendars.find((entry) =>
      booking.assignedResourceIds.includes(entry.resourceId),
    );
    if (target === undefined) {
      return null;
    }
    const api = this.#options.config.apiBaseUrl;
    if (this.#options.provider === 'google') {
      const eventId = `velyric${booking.id.replaceAll('-', '')}`;
      const result = await this.#authorized(
        context.tenantId,
        target.integrationId,
        traceId,
        'POST',
        `${api}/calendars/${encodeURIComponent(target.calendarRef)}/events`,
        {
          id: eventId,
          summary: summary.title,
          description: summary.note ?? '',
          start: { dateTime: booking.startsAt.toISOString() },
          end: { dateTime: booking.endsAt.toISOString() },
          extendedProperties: { private: { velyric_booking_id: booking.id } },
        },
      );
      if (result.status === 200 || result.status === 201 || result.status === 409) {
        return ['google', target.integrationId, target.calendarRef, eventId].join('|');
      }
      throw this.#failure(result, 'calendar event creation');
    }
    const result = await this.#authorized(
      context.tenantId,
      target.integrationId,
      traceId,
      'POST',
      `${api}/users/${encodeURIComponent(target.calendarRef)}/events`,
      {
        subject: summary.title,
        body: { contentType: 'text', content: summary.note ?? '' },
        start: { dateTime: graphDateTime(booking.startsAt), timeZone: 'UTC' },
        end: { dateTime: graphDateTime(booking.endsAt), timeZone: 'UTC' },
        transactionId: booking.id,
      },
    );
    const eventId = asText(asRecord(result.json)['id']);
    if ((result.status === 200 || result.status === 201) && eventId !== null) {
      return ['microsoft', target.integrationId, target.calendarRef, eventId].join('|');
    }
    throw this.#failure(
      result.status === 201 ? { status: 502, json: null } : result,
      'calendar event creation',
    );
  }

  async cancelEvent(tenantId: string, externalEventRef: string, traceId: string): Promise<void> {
    const [provider, integrationId, calendarRef, eventId, extra] = externalEventRef.split('|');
    if (
      provider !== this.#options.provider ||
      integrationId === undefined ||
      calendarRef === undefined ||
      eventId === undefined ||
      extra !== undefined
    ) {
      throw new ToolExecutionError(
        'PROVIDER_ERROR',
        'external event reference does not belong to this calendar provider',
      );
    }
    const api = this.#options.config.apiBaseUrl;
    const url =
      provider === 'google'
        ? `${api}/calendars/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(eventId)}`
        : `${api}/users/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(eventId)}`;
    const result = await this.#authorized(tenantId, integrationId, traceId, 'DELETE', url);
    if (
      result.status === 200 ||
      result.status === 204 ||
      result.status === 404 ||
      result.status === 410
    ) {
      return;
    }
    throw this.#failure(result, 'calendar event cancellation');
  }
}
