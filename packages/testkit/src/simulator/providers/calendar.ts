import { createHash, createHmac } from 'node:crypto';
import type { OAuthClient, ProviderModule, SimulatorContext } from '../context.js';
import {
  bearer,
  empty,
  escapeHtml,
  formBody,
  formString,
  html,
  json,
  jsonBody,
  redirect,
  type Router,
  type SimRequest,
  type SimResponse,
} from '../http.js';

type Flavor = 'google' | 'microsoft';

interface CalendarEvent {
  readonly id: string;
  readonly calendar: string;
  readonly start: number;
  readonly end: number;
  readonly body: Record<string, unknown>;
}

interface Grant {
  readonly account: string;
  readonly scope: string;
}

const ACCESS_TTL_SECONDS = 3_599;

function oauthError(status: number, error: string, description: string): SimResponse {
  return json(status, { error, error_description: description });
}

function graphInstant(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return Number.NaN;
  }
  const record = value as Record<string, unknown>;
  const dateTime = record['dateTime'];
  if (typeof dateTime !== 'string') {
    return Number.NaN;
  }
  const zone = record['timeZone'];
  const suffix = /[zZ]|[+-]\d{2}:\d{2}$/.test(dateTime) || zone !== 'UTC' ? '' : 'Z';
  return Date.parse(`${dateTime}${suffix}`);
}

function googleInstant(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return Number.NaN;
  }
  const dateTime = (value as Record<string, unknown>)['dateTime'];
  return typeof dateTime === 'string' ? Date.parse(dateTime) : Number.NaN;
}

function graphDateTime(instant: number): string {
  return new Date(instant).toISOString().replace('Z', '0000');
}

