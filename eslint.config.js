import { builtinModules } from 'node:module';

import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

// Import boundaries of the backend, as ename-internals.md states them. Each entry is one pattern of
// no-restricted-imports; a block below lists the union its files are bound by, since a later block
// replaces the rule's options rather than merging them.
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('node:')).join('|');

const boundary = {
  // A Node built-in carries the node: prefix.
  nodePrefix: {
    regex: `^(${nodeBuiltins})(/|$)`,
    message: 'Import a Node built-in with the node: prefix.',
  },
  // Another concept folder is imported through its index.ts barrel, whatever the depth of the path
  // (cf. ename-internals.md).
  barrelOfConcept: {
    regex: String.raw`(?:^|/)(?:services|api)/[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import another concept through its index.ts barrel.',
  },
  barrelOfSibling: {
    regex: String.raw`^\.\./(?!\.\./)[^/]+/(?!index\.ts$)[^/]+$`,
    message: 'Import another concept through its index.ts barrel.',
  },
  // The same rule for a block that holds a layer's root modules (src/api/*.ts, src/services/*.ts):
  // from there the utilities and the other layers are sibling folders too, imported by file.
  barrelOfSiblingConcept: {
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
  // The database plumbing is consumed by the Service layer only; an API test may reach the test DB
  // lifecycle helper.
  noDatabase: {
    regex: String.raw`/database/`,
    message: 'The API layer never imports src/database/.',
  },
  noDatabaseButTesting: {
    regex: String.raw`/database/(?!testing\.ts$)`,
    message: 'An API test imports nothing of src/database/ but testing.ts.',
  },
  noLayer: {
    regex: String.raw`(^|/)(api|services|database)/`,
    message: 'A utility knows no layer.',
  },
  // The event concept sits below every other concept and imports none of them: the signer of an
  // event is authenticated by the function its use case passes. It imports only the Service's
  // common folder, which any concept may import.
  noConceptFromEvent: {
    regex: String.raw`^\.\./(?!\.\./|errors\.ts$|context\.ts$|common/index\.ts$)`,
    message: 'The event concept imports no other concept (cf. ename-internals.md).',
  },
  // The key concept sits below the concepts that own keys and imports no other concept.
  noConceptFromKey: {
    regex: String.raw`^\.\./(?!\.\./|errors\.ts$|context\.ts$|common/index\.ts$)`,
    message: 'The key concept imports no other concept (cf. ename-internals.md).',
  },
  // The Service's common folder holds what several concepts share, below all of them: it imports no
  // concept.
  noConceptFromCommon: {
    regex: String.raw`^\.\./(?!\.\./|errors\.ts$|context\.ts$)`,
    message: 'The common folder imports no concept (cf. ename-internals.md).',
  },
};

// The selectors of no-restricted-syntax, shared by the blocks below.
const noProcessEnv = {
  selector: 'MemberExpression[object.name="process"][property.name="env"]',
  message: 'process.env is read in config.ts only; import config.',
};

const noQuery = {
  selector: 'CallExpression[callee.property.name="query"]',
  message: 'The Service layer runs SQL through the query helpers of src/database/.',
};

// pg appears only in src/database/ (cf. ename-internals.md).
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
    // A line holding only a comment, at Prettier's width (cf. ename-internals.md). Core's max-len
    // is deprecated and available until ESLint 11; its replacement is @stylistic/max-len, with the
    // same options.
    files: ['**/*.ts', '**/*.js'],
    rules: {
      'max-len': ['error', { code: Number.MAX_SAFE_INTEGER, comments: 100, ignoreUrls: true }],
    },
  },
  {
    // Test files: node:test's `test(name, fn)` returns a tracked Promise that the runner handles
    // internally, so the floating-promises rule produces noise here.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Import boundaries (cf. ename-internals.md). Every TypeScript file gets the node: prefix rule;
  // the backend's layers and concepts get theirs on top.
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
        [boundary.nodePrefix, boundary.noHono, boundary.noLayer],
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
    // The Service layer's root modules (its errors, its context, its test helper) sit beside the
    // concept folders, one level up: from there the plumbing and the utilities are siblings,
    // imported by file.
    files: ['backend/src/services/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [
          boundary.nodePrefix,
          boundary.noHono,
          boundary.noAPI,
          boundary.barrelOfConcept,
          boundary.barrelOfSiblingConcept,
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
          boundary.noConceptFromEvent,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/services/key/**/*.ts'],
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
          boundary.noConceptFromKey,
        ],
        [noPg],
      ),
    },
  },
  {
    files: ['backend/src/services/common/**/*.ts'],
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
          boundary.noConceptFromCommon,
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
          boundary.barrelOfSiblingConcept,
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
          boundary.barrelOfSiblingConcept,
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
      'no-restricted-syntax': ['error', noProcessEnv],
    },
  },
  {
    // The Service layer runs SQL through the query helpers, which translate an unavailable database
    // (cf. ename-internals.md). A later block replaces a rule rather than extending it, so this one
    // repeats noProcessEnv.
    files: ['backend/src/services/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noProcessEnv, noQuery],
    },
  },
);
