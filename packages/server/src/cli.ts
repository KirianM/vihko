#!/usr/bin/env node
// thoth serve                          arranca el servidor
// thoth user create <nombre> [--admin] crea un usuario; la contraseña se lee de stdin
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
    mkdirSync(config.stateDir, { recursive: true }) // puede ser lo primero que se ejecute en una instalación nueva
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      if (process.stdin.isTTY) process.stderr.write('contraseña (se lee de stdin; termina con Ctrl-D): ')
      const user = await new Auth(state).createUser(rest[0], await readStdin(), rest.includes('--admin') ? 'admin' : 'member')
      console.log(`usuario creado: ${user.username} (${user.role})`)
    } finally {
      state.close()
    }
    return
  }
  console.error('uso: thoth serve | thoth user create <nombre> [--admin]')
  process.exit(2)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof AuthError ? `error: ${err.message}` : err)
  process.exit(1)
})
