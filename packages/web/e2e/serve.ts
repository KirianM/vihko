// Server for the browser tests: a clean copy of testdata/vault, two users
// (noa admin, ana member) and thoth serving the compiled UI. Beside it, a
// second one with THOTH_INTEGRATIONS=off (the API and MCP locked by the
// server's administrator), with one note and the same users.
// Started by Playwright (webServer) or, if the browser runs elsewhere (the
// Playwright Docker image), launched by hand: node packages/web/e2e/serve.ts
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { E2E_DIR, E2E_PORT, LOCKED_PORT, PASSWORD, PUBLIC_URL, USERS } from './env.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = root + 'packages/server/src/cli.ts'
const env = { ...process.env, THOTH_NOTES_DIR: E2E_DIR + '/notes', THOTH_STATE_DIR: E2E_DIR + '/state' }

rmSync(E2E_DIR, { recursive: true, force: true })
mkdirSync(E2E_DIR, { recursive: true })
cpSync(root + 'testdata/vault', env.THOTH_NOTES_DIR, { recursive: true })
const locked = { ...process.env, THOTH_NOTES_DIR: E2E_DIR + '/locked/notes', THOTH_STATE_DIR: E2E_DIR + '/locked/state' }
mkdirSync(locked.THOTH_NOTES_DIR, { recursive: true })
writeFileSync(locked.THOTH_NOTES_DIR + '/Bloqueada.md', '# Bloqueada\n')
for (const e of [env, locked]) {
  for (const [name, admin] of USERS) {
    execFileSync(process.execPath, ['--no-experimental-webstorage', cli, 'user', 'create', name, ...(admin ? ['--admin'] : [])], { env: e, input: PASSWORD })
  }
}
// An open version of what's typed closes after 3 s of calm instead of 30: the history specs don't wait half a minute.
const servers = [
  spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
    // THOTH_PUBLIC_URL: OAuth exists (while MCP is on). Its address only goes into the metadata and redirects: the specs reach this server directly.
    env: { ...env, THOTH_HOST: '127.0.0.1', THOTH_PORT: String(E2E_PORT), THOTH_RESCAN_SECONDS: '5', THOTH_HISTORY_QUIET_SECONDS: '3', THOTH_PUBLIC_URL: PUBLIC_URL },
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
    env: { ...locked, THOTH_HOST: '127.0.0.1', THOTH_PORT: String(LOCKED_PORT), THOTH_INTEGRATIONS: 'off' },
    stdio: 'inherit',
  }),
]
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { for (const s of servers) s.kill(sig) })
// Either one ending ends both (and this process, with its code).
for (const s of servers) s.on('exit', (code) => { for (const o of servers) if (o !== s) o.kill(); process.exit(code ?? 0) })
