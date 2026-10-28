import { builtinModules } from 'node:module';

import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

// Import boundaries of the backend, as ename-internals.md states them. Each
// entry is one pattern of no-restricted-imports; a block below lists the
// union its files are bound by, since a later block replaces the rule's
// options rather than merging them.
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('node:')).join('|');

const boundary = {
  // A Node built-in carries the node: prefix.
  nodePrefix: {
    regex: `^(${nodeBuiltins})(/|$)`,
    message: 'Import a Node built-in with the node: prefix.',
  },
  // Another concept folder is imported through its index.ts barrel, whatever
  // the depth of the path (cf. ename-internals.md, concept folders).
  barrelOfConcept: {
    regex: String.raw`(?:^|/)(?:services|api)/[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import another concept through its index.ts barrel.',
  },
  barrelOfSibling: {
    regex: String.raw`^\.\./(?!\.\./)[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import another concept through its index.ts barrel.',
  },
  barrelOfSiblingFromAPI: {
    regex: String.raw`^\.\./(?!\.\./|utilities/|services/|database/)[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import another concept through its index.ts barrel.',
  },
  barrelOfChild: {
    regex: String.raw`^\./[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import a concept folder through its index.ts barrel.',
  },
  // The HTTP framework stays in the API layer.
  noHono: {
    regex: String.raw`^(hono(/|$)|@hono/|@scalar/)`,
    message: 'The HTTP framework is imported by the API layer only.',
  },
  noAPI: {
    regex: String.raw`(^|/)api/`,
    message: 'Nothing below the API layer imports it.',
  },
  // The database plumbing is consumed by the Service layer only; an API test
  // may reach the test DB lifecycle helper.
  noDatabase: {
    regex: String.raw`/database/`,
    message: 'The API layer never imports src/database/.',
  },
  noDatabaseButTesting: {
    regex: String.raw`/database/(?!testing\.ts$)`,
    message: 'An API test imports nothing of src/database/ but testing.ts.',
  },
  noServices: {
    regex: String.raw`/services/`,
    message: 'A utility knows no layer.',
  },
  // The event concept sits below every aggregate and imports none of them.
  noAggregateFromEvent: {
    regex: String.raw`^\.\./(?!\.\./|errors\.ts$|context\.ts$)`,
    message: 'The event concept imports no aggregate (cf. ename-internals.md).',
  },
};

// pg appears only in src/database/ (cf. ename-internals.md, primitives).
const noPg = { name: 'pg', message: 'pg is imported by src/database/ only.' };

function restrictImports(patterns, paths = []) {
  return ['error', { patterns, paths }];
}

export default defineConfig(
  {
    files: ['**/*.ts'],

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
  },
  {
    // Test files: node:test's `test(name, fn)` returns a tracked Promise that the
    // runner handles internally, so the floating-promises rule produces noise here.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Import boundaries (cf. ename-internals.md). Every TypeScript file gets the
  // node: prefix rule; the backend's layers and concepts get theirs on top.
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports([boundary.nodePrefix]),
    },
  },
  {
    files: ['backend/src/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [boundary.nodePrefix, boundary.barrelOfConcept, boundary.barrelOfChild],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/utilities/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noHono,
          boundary.noAPI,
          boundary.noServices,
          boundary.noDatabase,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/database/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports([
        boundary.nodePrefix,
        boundary.noHono,
        boundary.noAPI,
        boundary.barrelOfConcept,
        boundary.barrelOfChild,
      ]),
    },
  },
  {
    files: ['backend/src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noHono,
          boundary.noAPI,
          boundary.barrelOfConcept,
          boundary.barrelOfSibling,
          boundary.barrelOfChild,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/services/event/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noHono,
          boundary.noAPI,
          boundary.barrelOfConcept,
          boundary.barrelOfSibling,
          boundary.barrelOfChild,
          boundary.noAggregateFromEvent,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/api/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noDatabase,
          boundary.barrelOfConcept,
          boundary.barrelOfSiblingFromAPI,
          boundary.barrelOfChild,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/api/**/*.test.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noDatabaseButTesting,
          boundary.barrelOfConcept,
          boundary.barrelOfSiblingFromAPI,
          boundary.barrelOfChild,
        ],
        [noPg],
      ),
    },
  },
  {
    // Environment variables are read once, in config.ts (cf. ename-internals.md).
    files: ['backend/src/**/*.ts'],
    ignores: ['backend/src/config.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="process"][property.name="env"]',
          message: 'process.env is read in config.ts only; import config.',
        },
      ],
    },
  },
);
