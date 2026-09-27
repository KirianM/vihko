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
import { History } from './history/index.ts'
import { lockState, type StateLock } from './lock.ts'
import { ApiKeys } from './keys.ts'
import { mountMcp } from './mcp/server.ts'
import { Integrations, integrationsLockedFrom } from './integrations.ts'
import { SESSION_COOKIE } from './http/app.ts'
import { publicUrlFrom } from './oauth.ts'
import type { Server } from 'node:http'
import type { BlockList } from 'node:net'
import { trustedProxiesFrom } from './http/clientIp.ts'
import { WORKSPACE_FILE } from '@thoth/core'
import { AccessPolicy } from './access.ts'
import { PermissionsEngine, groupSource, stateDirectory } from './permissions.ts'
import { PermissionHolds } from './permissionHolds.ts'
import { Users } from './users.ts'

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
  /**
   * The history's timings, for tests and tuning (thoth.yaml says what matters:
   * its mode and size limit). THOTH_HISTORY_QUIET_SECONDS: an open version
   * closes after this long without changes (30); THOTH_HISTORY_MAX_SECONDS: or
   * this long after it opened (300); THOTH_HISTORY_SWEEP_SECONDS: the full
   * sweep of the folder (3600). THOTH_GIT: the git binary.
   */
  history: { quietMs: number; maxOpenMs: number; sweepMs: number; git: string }
  /**
   * THOTH_INTEGRATIONS=off: the API with keys and the MCP server stay off,
   * whatever the switches in the UI say (D-035.1).
   */
  integrationsLocked: boolean
  /**
   * THOTH_PUBLIC_URL: the HTTPS origin where thoth is reached from outside
   * (behind a reverse proxy). With it, OAuth exists for the MCP server while
   * the MCP switch is on (oauth.ts); without it, `/mcp` takes keys only.
   */
  publicUrl: string | null
  /**
   * THOTH_TRUSTED_PROXIES: the reverse proxies (addresses or CIDR ranges)
   * whose X-Forwarded-For says who the client is, for the login limits.
   * Unset: the socket's address, and the header is ignored.
   */
  trustedProxies: BlockList | null
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
    history: {
      quietMs: seconds(env.THOTH_HISTORY_QUIET_SECONDS, 30),
      maxOpenMs: seconds(env.THOTH_HISTORY_MAX_SECONDS, 300),
      sweepMs: seconds(env.THOTH_HISTORY_SWEEP_SECONDS, 3600),
      git: env.THOTH_GIT || 'git',
    },
    integrationsLocked: integrationsLockedFrom(env.THOTH_INTEGRATIONS),
    publicUrl: publicUrlFrom(env.THOTH_PUBLIC_URL),
    trustedProxies: trustedProxiesFrom(env.THOTH_TRUSTED_PROXIES),
  }
}

