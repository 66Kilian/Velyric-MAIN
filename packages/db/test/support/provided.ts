import type { MigrationTrack } from '../../src/migrations/manifest.js';

export interface ProvidedDatabase {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly template: string;
  readonly tracks: readonly MigrationTrack[];
  readonly migrationsDir: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    velyricDb: ProvidedDatabase;
  }
}
