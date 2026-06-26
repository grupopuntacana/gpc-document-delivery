'use strict';

// Build/runtime version for the CAP service. Resolution order:
//   1. APP_VERSION env — set at deploy time (e.g. the git tag); the SPA build
//      reads the same var (see app/portal/vite.config.js).
//   2. bundled package.json version — always present in gen/srv at runtime.
// No git lookup: the BTP runtime has no repo. Until the build stamps APP_VERSION
// into the deployed env, runtime reports the package.json version.
let cached;

function appVersion() {
  if (cached) return cached;
  if (process.env.APP_VERSION) {
    cached = process.env.APP_VERSION;
    return cached;
  }
  try {
    // srv/lib/version.js -> ../../package.json (repo root in dev, gen/srv at deploy).
    cached = require('../../package.json').version || 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

module.exports = { appVersion };
