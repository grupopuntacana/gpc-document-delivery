import { defineConfig } from 'vite'
import AdmZip from 'adm-zip'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue(), {
      name: 'zip-dist', // zipping ./dist is required for BTP HTML5 repo or Application Frontend deployment
      closeBundle() {
        const zip = new AdmZip()
        zip.addLocalFolder('dist')
        zip.writeZip('dist/portal.zip')
      }
  }],
  server: {
    proxy: {
      // Local dev only: CAP runs on :4004. The documents() function requires an
      // authenticated user; under `cds watch` mocked auth, send the default 'alice'
      // (base64 of "alice:"). On BTP, app-front/approuter supplies the real auth.
      '/odata': {
        target: 'http://localhost:4004',
        changeOrigin: true,
        headers: { Authorization: 'Basic YWxpY2U6' }
      },
      // The anonymous customer-facing PDF route (token is the credential).
      '/invoice': 'http://localhost:4004'
    }
  }
})
