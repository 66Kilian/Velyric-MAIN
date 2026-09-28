#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

import { DEV_PROCESSES, selectDevProcesses } from './lib/dev-processes.mjs';
import { runSupervised } from './lib/supervisor.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = fileURLToPath(new URL('../.env', import.meta.url));

function exitWithUsage(message) {
  process.stderr.write(
    `[dev] ${message}\nUsage: pnpm dev [--no-infra] [--only name,name]\nProcesses: ${DEV_PROCESSES.map((spec) => spec.name).join(', ')}\n`,
  );
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      'no-infra': { type: 'boolean', default: false },
      only: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
} catch (error) {
  exitWithUsage(error instanceof Error ? error.message : String(error));
}

const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const environment = { ...fileEnv, ...process.env };
environment.VELYRIC_ENV = environment.VELYRIC_ENV ?? 'local';
if (environment.VELYRIC_ENV !== 'local') {
  exitWithUsage(
    `the dev stack only runs with VELYRIC_ENV=local (got "${environment.VELYRIC_ENV}")`,
  );
}

let selected;
try {
  selected = selectDevProcesses(DEV_PROCESSES, {
    only: parsed.values.only,
    skipInfra: parsed.values['no-infra'] === true,
  });
} catch (error) {
  exitWithUsage(error instanceof Error ? error.message : String(error));
}

process.exitCode = await runSupervised(selected, {
  cwd: repoRoot,
  env: environment,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
