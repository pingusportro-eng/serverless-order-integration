import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.aws-sam/**',
      'coverage/**',
      'dist/**',
      'ui/coverage/**',
      'ui/dist/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      '*.config.ts',
      'ui/src/**/*.ts',
      'ui/src/**/*.tsx',
      'ui/tests/**/*.ts',
      'ui/tests/**/*.tsx',
      'ui/*.config.ts',
    ],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      curly: 'error',
      eqeqeq: 'error',
    },
  },
);
