import { describe, expect, it } from 'vitest';
import { buildConnectionOptionsString } from '../src/client.js';
import {
  detectDestructiveStatements,
  stripSqlLiteralsAndComments,
} from '../src/migrations/destructive.js';
import {
  compareReleases,
  ManifestError,
  parseManifest,
  serializeManifest,
  sha256Hex,
  type MigrationManifest,
} from '../src/migrations/manifest.js';
import { assertMigrationAllowed, computePlan, MigrationError } from '../src/migrations/runner.js';
import { assertTenantContext, DatabaseContextError } from '../src/tenant.js';

const sha = sha256Hex('select 1');

function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const track = id.split('/')[0];
  return {
    id,
    track,
    file: `${id}.sql`,
    sha256: sha,
    phase: 'expand',
    transactional: true,
    run_as_owner: true,
    requires_extensions: track === 'vector' ? ['vector'] : [],
    depends_on: [],
    contract_of: null,
    release_introduced: '2026.09.0',
    ...overrides,
  };
}

function manifest(...entries: Record<string, unknown>[]): MigrationManifest {
  return parseManifest({ schema_version: 1, migrations: entries });
}

describe('destructive statement detection', () => {
  it('ignores destructive words inside strings, comments and dollar-quoted bodies', () => {
    const sqlText = `
      -- DROP TABLE app.calls;
      /* ALTER TABLE x DROP COLUMN y */
      SELECT 'TRUNCATE app.calls';
      CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN TRUNCATE app.calls; END $body$;
      CREATE TABLE "DROP TABLE" (id int);
    `;
    expect(detectDestructiveStatements(sqlText)).toEqual([]);
    expect(stripSqlLiteralsAndComments("select 'it''s'")).toBe("select ''");
  });

  it('flags every destructive statement kind', () => {
    const sqlText = `
      DROP TABLE app.a;
      ALTER TABLE app.b DROP COLUMN c;
      ALTER TABLE app.b RENAME COLUMN c TO d;
      ALTER TABLE app.b RENAME TO e;
      ALTER TABLE app.b ALTER COLUMN c TYPE bigint;
      ALTER TABLE app.b ALTER COLUMN c SET NOT NULL;
      TRUNCATE app.b;
      DROP SCHEMA s;
      DROP TYPE t;
      DROP MATERIALIZED VIEW v;
    `;
    const kinds = detectDestructiveStatements(sqlText).map((finding) => finding.kind);
    expect(new Set(kinds)).toEqual(
      new Set([
        'DROP_TABLE',
        'DROP_COLUMN',
        'RENAME',
        'ALTER_COLUMN_TYPE',
        'SET_NOT_NULL',
        'TRUNCATE',
        'DROP_SCHEMA',
        'DROP_TYPE',
        'DROP_VIEW',
      ]),
    );
    expect(kinds.filter((kind) => kind === 'RENAME')).toHaveLength(2);
  });

  it('allows additive statements', () => {
    expect(
      detectDestructiveStatements(
        'CREATE TABLE app.x (id uuid); ALTER TABLE app.x ADD COLUMN y text; DROP POLICY p ON app.x; DROP TRIGGER t ON app.x;',
      ),
    ).toEqual([]);
  });
});

describe('manifest parsing and validation', () => {
  it('round-trips a valid manifest', () => {
    const parsed = manifest(
      entry('core/0001_a'),
      entry('core/0002_b', { depends_on: ['core/0001_a'] }),
      entry('vector/0001_c'),
    );
    expect(parseManifest(JSON.parse(serializeManifest(parsed)))).toEqual(parsed);
  });

  it('rejects gaps, mismatched files, unknown dependencies and missing vector extension', () => {
    const attempt = (): MigrationManifest =>
      manifest(
        entry('core/0001_a'),
        entry('core/0003_c', { file: 'core/other.sql', depends_on: ['core/0009_missing'] }),
        entry('vector/0001_v', { requires_extensions: [] }),
      );
    expect(attempt).toThrow(ManifestError);
    try {
      attempt();
    } catch (error) {
      const issues = (error as ManifestError).issues.join('\n');
      expect(issues).toContain('gapless numbering');
      expect(issues).toContain('file must be core/0003_c.sql');
      expect(issues).toContain('depends on core/0009_missing');
      expect(issues).toContain('must require the vector extension');
    }
  });

  it('rejects malformed fields', () => {
    expect(() =>
      parseManifest({
        schema_version: 2,
        migrations: [entry('core/0001_a', { sha256: 'XYZ', phase: 'drop' })],
      }),
    ).toThrow(/schema_version must be 1[\s\S]*sha256[\s\S]*phase/);
    expect(() => parseManifest([])).toThrow(ManifestError);
  });

  it('requires contract migrations to follow an expand migration from an earlier release', () => {
    expect(() =>
      manifest(
        entry('core/0001_a'),
        entry('core/0002_b', { phase: 'contract', contract_of: 'core/0001_a' }),
      ),
    ).toThrow(/later release/);
    expect(() => manifest(entry('core/0001_a', { contract_of: 'core/0001_a' }))).toThrow(
      /not a contract migration/,
    );
    expect(
      manifest(
        entry('core/0001_a'),
        entry('core/0002_b', {
          phase: 'contract',
          contract_of: 'core/0001_a',
          release_introduced: '2026.10.0',
        }),
      ).migrations,
    ).toHaveLength(2);
  });

  it('compares release identifiers numerically', () => {
    expect(compareReleases('2026.09.0', '2026.10.0')).toBeLessThan(0);
    expect(compareReleases('2026.10.2', '2026.10.10')).toBeLessThan(0);
    expect(compareReleases('2027.01.0', '2026.12.9')).toBeGreaterThan(0);
    expect(compareReleases('2026.09.1', '2026.09.1')).toBe(0);
  });
});

