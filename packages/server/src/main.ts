// Arranque del servidor. Configuración por variables de entorno; ninguna es
// obligatoria salvo dónde están las notas y el estado.
import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Auth } from './auth.ts'
import { openIndex } from './db.ts'
import { createApp, type Runtime } from './http/app.ts'
import { Indexer } from './indexer.ts'
import { NoteService } from './notes.ts'
import { openState } from './state.ts'
import { Watcher } from './watcher.ts'
import { CollabHub } from './hub.ts'
import { SESSION_COOKIE } from './http/app.ts'
import type { Server } from 'node:http'

export interface Config {
  notesDir: string
  stateDir: string
  host: string
  port: number
  rescanSeconds: number
}

export function configFromEnv(env = process.env): Config {
  return {
    notesDir: resolve(env.THOTH_NOTES_DIR ?? '/data/notes'),
    stateDir: resolve(env.THOTH_STATE_DIR ?? '/data/state'),
    host: env.THOTH_HOST ?? '0.0.0.0',
    port: Number(env.THOTH_PORT ?? 8080),
    rescanSeconds: Number(env.THOTH_RESCAN_SECONDS ?? 60),
  }
}

export function openStores(config: Config) {
  mkdirSync(config.stateDir, { recursive: true })
  const state = openState(join(config.stateDir, 'state.db'))
  const index = openIndex(join(config.stateDir, 'index.db'))
  return { state, index }
}

export async function start(config: Config) {
  const { state, index } = openStores(config)
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir: config.notesDir, db: index })
  const log = (msg: string) => console.log(`[thoth] ${msg}`)

  const runtime: Runtime = {
    lastScan: null,
    rescan(force) {
      const r = indexer.scan({ force })
      this.lastScan = r
      if (r.aborted) log(`escaneo abortado: ${r.aborted}`)
      return r
    },
  }
  const first = runtime.rescan(false)
  log(`índice listo: ${first.added.length} nuevas, ${first.changed.length} cambiadas, ${first.removed.length} retiradas, ${first.unchanged} sin cambios`)

  const hub = new CollabHub({ notesDir: config.notesDir, stateDir: config.stateDir, indexer, auth, log })
  await hub.recoverAll()

  const watcher = new Watcher({
    notesDir: config.notesDir,
    indexer,
    db: index,
    rescanMs: config.rescanSeconds * 1000,
    onReport: (kind, r) => { if (kind === 'rescan') runtime.lastScan = r },
    onError: (err) => log(`watcher: ${err instanceof Error ? err.message : String(err)}`),
    onChange: (paths) => { for (const p of paths) if (hub.has(p)) hub.checkExternal(p).catch(() => {}) },
  })
  watcher.start()

  const notes = new NoteService({ notesDir: config.notesDir, stateDir: config.stateDir, indexer, db: index, hot: hub })
  const app = createApp({ auth, notes, index, indexer, notesDir: config.notesDir, runtime })
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }) as Server
  hub.attach(server, SESSION_COOKIE)
  // serve() abre el puerto de forma asíncrona: solo se anuncia cuando de verdad escucha.
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  log(`escuchando en http://${config.host}:${config.port}`)

  const setup = auth.setupToken()
  if (setup) {
    log('primer arranque: no hay usuarios. Crea el administrador con este token de un solo uso')
    log(`  (en la UI, o con POST /api/setup): ${setup}`)
    log('  o desde la línea de comandos: thoth user create <nombre> --admin')
  }

  const stop = async () => {
    watcher.stop()
    await hub.close()
    server.close()
    index.close()
    state.close()
  }
  return { app, stop, auth, hub, notes, server }
}
