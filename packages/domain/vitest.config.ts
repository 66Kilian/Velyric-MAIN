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
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
