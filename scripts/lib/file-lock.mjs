import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const OWNER_FILE = 'owner.json';
export const DEFAULT_OWNERLESS_GRACE_MS = 10_000;
export const REAPER_STALE_MS = 30_000;
export const INITIAL_BACKOFF_MS = 50;
export const MAX_BACKOFF_MS = 2_000;

const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

export class LockTimeoutError extends Error {
  constructor(name, holder) {
    const detail =
      holder === null
        ? ''
        : ` held by pid ${holder.pid} on ${holder.hostname} since ${holder.acquiredAt} (${holder.command})`;
    super(`Timed out waiting for lock "${name}"${detail}`);
    this.name = 'LockTimeoutError';
    this.holder = holder;
  }
}

export function assertLockName(name) {
  if (typeof name !== 'string' || !LOCK_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `Invalid lock name "${String(name)}": expected ${LOCK_NAME_PATTERN.source}`,
    );
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function errorCode(error) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function isContention(error) {
  const code = errorCode(error);
  if (code === 'EEXIST') {
    return true;
  }
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

function isValidOwner(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isInteger(value.pid) &&
    typeof value.hostname === 'string' &&
    typeof value.token === 'string' &&
    typeof value.command === 'string' &&
    typeof value.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(value.acquiredAt))
  );
}

export function readOwner(lockPath) {
  let raw;
  try {
    raw = readFileSync(join(lockPath, OWNER_FILE), 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return isValidOwner(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function inspectLock(lockPath, now = Date.now()) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { exists: false, owner: null, ageMs: 0, mtimeMs: 0 };
    }
    throw error;
  }
  const owner = readOwner(lockPath);
  const since = owner === null ? stats.mtimeMs : Date.parse(owner.acquiredAt);
  return { exists: true, owner, ageMs: Math.max(0, now - since), mtimeMs: stats.mtimeMs };
}

export function staleReason(state, options) {
  const currentHost = options.currentHost ?? hostname();
  const alive = options.isAlive ?? isProcessAlive;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? DEFAULT_OWNERLESS_GRACE_MS;
  if (!state.exists) {
    return null;
  }
  if (state.owner === null) {
    return state.ageMs > ownerlessGraceMs ? 'owner metadata is missing or unreadable' : null;
  }
  if (state.ageMs > options.maxAgeMs) {
    return `lock is older than ${String(options.maxAgeMs)} ms`;
  }
  if (state.owner.hostname === currentHost && !alive(state.owner.pid)) {
    return `owner pid ${String(state.owner.pid)} is not running`;
  }
  return null;
}

export function backoffDelay(attempt, remainingMs, random = Math.random) {
  const base = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 1.6 ** attempt);
  const jittered = base / 2 + random() * (base / 2);
  return Math.max(1, Math.min(Math.round(jittered), Math.max(1, remainingMs)));
}

function tryCreate(lockPath, token, command) {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (isContention(error)) {
      return false;
    }
    throw error;
  }
  const owner = {
    pid: process.pid,
    hostname: hostname(),
    token,
    command,
    acquiredAt: new Date().toISOString(),
  };
  const temporary = join(lockPath, `${OWNER_FILE}.${token}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(owner));
    renameSync(temporary, join(lockPath, OWNER_FILE));
  } catch (error) {
    rmSync(lockPath, REMOVE_OPTIONS);
    throw error;
  }
  return true;
}

function sameHolder(current, observed) {
  if (current.owner !== null && observed.owner !== null) {
    return current.owner.token === observed.owner.token;
  }
  return current.owner === null && observed.owner === null && current.mtimeMs === observed.mtimeMs;
}

export function reapStaleLock(lockPath, observed) {
  const reaperPath = `${lockPath}.reaper`;
  try {
    mkdirSync(reaperPath);
  } catch (error) {
    if (!isContention(error)) {
      throw error;
    }
    try {
      if (Date.now() - statSync(reaperPath).mtimeMs > REAPER_STALE_MS) {
        rmSync(reaperPath, REMOVE_OPTIONS);
      }
    } catch (statError) {
      if (errorCode(statError) !== 'ENOENT') {
        throw statError;
      }
    }
    return false;
  }
  try {
    const current = inspectLock(lockPath);
    if (!current.exists) {
      return true;
    }
    if (!sameHolder(current, observed)) {
      return false;
    }
    rmSync(lockPath, REMOVE_OPTIONS);
    return true;
  } finally {
    rmSync(reaperPath, REMOVE_OPTIONS);
  }
}

export async function acquireLock(options) {
  assertLockName(options.name);
  mkdirSync(options.lockRoot, { recursive: true });
  const lockPath = join(options.lockRoot, options.name);
  const token = randomUUID();
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  for (;;) {
    if (tryCreate(lockPath, token, options.command)) {
      return { name: options.name, lockPath, token };
    }
    const state = inspectLock(lockPath);
    const reason = staleReason(state, {
      maxAgeMs: options.maxAgeMs,
      ownerlessGraceMs: options.ownerlessGraceMs,
    });
    if (reason !== null) {
      options.onStale?.(state, reason);
      if (reapStaleLock(lockPath, state)) {
        continue;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LockTimeoutError(options.name, state.owner);
    }
    options.onWait?.(state, attempt);
    await delay(backoffDelay(attempt, remaining));
    attempt += 1;
  }
}

export function releaseLock(handle) {
  const owner = readOwner(handle.lockPath);
  if (owner === null || owner.token !== handle.token) {
    return false;
  }
  rmSync(handle.lockPath, REMOVE_OPTIONS);
  return true;
}
