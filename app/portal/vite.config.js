import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import AdmZip from 'adm-zip';
import vue from '@vitejs/plugin-vue';

// Resolve a build-time version for the SPA. Order of precedence:
//   1. APP_VERSION env — set by CI on a tag deploy (e.g. github.ref_name = v1.2.0).
//   2. `git describe` — local builds / any checkout with tags reachable.
//   3. package.json version — last resort (mbt/CF buildpack env without git).
// Exposed to the app as the compile-time constant __APP_VERSION__ (see `define`).
function resolveVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return execSync('git describe --tags --always --dirty', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    // No git or no tags in this build environment — fall through to package.json.
  }
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url))));
  return pkg.version;
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  plugins: [vue(), {
    // Zipping ./dist is required for BTP HTML5 repo / Application Frontend deployment.
    name: 'zip-dist',
    closeBundle() {
      const zip = new AdmZip();
      zip.addLocalFolder('dist');
      zip.writeZip('dist/portal.zip');
    },
  }],
  server: {
    proxy: {
      // Local dev only: CAP runs on :4004. The documents() function requires an
      // authenticated user; under `cds watch` mocked auth, send the default 'alice'
      // (base64 of "alice:"). On BTP, app-front/approuter supplies the real auth.
      '/odata': {
        target: 'http://localhost:4004',
        changeOrigin: true,
        headers: { Authorization: 'Basic YWxpY2U6' },
      },
      // The anonymous customer-facing PDF route (token is the credential).
      '/invoice': 'http://localhost:4004',
    },
  },
});
