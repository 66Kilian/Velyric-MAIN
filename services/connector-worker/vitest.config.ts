import { defineConfig } from 'vitest/config';

const sourceConditions = ['@velyric/source'];

export default defineConfig({
  resolve: { conditions: [...sourceConditions, 'module', 'browser', 'development|production'] },
  ssr: {
    resolve: {
      conditions: [...sourceConditions, 'node', 'development|production'],
      externalConditions: [...sourceConditions, 'node'],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.db.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['test/**/*.db.test.ts'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
