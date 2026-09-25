import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, the API and co-editing are served by the thoth server (npm run dev -w @thoth/server
// or `thoth serve`); Vite only serves the UI and proxies the rest.
const target = process.env.THOTH_DEV_SERVER ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/collab': { target, ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
