import { defineConfig } from '@playwright/test'
import { BASE_URL, E2E_PORT } from './e2e/env.ts'

// Con E2E_BASE_URL el servidor ya está arrancado fuera (npm run e2e:serve);
// si no, Playwright lo arranca y lo para.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: BASE_URL, locale: 'es-ES', viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node e2e/serve.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
