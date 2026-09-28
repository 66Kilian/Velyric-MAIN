import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import pluginSecurity from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const velyricIgnores = globalIgnores([
  '**/node_modules/',
  '**/dist/',
  '**/.next/',
  '**/coverage/',
  '**/storybook-static/',
  '**/playwright-report/',
  '**/test-results/',
  '**/generated/',
  'target/',
  '.venv/',
  '.locks/',
  '.cache/',
  'docs/spec/',
  'assets/',
  'fuzz/',
  'infra/tofu/.terraform/',
]);

export const velyricBaseConfig = [
  js.configs.recommended,
  pluginSecurity.configs.recommended,
  {
    name: 'velyric/all',
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx', 'hack', 'implement later'], location: 'anywhere' },
      ],
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'security/detect-object-injection': 'off',
    },
  },
  {
    name: 'velyric/typescript',
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    name: 'velyric/react',
    files: ['**/*.tsx'],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    name: 'velyric/next-intl',
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-deprecated': [
        'error',
        {
          allow: [
            { from: 'package', package: 'next-intl', name: ['setRequestLocale'] },
            'requestLocale',
          ],
        },
      ],
    },
  },
  {
    name: 'velyric/repository-file-access',
    files: ['packages/db/src/migrations/**/*.ts', 'packages/tenant-secrets/src/index.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-unsafe-regex': 'off',
    },
  },
  {
    name: 'velyric/tooling-scripts',
    files: ['scripts/**/*.mjs', '**/scripts/**/*.{ts,mjs}', '**/*.config.{js,mjs,ts}'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
    },
  },
  {
    name: 'velyric/tests',
    files: ['**/*.test.{ts,tsx,mjs}', '**/test/**/*.{ts,tsx,mjs}', '**/tests/**/*.{ts,tsx,mjs}'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
      'security/detect-non-literal-regexp': 'off',
      'security/detect-unsafe-regex': 'off',
    },
  },
  eslintConfigPrettier,
];

export default defineConfig([velyricIgnores, ...velyricBaseConfig]);
