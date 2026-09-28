import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderEnumsJson } from '../src/registry.js';

const target = new URL('../generated/enums.json', import.meta.url);
const expected = renderEnumsJson();

function readCurrent(): string | null {
  try {
    return readFileSync(target, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

if (process.argv.includes('--check')) {
  if (readCurrent() !== expected) {
    process.stderr.write(
      'packages/contracts/generated/enums.json is stale; run: pnpm --filter @velyric/contracts run generate:enums\n',
    );
    process.exitCode = 1;
  }
} else {
  mkdirSync(new URL('../generated/', import.meta.url), { recursive: true });
  writeFileSync(target, expected);
}
