export const DEV_PROCESSES = Object.freeze([
  {
    name: 'infra',
    kind: 'task',
    command: 'docker',
    args: [
      'compose',
      '--env-file',
      '.env',
      '-f',
      'infra/docker/compose.dev.yml',
      'up',
      '--detach',
      '--wait',
    ],
  },
  {
    name: 'migrate',
    kind: 'task',
    command: 'pnpm',
    args: ['--filter', '@velyric/db', 'run', 'migrate'],
  },
  {
    name: 'seed',
    kind: 'task',
    command: 'pnpm',
    args: ['--filter', '@velyric/db', 'run', 'seed:local'],
  },
  {
    name: 'provider-simulator',
    kind: 'service',
    command: 'pnpm',
    args: ['--filter', '@velyric/testkit', 'run', 'provider-simulator'],
  },
  {
    name: 'typescript',
    kind: 'service',
    command: 'pnpm',
    args: ['-r', '--parallel', '--if-present', 'run', 'dev'],
  },
  {
    name: 'voice-runtime',
    kind: 'service',
    command: 'cargo',
    args: ['run', '--locked', '-p', 'velyric-voice-runtime'],
  },
  {
    name: 'metering-worker',
    kind: 'service',
    command: 'cargo',
    args: ['run', '--locked', '-p', 'velyric-metering-worker'],
  },
  {
    name: 'document-worker',
    kind: 'service',
    command: 'uv',
    args: ['run', '--frozen', '--package', 'velyric-document-worker', 'velyric-document-worker'],
  },
  {
    name: 'eval-runner',
    kind: 'service',
    command: 'uv',
    args: ['run', '--frozen', '--package', 'velyric-eval-runner', 'velyric-eval-runner'],
  },
]);

export function selectDevProcesses(table, { only, skipInfra }) {
  const known = new Set(table.map((spec) => spec.name));
  const requested =
    only === undefined
      ? null
      : only
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
  if (requested !== null) {
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new RangeError(
        `Unknown dev process name(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`,
      );
    }
  }
  return table.filter((spec) => {
    if (skipInfra && spec.name === 'infra') {
      return false;
    }
    return requested === null || requested.includes(spec.name);
  });
}
