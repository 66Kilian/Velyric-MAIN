import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEV_PROCESSES, selectDevProcesses } from '../lib/dev-processes.mjs';
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  LockTimeoutError,
  acquireLock,
  assertLockName,
  backoffDelay,
  releaseLock,
  staleReason,
} from '../lib/file-lock.mjs';
import { buildSpawnPlan, escapeCmdArgument, signalExitCode } from '../lib/spawn-command.mjs';
import { runSupervised, validateProcessTable } from '../lib/supervisor.mjs';
import {
  compareVersions,
  evaluateToolchain,
  parseRange,
  parseVersion,
  satisfiesRange,
} from '../lib/toolchain.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'velyric-lib-'));
  return Promise.resolve(run(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
}

describe('file-lock', () => {
  const owner = {
    pid: 4242,
    hostname: 'host-a',
    token: 't',
    command: 'c',
    acquiredAt: new Date().toISOString(),
  };

  it('validates lock names', () => {
    assert.doesNotThrow(() => assertLockName('cargo-manifest'));
    assert.throws(() => assertLockName('Upper'), TypeError);
    assert.throws(() => assertLockName('dotted.name'), TypeError);
    assert.throws(() => assertLockName(''), TypeError);
  });

  it('classifies stale locks by pid, age and missing metadata', () => {
    const base = { maxAgeMs: 1_000, ownerlessGraceMs: 500, currentHost: 'host-a' };
    assert.equal(staleReason({ exists: false, owner: null, ageMs: 0 }, base), null);
    assert.equal(
      staleReason({ exists: true, owner, ageMs: 10 }, { ...base, isAlive: () => true }),
      null,
    );
    assert.match(
      staleReason({ exists: true, owner, ageMs: 10 }, { ...base, isAlive: () => false }) ?? '',
      /not running/,
    );
    assert.equal(
      staleReason(
        { exists: true, owner: { ...owner, hostname: 'host-b' }, ageMs: 10 },
        { ...base, isAlive: () => false },
      ),
      null,
    );
    assert.match(
      staleReason({ exists: true, owner, ageMs: 5_000 }, { ...base, isAlive: () => true }) ?? '',
      /older/,
    );
    assert.equal(staleReason({ exists: true, owner: null, ageMs: 100 }, base), null);
    assert.match(staleReason({ exists: true, owner: null, ageMs: 900 }, base) ?? '', /missing/);
  });

  it('keeps backoff within bounds and the remaining budget', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const low = backoffDelay(attempt, 60_000, () => 0);
      const high = backoffDelay(attempt, 60_000, () => 1);
      assert.ok(low >= 1 && low <= high);
      assert.ok(high <= MAX_BACKOFF_MS);
    }
    assert.equal(
      backoffDelay(0, 60_000, () => 1),
      INITIAL_BACKOFF_MS,
    );
    assert.equal(
      backoffDelay(10, 7, () => 1),
      7,
    );
  });

  it('acquires, blocks a second acquirer, and releases only with the matching token', () =>
    withTempDir(async (dir) => {
      const handle = await acquireLock({
        lockRoot: dir,
        name: 'unit',
        command: 'x',
        timeoutMs: 1_000,
        maxAgeMs: 60_000,
      });
      await assert.rejects(
        acquireLock({
          lockRoot: dir,
          name: 'unit',
          command: 'y',
          timeoutMs: 150,
          maxAgeMs: 60_000,
        }),
        LockTimeoutError,
      );
      assert.equal(releaseLock({ ...handle, token: 'other' }), false);
      assert.equal(existsSync(handle.lockPath), true);
      assert.equal(releaseLock(handle), true);
      assert.equal(existsSync(handle.lockPath), false);
    }));

  it('treats corrupt owner metadata as ownerless', () =>
    withTempDir(async (dir) => {
      mkdirSync(join(dir, 'corrupt'));
      writeFileSync(join(dir, 'corrupt', 'owner.json'), '{not json');
      await assert.rejects(
        acquireLock({
          lockRoot: dir,
          name: 'corrupt',
          command: 'y',
          timeoutMs: 150,
          maxAgeMs: 60_000,
          ownerlessGraceMs: 60_000,
        }),
        LockTimeoutError,
      );
      const handle = await acquireLock({
        lockRoot: dir,
        name: 'corrupt',
        command: 'y',
        timeoutMs: 2_000,
        maxAgeMs: 60_000,
        ownerlessGraceMs: 0,
      });
      assert.equal(
        JSON.parse(readFileSync(join(handle.lockPath, 'owner.json'), 'utf8')).token,
        handle.token,
      );
      releaseLock(handle);
    }));
});

