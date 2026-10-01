// Server for the browser tests: a clean copy of testdata/vault, two users
// (an admin and a member, env.ts) and vihko serving the compiled UI. Beside it, a
// second one with VIHKO_INTEGRATIONS=off (the API and MCP locked by the
// server's administrator), with one note and the same users.
// Started by Playwright (webServer) or, if the browser runs elsewhere (the
// Playwright Docker image), launched by hand: node packages/web/e2e/serve.ts
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { seedLine, testSeed } from '../../../test/seed.ts'
import { E2E_DIR, E2E_PORT, LOCKED_PORT, PERMISSIONS, PUBLIC_URL, SPACE, USERS } from './env.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = root + 'packages/server/src/cli.ts'
const env = { ...process.env, VIHKO_NOTES_DIR: E2E_DIR + '/notes', VIHKO_STATE_DIR: E2E_DIR + '/state' }

rmSync(E2E_DIR, { recursive: true, force: true })
mkdirSync(E2E_DIR, { recursive: true })
// The specs must draw the same people: Playwright, started without a seed against this server, reads it here.
const seed = testSeed()
writeFileSync(E2E_DIR + '/seed', `${seed}\n`)
console.log(seedLine(seed, 'node packages/web/e2e/serve.ts'))
// The vault goes into a shared space both people belong to (D-056: nothing is seen outside a space).
cpSync(root + 'testdata/vault', `${env.VIHKO_NOTES_DIR}/${SPACE}`, { recursive: true })
const locked = { ...process.env, VIHKO_NOTES_DIR: E2E_DIR + '/locked/notes', VIHKO_STATE_DIR: E2E_DIR + '/locked/state' }
mkdirSync(`${locked.VIHKO_NOTES_DIR}/${SPACE}`, { recursive: true })
writeFileSync(`${locked.VIHKO_NOTES_DIR}/${SPACE}/Bloqueada.md`, '# Bloqueada\n')
for (const e of [env, locked]) {
  // Both see the vault's space (a member reads only what is shared with them); each has their own space too.
  writeFileSync(e.VIHKO_NOTES_DIR + '/vihko.yaml', PERMISSIONS)
  for (const u of USERS) {
    execFileSync(process.execPath, ['--no-experimental-webstorage', cli, 'user', 'create', u.username, ...(u.role === 'admin' ? ['--admin'] : [])], { env: e, input: u.password })
  }
}
// An open version of what's typed closes after 3 s of calm instead of 30: the history specs don't wait half a minute.
const servers = [
  spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
    // VIHKO_PUBLIC_URL: OAuth exists (while MCP is on). Its address only goes into the metadata and redirects: the specs reach this server directly.
    env: { ...env, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: String(E2E_PORT), VIHKO_RESCAN_SECONDS: '5', VIHKO_HISTORY_QUIET_SECONDS: '3', VIHKO_PUBLIC_URL: PUBLIC_URL },
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
    env: { ...locked, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: String(LOCKED_PORT), VIHKO_INTEGRATIONS: 'off' },
    stdio: 'inherit',
  }),
]
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { for (const s of servers) s.kill(sig) })
// Either one ending ends both (and this process, with its code).
for (const s of servers) s.on('exit', (code) => { for (const o of servers) if (o !== s) o.kill(); process.exit(code ?? 0) })
