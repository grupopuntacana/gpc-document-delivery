import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

// Twin of the backend's eslint.config.mjs (same Airbnb layering), but for the
// Vue SPA: the framework layer is eslint-plugin-vue instead of CAP, and the
// runtime globals are the browser's instead of Node's. Kept self-contained so
// the portal stays a standalone toolchain (its own deps + `npm run lint`), the
// way `cds add vue` scaffolds it — the root config ignores app/ for this reason.
export default [
  // Build output only — source under src/ is linted.
  {
    ignores: ['dist/**'],
  },

  // Airbnb JS style guide (base only — no React/Next). Same ruleset the backend
  // applies; here it covers the SPA's plain JS (main.js, cap.js) and the
  // <script> blocks inside .vue single-file components.
  airbnbPlugins.stylistic,
  airbnbPlugins.importX,
  ...airbnb.base.recommended,

  // Vue layer last so vue-eslint-parser owns *.vue files and the plugin's rules
  // win over anything Airbnb sets for template/SFC concerns.
  ...pluginVue.configs['flat/recommended'],

  // Modern JS + browser runtime. Airbnb base pins an older ecmaVersion that
  // rejects ?? and ?.; the SPA uses both. Globals are the browser's (window,
  // document, fetch, …) since this code never runs in Node. Both ecmaVersion
  // and parserOptions.ecmaVersion are set so .vue <script> blocks parse too.
  {
    files: ['**/*.{js,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaVersion: 'latest' },
      // __APP_VERSION__ is a build-time constant injected by Vite's `define`.
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
    },
    rules: {
      // ESM requires explicit file extensions on relative imports (./cap.js,
      // ./App.vue); Airbnb's no-extension rule predates native ESM.
      'import-x/extensions': 'off',
    },
  },

  // Build/config files (vite.config.js, this file) run in Node, not the browser:
  // give them Node globals so `process`, etc. don't trip no-undef.
  {
    files: ['*.config.js', '*.config.mjs', 'eslint.config.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Match the backend: restore canonical airbnb-base max-len options (the preset
  // drops them) so long string/template/URL/regex literals don't trip the
  // 100-col limit, while real code and comments still do. Scoped to JS files
  // (not .vue) because the @stylistic plugin is only registered for JS here;
  // long lines inside .vue templates are governed by the vue/* rules instead.
  {
    files: ['**/*.js', '**/*.mjs'],
    rules: {
      'max-len': 'off',
      '@stylistic/max-len': ['error', 100, 2, {
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }],
    },
  },
];
