import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, SignJWT, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  importServiceSigner,
  ServiceTokenError,
  signServiceToken,
  verifyServiceToken,
  type ServiceSigner,
  type ServiceTokenVerifier,
} from '../src/service-jwt.js';

const TENANT_ID = '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f';

function keyPair(): {
  pem: string;
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
} {
  const pair = generateKeyPairSync('ed25519');
  return {
    pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: pair.publicKey,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof ServiceTokenError ? error.code : 'OTHER';
  }
}

describe('service JWTs', () => {
  let signer: ServiceSigner;
  let jwks: JSONWebKeySet;
  const seen = new Set<string>();
  const verifier = (): ServiceTokenVerifier => ({
    audience: 'control-api',
    jwks,
    replayGuard: (issuer, jti) => {
      const key = `${issuer}:${jti}`;
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
  });

  beforeAll(async () => {
    const { pem, publicKey } = keyPair();
    signer = await importServiceSigner('voice-runtime', 'voice-runtime-2026-09', pem);
    jwks = {
      keys: [
        { ...(await exportJWK(publicKey)), kid: 'voice-runtime-2026-09', alg: 'EdDSA', use: 'sig' },
      ],
    };
  });

  it('signs and verifies scoped, tenant-bound tokens exactly once', async () => {
    const token = await signServiceToken(signer, {
      audience: 'control-api',
      scopes: ['tool.execute', 'runtime.snapshot.read'],
      tenantId: TENANT_ID,
    });
    const verified = await verifyServiceToken(token, verifier(), ['tool.execute']);
    expect(verified.issuer).toBe('voice-runtime');
    expect(verified.tenantId).toBe(TENANT_ID);
    expect([...verified.scopes].sort()).toEqual(['runtime.snapshot.read', 'tool.execute']);
    expect(await errorCode(verifyServiceToken(token, verifier(), ['tool.execute']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );
  });

  it('rejects missing scopes, wrong audience, expiry and unknown keys', async () => {
    const token = await signServiceToken(signer, {
      audience: 'control-api',
      scopes: ['usage.write'],
    });
    expect(await errorCode(verifyServiceToken(token, verifier(), ['tool.execute']))).toBe(
      'SERVICE_SCOPE_MISSING',
    );

    const wrongAudience = await signServiceToken(signer, {
      audience: 'metering-worker',
      scopes: ['usage.write'],
    });
    expect(await errorCode(verifyServiceToken(wrongAudience, verifier(), ['usage.write']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );

    const past = new Date(Date.now() - 3_600_000);
    const expired = await signServiceToken(signer, {
      audience: 'control-api',
      scopes: ['usage.write'],
      now: past,
    });
    expect(await errorCode(verifyServiceToken(expired, verifier(), ['usage.write']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );

    const foreign = await importServiceSigner(
      'voice-runtime',
      'voice-runtime-2026-09',
      keyPair().pem,
    );
    const forged = await signServiceToken(foreign, {
      audience: 'control-api',
      scopes: ['usage.write'],
    });
    expect(await errorCode(verifyServiceToken(forged, verifier(), ['usage.write']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );
  });

  it('rejects tokens whose issuer and subject disagree or whose lifetime is too long', async () => {
    const now = Math.floor(Date.now() / 1000);
    const spoofed = await new SignJWT({ scope: 'usage.write' })
      .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid })
      .setIssuer('voice-runtime')
      .setSubject('workflow-worker')
      .setAudience('control-api')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .setJti('0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e60')
      .sign(signer.key);
    expect(await errorCode(verifyServiceToken(spoofed, verifier(), ['usage.write']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );

    const longLived = await new SignJWT({ scope: 'usage.write' })
      .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid })
      .setIssuer('voice-runtime')
      .setSubject('voice-runtime')
      .setAudience('control-api')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 3600)
      .setJti('0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e61')
      .sign(signer.key);
    expect(await errorCode(verifyServiceToken(longLived, verifier(), ['usage.write']))).toBe(
      'SERVICE_TOKEN_INVALID',
    );
  });

  it('refuses to sign invalid tokens', async () => {
    expect(await errorCode(signServiceToken(signer, { audience: 'control-api', scopes: [] }))).toBe(
      'SERVICE_TOKEN_INVALID',
    );
    expect(
      await errorCode(
        signServiceToken(signer, {
          audience: 'control-api',
          scopes: ['usage.write'],
          lifetimeSeconds: 900,
        }),
      ),
    ).toBe('SERVICE_TOKEN_INVALID');
    expect(
      await errorCode(
        signServiceToken(signer, {
          audience: 'control-api',
          scopes: ['usage.write'],
          tenantId: 'tenant-1',
        }),
      ),
    ).toBe('SERVICE_TOKEN_INVALID');
    expect(await errorCode(importServiceSigner('voice-runtime', 'x', keyPair().pem))).toBe(
      'SERVICE_TOKEN_INVALID',
    );
  });
});
