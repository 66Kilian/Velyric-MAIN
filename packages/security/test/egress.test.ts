import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  hostMatchesAllowlist,
  normalizeAllowlistEntry,
  safeRequest,
  validateEgressUrl,
  validatePolicy,
  type EgressPolicy,
  type HostResolver,
} from '../src/egress.js';

function reasonOf(error: unknown): string | undefined {
  return error instanceof EgressBlockedError ? error.reason : undefined;
}

const basePolicy: EgressPolicy = {
  ...DEFAULT_EGRESS_POLICY,
  allowedHosts: ['api.example.com', '*.partner.example'],
};

describe('static URL validation', () => {
  it('accepts allowlisted https hosts and wildcard subdomains', () => {
    expect(validateEgressUrl('https://api.example.com/v1/items', basePolicy).hostname).toBe(
      'api.example.com',
    );
    expect(validateEgressUrl('https://eu.partner.example/x', basePolicy).hostname).toBe(
      'eu.partner.example',
    );
  });

  it.each([
    ['http://api.example.com/', 'SCHEME_NOT_ALLOWED'],
    ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
    ['gopher://api.example.com/', 'SCHEME_NOT_ALLOWED'],
    ['https://user:pass@api.example.com/', 'CREDENTIALS_IN_URL'],
    ['https://api.example.com:8443/', 'PORT_NOT_ALLOWED'],
    ['https://partner.example/', 'HOST_NOT_ALLOWLISTED'],
    ['https://api.example.com.evil.test/', 'HOST_NOT_ALLOWLISTED'],
    ['https://127.0.0.1/', 'HOST_NOT_ALLOWLISTED'],
    ['https://0x7f.1/', 'HOST_NOT_ALLOWLISTED'],
    ['https://[::ffff:7f00:1]/', 'HOST_NOT_ALLOWLISTED'],
    ['not a url', 'INVALID_URL'],
  ])('rejects %s with %s', (url, reason) => {
    expect(
      reasonOf(
        (() => {
          try {
            validateEgressUrl(url, basePolicy);
            return null;
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toBe(reason);
  });

  it('refuses private IP literals even when allowlisted by mistake', () => {
    expect(() => normalizeAllowlistEntry('169.254.169.254')).toThrow(EgressBlockedError);
    expect(() => normalizeAllowlistEntry('*')).toThrow(EgressBlockedError);
    expect(normalizeAllowlistEntry(' API.Example.com ')).toBe('api.example.com');
    expect(hostMatchesAllowlist('partner.example', ['*.partner.example'])).toBe(false);
  });

  it('validates policy limits per environment', () => {
    expect(() => {
      validatePolicy({ ...basePolicy, trustedPrivateCidrs: ['10.0.0.0/8'] }, 'production');
    }).toThrow(/local and ci/);
    expect(() => {
      validatePolicy({ ...basePolicy, allowHttp: true }, 'production');
    }).toThrow(/HTTP/);
    expect(() => {
      validatePolicy({ ...basePolicy, allowedHosts: [] }, 'staging');
    }).toThrow(/at least one/);
    expect(() => {
      validatePolicy({ ...basePolicy, maxRedirects: 9 }, 'staging');
    }).toThrow(/limits/);
    expect(() => {
      validatePolicy(basePolicy, 'production');
    }).not.toThrow();
  });
});

describe('safeRequest against a real HTTP server', () => {
  let server: Server;
  let port = 0;
  const seenHosts: string[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      seenHosts.push(request.headers.host ?? '');
      const url = new URL(request.url ?? '/', 'http://localhost');
      switch (url.pathname) {
        case '/json':
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          return;
        case '/html':
          response.writeHead(200, { 'content-type': 'text/html' }).end('<p>no</p>');
          return;
        case '/large':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(`"${'x'.repeat(5000)}"`);
          return;
        case '/chunked':
          response.writeHead(200, {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          });
          for (let index = 0; index < 20; index += 1) {
            response.write('x'.repeat(500));
          }
          response.end();
          return;
        case '/slow':
          setTimeout(
            () => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
            1500,
          );
          return;
        case '/redirect-evil':
          response.writeHead(302, { location: 'http://evil.test/' }).end();
          return;
        case '/redirect-internal':
          response
            .writeHead(302, { location: `http://internal.service.test:${String(port)}/json` })
            .end();
          return;
        case '/redirect-ok':
          response.writeHead(307, { location: '/json' }).end();
          return;
        default:
          response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  const resolverCalls: string[] = [];
  const resolver: HostResolver = (hostname) => {
    resolverCalls.push(hostname);
    if (hostname === 'service.test') return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    if (hostname === 'internal.service.test')
      return Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    if (hostname === 'mixed.service.test')
      return Promise.resolve([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    return Promise.reject(new Error('NXDOMAIN'));
  };

  const policy = (overrides: Partial<EgressPolicy> = {}): EgressPolicy => ({
    ...DEFAULT_EGRESS_POLICY,
    allowedHosts: ['service.test', '*.service.test'],
    allowHttp: true,
    allowedPorts: [port],
    trustedPrivateCidrs: ['127.0.0.1/32'],
    maxResponseBytes: 2048,
    totalTimeoutMs: 800,
    ...overrides,
  });

  const run = (path: string, overrides: Partial<EgressPolicy> = {}): Promise<unknown> =>
    safeRequest(
      { url: `http://service.test:${String(port)}${path}` },
      { policy: policy(overrides), environment: 'ci', resolver },
    );

  it('connects to the validated, pinned address while preserving the Host header', async () => {
    const response = (await run('/json')) as {
      status: number;
      body: Uint8Array;
      remoteAddress: string;
    };
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
    expect(response.remoteAddress).toBe('127.0.0.1');
    expect(seenHosts.at(-1)).toBe(`service.test:${String(port)}`);
  });

  it('blocks hosts that resolve to non-public addresses (DNS rebinding) and mixed answers', async () => {
    const internal = safeRequest(
      { url: `http://internal.service.test:${String(port)}/json` },
      { policy: policy(), environment: 'ci', resolver },
    );
    await expect(internal).rejects.toMatchObject({ reason: 'ADDRESS_NOT_PUBLIC' });
    const mixed = safeRequest(
      { url: `http://mixed.service.test:${String(port)}/json` },
      { policy: policy(), environment: 'ci', resolver },
    );
    await expect(mixed).rejects.toMatchObject({ reason: 'ADDRESS_NOT_PUBLIC' });
    await expect(
      safeRequest(
        { url: `http://nx.service.test:${String(port)}/` },
        { policy: policy(), environment: 'ci', resolver },
      ),
    ).rejects.toMatchObject({
      reason: 'DNS_RESOLUTION_FAILED',
    });
  });

  it('denies redirects by default and re-validates every hop when enabled', async () => {
    await expect(run('/redirect-ok')).rejects.toMatchObject({ reason: 'REDIRECT_NOT_ALLOWED' });
    await expect(run('/redirect-evil', { maxRedirects: 2 })).rejects.toMatchObject({
      reason: 'HOST_NOT_ALLOWLISTED',
    });
    await expect(run('/redirect-internal', { maxRedirects: 2 })).rejects.toMatchObject({
      reason: 'ADDRESS_NOT_PUBLIC',
    });
    const ok = (await run('/redirect-ok', { maxRedirects: 1 })) as {
      status: number;
      redirects: number;
    };
    expect(ok).toMatchObject({ status: 200, redirects: 1 });
  });

  it('enforces response size, content type and total timeout', async () => {
    await expect(run('/large')).rejects.toMatchObject({ reason: 'RESPONSE_TOO_LARGE' });
    await expect(run('/chunked', { maxResponseBytes: 4000 })).rejects.toMatchObject({
      reason: 'RESPONSE_TOO_LARGE',
    });
    await expect(run('/html')).rejects.toMatchObject({ reason: 'CONTENT_TYPE_NOT_ALLOWED' });
    await expect(run('/slow')).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('does not trust loopback without an explicit trusted CIDR', async () => {
    await expect(run('/json', { trustedPrivateCidrs: [] })).rejects.toMatchObject({
      reason: 'ADDRESS_NOT_PUBLIC',
    });
    expect(resolverCalls.length).toBeGreaterThan(0);
  });
});
