import { randomUUID } from 'node:crypto';
import { ServiceName } from '@velyric/contracts';
import {
  createLocalJWKSet,
  errors,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
} from 'jose';

export const SERVICE_SCOPES = [
  'runtime.snapshot.read',
  'runtime.admission.read',
  'tool.execute',
  'call.control',
  'usage.write',
  'provider_cost.write',
  'knowledge.ingest',
  'knowledge.retrieve',
  'simulation.run',
  'quality.write',
  'notification.send',
  'provisioning.execute',
  'billing.execute',
  'connector.execute',
  'support.ops',
] as const;

export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export const SERVICE_TOKEN_LIFETIME_SECONDS = 300;
export const SERVICE_TOKEN_CLOCK_SKEW_SECONDS = 30;

const SERVICE_NAMES: ReadonlySet<string> = new Set(Object.values(ServiceName));
const SCOPE_SET: ReadonlySet<string> = new Set(SERVICE_SCOPES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ServiceTokenErrorCode = 'SERVICE_TOKEN_INVALID' | 'SERVICE_SCOPE_MISSING';

export class ServiceTokenError extends Error {
  readonly code: ServiceTokenErrorCode;

  constructor(code: ServiceTokenErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ServiceTokenError';
    this.code = code;
  }
}

export type ServiceSigningKey = Awaited<ReturnType<typeof importPKCS8>>;

export interface ServiceSigner {
  readonly issuer: ServiceName;
  readonly kid: string;
  readonly key: ServiceSigningKey;
}

export async function importServiceSigner(
  issuer: ServiceName,
  kid: string,
  pkcs8Pem: string,
): Promise<ServiceSigner> {
  if (!SERVICE_NAMES.has(issuer)) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', `unknown service ${issuer}`);
  }
  if (!/^[A-Za-z0-9_.-]{4,128}$/.test(kid)) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', 'kid has an invalid format');
  }
  return { issuer, kid, key: await importPKCS8(pkcs8Pem, 'EdDSA') };
}

export interface SignServiceTokenInput {
  readonly audience: ServiceName;
  readonly scopes: readonly ServiceScope[];
  readonly tenantId?: string;
  readonly lifetimeSeconds?: number;
  readonly now?: Date;
}

export async function signServiceToken(
  signer: ServiceSigner,
  input: SignServiceTokenInput,
): Promise<string> {
  const lifetime = input.lifetimeSeconds ?? SERVICE_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > SERVICE_TOKEN_LIFETIME_SECONDS) {
    throw new ServiceTokenError(
      'SERVICE_TOKEN_INVALID',
      `lifetime must be 1-${String(SERVICE_TOKEN_LIFETIME_SECONDS)} seconds`,
    );
  }
  if (input.scopes.length === 0 || input.scopes.some((scope) => !SCOPE_SET.has(scope))) {
    throw new ServiceTokenError(
      'SERVICE_TOKEN_INVALID',
      'scopes must be non-empty known service scopes',
    );
  }
  if (input.tenantId !== undefined && !UUID_PATTERN.test(input.tenantId)) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', 'tenantId must be a UUID');
  }
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims: Record<string, string> = { scope: [...new Set(input.scopes)].join(' ') };
  if (input.tenantId !== undefined) {
    claims['tenant_id'] = input.tenantId;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid, typ: 'JWT' })
    .setIssuer(signer.issuer)
    .setSubject(signer.issuer)
    .setAudience(input.audience)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + lifetime)
    .setJti(randomUUID())
    .sign(signer.key);
}

export type ReplayGuard = (issuer: string, jti: string, ttlSeconds: number) => Promise<boolean>;

export interface ServiceTokenVerifier {
  readonly audience: ServiceName;
  readonly jwks: JSONWebKeySet;
  readonly replayGuard: ReplayGuard;
}

export interface VerifiedServiceToken {
  readonly issuer: ServiceName;
  readonly scopes: ReadonlySet<ServiceScope>;
  readonly tenantId: string | null;
  readonly jti: string;
  readonly expiresAt: Date;
}

export async function verifyServiceToken(
  token: string,
  verifier: ServiceTokenVerifier,
  requiredScopes: readonly ServiceScope[],
  now: Date = new Date(),
): Promise<VerifiedServiceToken> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const result = await jwtVerify(token, createLocalJWKSet(verifier.jwks), {
      audience: verifier.audience,
      algorithms: ['EdDSA', 'Ed25519'],
      clockTolerance: SERVICE_TOKEN_CLOCK_SKEW_SECONDS,
      currentDate: now,
      requiredClaims: ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti'],
    });
    payload = result.payload;
  } catch (error) {
    const reason = error instanceof errors.JOSEError ? error.code : 'ERR_UNKNOWN';
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', `service token rejected: ${reason}`, {
      cause: error,
    });
  }
  const { iss, sub, jti, iat, exp } = payload;
  if (iss === undefined || !SERVICE_NAMES.has(iss) || sub !== iss) {
    throw new ServiceTokenError(
      'SERVICE_TOKEN_INVALID',
      'issuer and subject must be the same known service',
    );
  }
  if (jti === undefined || !UUID_PATTERN.test(jti) || iat === undefined || exp === undefined) {
    throw new ServiceTokenError(
      'SERVICE_TOKEN_INVALID',
      'token is missing a valid jti, iat or exp',
    );
  }
  if (exp - iat > SERVICE_TOKEN_LIFETIME_SECONDS) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', 'token lifetime exceeds the maximum');
  }
  const scopeClaim = payload['scope'];
  const scopes = new Set(
    (typeof scopeClaim === 'string' ? scopeClaim.split(' ') : []).filter(
      (scope): scope is ServiceScope => SCOPE_SET.has(scope),
    ),
  );
  const missing = requiredScopes.filter((scope) => !scopes.has(scope));
  if (missing.length > 0) {
    throw new ServiceTokenError('SERVICE_SCOPE_MISSING', `missing scopes: ${missing.join(', ')}`);
  }
  const tenantClaim = payload['tenant_id'];
  if (
    tenantClaim !== undefined &&
    (typeof tenantClaim !== 'string' || !UUID_PATTERN.test(tenantClaim))
  ) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', 'tenant_id claim is malformed');
  }
  const remaining = Math.max(
    1,
    exp + SERVICE_TOKEN_CLOCK_SKEW_SECONDS - Math.floor(now.getTime() / 1000),
  );
  if (!(await verifier.replayGuard(iss, jti, remaining))) {
    throw new ServiceTokenError('SERVICE_TOKEN_INVALID', 'service token was already used');
  }
  return {
    issuer: iss as ServiceName,
    scopes,
    tenantId: typeof tenantClaim === 'string' ? tenantClaim : null,
    jti,
    expiresAt: new Date(exp * 1000),
  };
}
