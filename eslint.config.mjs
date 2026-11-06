// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Nest's DI and decorator metadata rely on patterns these rules dislike.
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Seeds and CLI scripts are console programs; that is their interface.
    files: ['prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
