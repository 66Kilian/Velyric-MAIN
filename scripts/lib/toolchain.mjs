import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSpawnPlan } from './spawn-command.mjs';

export function parseVersion(text) {
  const source = String(text);
  const start = source.search(/\d\.\d/);
  if (start < 0) {
    return null;
  }
  let begin = start;
  while (begin > 0 && source.charCodeAt(begin - 1) >= 48 && source.charCodeAt(begin - 1) <= 57) {
    begin -= 1;
  }
  let end = start;
  while (end < source.length && /[\d.]/.test(source.charAt(end))) {
    end += 1;
  }
  const parts = source
    .slice(begin, end)
    .split('.')
    .filter((part) => part.length > 0)
    .map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

export function formatVersion(version) {
  return version.join('.');
}

export function parseRange(range) {
  const bounds = { min: null, maxExclusive: null };
  for (const part of range
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)) {
    const match = /^(>=|<)\s*([\d.]+)$/.exec(part);
    const version = match === null ? null : parseVersion(match[2]);
    if (match === null || version === null) {
      throw new RangeError(`Unsupported version range segment "${part}" in "${range}"`);
    }
    if (match[1] === '>=') {
      bounds.min = version;
    } else {
      bounds.maxExclusive = version;
    }
  }
  return bounds;
}

export function satisfiesRange(version, bounds) {
  if (bounds.min !== null && compareVersions(version, bounds.min) < 0) {
    return false;
  }
  return !(bounds.maxExclusive !== null && compareVersions(version, bounds.maxExclusive) >= 0);
}

function requireMatch(pattern, text, description) {
  const match = pattern.exec(text);
  if (match === null) {
    throw new Error(`Could not read ${description}`);
  }
  return match[1];
}

export function readPinnedToolchain(repoRoot) {
  const read = (file) => readFileSync(join(repoRoot, file), 'utf8');
  const packageJson = JSON.parse(read('package.json'));
  return {
    node: read('.nvmrc').trim(),
    pnpm: requireMatch(
      /^pnpm@(\d+\.\d+\.\d+)$/,
      String(packageJson.packageManager),
      'packageManager',
    ),
    rust: requireMatch(
      /channel\s*=\s*"([^"]+)"/,
      read('rust-toolchain.toml'),
      'rust-toolchain channel',
    ),
    python: read('.python-version').trim(),
    uvRange: requireMatch(
      /required-version\s*=\s*"([^"]+)"/,
      read('pyproject.toml'),
      'uv required-version',
    ),
  };
}

export function probeVersion(command, args, cwd) {
  const plan = buildSpawnPlan(command, args);
  const result = spawnSync(plan.file, plan.args, {
    cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

export function evaluateToolchain(pins, found) {
  const exact = (tool, pinned, version, optional) => {
    const expected = parseVersion(pinned);
    const ok = version !== null && expected !== null && compareVersions(version, expected) === 0;
    return {
      tool,
      required: pinned,
      found: version === null ? null : formatVersion(version),
      ok,
      optional,
    };
  };
  const nodeExpected = parseVersion(pins.node);
  const nodeOk =
    found.node !== null &&
    nodeExpected !== null &&
    found.node[0] === nodeExpected[0] &&
    compareVersions(found.node, nodeExpected) >= 0;
  const uvBounds = parseRange(pins.uvRange);
  const pythonExpected = parseVersion(pins.python);
  return [
    {
      tool: 'node',
      required: `>=${pins.node} <${String((nodeExpected?.[0] ?? 0) + 1)}`,
      found: found.node === null ? null : formatVersion(found.node),
      ok: nodeOk,
      optional: false,
    },
    exact('pnpm', pins.pnpm, found.pnpm, false),
    exact('rustc', pins.rust, found.rustc, false),
    {
      tool: 'uv',
      required: pins.uvRange,
      found: found.uv === null ? null : formatVersion(found.uv),
      ok: found.uv !== null && satisfiesRange(found.uv, uvBounds),
      optional: false,
    },
    {
      tool: 'python',
      required: pins.python,
      found: found.python === null ? null : formatVersion(found.python),
      ok:
        found.python !== null &&
        pythonExpected !== null &&
        found.python[0] === pythonExpected[0] &&
        found.python[1] === pythonExpected[1],
      optional: false,
    },
    {
      tool: 'docker',
      required: 'any (local dev stack only)',
      found: found.docker === null ? null : formatVersion(found.docker),
      ok: found.docker !== null,
      optional: true,
    },
    {
      tool: 'go',
      required: 'any (local test servers only)',
      found: found.go === null ? null : formatVersion(found.go),
      ok: found.go !== null,
      optional: true,
    },
  ];
}
