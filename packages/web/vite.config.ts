import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// In development, the API and co-editing are served by the vihko server (npm run dev -w @vihko/server
// or `vihko serve`); Vite only serves the UI and proxies the rest.
const target = process.env.VIHKO_DEV_SERVER ?? 'http://localhost:8080'

/**
 * Web app manifest and theme-color, with the colours from the design tokens.
 * Installable, with no service worker: nothing is cached for offline use.
 */
function appManifest(): Plugin {
  const tokens = JSON.parse(readFileSync(new URL('src/theme/tokens.json', import.meta.url), 'utf8')) as {
    color: { tokens: { name: string; value: string | Record<string, string> }[] }
  }
  const bg = tokens.color.tokens.find((t) => t.name === 'bg')!.value as Record<string, string>
  const manifest = JSON.stringify({
    id: '/',
    name: 'vihko',
    short_name: 'vihko',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The manifest has one colour for the splash and title bar; the page switches it by theme (theme.ts).
    background_color: bg.light,
    theme_color: bg.light,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)
  const file = 'manifest.webmanifest'
  return {
    name: 'vihko-manifest',
    transformIndexHtml: (html) => html.replaceAll('__VIHKO_BG_LIGHT__', bg.light!).replaceAll('__VIHKO_BG_DARK__', bg.dark!),
    configureServer(server) {
      server.middlewares.use(`/${file}`, (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(manifest)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: file, source: manifest })
    },
  }
}

export default defineConfig({
  plugins: [react(), appManifest()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/collab': { target, ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