describe('migration planning', () => {
  const plan = manifest(entry('core/0001_a'), entry('core/0002_b'), entry('vector/0001_v'));

  it('orders core before vector and filters by track', () => {
    expect(computePlan(plan, [], ['vector', 'core']).pending.map((item) => item.id)).toEqual([
      'core/0001_a',
      'core/0002_b',
      'vector/0001_v',
    ]);
    expect(computePlan(plan, [], ['core']).pending.map((item) => item.id)).toEqual([
      'core/0001_a',
      'core/0002_b',
    ]);
  });

  it('refuses unknown applied migrations and checksum drift', () => {
    const appliedAt = new Date();
    expect(() =>
      computePlan(
        plan,
        [{ id: 'core/0099_x', track: 'core', sha256: sha, appliedAt, appliedBy: 't' }],
        ['core'],
      ),
    ).toThrow(MigrationError);
    expect(() =>
      computePlan(
        plan,
        [
          {
            id: 'core/0001_a',
            track: 'core',
            sha256: sha256Hex('other'),
            appliedAt,
            appliedBy: 't',
          },
        ],
        ['core'],
      ),
    ).toThrow(/sha256/);
  });

  it('blocks destructive expand migrations and out-of-order contract migrations', () => {
    const [first] = plan.migrations;
    if (first === undefined) {
      throw new Error('fixture missing');
    }
    expect(() => {
      assertMigrationAllowed(first, plan, new Set(), 'DROP TABLE app.calls');
    }).toThrow(/destructive/);
    const contractPlan = manifest(
      entry('core/0001_a'),
      entry('core/0002_b', {
        phase: 'contract',
        contract_of: 'core/0001_a',
        release_introduced: '2026.10.0',
      }),
    );
    const contract = contractPlan.migrations[1];
    if (contract === undefined) {
      throw new Error('fixture missing');
    }
    expect(() => {
      assertMigrationAllowed(contract, contractPlan, new Set(), 'ALTER TABLE app.x DROP COLUMN y');
    }).toThrow(/earlier release/);
    expect(() => {
      assertMigrationAllowed(
        contract,
        contractPlan,
        new Set(['core/0001_a']),
        'ALTER TABLE app.x DROP COLUMN y',
      );
    }).not.toThrow();
  });
});

describe('connection and context guards', () => {
  it('builds session options with role and timeouts', () => {
    expect(
      buildConnectionOptionsString({
        connectionString: 'postgres://x',
        applicationName: 'control-api',
        assumeRole: 'velyric_app',
      }),
    ).toBe(
      '-c search_path=app,public -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000 -c role=velyric_app',
    );
    expect(() =>
      buildConnectionOptionsString({
        connectionString: 'postgres://x',
        applicationName: 'control-api',
        statementTimeoutMs: 0,
      }),
    ).toThrow(RangeError);
  });

  it('rejects malformed tenant contexts before touching the database', () => {
    const valid = {
      tenantId: '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f',
      actorType: 'USER' as const,
      actorId: 'user-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    };
    expect(() => {
      assertTenantContext(valid);
    }).not.toThrow();
    expect(() => {
      assertTenantContext({ ...valid, tenantId: "x' or 1=1" });
    }).toThrow(DatabaseContextError);
    expect(() => {
      assertTenantContext({ ...valid, traceId: 'short' });
    }).toThrow(DatabaseContextError);
    expect(() => {
      assertTenantContext({ ...valid, actorId: '' });
    }).toThrow(DatabaseContextError);
  });
});
