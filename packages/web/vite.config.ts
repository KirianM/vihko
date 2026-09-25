import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// En desarrollo, la API y la coedición las sirve el servidor de thoth (npm run dev -w @thoth/server
// o `thoth serve`); Vite solo sirve la UI y reenvía el resto.
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