describe('spawn-command', () => {
  it('passes commands through unchanged on POSIX platforms', () => {
    assert.deepEqual(buildSpawnPlan('pnpm', ['install'], {}, 'linux'), {
      file: 'pnpm',
      args: ['install'],
      windowsVerbatimArguments: false,
    });
  });

  it('quotes and caret-escapes cmd.exe arguments', () => {
    assert.equal(escapeCmdArgument('a&b', false), '^"a^&b^"');
    assert.equal(escapeCmdArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.equal(escapeCmdArgument('x|y', true), '^^^"x^^^|y^^^"');
  });

  it('maps signals to conventional exit codes', () => {
    assert.equal(signalExitCode('SIGINT'), 130);
    assert.equal(signalExitCode('SIGTERM'), 143);
    assert.equal(signalExitCode(null), 129);
  });
});

describe('toolchain', () => {
  it('parses and compares versions', () => {
    assert.deepEqual(parseVersion('rustc 1.98.1 (48a229cea 2026-09-01)'), [1, 98, 1]);
    assert.deepEqual(parseVersion('v22.20.0'), [22, 20, 0]);
    assert.deepEqual(parseVersion('Python 3.11'), [3, 11, 0]);
    assert.equal(parseVersion('no version here'), null);
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
    assert.equal(compareVersions([1, 10, 0], [1, 9, 9]), 1);
    assert.equal(compareVersions([0, 11, 9], [0, 12, 0]), -1);
  });

  it('evaluates ranges', () => {
    const bounds = parseRange('>=0.12.0,<0.13');
    assert.equal(satisfiesRange([0, 12, 0], bounds), true);
    assert.equal(satisfiesRange([0, 12, 99], bounds), true);
    assert.equal(satisfiesRange([0, 13, 0], bounds), false);
    assert.equal(satisfiesRange([0, 11, 5], bounds), false);
    assert.throws(() => parseRange('~0.12'), RangeError);
  });

  it('reports mismatches and optional tools', () => {
    const pins = {
      node: '22.20.0',
      pnpm: '11.24.0',
      rust: '1.98.1',
      python: '3.11',
      uvRange: '>=0.12.0,<0.13',
    };
    const report = evaluateToolchain(pins, {
      node: [22, 21, 1],
      pnpm: [11, 23, 0],
      rustc: [1, 98, 1],
      uv: [0, 12, 0],
      python: [3, 11, 9],
      docker: null,
      go: [1, 25, 5],
    });
    const byTool = Object.fromEntries(report.map((entry) => [entry.tool, entry]));
    assert.equal(byTool.node.ok, true);
    assert.equal(byTool.pnpm.ok, false);
    assert.equal(byTool.rustc.ok, true);
    assert.equal(byTool.uv.ok, true);
    assert.equal(byTool.python.ok, true);
    assert.equal(byTool.docker.ok, false);
    assert.equal(byTool.docker.optional, true);
    const olderNode = evaluateToolchain(pins, {
      ...byTool,
      node: [22, 19, 0],
      pnpm: [11, 24, 0],
      rustc: [1, 98, 1],
      uv: [0, 12, 0],
      python: [3, 11, 9],
      docker: null,
      go: null,
    });
    assert.equal(olderNode.find((entry) => entry.tool === 'node')?.ok, false);
  });
});

describe('dev process table', () => {
  it('is a valid supervisor table', () => {
    assert.doesNotThrow(() => validateProcessTable(DEV_PROCESSES));
  });

  it('filters by name and infra flag and rejects unknown names', () => {
    const noInfra = selectDevProcesses(DEV_PROCESSES, { only: undefined, skipInfra: true });
    assert.equal(
      noInfra.some((spec) => spec.name === 'infra'),
      false,
    );
    const only = selectDevProcesses(DEV_PROCESSES, {
      only: 'voice-runtime, migrate',
      skipInfra: false,
    });
    assert.deepEqual(
      only.map((spec) => spec.name),
      ['migrate', 'voice-runtime'],
    );
    assert.throws(
      () => selectDevProcesses(DEV_PROCESSES, { only: 'nope', skipInfra: false }),
      RangeError,
    );
  });
});

describe('supervisor', () => {
  function collector() {
    const lines = [];
    return {
      lines,
      io: {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => lines.push(text),
        stderr: (text) => lines.push(text),
      },
    };
  }

  it('stops at the first failing task and never starts services', () =>
    withTempDir(async (dir) => {
      const marker = join(dir, 'service-started');
      const { io, lines } = collector();
      const code = await runSupervised(
        [
          {
            name: 'ok-task',
            kind: 'task',
            command: process.execPath,
            args: ['-e', "console.log('prepared')"],
          },
          {
            name: 'bad-task',
            kind: 'task',
            command: process.execPath,
            args: ['-e', 'process.exit(4)'],
          },
          {
            name: 'service',
            kind: 'service',
            command: process.execPath,
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
          },
        ],
        io,
      );
      assert.equal(code, 4);
      assert.equal(existsSync(marker), false);
      assert.ok(lines.includes('[ok-task] prepared\n'));
    }));

  it('stops long-running services when one service fails and returns its exit code', async () => {
    const { io, lines } = collector();
    const started = Date.now();
    const code = await runSupervised(
      [
        {
          name: 'forever',
          kind: 'service',
          command: process.execPath,
          args: ['-e', "console.log('up'); setInterval(() => {}, 1000)"],
        },
        {
          name: 'crasher',
          kind: 'service',
          command: process.execPath,
          args: ['-e', "setTimeout(() => { console.error('boom'); process.exit(3); }, 300)"],
        },
      ],
      io,
    );
    assert.equal(code, 3);
    assert.ok(Date.now() - started < 20_000);
    assert.ok(lines.includes('[crasher] boom\n'));
  });

  it('treats a service that exits successfully as an unexpected stop', async () => {
    const { io } = collector();
    const code = await runSupervised(
      [
        {
          name: 'forever',
          kind: 'service',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
        },
        {
          name: 'quitter',
          kind: 'service',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      ],
      io,
    );
    assert.equal(code, 1);
  });

  it('rejects malformed process tables', () => {
    assert.throws(
      () =>
        validateProcessTable([
          { name: 'a', kind: 'task', command: 'x', args: [] },
          { name: 'a', kind: 'task', command: 'x', args: [] },
        ]),
      TypeError,
    );
    assert.throws(
      () => validateProcessTable([{ name: 'b', kind: 'daemon', command: 'x', args: [] }]),
      TypeError,
    );
  });
});
