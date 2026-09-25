#!/usr/bin/env -S node --no-experimental-webstorage
// thoth serve                         starts the server
// thoth user create <name> [--admin]  creates a user; the password is read from stdin
//
// No Web Storage: the server doesn't use it, and lib0 (Yjs) probes for it on import,
// which on Node 26 prints an ExperimentalWarning on every startup.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Auth, AuthError } from './auth.ts'
import { configFromEnv, start } from './main.ts'
import { openState } from './state.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function main(argv: string[]) {
  const [cmd, sub, ...rest] = argv
  const config = configFromEnv()
  if (cmd === 'serve' || cmd === undefined) {
    const s = await start(config)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await s.stop(); process.exit(0) })
    return
  }
  if (cmd === 'user' && sub === 'create' && rest[0]) {
    mkdirSync(config.stateDir, { recursive: true }) // may be the first thing that runs on a new install
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      if (process.stdin.isTTY) process.stderr.write('password (read from stdin; end with Ctrl-D): ')
      const user = await new Auth(state).createUser(rest[0], await readStdin(), rest.includes('--admin') ? 'admin' : 'member')
      console.log(`user created: ${user.username} (${user.role})`)
    } finally {
      state.close()
    }
    return
  }
  console.error('usage: thoth serve | thoth user create <name> [--admin]')
  process.exit(2)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof AuthError ? `error: ${err.message}` : err)
  process.exit(1)
})
