// Server startup. Configuration via environment variables; none is
// mandatory except where the notes and the state live.
import { serve } from '@hono/node-server'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from './auth.ts'
import { openIndex } from './db.ts'
import { createApp, type ExternalImages, type Runtime } from './http/app.ts'
import { Indexer } from './indexer.ts'
import { DEFAULT_MAX_IMAGE_BYTES, NoteService } from './notes.ts'
import { openState } from './state.ts'
import { Profiles } from './profiles.ts'
import { Workspace } from './workspace.ts'
import { Watcher } from './watcher.ts'
import { ExternalMoves } from './externalMoves.ts'
import { CollabHub } from './hub.ts'
import { SESSION_COOKIE } from './http/app.ts'
import type { Server } from 'node:http'
import { WORKSPACE_FILE } from '@thoth/core'

export interface Config {
  notesDir: string
  stateDir: string
  host: string
  port: number
  rescanSeconds: number
  webDir: string
  /** THOTH_MAX_IMAGE_MB: largest image stored, from an upload or a URL (20 MB). */
  maxImageBytes: number
  /** THOTH_EXTERNAL_IMAGES: `allow` (default) or `block` images linked from other sites. */
  externalImages: ExternalImages
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
    externalImages: externalImagesFrom(env.THOTH_EXTERNAL_IMAGES),
  }
}

function positiveMb(raw: string): number {
  const mb = Number(raw)
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`THOTH_MAX_IMAGE_MB must be a positive number of megabytes, not "${raw}"`)
  return Math.floor(mb * 1024 * 1024)
}

function externalImagesFrom(raw: string | undefined): ExternalImages {
  const v = (raw ?? 'allow').trim().toLowerCase()
  if (v !== 'allow' && v !== 'block') throw new Error(`THOTH_EXTERNAL_IMAGES must be "allow" or "block", not "${raw}"`)
  return v
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
  const log = (msg: string) => console.log(`[thoth] ${msg}`)
  const workspace = new Workspace({ notesDir: config.notesDir, log })
  const indexer = new Indexer({ notesDir: config.notesDir, db: index, linkAliases: workspace.config.links.aliases })
  // Before the first scan: a note moved while the server was stopped is detected too.
  const externalMoves = new ExternalMoves({ stateDir: config.stateDir, db: index, indexer, log })
  indexer.onMoves = (moves) => {
    externalMoves.record(moves)
    log(`moved outside thoth: ${moves.map((m) => `${m.from} → ${m.to} (${m.by})`).join(', ')}`)
  }
  /** Rereads thoth.yaml and applies what the index depends on. */
  const reloadWorkspace = () => {
    if (workspace.reload()) indexer.setLinkAliases(workspace.config.links.aliases)
  }

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
    // The rescan also rereads thoth.yaml: its events can be lost like any other (NFS).
    onReport: (kind, r) => { if (kind === 'rescan') { runtime.lastScan = r; reloadWorkspace() } },
    onError: (err) => log(`watcher: ${err instanceof Error ? err.message : String(err)}`),
    onChange: (paths) => {
      if (paths.includes(WORKSPACE_FILE)) reloadWorkspace()
      for (const p of paths) if (hub.has(p)) hub.checkExternal(p).catch(() => {})
    },
  })
  watcher.start()

  const notes = new NoteService({
    notesDir: config.notesDir, stateDir: config.stateDir, indexer, db: index, hot: hub, maxImageBytes: config.maxImageBytes,
    attachmentsFolder: () => workspace.config.attachments.folder,
  })
  const webDir = existsSync(join(config.webDir, 'index.html')) ? config.webDir : undefined
  if (!webDir) log(`no UI: nothing built at ${config.webDir} (npm run build); API only`)
  const profiles = new Profiles(state)
  const app = createApp({ auth, profiles, workspace, notes, index, indexer, notesDir: config.notesDir, runtime, orphans: hub, webDir, externalImages: config.externalImages, externalMoves })
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
  return { app, stop, auth, hub, notes, server, workspace }
}
