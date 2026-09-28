import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AwsTenantSecrets,
  LocalVaultTenantSecrets,
  RoutingTenantSecrets,
  TenantSecretError,
  parseSecretReference,
  tenantSecretName,
} from '../src/index.js';

const TENANT = '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f';
const REF_ID = '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e60';
let vault: string;

beforeAll(async () => {
  vault = await mkdtemp(path.join(tmpdir(), 'velyric-tenant-secrets-'));
});

afterAll(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof TenantSecretError ? error.code : String(error);
  }
  return 'resolved';
}

class RecordingClient {
  readonly commands: unknown[] = [];
  readonly values = new Map<string, string>();
  failWith: string | null = null;

  send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    if (this.failWith !== null) {
      return Promise.reject(Object.assign(new Error('aws failure'), { name: this.failWith }));
    }
    if (command instanceof CreateSecretCommand) {
      this.values.set(command.input.Name ?? '', command.input.SecretString ?? '');
      return Promise.resolve({});
    }
    if (command instanceof GetSecretValueCommand) {
      return Promise.resolve({ SecretString: this.values.get(command.input.SecretId ?? '') });
    }
    if (command instanceof DeleteSecretCommand) {
      this.values.delete(command.input.SecretId ?? '');
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  }
}

describe('tenant secret references', () => {
  it('builds and parses namespaced references and rejects traversal', () => {
    expect(
      tenantSecretName({
        tenantId: TENANT,
        kind: 'OAUTH_REFRESH_TOKEN',
        secretRefId: REF_ID,
        version: 2,
      }),
    ).toBe(`tenants/${TENANT}/oauth_refresh_token/${REF_ID}/v2`);
    expect(parseSecretReference(`aws-sm://tenants/${TENANT}/x/v1`)).toEqual({
      scheme: 'aws-sm://',
      name: `tenants/${TENANT}/x/v1`,
    });
    expect(() => parseSecretReference('local-vault://tenants/../etc/passwd')).toThrow(
      TenantSecretError,
    );
    expect(() => parseSecretReference('file:///etc/passwd')).toThrow(TenantSecretError);
    expect(() =>
      tenantSecretName({ tenantId: '../x', kind: 'K', secretRefId: REF_ID, version: 1 }),
    ).toThrow(TenantSecretError);
    expect(() =>
      tenantSecretName({ tenantId: TENANT, kind: 'K', secretRefId: REF_ID, version: 0 }),
    ).toThrow(TenantSecretError);
  });
});

describe('local vault backend', () => {
  it('stores secrets with owner-only permissions, refuses overwrites and deletes them', async () => {
    const secrets = new LocalVaultTenantSecrets(vault);
    const ref = await secrets.store({
      tenantId: TENANT,
      kind: 'OPENAI_SERVICE_ACCOUNT_KEY',
      secretRefId: REF_ID,
      version: 1,
      value: 'sk-proj-test',
    });
    expect(ref).toBe(`local-vault://tenants/${TENANT}/openai_service_account_key/${REF_ID}/v1`);
    expect(await secrets.read(ref)).toBe('sk-proj-test');
    const file = path.join(vault, `${ref.slice('local-vault://'.length)}.secret`);
    expect(await readFile(file, 'utf8')).toBe('sk-proj-test');
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(
      await code(
        secrets.store({
          tenantId: TENANT,
          kind: 'OPENAI_SERVICE_ACCOUNT_KEY',
          secretRefId: REF_ID,
          version: 1,
          value: 'other',
        }),
      ),
    ).toBe('SECRET_ALREADY_EXISTS');
    await secrets.scheduleDeletion(ref);
    expect(await code(secrets.read(ref))).toBe('SECRET_UNAVAILABLE');
    expect(await code(secrets.read(`aws-sm://tenants/${TENANT}/x/v1`))).toBe(
      'SECRET_REFERENCE_INVALID',
    );
  });
});

describe('AWS Secrets Manager backend', () => {
  it('creates tagged secrets idempotently, caches reads and schedules recoverable deletion', async () => {
    const client = new RecordingClient();
    let now = 1_000;
    const secrets = new AwsTenantSecrets(client as unknown as SecretsManagerClient, {
      cacheTtlMs: 100,
      now: () => now,
    });
    const ref = await secrets.store({
      tenantId: TENANT,
      kind: 'OAUTH_REFRESH_TOKEN',
      secretRefId: REF_ID,
      version: 1,
      value: '{"refresh_token":"r"}',
    });
    const create = client.commands[0] as CreateSecretCommand;
    expect(create.input).toMatchObject({
      ClientRequestToken: REF_ID,
      Tags: [
        { Key: 'velyric:tenant_id', Value: TENANT },
        { Key: 'velyric:secret_kind', Value: 'OAUTH_REFRESH_TOKEN' },
      ],
    });
    expect(await secrets.read(ref)).toBe('{"refresh_token":"r"}');
    expect(await secrets.read(ref)).toBe('{"refresh_token":"r"}');
    expect(
      client.commands.filter((command) => command instanceof GetSecretValueCommand),
    ).toHaveLength(1);
    now += 200;
    await secrets.read(ref);
    expect(
      client.commands.filter((command) => command instanceof GetSecretValueCommand),
    ).toHaveLength(2);
    await secrets.scheduleDeletion(ref);
    expect((client.commands.at(-1) as DeleteSecretCommand).input.RecoveryWindowInDays).toBe(7);
    client.failWith = 'ResourceExistsException';
    expect(
      await code(
        secrets.store({ tenantId: TENANT, kind: 'K', secretRefId: REF_ID, version: 1, value: 'v' }),
      ),
    ).toBe('SECRET_ALREADY_EXISTS');
    client.failWith = 'ResourceNotFoundException';
    await expect(secrets.scheduleDeletion(ref)).resolves.toBeUndefined();
    expect(await code(secrets.read(`aws-sm://tenants/${TENANT}/missing/v1`))).toBe(
      'SECRET_UNAVAILABLE',
    );
  });

  it('routes reads by scheme and writes to the configured backend', async () => {
    const client = new RecordingClient();
    const aws = new AwsTenantSecrets(client as unknown as SecretsManagerClient);
    const local = new LocalVaultTenantSecrets(vault);
    const routed = new RoutingTenantSecrets({ aws, local });
    const localRef = await routed.store({
      tenantId: TENANT,
      kind: 'K',
      secretRefId: '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e61',
      version: 1,
      value: 'local-value',
    });
    expect(localRef.startsWith('local-vault://')).toBe(true);
    const awsRef = await aws.store({
      tenantId: TENANT,
      kind: 'K',
      secretRefId: REF_ID,
      version: 3,
      value: 'aws-value',
    });
    expect(await routed.read(localRef)).toBe('local-value');
    expect(await routed.read(awsRef)).toBe('aws-value');
    const awsOnly = new RoutingTenantSecrets({ aws, local: null });
    expect(await code(awsOnly.read(localRef))).toBe('SECRET_REFERENCE_INVALID');
    expect(() => new RoutingTenantSecrets({ aws: null, local: null })).toThrow(RangeError);
  });
});
