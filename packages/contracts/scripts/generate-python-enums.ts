import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderEnumsJson } from '../src/registry.js';

const TARGETS = [
  new URL(
    '../../../services/document-worker/src/velyric_document_worker/generated/',
    import.meta.url,
  ),
  new URL('../../../services/eval-runner/src/velyric_eval_runner/generated/', import.meta.url),
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function render(): string {
  const parsed = JSON.parse(renderEnumsJson()) as { enums: Record<string, Record<string, string>> };
  const lines = ['from enum import StrEnum', ''];
  for (const [name, members] of Object.entries(parsed.enums).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!IDENTIFIER.test(name)) {
      throw new Error(`enum name ${name} is not a Python identifier`);
    }
    lines.push('', `class ${name}(StrEnum):`);
    for (const [member, value] of Object.entries(members)) {
      if (!IDENTIFIER.test(member)) {
        throw new Error(`enum member ${name}.${member} is not a Python identifier`);
      }
      lines.push(`    ${member} = ${JSON.stringify(value)}`);
    }
    lines.push('');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n\n')
    .trimEnd()}\n`;
}

const expected = render();
let stale = false;
for (const directory of TARGETS) {
  const file = new URL('enums.py', directory);
  const init = new URL('__init__.py', directory);
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  if (process.argv.includes('--check')) {
    stale ||= current !== expected;
    continue;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, expected);
  writeFileSync(init, '');
}
if (stale) {
  process.stderr.write(
    'generated Python enum mirrors are stale; run: pnpm --filter @velyric/contracts run generate:python-enums\n',
  );
  process.exitCode = 1;
}
