import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.db.test.ts'],
          environment: 'node',
        },
      },
      {
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
