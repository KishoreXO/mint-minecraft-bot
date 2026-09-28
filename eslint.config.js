/**
 * Lint config, deliberately dependency-free.
 *
 * There wasn't one, which meant "run lint before reporting" quietly did
 * nothing for a long time — `npx eslint .` downloaded a fresh ESLint, found no
 * config, printed a migration guide and exited non-zero, which reads as a
 * tooling problem rather than a missing check.
 *
 * No plugins and no `@eslint/js` import on purpose: those resolve from the
 * project's node_modules, and ESLint here is run through npx from a temporary
 * install, so importing anything would break the moment it is actually needed.
 * Plain rules always work.
 *
 * The rules are chosen for the failures this project actually has. Every one
 * of these has cost a live session:
 *
 *   no-undef            a typo'd identifier that only throws on the code path
 *                       nobody hits until the bot is 60 blocks underground
 *   no-unused-vars      a require() left behind after a refactor, or an
 *                       argument that was silently dropped from a signature
 *   no-await-in-loop    off, deliberately — nearly every behavior is a
 *                       sequence of awaited game actions and must stay that way
 *   require-atomic-updates
 *                       also off, and that is a considered call rather than
 *                       giving up on it. It fires on every `ctx.x = y` that
 *                       follows an await, which in this codebase is most of
 *                       them — and the premise does not hold here: the
 *                       director runs exactly one behavior at a time and
 *                       aborts it before starting another, so there is no
 *                       second writer for a stale read to race. Fifteen
 *                       reports, none of them real, is a rule that trains you
 *                       to skim past the output.
 */

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
};

module.exports = [
  {
    // _superseded holds the old implementations, kept for reference only.
    // Nothing requires them and they are not maintained.
    ignores: ['node_modules/**', '_superseded/**', 'logs/**', 'authCache/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-shadow': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false }],
      'no-return-await': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'require-atomic-updates': 'off',
      'no-unsafe-optional-chaining': 'error',
      'no-promise-executor-return': 'error',
      'consistent-return': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // The web dashboard runs in a browser, not in node.
    files: ['dashboard/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        EventSource: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        URLSearchParams: 'readonly',
        AudioContext: 'readonly',
        matchMedia: 'readonly',
        console: 'readonly',
      },
    },
  },
];
