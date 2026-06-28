'use strict';

// Build/runtime version for the CAP service. Resolution order:
//   1. APP_VERSION env — set at deploy time (e.g. the git tag); the SPA build
//      reads the same var (see app/frontend/vite.config.js).
//   2. bundled package.json version — always present in gen/srv at runtime.
// No git lookup: the BTP runtime has no repo. Until the build stamps APP_VERSION
// into the deployed env, runtime reports the package.json version.
//
// No memoization: reading process.env is free and require() is already cached by
// Node's module cache, so a plain resolve keeps it honest if APP_VERSION changes.
function appVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    // srv/lib/version.js -> ../../package.json (repo root in dev, gen/srv at deploy).
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { appVersion };
