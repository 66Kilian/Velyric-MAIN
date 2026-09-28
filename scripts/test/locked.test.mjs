import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const lockedScript = fileURLToPath(new URL('../locked.mjs', import.meta.url));

let workDir;
let lockDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'velyric-locked-'));
  lockDir = join(workDir, 'locks');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function lockEnv(extra = {}) {
  return { ...process.env, VELYRIC_LOCK_DIR: lockDir, ...extra };
}

function runLocked(args, extraEnv = {}) {
  return spawnSync(process.execPath, [lockedScript, ...args], {
    env: lockEnv(extraEnv),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function runLockedAsync(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lockedScript, ...args], {
      env: lockEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code, stderr });
    });
  });
}

function writeOwner(name, owner) {
  const path = join(lockDir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
  return path;
}

function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(result.stdout);
}

describe('scripts/locked.mjs', () => {
  it('runs the command and propagates a zero exit code', () => {
    const result = runLocked(['test', '--', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(lockDir, 'test')), false);
  });

  it('propagates a non-zero exit code and still releases the lock', () => {
    const result = runLocked(['test', '--', process.execPath, '-e', 'process.exit(7)']);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(existsSync(join(lockDir, 'test')), false);
  });

  it('rejects a missing separator with the usage exit code', () => {
    const result = runLocked(['test', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });

  it('rejects invalid lock names', () => {
    const result = runLocked(['Bad Name', '--', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid lock name/);
  });

  it('rejects malformed timeout configuration', () => {
    const result = runLocked(['test', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_TIMEOUT_MS: 'soon',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /VELYRIC_LOCK_TIMEOUT_MS/);
  });

  it('returns 127 and releases the lock when the command does not exist', () => {
    const result = runLocked(['test', '--', 'velyric-command-that-does-not-exist-anywhere']);
    assert.equal(result.status, 127, result.stderr);
    assert.equal(existsSync(join(lockDir, 'test')), false);
  });

  it('serializes concurrent holders of the same lock', async () => {
    const journal = join(workDir, 'journal.txt');
    const body = [
      "const fs = require('node:fs');",
      `const file = ${JSON.stringify(journal)};`,
      'const id = process.argv[1];',
      "fs.appendFileSync(file, 'start ' + id + '\\n');",
      "setTimeout(() => { fs.appendFileSync(file, 'end ' + id + '\\n'); }, 250);",
    ].join('\n');
    const runs = ['a', 'b', 'c'].map((id) =>
      runLockedAsync(['serial', '--', process.execPath, '-e', body, id]),
    );
    const results = await Promise.all(runs);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    const lines = readFileSync(journal, 'utf8').trim().split('\n');
    assert.equal(lines.length, 6);
    for (let index = 0; index < lines.length; index += 2) {
      const [startKind, startId] = lines[index].split(' ');
      const [endKind, endId] = lines[index + 1].split(' ');
      assert.equal(startKind, 'start');
      assert.equal(endKind, 'end');
      assert.equal(startId, endId);
    }
  });

  it('reclaims a lock whose owner process is no longer running', () => {
    writeOwner('stale', {
      pid: deadPid(),
      hostname: hostname(),
      token: 'dead-owner',
      command: 'pnpm install',
      acquiredAt: new Date().toISOString(),
    });
    const result = runLocked(['stale', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_TIMEOUT_MS: '10000',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /removing stale lock/);
  });

  it('waits for a live holder and times out with exit code 75 without stealing the lock', () => {
    const path = writeOwner('held', {
      pid: process.pid,
      hostname: hostname(),
      token: 'live-owner',
      command: 'cargo metadata',
      acquiredAt: new Date().toISOString(),
    });
    const result = runLocked(['held', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_TIMEOUT_MS: '400',
    });
    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /Timed out waiting for lock "held"/);
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    assert.equal(owner.token, 'live-owner');
  });

  it('treats a lock older than the maximum age as stale even if the pid is alive', () => {
    writeOwner('aged', {
      pid: process.pid,
      hostname: hostname(),
      token: 'aged-owner',
      command: 'uv lock',
      acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const result = runLocked(['aged', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_MAX_AGE_MS: '60000',
      VELYRIC_LOCK_TIMEOUT_MS: '10000',
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('reclaims an ownerless lock directory only after the grace period', () => {
    const fresh = join(lockDir, 'ownerless');
    mkdirSync(fresh, { recursive: true });
    const waiting = runLocked(['ownerless', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_TIMEOUT_MS: '300',
    });
    assert.equal(waiting.status, 75, waiting.stderr);
    const past = new Date(Date.now() - 120_000);
    utimesSync(fresh, past, past);
    const reclaimed = runLocked(['ownerless', '--', process.execPath, '-e', 'process.exit(0)'], {
      VELYRIC_LOCK_TIMEOUT_MS: '10000',
    });
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
  });

  it('resolves command shims on PATH and preserves special-character arguments', () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, 'echo-args.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
    );
    if (process.platform === 'win32') {
      writeFileSync(join(binDir, 'echo-args.cmd'), '@"%NODE_EXE%" "%~dp0echo-args.js" %*\r\n');
    } else {
      const shim = join(binDir, 'echo-args');
      writeFileSync(shim, '#!/bin/sh\nexec "$NODE_EXE" "$(dirname "$0")/echo-args.js" "$@"\n');
      chmodSync(shim, 0o755);
    }
    const args = [
      'plain',
      'with space',
      'a&b',
      'pipe|value',
      '(paren)',
      'caret^value',
      'semi;colon',
      'quote"inside',
    ];
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const result = runLocked(['shim', '--', 'echo-args', ...args], {
      NODE_EXE: process.execPath,
      [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  });
});
