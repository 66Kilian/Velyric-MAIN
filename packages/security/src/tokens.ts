import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError('token size must be 16-128 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

export type ApiKeyEnvironment = 'live' | 'test';

export interface GeneratedApiKey {
  readonly plaintext: string;
  readonly prefix: string;
  readonly hash: Buffer;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const API_KEY_PATTERN = /^(vk_(live|test)_[A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

function randomAlphanumeric(length: number): string {
  const limit = 256 - (256 % ALPHANUMERIC.length);
  let output = '';
  while (output.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && output.length < length) {
        output += ALPHANUMERIC.charAt(byte % ALPHANUMERIC.length);
      }
    }
  }
  return output;
}

function assertPepper(pepper: Uint8Array): void {
  if (pepper.byteLength < 32) {
    throw new RangeError('API key pepper must be at least 32 bytes');
  }
}

export function hashApiKey(plaintext: string, pepper: Uint8Array): Buffer {
  assertPepper(pepper);
  return hmacSha256(pepper, plaintext);
}

export function generateApiKey(
  environment: ApiKeyEnvironment,
  pepper: Uint8Array,
): GeneratedApiKey {
  const prefix = `vk_${environment}_${randomAlphanumeric(12)}`;
  const plaintext = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext, pepper) };
}

export function parseApiKey(
  plaintext: string,
): { readonly prefix: string; readonly environment: ApiKeyEnvironment } | null {
  const match = API_KEY_PATTERN.exec(plaintext);
  if (match === null) {
    return null;
  }
  const [, prefix = '', environment] = match;
  return { prefix, environment: environment === 'live' ? 'live' : 'test' };
}

export function createCsrfToken(): string {
  return randomToken(32);
}

export function csrfTokensMatch(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (
    cookieToken === undefined ||
    headerToken === undefined ||
    cookieToken.length < 43 ||
    headerToken.length < 43
  ) {
    return false;
  }
  return timingSafeEqualString(cookieToken, headerToken);
}

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  return `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, nRaw, rRaw, pRaw, salt, hashHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    salt === undefined ||
    hashHex === undefined ||
    salt === '' ||
    hashHex === ''
  ) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = scryptSync(password, salt, expected.byteLength, { N: n, r, p });
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}

export function passwordStrengthIssues(password: string): readonly string[] {
  const issues: string[] = [];
  if (password.length < 10) {
    issues.push('too_short');
  }
  if (password.length > 256) {
    issues.push('too_long');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    issues.push('too_weak');
  }
  return issues;
}

export interface SessionTokenPayload {
  readonly sid: string;
  readonly sub: string;
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
}

function isSessionTokenPayload(value: unknown): value is SessionTokenPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['sid'] === 'string' &&
    typeof (value as Record<string, unknown>)['sub'] === 'string' &&
    typeof (value as Record<string, unknown>)['email'] === 'string' &&
    typeof (value as Record<string, unknown>)['iat'] === 'number' &&
    typeof (value as Record<string, unknown>)['exp'] === 'number'
  );
}

export function signSessionToken(payload: SessionTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmacSha256(secret, body).toString('base64url');
  return `${body}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts;
  if (body === undefined || signature === undefined || body === '' || signature === '') {
    return null;
  }
  const expected = hmacSha256(secret, body).toString('base64url');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.byteLength !== signatureBuffer.byteLength ||
    !timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isSessionTokenPayload(payload) || payload.exp * 1000 < Date.now()) {
    return null;
  }
  return payload;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

export function createPkcePair(): PkcePair {
  const verifier = randomToken(48);
  return {
    verifier,
    challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    method: 'S256',
  };
}

export interface SignedStatePayload {
  readonly [key: string]: string | number | boolean | null;
}

export function signState(
  payload: SignedStatePayload,
  key: Uint8Array,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  assertPepper(key);
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
      nonce: randomToken(16),
    }),
    'utf8',
  ).toString('base64url');
  return `${body}.${hmacSha256(key, body).toString('base64url')}`;
}

export function verifyState(
  token: string,
  key: Uint8Array,
  now: Date = new Date(),
): Record<string, unknown> | null {
  assertPepper(key);
  const [body, signature, extra] = token.split('.');
  if (body === undefined || signature === undefined || extra !== undefined) {
    return null;
  }
  const expected = hmacSha256(key, body);
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const exp = record['exp'];
    if (typeof exp !== 'number' || exp < Math.floor(now.getTime() / 1000)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export interface CursorPayload {
  readonly v: 1;
  readonly k: readonly (string | number | null)[];
  readonly id: string;
}

export function encodeCursor(payload: CursorPayload, key: Uint8Array): string {
  assertPepper(key);
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmacSha256(key, body).toString('base64url')}`;
}

export function decodeCursor(cursor: string, key: Uint8Array): CursorPayload | null {
  if (cursor.length > 1024) {
    return null;
  }
  const record = verifyCursorSignature(cursor, key);
  if (record === null) {
    return null;
  }
  const { v, k, id } = record;
  if (v !== 1 || !Array.isArray(k) || typeof id !== 'string') {
    return null;
  }
  const keys = k as unknown[];
  if (
    !keys.every((item) => item === null || typeof item === 'string' || typeof item === 'number')
  ) {
    return null;
  }
  return { v: 1, k: keys, id };
}

function verifyCursorSignature(cursor: string, key: Uint8Array): Record<string, unknown> | null {
  assertPepper(key);
  const [body, signature, extra] = cursor.split('.');
  if (body === undefined || signature === undefined || extra !== undefined) {
    return null;
  }
  const expected = hmacSha256(key, body);
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const REDACTED = '[REDACTED]';

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) {
      throw new RangeError('secret value must not be empty');
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
