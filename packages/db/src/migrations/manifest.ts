import { createHash } from 'node:crypto';

export const MIGRATION_TRACKS = ['core', 'vector'] as const;
export type MigrationTrack = (typeof MIGRATION_TRACKS)[number];

export const MIGRATION_PHASES = ['expand', 'migrate', 'contract'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export interface MigrationEntry {
  readonly id: string;
  readonly track: MigrationTrack;
  readonly file: string;
  readonly sha256: string;
  readonly phase: MigrationPhase;
  readonly transactional: boolean;
  readonly runAsOwner: boolean;
  readonly requiresExtensions: readonly string[];
  readonly dependsOn: readonly string[];
  readonly contractOf: string | null;
  readonly releaseIntroduced: string;
}

export interface MigrationManifest {
  readonly schemaVersion: 1;
  readonly migrations: readonly MigrationEntry[];
}

export class ManifestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid migration manifest:\n- ${issues.join('\n- ')}`);
    this.name = 'ManifestError';
    this.issues = issues;
  }
}

const ID_PATTERN = /^(core|vector)\/(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^\d{4}\.\d{2}\.\d+$/;
const EXTENSION_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function compareReleases(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTrack(value: unknown): value is MigrationTrack {
  return typeof value === 'string' && (MIGRATION_TRACKS as readonly string[]).includes(value);
}

function isPhase(value: unknown): value is MigrationPhase {
  return typeof value === 'string' && (MIGRATION_PHASES as readonly string[]).includes(value);
}

function parseEntry(item: unknown, where: string, issues: string[]): MigrationEntry | null {
  if (!isRecord(item)) {
    issues.push(`${where} must be an object`);
    return null;
  }
  const startCount = issues.length;
  const id = item['id'];
  const track = item['track'];
  const file = item['file'];
  const sha256 = item['sha256'];
  const phase = item['phase'];
  const transactional = item['transactional'];
  const runAsOwner = item['run_as_owner'];
  const requiresExtensions = item['requires_extensions'];
  const dependsOn = item['depends_on'];
  const contractOf = item['contract_of'];
  const releaseIntroduced = item['release_introduced'];

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) issues.push(`${where}.id is invalid`);
  if (!isTrack(track)) issues.push(`${where}.track must be one of ${MIGRATION_TRACKS.join(', ')}`);
  if (typeof file !== 'string') issues.push(`${where}.file must be a string`);
  if (typeof sha256 !== 'string' || !SHA_PATTERN.test(sha256))
    issues.push(`${where}.sha256 must be a lowercase hex sha256`);
  if (!isPhase(phase)) issues.push(`${where}.phase must be one of ${MIGRATION_PHASES.join(', ')}`);
  if (typeof transactional !== 'boolean') issues.push(`${where}.transactional must be a boolean`);
  if (typeof runAsOwner !== 'boolean') issues.push(`${where}.run_as_owner must be a boolean`);
  if (
    !isStringArray(requiresExtensions) ||
    !requiresExtensions.every((ext) => EXTENSION_PATTERN.test(ext))
  ) {
    issues.push(`${where}.requires_extensions must be an array of extension names`);
  }
  if (!isStringArray(dependsOn))
    issues.push(`${where}.depends_on must be an array of migration ids`);
  if (contractOf !== null && typeof contractOf !== 'string')
    issues.push(`${where}.contract_of must be null or a migration id`);
  if (typeof releaseIntroduced !== 'string' || !RELEASE_PATTERN.test(releaseIntroduced)) {
    issues.push(`${where}.release_introduced must look like 2026.09.0`);
  }

  if (
    issues.length !== startCount ||
    typeof id !== 'string' ||
    !isTrack(track) ||
    typeof file !== 'string' ||
    typeof sha256 !== 'string' ||
    !isPhase(phase) ||
    typeof transactional !== 'boolean' ||
    typeof runAsOwner !== 'boolean' ||
    !isStringArray(requiresExtensions) ||
    !isStringArray(dependsOn) ||
    (contractOf !== null && typeof contractOf !== 'string') ||
    typeof releaseIntroduced !== 'string'
  ) {
    return null;
  }

  return {
    id,
    track,
    file,
    sha256,
    phase,
    transactional,
    runAsOwner,
    requiresExtensions,
    dependsOn,
    contractOf,
    releaseIntroduced,
  };
}

export function validateManifest(manifest: MigrationManifest): void {
  const issues: string[] = [];
  const seen = new Map<string, MigrationEntry>();
  const nextNumber = new Map<MigrationTrack, number>();

  for (const entry of manifest.migrations) {
    if (seen.has(entry.id)) {
      issues.push(`duplicate migration id ${entry.id}`);
      continue;
    }
    const match = ID_PATTERN.exec(entry.id);
    if (match?.[1] !== entry.track) {
      issues.push(`${entry.id} id prefix does not match track ${entry.track}`);
    }
    if (entry.file !== `${entry.id}.sql`) {
      issues.push(`${entry.id} file must be ${entry.id}.sql`);
    }
    const expected = nextNumber.get(entry.track) ?? 1;
    const actual = Number(match?.[2] ?? Number.NaN);
    if (actual !== expected) {
      issues.push(
        `${entry.id} breaks gapless numbering for track ${entry.track}; expected ${String(expected).padStart(4, '0')}`,
      );
    }
    nextNumber.set(entry.track, expected + 1);

    for (const dependency of entry.dependsOn) {
      if (!seen.has(dependency)) {
        issues.push(`${entry.id} depends on ${dependency}, which is not an earlier manifest entry`);
      }
    }

    if (entry.phase === 'contract') {
      const expand = entry.contractOf === null ? undefined : seen.get(entry.contractOf);
      if (expand === undefined) {
        issues.push(
          `${entry.id} is a contract migration and must reference an earlier expand migration in contract_of`,
        );
      } else if (expand.phase !== 'expand') {
        issues.push(`${entry.id} contract_of ${expand.id} must reference an expand migration`);
      } else if (compareReleases(expand.releaseIntroduced, entry.releaseIntroduced) >= 0) {
        issues.push(`${entry.id} must ship in a later release than ${expand.id}`);
      }
    } else if (entry.contractOf !== null) {
      issues.push(`${entry.id} sets contract_of but is not a contract migration`);
    }

    if (entry.track === 'vector' && !entry.requiresExtensions.includes('vector')) {
      issues.push(`${entry.id} is in the vector track and must require the vector extension`);
    }

    seen.set(entry.id, entry);
  }

  if (issues.length > 0) {
    throw new ManifestError(issues);
  }
}

export function parseManifest(raw: unknown): MigrationManifest {
  if (!isRecord(raw)) {
    throw new ManifestError(['manifest must be a JSON object']);
  }
  const issues: string[] = [];
  if (raw['schema_version'] !== 1) {
    issues.push('schema_version must be 1');
  }
  const list = raw['migrations'];
  if (!Array.isArray(list)) {
    throw new ManifestError([...issues, 'migrations must be an array']);
  }
  const migrations: MigrationEntry[] = [];
  list.forEach((item: unknown, index) => {
    const entry = parseEntry(item, `migrations[${String(index)}]`, issues);
    if (entry !== null) {
      migrations.push(entry);
    }
  });
  if (issues.length > 0) {
    throw new ManifestError(issues);
  }
  const manifest: MigrationManifest = { schemaVersion: 1, migrations };
  validateManifest(manifest);
  return manifest;
}

export function serializeManifest(manifest: MigrationManifest): string {
  const json = {
    schema_version: manifest.schemaVersion,
    migrations: manifest.migrations.map((entry) => ({
      id: entry.id,
      track: entry.track,
      file: entry.file,
      sha256: entry.sha256,
      phase: entry.phase,
      transactional: entry.transactional,
      run_as_owner: entry.runAsOwner,
      requires_extensions: entry.requiresExtensions,
      depends_on: entry.dependsOn,
      contract_of: entry.contractOf,
      release_introduced: entry.releaseIntroduced,
    })),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}
