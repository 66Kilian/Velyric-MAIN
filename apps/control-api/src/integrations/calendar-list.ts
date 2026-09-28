import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  safeRequest,
  type EgressPolicy,
  type HostResolver,
} from '@velyric/security';
import type { VelyricEnvironment } from '@velyric/contracts';
import type { OAuthProvider } from './oauth.js';

export interface CalendarListItem {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
}

export class CalendarListError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'CalendarListError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface CalendarLister {
  list(
    provider: OAuthProvider,
    apiBaseUrl: string,
    accessToken: string,
  ): Promise<readonly CalendarListItem[]>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export class HttpCalendarLister implements CalendarLister {
  readonly #environment: VelyricEnvironment;
  readonly #allowHttp: boolean;
  readonly #resolver: HostResolver | undefined;

  constructor(environment: VelyricEnvironment, allowHttp: boolean, resolver?: HostResolver) {
    this.#environment = environment;
    this.#allowHttp = allowHttp;
    this.#resolver = resolver;
  }

  async list(
    provider: OAuthProvider,
    apiBaseUrl: string,
    accessToken: string,
  ): Promise<readonly CalendarListItem[]> {
    const base = new URL(apiBaseUrl);
    const path = provider === 'google' ? '/users/me/calendarList' : '/me/calendars';
    const url = `${apiBaseUrl.replace(/\/$/, '')}${path}`;
    const policy: EgressPolicy = {
      ...DEFAULT_EGRESS_POLICY,
      allowedHosts: [base.hostname],
      allowHttp: this.#allowHttp && base.protocol === 'http:',
      allowedPorts: [...new Set([443, base.port === '' ? 443 : Number(base.port)])],
      trustedPrivateCidrs: this.#allowHttp ? ['127.0.0.0/8', '::1/128'] : [],
    };
    let response;
    try {
      response = await safeRequest(
        {
          url,
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        },
        {
          policy,
          environment: this.#environment,
          ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
        },
      );
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        throw new CalendarListError('egress_blocked', 'calendar provider request was blocked');
      }
      throw new CalendarListError('unreachable', 'calendar provider is unreachable');
    }
    let json: unknown = null;
    try {
      json = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      // response was not valid JSON; json stays null
    }
    if (response.status === 401) {
      throw new CalendarListError('auth_expired', 'access token was rejected', response.status);
    }
    if (response.status >= 400) {
      throw new CalendarListError(
        'provider_error',
        'calendar provider rejected the request',
        response.status,
      );
    }
    const body = asRecord(json);
    return provider === 'google'
      ? asArray(body['items']).flatMap((entry) => {
          const item = asRecord(entry);
          const id = asText(item['id']);
          if (id === null) {
            return [];
          }
          return [{ id, name: asText(item['summary']) ?? id, primary: item['primary'] === true }];
        })
      : asArray(body['value']).flatMap((entry) => {
          const item = asRecord(entry);
          const id = asText(item['id']);
          if (id === null) {
            return [];
          }
          return [
            {
              id,
              name: asText(item['name']) ?? id,
              primary: item['isDefaultCalendar'] === true,
            },
          ];
        });
  }
}