export class CalendarSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #flavor: Flavor;
  readonly #client: OAuthClient;
  readonly #codes = new Map<
    string,
    Grant & {
      readonly redirectUri: string;
      readonly expiresAt: number;
      readonly codeChallenge: string | null;
    }
  >();
  readonly #refreshTokens = new Map<string, Grant>();
  readonly #accessTokens = new Map<string, Grant & { readonly expiresAt: number }>();
  readonly #events = new Map<string, CalendarEvent>();
  readonly #busy: CalendarEvent[] = [];

  constructor(context: SimulatorContext, flavor: Flavor) {
    this.#context = context;
    this.#flavor = flavor;
    this.#client =
      flavor === 'google'
        ? context.config.credentials.google
        : context.config.credentials.microsoft;
  }

  snapshot(): Record<string, number> {
    return {
      refresh_tokens: this.#refreshTokens.size,
      events: this.#events.size,
      busy_blocks: this.#busy.length,
    };
  }

  register(api: Router, control: Router): void {
    const base = `/${this.#flavor}`;
    api.add('GET', `${base}/authorize`, (request) => this.#authorize(request));
    api.add('POST', `${base}/authorize/decision`, (request) => this.#decision(request));
    api.add('POST', `${base}/token`, (request) => this.#token(request));
    if (this.#flavor === 'google') {
      api.add('GET', `${base}/api/users/me/calendarList`, (request) =>
        this.#authorized(request, () => this.#calendarList(request)),
      );
      api.add('POST', `${base}/api/freeBusy`, (request) =>
        this.#authorized(request, () => this.#freeBusy(request)),
      );
      api.add('POST', `${base}/api/calendars/:calendar/events`, (request) =>
        this.#authorized(request, () => this.#createEvent(request)),
      );
      api.add('DELETE', `${base}/api/calendars/:calendar/events/:eventId`, (request) =>
        this.#authorized(request, () => this.#deleteEvent(request)),
      );
    } else {
      api.add('GET', `${base}/api/me/calendars`, (request) =>
        this.#authorized(request, () => this.#calendarList(request)),
      );
      api.add('POST', `${base}/api/users/:calendar/calendar/getSchedule`, (request) =>
        this.#authorized(request, () => this.#schedule(request)),
      );
      api.add('POST', `${base}/api/users/:calendar/events`, (request) =>
        this.#authorized(request, () => this.#createEvent(request)),
      );
      api.add('DELETE', `${base}/api/users/:calendar/events/:eventId`, (request) =>
        this.#authorized(request, () => this.#deleteEvent(request)),
      );
    }
    control.add('POST', `/_control/${this.#flavor}/busy`, (request) => {
      const body = jsonBody(request);
      const start = typeof body['start'] === 'string' ? Date.parse(body['start']) : Number.NaN;
      const end = typeof body['end'] === 'string' ? Date.parse(body['end']) : Number.NaN;
      if (
        typeof body['calendar'] !== 'string' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      ) {
        return json(400, { error: 'calendar, start and end are required' });
      }
      const block = {
        id: this.#context.ids.id(`${this.#flavor}_busy`, '_', 16),
        calendar: body['calendar'],
        start,
        end,
        body: {},
      };
      this.#busy.push(block);
      return json(201, { id: block.id });
    });
    control.add('POST', `/_control/${this.#flavor}/revoke`, () => {
      const revoked = this.#refreshTokens.size;
      this.#refreshTokens.clear();
      this.#accessTokens.clear();
      return json(200, { revoked });
    });
    control.add('GET', `/_control/${this.#flavor}/events`, () =>
      json(200, { data: [...this.#events.values()] }),
    );
  }

  #authorize(request: SimRequest): SimResponse {
    const redirectUri = request.query.get('redirect_uri');
    if (request.query.get('client_id') !== this.#client.clientId) {
      return html(
        400,
        '<!doctype html><html lang="en"><body><p>Unknown OAuth client.</p></body></html>',
      );
    }
    if (
      redirectUri === null ||
      !URL.canParse(redirectUri) ||
      request.query.get('response_type') !== 'code'
    ) {
      return html(
        400,
        '<!doctype html><html lang="en"><body><p>redirect_uri and response_type=code are required.</p></body></html>',
      );
    }
    const hidden = (name: string, value: string | null): string =>
      value === null ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    const challengeMethod = request.query.get('code_challenge_method');
    if (challengeMethod !== null && challengeMethod !== 'S256') {
      return html(
        400,
        '<!doctype html><html lang="en"><body><p>Only S256 PKCE challenges are supported.</p></body></html>',
      );
    }
    const common = `${hidden('redirect_uri', redirectUri)}${hidden('state', request.query.get('state'))}${hidden('scope', request.query.get('scope'))}${hidden('code_challenge', request.query.get('code_challenge'))}`;
    const accounts = this.#context.config.calendarAccounts
      .map(
        (account) =>
          `<li><form method="post" action="/${this.#flavor}/authorize/decision">${common}${hidden('account', account)}<button type="submit" name="decision" value="allow">Allow ${escapeHtml(account)}</button></form></li>`,
      )
      .join('');
    return html(
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${this.#flavor} OAuth simulator</title></head><body><main><h1>Grant calendar access</h1><ul>${accounts}</ul><form method="post" action="/${this.#flavor}/authorize/decision">${common}<button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`,
    );
  }

  #decision(request: SimRequest): SimResponse {
    const form = formBody(request);
    const redirectUri = formString(form, 'redirect_uri');
    if (redirectUri === null || !URL.canParse(redirectUri)) {
      return html(
        400,
        '<!doctype html><html lang="en"><body><p>Invalid redirect_uri.</p></body></html>',
      );
    }
    const target = new URL(redirectUri);
    const state = formString(form, 'state');
    if (state !== null) {
      target.searchParams.set('state', state);
    }
    const account = formString(form, 'account');
    if (
      formString(form, 'decision') !== 'allow' ||
      account === null ||
      !this.#context.config.calendarAccounts.includes(account)
    ) {
      target.searchParams.set('error', 'access_denied');
      return redirect(target.toString());
    }
    const code = this.#context.ids.token(`${this.#flavor}_code`, 40);
    this.#codes.set(code, {
      account,
      scope: formString(form, 'scope') ?? '',
      redirectUri,
      expiresAt: this.#context.now().getTime() + 600_000,
      codeChallenge: formString(form, 'code_challenge'),
    });
    target.searchParams.set('code', code);
    return redirect(target.toString());
  }

  #idToken(account: string): string {
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(this.#context.now().getTime() / 1000);
    const claims =
      this.#flavor === 'google'
        ? {
            iss: `${this.#context.config.publicUrl}/google`,
            aud: this.#client.clientId,
            sub: account,
            email: account,
            email_verified: true,
            iat: now,
            exp: now + ACCESS_TTL_SECONDS,
          }
        : {
            iss: `${this.#context.config.publicUrl}/microsoft`,
            aud: this.#client.clientId,
            sub: account,
            preferred_username: account,
            iat: now,
            exp: now + ACCESS_TTL_SECONDS,
          };
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
    return `${unsigned}.${createHmac('sha256', this.#client.clientSecret).update(unsigned).digest('base64url')}`;
  }

  #issueAccess(grant: Grant): string {
    const token = `${this.#flavor === 'google' ? 'ya29' : 'EwB'}.${this.#context.ids.token(`${this.#flavor}_access`, 48)}`;
    this.#accessTokens.set(token, {
      ...grant,
      expiresAt: this.#context.now().getTime() + ACCESS_TTL_SECONDS * 1000,
    });
    return token;
  }

  #token(request: SimRequest): SimResponse {
    const form = formBody(request);
    if (
      formString(form, 'client_id') !== this.#client.clientId ||
      formString(form, 'client_secret') !== this.#client.clientSecret
    ) {
      return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    }
    const grantType = formString(form, 'grant_type');
    if (grantType === 'authorization_code') {
      const codeValue = formString(form, 'code') ?? '';
      const code = this.#codes.get(codeValue);
      if (
        code === undefined ||
        code.expiresAt < this.#context.now().getTime() ||
        code.redirectUri !== formString(form, 'redirect_uri')
      ) {
        return oauthError(400, 'invalid_grant', 'Malformed auth code.');
      }
      const verifier = formString(form, 'code_verifier');
      if (
        code.codeChallenge !== null &&
        (verifier === null ||
          createHash('sha256').update(verifier).digest('base64url') !== code.codeChallenge)
      ) {
        return oauthError(400, 'invalid_grant', 'Missing code verifier.');
      }
      this.#codes.delete(codeValue);
      const refreshToken = `${this.#flavor === 'google' ? '1//' : 'M.R3_'}${this.#context.ids.token(`${this.#flavor}_refresh`, 48)}`;
      this.#refreshTokens.set(refreshToken, { account: code.account, scope: code.scope });
      return json(200, {
        access_token: this.#issueAccess(code),
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: code.scope,
        token_type: 'Bearer',
        id_token: this.#idToken(code.account),
      });
    }
    if (grantType === 'refresh_token') {
      const grant = this.#refreshTokens.get(formString(form, 'refresh_token') ?? '');
      if (grant === undefined) {
        return oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
      }
      return json(200, {
        access_token: this.#issueAccess(grant),
        expires_in: ACCESS_TTL_SECONDS,
        scope: grant.scope,
        token_type: 'Bearer',
      });
    }
    return oauthError(400, 'unsupported_grant_type', 'Invalid grant_type.');
  }

  #authorized(request: SimRequest, next: () => SimResponse): SimResponse {
    const token = bearer(request);
    const grant = token === null ? undefined : this.#accessTokens.get(token);
    if (grant === undefined || grant.expiresAt < this.#context.now().getTime()) {
      return this.#flavor === 'google'
        ? json(401, {
            error: {
              code: 401,
              message: 'Request had invalid authentication credentials.',
              status: 'UNAUTHENTICATED',
            },
          })
        : json(401, {
            error: {
              code: 'InvalidAuthenticationToken',
              message: 'Access token is empty or invalid.',
            },
          });
    }
    return next();
  }

  #calendarList(request: SimRequest): SimResponse {
    const token = bearer(request);
    const grant = token === null ? undefined : this.#accessTokens.get(token);
    const account = grant?.account ?? 'unknown@example.test';
    return this.#flavor === 'google'
      ? json(200, {
          kind: 'calendar#calendarList',
          items: [
            { id: account, summary: account, primary: true },
            {
              id: `team_${this.#context.ids.id('cal', '_', 8)}@group.calendar.google.com`,
              summary: 'Team calendar',
            },
          ],
        })
      : json(200, {
          value: [
            { id: account, name: 'Calendar', isDefaultCalendar: true },
            {
              id: `team_${this.#context.ids.id('cal', '_', 8)}`,
              name: 'Team calendar',
              isDefaultCalendar: false,
            },
          ],
        });
  }

  #occupied(calendar: string, from: number, to: number): CalendarEvent[] {
    return [...this.#events.values(), ...this.#busy].filter(
      (event) => event.calendar === calendar && event.start < to && event.end > from,
    );
  }

  #freeBusy(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const from = typeof body['timeMin'] === 'string' ? Date.parse(body['timeMin']) : Number.NaN;
    const to = typeof body['timeMax'] === 'string' ? Date.parse(body['timeMax']) : Number.NaN;
    const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return json(400, {
        error: {
          code: 400,
          message: 'timeMin and timeMax are required.',
          status: 'INVALID_ARGUMENT',
        },
      });
    }
    const calendars = Object.fromEntries(
      items.flatMap((item) =>
        typeof item['id'] === 'string'
          ? [
              [
                item['id'],
                {
                  busy: this.#occupied(item['id'], from, to).map((event) => ({
                    start: new Date(event.start).toISOString(),
                    end: new Date(event.end).toISOString(),
                  })),
                },
              ],
            ]
          : [],
      ),
    );
    return json(200, {
      kind: 'calendar#freeBusy',
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      calendars,
    });
  }

  #schedule(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const from = graphInstant(body['startTime']);
    const to = graphInstant(body['endTime']);
    const schedules = Array.isArray(body['schedules'])
      ? body['schedules'].filter((entry): entry is string => typeof entry === 'string')
      : [request.params['calendar'] ?? ''];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return json(400, {
        error: { code: 'ErrorInvalidParameter', message: 'startTime and endTime are required.' },
      });
    }
    return json(200, {
      value: schedules.map((calendar) => ({
        scheduleId: calendar,
        availabilityView: '',
        scheduleItems: this.#occupied(calendar, from, to).map((event) => ({
          isPrivate: false,
          status: 'busy',
          subject: 'Busy',
          start: { dateTime: graphDateTime(event.start), timeZone: 'UTC' },
          end: { dateTime: graphDateTime(event.end), timeZone: 'UTC' },
        })),
      })),
    });
  }

  #createEvent(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const calendar = request.params['calendar'] ?? '';
    const start =
      this.#flavor === 'google' ? googleInstant(body['start']) : graphInstant(body['start']);
    const end = this.#flavor === 'google' ? googleInstant(body['end']) : graphInstant(body['end']);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return json(
        400,
        this.#flavor === 'google'
          ? {
              error: {
                code: 400,
                message: 'Invalid start or end time.',
                status: 'INVALID_ARGUMENT',
              },
            }
          : { error: { code: 'ErrorInvalidParameter', message: 'Invalid start or end time.' } },
      );
    }
    const requestedId =
      this.#flavor === 'google' && typeof body['id'] === 'string' ? body['id'] : null;
    const transaction =
      this.#flavor === 'microsoft' && typeof body['transactionId'] === 'string'
        ? body['transactionId']
        : null;
    const existing = [...this.#events.values()].find(
      (event) =>
        event.calendar === calendar &&
        ((requestedId !== null && event.id === requestedId) ||
          (transaction !== null && event.body['transactionId'] === transaction)),
    );
    if (existing !== undefined) {
      return this.#flavor === 'google'
        ? json(409, {
            error: {
              code: 409,
              message: 'The requested identifier already exists.',
              status: 'ALREADY_EXISTS',
            },
          })
        : json(201, { ...existing.body, id: existing.id });
    }
    const id =
      requestedId ??
      this.#context.ids.token(`${this.#flavor}_event`, this.#flavor === 'google' ? 26 : 120);
    const event = { id, calendar, start, end, body };
    this.#events.set(`${calendar}:${id}`, event);
    return json(this.#flavor === 'google' ? 200 : 201, { ...body, id, status: 'confirmed' });
  }

  #deleteEvent(request: SimRequest): SimResponse {
    const key = `${request.params['calendar'] ?? ''}:${request.params['eventId'] ?? ''}`;
    if (!this.#events.delete(key)) {
      return this.#flavor === 'google'
        ? json(410, { error: { code: 410, message: 'Resource has been deleted', status: 'GONE' } })
        : json(404, {
            error: {
              code: 'ErrorItemNotFound',
              message: 'The specified object was not found in the store.',
            },
          });
    }
    return empty(204);
  }
}
