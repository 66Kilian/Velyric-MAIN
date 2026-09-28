import { timingSafeEqual } from 'node:crypto';
import { Permission, PlatformRole, Role, staffWorkspaceRole } from '@velyric/contracts';
import { withTenantTransaction, withUserTransaction, type DB } from '@velyric/db';
import {
  hashApiKey,
  hashPassword,
  parseApiKey,
  passwordStrengthIssues,
  signSessionToken,
  verifyPassword,
  verifyServiceToken,
  verifySessionToken,
  type ServiceTokenVerifier,
} from '@velyric/security';
import { sql, type Kysely } from 'kysely';
import { ApiError } from './errors.js';
import { newId } from './persistence.js';
import type { ApiKeyPrincipal, ServicePrincipal, UserPrincipal } from './principal.js';

export const SESSION_COOKIE_NAME = 'vly_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
export const WORKSPACE_HEADER = 'x-velyric-workspace';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERMISSIONS: ReadonlySet<string> = new Set(Object.values(Permission));
const ROLES: ReadonlySet<string> = new Set(Object.values(Role));
const PLATFORM_ROLES: ReadonlySet<string> = new Set(Object.values(PlatformRole));

export interface VerifiedSession {
  readonly authSubject: string;
  readonly email: string;
  readonly sessionId: string;
}

export interface SessionVerifier {
  verify(sealedSession: string): Promise<VerifiedSession | null>;
}

export class VelyricSessionVerifier implements SessionVerifier {
  readonly #db: Kysely<DB>;
  readonly #secret: string;

  constructor(db: Kysely<DB>, secret: string) {
    this.#db = db;
    this.#secret = secret;
  }

  async verify(sealedSession: string): Promise<VerifiedSession | null> {
    const payload = verifySessionToken(sealedSession, this.#secret);
    if (payload === null) {
      return null;
    }
    const row = await this.#db
      .selectFrom('user_sessions')
      .select(['revoked_at', 'expires_at'])
      .where('id', '=', payload.sid)
      .where('auth_subject', '=', payload.sub)
      .executeTakeFirst();
    if (row === undefined || row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      return null;
    }
    await this.#db
      .updateTable('user_sessions')
      .set({ last_seen_at: new Date() })
      .where('id', '=', payload.sid)
      .execute();
    return { authSubject: payload.sub, email: payload.email, sessionId: payload.sid };
  }
}

export interface CredentialInput {
  readonly authorization: string | undefined;
  readonly sessionCookie: string | undefined;
  readonly workspace: string | undefined;
  readonly traceId: string;
}

export class PublicAuthenticator {
  readonly #db: Kysely<DB>;
  readonly #sessions: SessionVerifier;
  readonly #pepper: Uint8Array;

  constructor(db: Kysely<DB>, sessions: SessionVerifier, apiKeyPepper: Uint8Array) {
    this.#db = db;
    this.#sessions = sessions;
    this.#pepper = apiKeyPepper;
  }

  async authenticate(input: CredentialInput): Promise<UserPrincipal | ApiKeyPrincipal | null> {
    if (input.authorization !== undefined) {
      const [scheme, token, extra] = input.authorization.split(' ');
      if (scheme !== 'Bearer' || token === undefined || token === '' || extra !== undefined) {
        throw new ApiError('UNAUTHENTICATED');
      }
      return this.#authenticateApiKey(token, input.traceId);
    }
    if (input.sessionCookie !== undefined && input.sessionCookie !== '') {
      return this.#authenticateSession(input.sessionCookie, input.workspace, input.traceId);
    }
    return null;
  }

