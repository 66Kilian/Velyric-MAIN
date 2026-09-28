#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { LOCK_NAME_PATTERN, LockTimeoutError, acquireLock, releaseLock } from './lib/file-lock.mjs';
import { runInherited } from './lib/spawn-command.mjs';

const USAGE = 'Usage: node scripts/locked.mjs <lock-name> -- <command> [args...]';
const EXIT_USAGE = 2;
const EXIT_LOCK_TIMEOUT = 75;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const WAIT_REPORT_INTERVAL_MS = 30_000;

function fail(message, code) {
  process.stderr.write(`[locked] ${message}\n`);
  process.exit(code);
}

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    return fail(
      `${name} must be a positive integer number of milliseconds, got "${raw}"`,
      EXIT_USAGE,
    );
  }
  return Number(raw);
}

function parseArguments(argv) {
  const [name, separator, command, ...args] = argv;
  if (name === undefined || separator !== '--' || command === undefined || command === '') {
    return fail(USAGE, EXIT_USAGE);
  }
  if (!LOCK_NAME_PATTERN.test(name)) {
    return fail(
      `invalid lock name "${name}" (expected ${LOCK_NAME_PATTERN.source})\n${USAGE}`,
      EXIT_USAGE,
    );
  }
  return { name, command, args };
}

async function main() {
  const { name, command, args } = parseArguments(process.argv.slice(2));
  const lockRoot =
    process.env.VELYRIC_LOCK_DIR ?? fileURLToPath(new URL('../.locks', import.meta.url));
  const timeoutMs = positiveIntegerFromEnv('VELYRIC_LOCK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const maxAgeMs = positiveIntegerFromEnv('VELYRIC_LOCK_MAX_AGE_MS', DEFAULT_MAX_AGE_MS);
  const commandLine = [command, ...args].join(' ');
  let lastReport = 0;

  let handle;
  try {
    handle = await acquireLock({
      lockRoot,
      name,
      command: commandLine,
      timeoutMs,
      maxAgeMs,
      onStale: (_state, reason) => {
        process.stderr.write(`[locked] removing stale lock "${name}": ${reason}\n`);
      },
      onWait: (state) => {
        const now = Date.now();
        if (now - lastReport < WAIT_REPORT_INTERVAL_MS) {
          return;
        }
        lastReport = now;
        const holder =
          state.owner === null
            ? 'an acquiring process'
            : `pid ${String(state.owner.pid)} since ${state.owner.acquiredAt} (${state.owner.command})`;
        process.stderr.write(`[locked] waiting for lock "${name}" held by ${holder}\n`);
      },
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return fail(error.message, EXIT_LOCK_TIMEOUT);
    }
    throw error;
  }

  const releaseOnExit = () => {
    try {
      releaseLock(handle);
    } catch (error) {
      process.stderr.write(`[locked] failed to release lock "${name}": ${String(error)}\n`);
    }
  };
  process.once('exit', releaseOnExit);

  let result;
  try {
    result = await runInherited(command, args);
  } finally {
    process.removeListener('exit', releaseOnExit);
    releaseOnExit();
  }
  if (result.error !== undefined) {
    process.stderr.write(`[locked] failed to start "${command}": ${result.error.message}\n`);
  }
  process.exitCode = result.code;
}

await main();
