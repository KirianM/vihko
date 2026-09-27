// Server for the browser part of the M1 acceptance suite: the generated
// 1,000-note vault (packages/server/test/acceptance/_vault.ts), two users and
// the compiled UI. Started by Playwright, or by hand when the browser runs in
// the Playwright Docker image: node packages/web/acceptance/serve.ts
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateVault } from '../../server/test/acceptance/_vault.ts'
import { ACC_DIR, ACC_PORT, NOTES, PASSWORD, PERMISSIONS, USERS } from './env.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = root + 'packages/server/src/cli.ts'
const env = { ...process.env, THOTH_NOTES_DIR: NOTES, THOTH_STATE_DIR: ACC_DIR + '/state' }

rmSync(ACC_DIR, { recursive: true, force: true })
mkdirSync(ACC_DIR, { recursive: true })
const vault = generateVault(NOTES, { notes: Number(process.env.ACCEPTANCE_NOTES ?? 1000), seed: Number(process.env.ACCEPTANCE_SEED ?? 1) })
// What the specs need to know about the vault.
writeFileSync(ACC_DIR + '/vault.json', JSON.stringify(vault))
writeFileSync(NOTES + '/thoth.yaml', PERMISSIONS)
for (const [name, admin] of USERS) {
  execFileSync(process.execPath, ['--no-experimental-webstorage', cli, 'user', 'create', name, ...(admin ? ['--admin'] : [])], { env, input: PASSWORD })
}
const server = spawn(process.execPath, ['--no-experimental-webstorage', cli, 'serve'], {
  env: { ...env, THOTH_HOST: '127.0.0.1', THOTH_PORT: String(ACC_PORT) },
  stdio: 'inherit',
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.kill(sig))
server.on('exit', (code) => process.exit(code ?? 0))