  async #authenticateApiKey(token: string, traceId: string): Promise<ApiKeyPrincipal> {
    const parsed = parseApiKey(token);
    if (parsed === null) {
      throw new ApiError('API_KEY_INVALID');
    }
    const directory = await sql<{ tenant_id: string; api_key_id: string; active: boolean }>`
      select tenant_id, api_key_id, active from app.api_key_directory where prefix = ${parsed.prefix}`.execute(
      this.#db,
    );
    const entry = directory.rows[0];
    if (entry === undefined || !entry.active) {
      throw new ApiError('API_KEY_INVALID');
    }
    const expected = hashApiKey(token, this.#pepper);
    const record = await withTenantTransaction(
      this.#db,
      { tenantId: entry.tenant_id, actorType: 'API_KEY', actorId: entry.api_key_id, traceId },
      async (trx) => {
        const row = await trx
          .selectFrom('api_keys')
          .select(['id', 'key_hash', 'scopes', 'expires_at', 'revoked_at'])
          .where('id', '=', entry.api_key_id)
          .executeTakeFirst();
        if (
          row === undefined ||
          row.revoked_at !== null ||
          (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) ||
          row.key_hash.length !== expected.length ||
          !timingSafeEqual(row.key_hash, expected)
        ) {
          return null;
        }
        await trx
          .updateTable('api_keys')
          .set({ last_used_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        return row;
      },
    );
    if (record === null) {
      throw new ApiError('API_KEY_INVALID');
    }
    const scopes = new Set(
      record.scopes.filter((scope): scope is Permission => PERMISSIONS.has(scope)),
    );
    return { kind: 'api_key', apiKeyId: record.id, tenantId: entry.tenant_id, scopes };
  }

  async #authenticateSession(
    sealed: string,
    workspace: string | undefined,
    traceId: string,
  ): Promise<UserPrincipal> {
    const session = await this.#sessions.verify(sealed);
    if (session === null) {
      throw new ApiError('SESSION_EXPIRED');
    }
    if (workspace !== undefined && !UUID_PATTERN.test(workspace)) {
      throw new ApiError('VALIDATION_FAILED', {
        issues: [{ path: `/headers/${WORKSPACE_HEADER}`, rule: 'uuid' }],
      });
    }
    return withUserTransaction(
      this.#db,
      { authSubject: session.authSubject, traceId },
      async (trx) => {
        let user = await trx
          .selectFrom('users')
          .select(['id', 'email', 'deactivated_at'])
          .where('auth_subject', '=', session.authSubject)
          .executeTakeFirst();
        if (user === undefined) {
          user = await trx
            .insertInto('users')
            .values({
              id: newId(),
              auth_subject: session.authSubject,
              email: session.email,
              last_login_at: new Date(),
            })
            .returning(['id', 'email', 'deactivated_at'])
            .executeTakeFirstOrThrow();
        } else if (user.email !== session.email) {
          await trx
            .updateTable('users')
            .set({ email: session.email })
            .where('id', '=', user.id)
            .execute();
        }
        if (user.deactivated_at !== null) {
          throw new ApiError('FORBIDDEN', { reason: 'user_deactivated' });
        }
        await sql`select set_config('app.user_id', ${user.id}, true)`.execute(trx);
        const staff = await trx
          .selectFrom('platform_staff')
          .select(['platform_role'])
          .where('user_id', '=', user.id)
          .where('active', '=', true)
          .executeTakeFirst();
        const platformRole =
          staff !== undefined && PLATFORM_ROLES.has(staff.platform_role)
            ? (staff.platform_role as PlatformRole)
            : null;
        let membership: UserPrincipal['membership'] = null;
        if (workspace !== undefined) {
          const row = await trx
            .selectFrom('memberships')
            .select(['tenant_id', 'role', 'location_scope'])
            .where('user_id', '=', user.id)
            .where('tenant_id', '=', workspace)
            .where('status', '=', 'ACTIVE')
            .executeTakeFirst();
          if (row !== undefined && ROLES.has(row.role)) {
            membership = {
              tenantId: row.tenant_id,
              role: row.role as Role,
              locationScope: row.location_scope,
            };
          } else {
            const staffRole = platformRole === null ? null : staffWorkspaceRole(platformRole);
            if (staffRole === null) {
              throw new ApiError('FORBIDDEN', { reason: 'not_a_member' });
            }
            const tenant = await trx
              .selectFrom('tenants')
              .select(['id'])
              .where('id', '=', workspace)
              .executeTakeFirst();
            if (tenant === undefined) {
              throw new ApiError('FORBIDDEN', { reason: 'not_a_member' });
            }
            membership = {
              tenantId: tenant.id,
              role: staffRole,
              locationScope: [],
              viaPlatformRole: true,
            };
          }
        }
        return {
          kind: 'user',
          userId: user.id,
          authSubject: session.authSubject,
          email: session.email,
          sessionId: session.sessionId,
          platformRole,
          membership,
        };
      },
    );
  }
}

export class ServiceAuthenticator {
  readonly #verifier: ServiceTokenVerifier;

  constructor(verifier: ServiceTokenVerifier) {
    this.#verifier = verifier;
  }