function seconds(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive number of seconds, not "${raw}"`)
  return n * 1000
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
  // One process at a time on the state volume (a second server, or `thoth history purge`).
  mkdirSync(config.stateDir, { recursive: true })
  const lock = lockState(config.stateDir)
  try {
    return await run(config, lock)
  } catch (err) {
    lock.release()
    throw err
  }
}

async function run(config: Config, lock: StateLock) {
  const { state, index } = openStores(config)
  const auth = new Auth(state)
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state, { locked: config.integrationsLocked })
  const log = (msg: string) => console.log(`[thoth] ${msg}`)
  const workspace = new Workspace({ notesDir: config.notesDir, log })
  const indexer = new Indexer({ notesDir: config.notesDir, db: index, linkAliases: workspace.config.links.aliases })
  // Users and groups. Ending someone's sessions ends their live connections
  // too (the hub exists further down). Their grants in thoth.yaml follow a
  // deletion or a group's rename (http/app.ts fills those hooks in).
  const users = new Users(auth, { hooks: { onSessionsEnded: (id) => hub.checkSessions(id) } })
  // Who reads what (D-038): thoth.yaml's rules over state.db's users and groups.
  const permissions = new PermissionsEngine({ source: () => workspace.permissions, directory: stateDirectory(state, groupSource(users)) })
  // Before the first scan: a note moved while the server was stopped is detected too.
  const holds = new PermissionHolds({ stateDir: config.stateDir, engine: permissions, log })
  const policy = new AccessPolicy({ index, permissions, holds })
  const externalMoves = new ExternalMoves({ stateDir: config.stateDir, db: index, indexer, log })
  // Open notes follow their file (the hub exists after the first scan, which
  // hands it its moves once the recovery logs are loaded).
  let follow: CollabHub | null = null
  indexer.onMoves = (moves) => {
    // First: a note that left a folder with rules of its own is held before anyone can list it.
    holds.consider(moves)
    externalMoves.record(moves)
    log(`moved outside thoth: ${moves.map((m) => `${m.from} → ${m.to} (${m.by})`).join(', ')}`)
    follow?.followMoves(moves)
  }
  // The history: its journal is read before the hub recovers its notes (their
  // flushes join what it left pending); it starts once they are recovered.
  const history = new History({
    notesDir: config.notesDir, stateDir: config.stateDir, config: () => workspace.config.history, log,
    git: config.history.git, quietMs: config.history.quietMs, maxOpenMs: config.history.maxOpenMs, sweepMs: config.history.sweepMs,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind === 'agent' ? keys.nameOf(a.id) ?? a.id : a.kind),
  })
  /** Rereads thoth.yaml and applies what the index, the history and open editors depend on. */
  const reloadWorkspace = () => {
    if (!workspace.reload()) return
    indexer.setLinkAliases(workspace.config.links.aliases)
    history.configure().catch((e) => log(`history: ${e instanceof Error ? e.message : String(e)}`))
    follow?.recheckAccess()
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

  await history.open()
  const hub = new CollabHub({ notesDir: config.notesDir, stateDir: config.stateDir, indexer, auth, log, history: history.recorder, agentName: (id) => keys.nameOf(id), policy })
  // Checked against the index as the first scan left it. One that stopped may
  // have left the index behind the files: then no saved state is trusted.
  if (!first.aborted) hub.trustSavedStates()
  await hub.recoverAll()
  // A note with pending edits moved while the server was stopped: its copy goes where the file is.
  hub.followMoves(first.moved)
  follow = hub
  // What the journal left pending, then the folder against the history (changes made while stopped).
  await history.start()
  indexer.onApplied = (applied) => history.recorder.observeIndexed(applied)

  const watcher = new Watcher({
    notesDir: config.notesDir,
    indexer,
    db: index,
    rescanMs: config.rescanSeconds * 1000,
    // The rescan also rereads thoth.yaml: its events can be lost like any other (NFS).
    onReport: (kind, r) => { if (kind === 'rescan') { runtime.lastScan = r; reloadWorkspace() } },
    onError: (err) => log(`watcher: ${err instanceof Error ? err.message : String(err)}`),
    onChange: (paths) => {
      // Files that aren't notes reach the history here (notes, through the indexer).
      void history.recorder.observePaths(paths)
      if (paths.includes(WORKSPACE_FILE)) reloadWorkspace()
      for (const p of paths) if (hub.has(p)) hub.checkExternal(p).catch(() => {})
    },
  })
  watcher.start()

  const notes = new NoteService({
    notesDir: config.notesDir, stateDir: config.stateDir, indexer, db: index, hot: hub, maxImageBytes: config.maxImageBytes,
    attachments: () => workspace.config.attachments, history: history.recorder,
  })
  const webDir = existsSync(join(config.webDir, 'index.html')) ? config.webDir : undefined
  if (!webDir) log(`no UI: nothing built at ${config.webDir} (npm run build); API only`)
  const profiles = new Profiles(state)
  const app = createApp({
    auth, profiles, workspace, notes, index, indexer, notesDir: config.notesDir, runtime, orphans: hub, webDir, externalImages: config.externalImages, externalMoves, history, keys, integrations, publicUrl: config.publicUrl, trustedProxies: config.trustedProxies, users,
    policy, holds, onPermissionsChanged: () => hub.recheckAccess(),
    // The MCP server, at /mcp (off until the admin turns it on).
    routes: (app, services) => { mountMcp(app, services, { auth, workspace, log }) },
  })
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }) as Server
  hub.attach(server, SESSION_COOKIE)
  // serve() opens the port asynchronously: only announced once it's actually listening.
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  log(`listening on http://${config.host}:${config.port}`)
  if (config.integrationsLocked) log('THOTH_INTEGRATIONS=off: the API with keys and the MCP server stay off')
  if (config.publicUrl) log(`public URL ${config.publicUrl}: OAuth for ${config.publicUrl}/mcp while the MCP server is on`)
  // Behind a proxy without it, every client is the proxy to the login limits: one guesser holds everyone back.
  if (config.publicUrl && !config.trustedProxies) log('THOTH_TRUSTED_PROXIES is unset: the login limits count every client by the connection\'s address (a reverse proxy\'s, if there is one). Set it to the proxy\'s address; see the README')

  const setup = auth.setupToken()
  if (setup) {
    log('first boot: no users yet. Create the admin with this one-time token')
    log(`  (in the UI, or with POST /api/setup): ${setup}`)
    log('  or from the command line: thoth user create <name> --admin')
  }

  const stop = async () => {
    watcher.stop()
    await hub.close()
    await history.close()
    server.close()
    index.close()
    state.close()
    lock.release()
  }
  return { app, stop, auth, users, hub, notes, server, workspace, history }
}
