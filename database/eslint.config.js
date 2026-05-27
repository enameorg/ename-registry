import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['scripts/**/*.ts'],

  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },

  plugins: {
    '@typescript-eslint': tseslint.plugin,
    'import-x': importX,
    'unused-imports': unusedImports,
  },

  rules: {
    // Promise hygiene — type-aware
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/require-await': 'error',

    // Import discipline
    'import-x/no-extraneous-dependencies': 'error',
    'import-x/order': [
      'error',
      {
        groups: ['builtin', 'external', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],

    // Auto-removable unused imports
    'unused-imports/no-unused-imports': 'error',
  },
});
