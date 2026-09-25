// Server startup. Configuration via environment variables; none is
// mandatory except where the notes and the state live.
import { serve } from '@hono/node-server'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from './auth.ts'
import { openIndex } from './db.ts'
import { createApp, type Runtime } from './http/app.ts'
import { Indexer } from './indexer.ts'
import { DEFAULT_MAX_IMAGE_BYTES, NoteService } from './notes.ts'
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
  webDir: string
  /** THOTH_MAX_IMAGE_MB: largest image stored, from an upload or a URL (20 MB). */
  maxImageBytes: number
}

export function configFromEnv(env = process.env): Config {
  return {
    notesDir: resolve(env.THOTH_NOTES_DIR ?? '/data/notes'),
    stateDir: resolve(env.THOTH_STATE_DIR ?? '/data/state'),
    host: env.THOTH_HOST ?? '0.0.0.0',
    port: Number(env.THOTH_PORT ?? 8080),
    rescanSeconds: Number(env.THOTH_RESCAN_SECONDS ?? 60),
    webDir: resolve(env.THOTH_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
    maxImageBytes: env.THOTH_MAX_IMAGE_MB ? positiveMb(env.THOTH_MAX_IMAGE_MB) : DEFAULT_MAX_IMAGE_BYTES,
  }
}

function positiveMb(raw: string): number {
  const mb = Number(raw)
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`THOTH_MAX_IMAGE_MB must be a positive number of megabytes, not "${raw}"`)
  return Math.floor(mb * 1024 * 1024)
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
    rescan(opts) {
      const r = indexer.scan(opts)
      this.lastScan = r
      if (r.aborted) log(`scan aborted: ${r.aborted}`)
      return r
    },
  }
  const first = runtime.rescan({})
  log(`index ready: ${first.added.length} added, ${first.changed.length} changed, ${first.removed.length} removed, ${first.unchanged} unchanged`)

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

  const notes = new NoteService({ notesDir: config.notesDir, stateDir: config.stateDir, indexer, db: index, hot: hub, maxImageBytes: config.maxImageBytes })
  const webDir = existsSync(join(config.webDir, 'index.html')) ? config.webDir : undefined
  if (!webDir) log(`no UI: nothing built at ${config.webDir} (npm run build); API only`)
  const app = createApp({ auth, notes, index, indexer, notesDir: config.notesDir, runtime, orphans: hub, webDir })
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }) as Server
  hub.attach(server, SESSION_COOKIE)
  // serve() opens the port asynchronously: only announced once it's actually listening.
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  log(`listening on http://${config.host}:${config.port}`)

  const setup = auth.setupToken()
  if (setup) {
    log('first boot: no users yet. Create the admin with this one-time token')
    log(`  (in the UI, or with POST /api/setup): ${setup}`)
    log('  or from the command line: thoth user create <name> --admin')
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
