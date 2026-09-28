import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  createPkcePair,
  csrfTokensMatch,
  decodeCursor,
  encodeCursor,
  generateApiKey,
  hashApiKey,
  hashPassword,
  parseApiKey,
  passwordStrengthIssues,
  SecretValue,
  signSessionToken,
  signState,
  timingSafeEqualString,
  verifyPassword,
  verifySessionToken,
  verifyState,
} from '../src/tokens.js';

const key = randomBytes(32);

describe('API keys', () => {
  it('generates keys whose prefix and hash satisfy the database constraints', () => {
    const generated = generateApiKey('live', key);
    expect(generated.prefix).toMatch(/^vk_(live|test)_[A-Za-z0-9]{8,16}$/);
    expect(generated.hash).toHaveLength(32);
    expect(parseApiKey(generated.plaintext)).toEqual({
      prefix: generated.prefix,
      environment: 'live',
    });
    expect(hashApiKey(generated.plaintext, key).equals(generated.hash)).toBe(true);
    expect(hashApiKey(generated.plaintext, randomBytes(32)).equals(generated.hash)).toBe(false);
  });

  it('rejects malformed keys and weak peppers', () => {
    expect(parseApiKey('vk_live_short_abc')).toBeNull();
    expect(parseApiKey(`sk_live_${'a'.repeat(12)}_${'b'.repeat(43)}`)).toBeNull();
    expect(() => generateApiKey('test', randomBytes(8))).toThrow(RangeError);
  });

  it('never produces duplicate prefixes in a large sample', () => {
    const prefixes = new Set(Array.from({ length: 500 }, () => generateApiKey('test', key).prefix));
    expect(prefixes.size).toBe(500);
  });
});

describe('CSRF, PKCE and comparisons', () => {
  it('matches only identical double-submit tokens', () => {
    const token = createCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
    expect(csrfTokensMatch(token, createCsrfToken())).toBe(false);
    expect(csrfTokensMatch(undefined, token)).toBe(false);
    expect(csrfTokensMatch('short', 'short')).toBe(false);
  });

  it('derives S256 PKCE challenges', () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
  });

  it('compares strings without length shortcuts leaking equality', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
  });
});

describe('signed state and cursors', () => {
  it('round-trips signed state and rejects tampering and expiry', () => {
    const now = new Date('2026-09-13T10:00:00Z');
    const token = signState({ tenant_id: 't1', provider: 'google' }, key, 600, now);
    expect(verifyState(token, key, now)).toMatchObject({ tenant_id: 't1', provider: 'google' });
    expect(verifyState(token, key, new Date('2026-09-13T10:11:00Z'))).toBeNull();
    const [body = '', signature = ''] = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ tenant_id: 't2', exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifyState(`${forgedBody}.${signature}`, key, now)).toBeNull();
    expect(verifyState(`${body}.${signature}.x`, key, now)).toBeNull();
    expect(verifyState(token, randomBytes(32), now)).toBeNull();
  });

  it('round-trips pagination cursors and rejects forged ones', () => {
    const cursor = encodeCursor({ v: 1, k: ['2026-09-13T10:00:00.000Z', 5], id: 'abc' }, key);
    expect(decodeCursor(cursor, key)).toEqual({
      v: 1,
      k: ['2026-09-13T10:00:00.000Z', 5],
      id: 'abc',
    });
    const [, signature = ''] = cursor.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, k: [], id: 'other' })).toString('base64url');
    expect(decodeCursor(`${forged}.${signature}`, key)).toBeNull();
    expect(decodeCursor('garbage', key)).toBeNull();
    expect(decodeCursor('x'.repeat(2000), key)).toBeNull();
  });
});

describe('passwords', () => {
  it('hashes and verifies passwords, rejecting wrong passwords and tampered encodings', () => {
    const encoded = hashPassword('Correct-Horse-9');
    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(verifyPassword('Correct-Horse-9', encoded)).toBe(true);
    expect(verifyPassword('wrong-password-9', encoded)).toBe(false);
    expect(verifyPassword('Correct-Horse-9', 'garbage')).toBe(false);
    expect(verifyPassword('Correct-Horse-9', 'bcrypt$10$abc$def')).toBe(false);
    expect(hashPassword('Correct-Horse-9')).not.toBe(encoded);
  });

  it('flags weak passwords and accepts strong ones', () => {
    expect(passwordStrengthIssues('short1A')).toContain('too_short');
    expect(passwordStrengthIssues('alllowercase123')).toContain('too_weak');
    expect(passwordStrengthIssues('a'.repeat(300))).toContain('too_long');
    expect(passwordStrengthIssues('Str0ngEnoughPass')).toEqual([]);
  });
});

describe('session tokens', () => {
  it('round-trips a signed session token and rejects tampering and expiry', () => {
    const secret = 'session-secret-at-least-32-bytes-long';
    const now = Math.floor(Date.now() / 1000);
    const payload = { sid: 'sess_1', sub: 'usr_1', email: 'a@example.com', iat: now, exp: now + 3600 };
    const token = signSessionToken(payload, secret);
    expect(verifySessionToken(token, secret)).toEqual(payload);
    expect(verifySessionToken(token, 'a-different-secret-entirely')).toBeNull();
    expect(verifySessionToken('not-a-token', secret)).toBeNull();
    const [body = ''] = token.split('.');
    expect(verifySessionToken(`${body}.forged-signature`, secret)).toBeNull();
    const expired = signSessionToken({ ...payload, exp: now - 1 }, secret);
    expect(verifySessionToken(expired, secret)).toBeNull();
  });
});

describe('SecretValue', () => {
  it('never reveals the secret through serialization or inspection', () => {
    const secret = new SecretValue('sk_live_super_secret');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(String(secret)).toBe('[REDACTED]');
    expect(inspect({ secret })).not.toContain('sk_live');
    expect(secret.reveal()).toBe('sk_live_super_secret');
    expect(() => new SecretValue('')).toThrow(RangeError);
  });
});