  async authenticate(authorization: string | undefined): Promise<ServicePrincipal> {
    const [scheme, token, extra] = (authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || token === undefined || token === '' || extra !== undefined) {
      throw new ApiError('SERVICE_TOKEN_INVALID');
    }
    const verified = await verifyServiceToken(token, this.#verifier, []);
    return {
      kind: 'service',
      issuer: verified.issuer,
      scopes: verified.scopes,
      tenantId: verified.tenantId,
    };
  }
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export interface Credential {
  readonly authSubject: string;
  readonly email: string;
}

export class CredentialAuthenticator {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async register(email: string, password: string): Promise<Credential> {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
      throw new ApiError('VALIDATION_FAILED', { issues: [{ path: '/email', rule: 'format' }] });
    }
    const issues = passwordStrengthIssues(password);
    if (issues.length > 0) {
      throw new ApiError('WEAK_PASSWORD', { issues });
    }
    const authSubject = newId();
    try {
      await this.#db
        .insertInto('credentials')
        .values({
          auth_subject: authSubject,
          email: normalized,
          password_hash: hashPassword(password),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('EMAIL_ALREADY_REGISTERED');
      }
      throw error;
    }
    return { authSubject, email: normalized };
  }

  async authenticate(email: string, password: string): Promise<Credential> {
    const normalized = email.trim().toLowerCase();
    const row = await this.#db
      .selectFrom('credentials')
      .select(['auth_subject', 'password_hash', 'failed_attempts', 'locked_until'])
      .where('email', '=', normalized)
      .executeTakeFirst();
    if (row === undefined) {
      hashPassword(password);
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if (row.locked_until !== null && row.locked_until.getTime() > Date.now()) {
      throw new ApiError('ACCOUNT_LOCKED');
    }
    if (row.password_hash === null || !verifyPassword(password, row.password_hash)) {
      const attempts = row.failed_attempts + 1;
      await this.#db
        .updateTable('credentials')
        .set({
          failed_attempts: attempts,
          locked_until: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
        })
        .where('auth_subject', '=', row.auth_subject)
        .execute();
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if (row.failed_attempts > 0 || row.locked_until !== null) {
      await this.#db
        .updateTable('credentials')
        .set({ failed_attempts: 0, locked_until: null })
        .where('auth_subject', '=', row.auth_subject)
        .execute();
    }
    return { authSubject: row.auth_subject, email: normalized };
  }
}

export async function loginOrRegisterWithGoogle(
  db: Kysely<DB>,
  email: string,
): Promise<Credential> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path: '/email', rule: 'format' }] });
  }
  const existing = await db
    .selectFrom('credentials')
    .select(['auth_subject', 'password_hash'])
    .where('email', '=', normalized)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.password_hash !== null) {
      // This email already has a password on file. Attaching the Google identity to it
      // automatically would let anyone who set that password earlier (including an
      // attacker who pre-registered the victim's email before they ever signed up)
      // take over the account the moment its real owner uses "Sign in with Google".
      // Require them to sign in with the password first instead.
      throw new ApiError('GOOGLE_ACCOUNT_HAS_PASSWORD');
    }
    return { authSubject: existing.auth_subject, email: normalized };
  }
  const authSubject = newId();
  try {
    await db
      .insertInto('credentials')
      .values({
        auth_subject: authSubject,
        email: normalized,
        password_hash: null,
        email_verified_at: new Date(),
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const row = await db
        .selectFrom('credentials')
        .select(['auth_subject', 'password_hash'])
        .where('email', '=', normalized)
        .executeTakeFirstOrThrow();
      if (row.password_hash !== null) {
        throw new ApiError('GOOGLE_ACCOUNT_HAS_PASSWORD');
      }
      return { authSubject: row.auth_subject, email: normalized };
    }
    throw error;
  }
  return { authSubject, email: normalized };
}

export interface SessionMeta {
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issueSession(
  db: Kysely<DB>,
  secret: string,
  credential: Credential,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const sessionId = newId();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);
  await db
    .insertInto('user_sessions')
    .values({
      id: sessionId,
      auth_subject: credential.authSubject,
      expires_at: expiresAt,
      user_agent: meta.userAgent,
      ip: meta.ip,
    })
    .execute();
  const token = signSessionToken(
    {
      sid: sessionId,
      sub: credential.authSubject,
      email: credential.email,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    secret,
  );
  return { token, expiresAt };
}

export async function revokeSession(db: Kysely<DB>, sessionId: string): Promise<void> {
  await db
    .updateTable('user_sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}
