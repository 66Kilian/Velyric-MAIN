#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runInherited } from './lib/spawn-command.mjs';
import { evaluateToolchain, probeVersion, readPinnedToolchain } from './lib/toolchain.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lockedScript = fileURLToPath(new URL('./locked.mjs', import.meta.url));

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    'skip-rust': { type: 'boolean', default: false },
    'skip-python': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

function log(message) {
  process.stderr.write(`[bootstrap] ${message}\n`);
}

const pins = readPinnedToolchain(repoRoot);
const found = {
  node: probeVersion(process.execPath, ['--version'], repoRoot),
  pnpm: probeVersion('pnpm', ['--version'], repoRoot),
  rustc: values['skip-rust'] ? null : probeVersion('rustc', ['--version'], repoRoot),
  uv: values['skip-python'] ? null : probeVersion('uv', ['--version'], repoRoot),
  python: values['skip-python']
    ? null
    : probeVersion('uv', ['run', '--no-project', 'python', '--version'], repoRoot),
  docker: probeVersion('docker', ['--version'], repoRoot),
  go: probeVersion('go', ['version'], repoRoot),
};

const report = evaluateToolchain(pins, found).filter((entry) => {
  if (values['skip-rust'] && entry.tool === 'rustc') {
    return false;
  }
  return !(values['skip-python'] && (entry.tool === 'uv' || entry.tool === 'python'));
});

let missingRequired = false;
for (const entry of report) {
  const status = entry.ok ? 'ok' : entry.optional ? 'missing (optional)' : 'MISMATCH';
  log(
    `${entry.tool.padEnd(7)} required ${entry.required}, found ${entry.found ?? 'nothing'}: ${status}`,
  );
  if (!entry.ok && !entry.optional) {
    missingRequired = true;
  }
}
if (missingRequired) {
  log('toolchain requirements are not met; see docs/architecture/blueprint.md section 2');
  process.exit(1);
}
if (values.check) {
  process.exit(0);
}

const steps = [
  {
    label: 'pnpm install',
    command: process.execPath,
    args: [
      lockedScript,
      'pnpm',
      '--',
      'pnpm',
      'install',
      ...(existsSync(join(repoRoot, 'pnpm-lock.yaml')) ? ['--frozen-lockfile'] : []),
    ],
  },
];
if (!values['skip-python']) {
  steps.push({
    label: 'uv sync',
    command: process.execPath,
    args: [
      lockedScript,
      'uv',
      '--',
      'uv',
      'sync',
      '--all-packages',
      ...(existsSync(join(repoRoot, 'uv.lock')) ? ['--frozen'] : []),
    ],
  });
}
if (!values['skip-rust']) {
  steps.push({
    label: 'cargo fetch',
    command: process.execPath,
    args: [
      lockedScript,
      'cargo-manifest',
      '--',
      'cargo',
      'fetch',
      ...(existsSync(join(repoRoot, 'Cargo.lock')) ? ['--locked'] : []),
    ],
  });
}
if (!values['skip-build']) {
  steps.push({ label: 'build TypeScript packages', command: 'pnpm', args: ['run', 'build:ts'] });
}
steps.push({
  label: 'local environment file',
  command: process.execPath,
  args: [fileURLToPath(new URL('./env-local.mjs', import.meta.url))],
});

for (const step of steps) {
  log(`running ${step.label}`);
  const result = await runInherited(step.command, step.args, { cwd: repoRoot });
  if (result.code !== 0) {
    log(`${step.label} failed with exit code ${String(result.code)}`);
    process.exit(result.code);
  }
}
log('done');
