import { defineConfig } from 'vite'
import AdmZip from 'adm-zip'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue(), {
      name: 'zip-dist', // zipping ./dist is required for BTP HTML5 repo or Application Frontend deployment
      closeBundle() {
        const zip = new AdmZip()
        zip.addLocalFolder('dist')
        zip.writeZip('dist/catalog.zip')
      }
  }],
  server: {
    proxy: {
      '/odata': 'http://localhost:4004'
    }
  }
})
