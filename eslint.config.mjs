import cds from '@sap/cds/eslint.config.mjs';
import cdsPlugin from '@sap/eslint-plugin-cds';
import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';

export default [
  // Lint the CAP backend only (srv, test, root configs). The Vue SPA under
  // app/portal/ has its own toolchain (app/portal/eslint.config.mjs), app/ also
  // holds compiled bundles, and gen/ is generated.
  {
    ignores: ['app/**', 'gen/**', 'dist/**'],
  },

  // Airbnb JS style guide (base only — no React/Next). This is the full
  // eslint-config-airbnb-base ruleset for non-React JS: style + best practices.
  airbnbPlugins.stylistic,
  airbnbPlugins.importX,
  ...airbnb.base.recommended,

  // CAP layers last so its globals (SELECT, INSERT, cds, …) and .cds linting
  // win over Airbnb's no-undef, and .cds files are parsed/linted correctly.
  ...cds.recommended,
  cdsPlugin.configs.recommended,

  // srv/ and scripts/ are CommonJS (require/module.exports) at runtime, even
  // though Airbnb's base parses as ESM. Declaring sourceType keeps that explicit
  // so `strict: 'safe'` (below) treats them as scripts and enforces the global
  // "use strict" directive they rely on for strict-mode runtime semantics.
  // test/ is left as ESM — the vitest suites use import/export.
  {
    files: ['srv/**/*.js', 'scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },

  // Modern JS: Airbnb base pins an older ecmaVersion that rejects ?? and ?.
  // CAP service code uses both, so opt the backend JS into the latest syntax.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: { ecmaVersion: 'latest' },
    },
    rules: {
      // ESM (flat config, .mjs) requires explicit file extensions on imports;
      // Airbnb's no-extension rule predates native ESM.
      'import-x/extensions': 'off',
      // 'safe' = require/allow "use strict" in CommonJS (.js) files, forbid it
      // in ESM (.mjs). The backend is CommonJS and keeps its directives; Airbnb
      // defaults to 'never', which assumes everything is a module.
      strict: ['error', 'safe'],
      // Restore canonical eslint-config-airbnb-base max-len options (this
      // airbnb-extended preset drops them): keep the 100-col limit for real code
      // and comments, but don't count long string/template/URL/regex literals —
      // breaking a CloudFront policy JSON or a log template only hurts readability.
      // The preset lints via @stylistic/max-len; core max-len stays off (no dupes).
      'max-len': 'off',
      '@stylistic/max-len': ['error', 100, 2, {
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }],
      // The lib/ modules keep small helper functions at the bottom and call them
      // from the top — a readable layout that Airbnb's default would forbid.
      'no-use-before-define': ['error', { functions: false }],
    },
  },

  // CAP service handlers idiomatically mutate the request/result rows passed to
  // them and early-return req.error(...) — both fight Airbnb's defaults.
  {
    files: ['srv/**/*.js'],
    rules: {
      'no-param-reassign': ['error', { props: false }],
      'consistent-return': 'off',
    },
  },

  // srv/lib/ ports the Python prototype and uses a leading-underscore naming
  // convention for module-private helpers (_respond, _serialized, …).
  {
    files: ['srv/lib/**/*.js'],
    rules: {
      'no-underscore-dangle': 'off',
    },
  },

  // scripts/ are standalone CLI provisioning/diagnostic tools: console IS their
  // output, and for-of over fetched rows is fine outside hot service paths.
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // Tests: chai's BDD assertions (expect(x).to.be.empty) read as unused
  // expressions; the suites also define throwaway mock classes and loop freely.
  {
    files: ['test/**/*.js'],
    rules: {
      'no-unused-expressions': 'off',
      'no-restricted-syntax': 'off',
      'no-underscore-dangle': 'off',
      'max-classes-per-file': 'off',
      'class-methods-use-this': 'off',
    },
  },
];
