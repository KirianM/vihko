import { defineConfig } from '@playwright/test'
import { BASE_URL, E2E_PORT } from './e2e/env.ts'

// With E2E_BASE_URL the server is already running externally (npm run e2e:serve);
// otherwise, Playwright starts and stops it.
//
// Traces only on a retry. Recording one on every test cost time on each of
// them, and stopping it could fail a test that had passed: many specs keep a
// browser context open across their tests, and each test's trace of such a
// context carries everything the context loaded since it opened, so a late
// test's trace grew until writing it took longer than the teardown's 30 s
// («Tracing is already stopping»). In CI a failed test runs once more, with
// its trace; if it passes then, the summary lists it as flaky (scripts/ci.ts
// says so in the result too). A failure keeps its screenshot either way.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: BASE_URL, locale: 'es-ES', viewport: { width: 1280, height: 800 }, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node e2e/serve.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
