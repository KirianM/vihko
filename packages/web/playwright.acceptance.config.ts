import { defineConfig } from '@playwright/test'
import { ACC_PORT, BASE_URL } from './acceptance/env.ts'

// The browser part of the M1 acceptance suite (npm run acceptance:ui -w @thoth/web).
// With ACC_BASE_URL the server is already running externally (node acceptance/serve.ts).
export default defineConfig({
  testDir: 'acceptance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  use: { baseURL: BASE_URL, locale: 'es-ES', viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure' },
  webServer: process.env.ACC_BASE_URL ? undefined : {
    command: 'node acceptance/serve.ts',
    url: `http://127.0.0.1:${ACC_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
