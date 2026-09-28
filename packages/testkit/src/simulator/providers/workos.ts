import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { ProviderModule, SimulatorContext, SyntheticUser } from '../context.js';
import {
  bearer,
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

interface WorkosUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly createdAt: string;
  lastSignInAt: string | null;
}

interface PendingCode {
  readonly userId: string;
  readonly clientId: string;
  readonly expiresAt: number;
}

interface Session {
  readonly id: string;
  readonly userId: string;
  revoked: boolean;
}

const KEY_ID = 'sim_workos_rs256';
const ACCESS_TOKEN_TTL_SECONDS = 300;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function workosError(status: number, code: string, message: string): SimResponse {
  return json(status, { code, message, error: code, error_description: message });
}

export class WorkosSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #privateKey: KeyObject;
  readonly #publicJwk: Record<string, unknown>;
  readonly #users = new Map<string, WorkosUser>();
  readonly #codes = new Map<string, PendingCode>();
  readonly #refreshTokens = new Map<string, string>();
  readonly #sessions = new Map<string, Session>();

  constructor(context: SimulatorContext) {
    this.#context = context;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#privateKey = privateKey;
    this.#publicJwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: KEY_ID,
      alg: 'RS256',
      use: 'sig',
    };
    for (const user of context.config.users) {
      this.#createUser(user);
    }
  }

  snapshot(): Record<string, number> {
    return {
      users: this.#users.size,
      sessions: [...this.#sessions.values()].filter((session) => !session.revoked).length,
    };
  }

  register(api: Router, control: Router): void {
    for (const prefix of ['', '/workos']) {
      api.add('GET', `${prefix}/user_management/authorize`, (request) => this.#authorize(request));
      api.add('POST', `${prefix}/user_management/authorize/select`, (request) =>
        this.#select(request),
      );
      api.add('POST', `${prefix}/user_management/authenticate`, (request) =>
        this.#authenticate(request),
      );
      api.add('GET', `${prefix}/sso/jwks/:clientId`, (request) => this.#jwks(request));
      api.add('GET', `${prefix}/user_management/sessions/logout`, (request) =>
        this.#logout(request),
      );
      api.add('POST', `${prefix}/user_management/sessions/revoke`, (request) =>
        this.#revoke(request),
      );
      api.add('GET', `${prefix}/user_management/users/:id`, (request) => this.#getUser(request));
    }
    control.add('POST', '/_control/workos/users', (request) => {
      const body = jsonBody(request);
      const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(400, { error: 'email_invalid' });
      }
      const user = this.#createUser({
        email,
        firstName: typeof body['first_name'] === 'string' ? body['first_name'] : 'Synthetic',
        lastName: typeof body['last_name'] === 'string' ? body['last_name'] : 'User',
      });
      return json(201, this.#presentUser(user));
    });
    control.add('POST', '/_control/workos/sessions/:id/revoke', (request) => {
      const session = this.#sessions.get(request.params['id'] ?? '');
      if (session === undefined) {
        return json(404, { error: 'session_not_found' });
      }
      session.revoked = true;
      return json(200, { id: session.id, revoked: true });
    });
  }

  #createUser(input: SyntheticUser): WorkosUser {
    const existing = [...this.#users.values()].find(
      (user) => user.email === input.email.toLowerCase(),
    );
    if (existing !== undefined) {
      return existing;
    }
    const user: WorkosUser = {
      id: this.#context.ids.id('user', '_', 26),
      email: input.email.toLowerCase(),
      firstName: input.firstName,
      lastName: input.lastName,
      createdAt: this.#context.now().toISOString(),
      lastSignInAt: null,
    };
    this.#users.set(user.id, user);
    return user;
  }

  #presentUser(user: WorkosUser): Record<string, unknown> {
    return {
      object: 'user',
      id: user.id,
      email: user.email,
      email_verified: true,
      first_name: user.firstName,
      last_name: user.lastName,
      profile_picture_url: null,
      last_sign_in_at: user.lastSignInAt,
      locale: null,
      created_at: user.createdAt,
      updated_at: user.createdAt,
      external_id: null,
      metadata: {},
    };
  }

  #validRedirect(clientId: string | null, redirectUri: string | null): URL | SimResponse {
    if (clientId !== this.#context.config.credentials.workosClientId) {
      return workosError(400, 'invalid_client', 'client_id is not registered with the simulator');
    }
    if (redirectUri === null || !URL.canParse(redirectUri)) {
      return workosError(400, 'invalid_redirect_uri', 'redirect_uri must be an absolute URL');
    }
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return workosError(400, 'invalid_redirect_uri', 'redirect_uri must use http or https');
    }
    return parsed;
  }

  #issueCode(
    user: WorkosUser,
    clientId: string,
    redirectUri: URL,
    state: string | null,
  ): SimResponse {
    const code = this.#context.ids.token('workos_code', 32);
    this.#codes.set(code, {
      userId: user.id,
      clientId,
      expiresAt: this.#context.now().getTime() + 600_000,
    });
    redirectUri.searchParams.set('code', code);
    if (state !== null) {
      redirectUri.searchParams.set('state', state);
    }
    return redirect(redirectUri.toString());
  }

  #authorize(request: SimRequest): SimResponse {
    const clientId = request.query.get('client_id');
    const target = this.#validRedirect(clientId, request.query.get('redirect_uri'));
    if (!(target instanceof URL) || clientId === null) {
      return target instanceof URL
        ? workosError(400, 'invalid_client', 'client_id is required')
        : target;
    }
    const state = request.query.get('state');
    const hint = request.query.get('login_hint')?.toLowerCase();
    const hinted = [...this.#users.values()].find((user) => user.email === hint);
    if (hinted !== undefined) {
      return this.#issueCode(hinted, clientId, target, state);
    }
    const signUp = request.query.get('screen_hint') === 'sign-up';
    const hidden = (name: string, value: string | null): string =>
      value === null ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    const common = `${hidden('client_id', clientId)}${hidden('redirect_uri', target.toString())}${hidden('state', state)}`;
    const users = [...this.#users.values()]
      .map(
        (user) =>
          `<li><form method="post" action="/user_management/authorize/select">${common}${hidden('email', user.email)}<button type="submit">${escapeHtml(`${user.firstName} ${user.lastName}`)} &lt;${escapeHtml(user.email)}&gt;</button></form></li>`,
      )
      .join('');
    return html(
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WorkOS simulator</title></head><body><main><h1>${signUp ? 'Create a synthetic account' : 'Sign in as a synthetic user'}</h1><ul>${users}</ul><form method="post" action="/user_management/authorize/select">${common}<label for="email">Email</label><input id="email" name="email" type="email" required><button type="submit">${signUp ? 'Create account' : 'Continue'}</button></form></main></body></html>`,
    );
  }

  #select(request: SimRequest): SimResponse {
    const form = formBody(request);
    const clientId = formString(form, 'client_id');
    const target = this.#validRedirect(clientId, formString(form, 'redirect_uri'));
    if (!(target instanceof URL) || clientId === null) {
      return target instanceof URL
        ? workosError(400, 'invalid_client', 'client_id is required')
        : target;
    }
    const email = formString(form, 'email')?.trim().toLowerCase() ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return workosError(400, 'invalid_email', 'a valid email address is required');
    }
    const user = this.#createUser({
      email,
      firstName: email.split('@')[0] ?? 'Synthetic',
      lastName: 'User',
    });
    return this.#issueCode(user, clientId, target, formString(form, 'state'));
  }

  #accessToken(user: WorkosUser, session: Session): string {
    const now = Math.floor(this.#context.now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID }));
    const payload = base64url(
      JSON.stringify({
        iss: `${this.#context.config.publicUrl}/user_management/${this.#context.config.credentials.workosClientId}`,
        sub: user.id,
        sid: session.id,
        jti: this.#context.ids.token('workos_jti', 26),
        iat: now,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.#privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  #authenticate(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const credentials = this.#context.config.credentials;
    if (body['client_id'] !== credentials.workosClientId) {
      return workosError(400, 'invalid_client', 'client_id is not registered with the simulator');
    }
    if (body['client_secret'] !== credentials.workosApiKey) {
      return workosError(401, 'invalid_client', 'client_secret is invalid');
    }
    let user: WorkosUser | undefined;
    let session: Session | undefined;
    if (body['grant_type'] === 'authorization_code') {
      const code = typeof body['code'] === 'string' ? this.#codes.get(body['code']) : undefined;
      if (
        code === undefined ||
        code.expiresAt < this.#context.now().getTime() ||
        code.clientId !== body['client_id']
      ) {
        return workosError(400, 'invalid_grant', 'the authorization code is invalid or expired');
      }
      this.#codes.delete(String(body['code']));
      user = this.#users.get(code.userId);
      if (user !== undefined) {
        session = { id: this.#context.ids.id('session', '_', 26), userId: user.id, revoked: false };
        this.#sessions.set(session.id, session);
        user.lastSignInAt = this.#context.now().toISOString();
      }
    } else if (body['grant_type'] === 'refresh_token') {
      const sessionId =
        typeof body['refresh_token'] === 'string'
          ? this.#refreshTokens.get(body['refresh_token'])
          : undefined;
      session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
      if (session === undefined || session.revoked) {
        return workosError(400, 'invalid_grant', 'the refresh token is invalid or revoked');
      }
      this.#refreshTokens.delete(String(body['refresh_token']));
      user = this.#users.get(session.userId);
    } else {
      return workosError(
        400,
        'unsupported_grant_type',
        'grant_type is not supported by the simulator',
      );
    }
    if (user === undefined || session === undefined) {
      return workosError(400, 'invalid_grant', 'the user no longer exists');
    }
    const refreshToken = this.#context.ids.token('workos_refresh', 40);
    this.#refreshTokens.set(refreshToken, session.id);
    return json(200, {
      user: this.#presentUser(user),
      organization_id: null,
      access_token: this.#accessToken(user, session),
      refresh_token: refreshToken,
      authentication_method: 'Password',
    });
  }

  #jwks(request: SimRequest): SimResponse {
    if (request.params['clientId'] !== this.#context.config.credentials.workosClientId) {
      return workosError(404, 'client_not_found', 'unknown client');
    }
    return json(200, { keys: [this.#publicJwk] });
  }

  #logout(request: SimRequest): SimResponse {
    const session = this.#sessions.get(request.query.get('session_id') ?? '');
    if (session !== undefined) {
      session.revoked = true;
    }
    const returnTo = request.query.get('return_to');
    return returnTo !== null && URL.canParse(returnTo)
      ? redirect(returnTo)
      : html(
          200,
          '<!doctype html><html lang="en"><body><p>Signed out of the WorkOS simulator.</p></body></html>',
        );
  }

  #revoke(request: SimRequest): SimResponse {
    if (bearer(request) !== this.#context.config.credentials.workosApiKey) {
      return workosError(401, 'unauthorized', 'API key is invalid');
    }
    const sessionId = jsonBody(request)['session_id'];
    const session = typeof sessionId === 'string' ? this.#sessions.get(sessionId) : undefined;
    if (session === undefined) {
      return workosError(404, 'session_not_found', 'session does not exist');
    }
    session.revoked = true;
    return json(200, {});
  }

  #getUser(request: SimRequest): SimResponse {
    if (bearer(request) !== this.#context.config.credentials.workosApiKey) {
      return workosError(401, 'unauthorized', 'API key is invalid');
    }
    const user = this.#users.get(request.params['id'] ?? '');
    return user === undefined
      ? workosError(404, 'entity_not_found', 'user does not exist')
      : json(200, this.#presentUser(user));
  }
}
