// Server for the browser tests: a clean copy of testdata/vault, two users
// (noa admin, ana member) and thoth serving the compiled UI.
// Started by Playwright (webServer) or, if the browser runs elsewhere (the
// Playwright Docker image), launched by hand: node packages/web/e2e/serve.ts
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { E2E_DIR, E2E_PORT, PASSWORD, USERS } from './env.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = root + 'packages/server/src/cli.ts'
const env = { ...process.env, THOTH_NOTES_DIR: E2E_DIR + '/notes', THOTH_STATE_DIR: E2E_DIR + '/state' }

rmSync(E2E_DIR, { recursive: true, force: true })
mkdirSync(E2E_DIR, { recursive: true })
cpSync(root + 'testdata/vault', env.THOTH_NOTES_DIR, { recursive: true })
for (const [name, admin] of USERS) {
  execFileSync(process.execPath, ['--no-experimental-webstorage', cli, 'user', 'create', name, ...(admin ? ['--admin'] : [])], { env, input: PASSWORD })
}
const server = spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
  env: { ...env, THOTH_HOST: '127.0.0.1', THOTH_PORT: String(E2E_PORT), THOTH_RESCAN_SECONDS: '5' },
  stdio: 'inherit',
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.kill(sig))
server.on('exit', (code) => process.exit(code ?? 0))
