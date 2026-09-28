import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ['@velyric/source', 'node', 'development|production'],
      externalConditions: ['@velyric/source', 'node'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
