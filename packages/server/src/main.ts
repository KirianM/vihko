// Server startup. Configuration via environment variables; none is
// mandatory except where the notes and the state live.
import { serve } from '@hono/node-server'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from './auth.ts'
import { openIndex } from './db.ts'
import { createServer, type ExternalImages, type Runtime } from './http/app.ts'
import { FolderRefs } from './folderRefs.ts'
import { renameLegacySpaces } from './legacySpaces.ts'
import { NoteSettingsStore } from './noteSettings.ts'
import { Indexer } from './indexer.ts'
import { DEFAULT_MAX_IMAGE_BYTES, NoteService } from './notes.ts'
import { openState } from './state.ts'
import { Profiles } from './profiles.ts'
import { Workspace } from './workspace.ts'
import { Watcher } from './watcher.ts'
import { ExternalMoves } from './externalMoves.ts'
import { RelinkRetries } from './relinkRetries.ts'
import { Notices } from './notices.ts'
import { CollabHub } from './hub.ts'
import { History } from './history/index.ts'
import { lockState, type StateLock } from './lock.ts'
import { StartupError, checkVolumes, prepareStateDir, rootWarning } from './volumes.ts'
import { ApiKeys } from './keys.ts'
import { markIcons, mountMcp } from './mcp/server.ts'
import { Integrations, integrationsLockedFrom } from './integrations.ts'
import { SESSION_COOKIE } from './http/app.ts'
import { publicUrlFrom } from './oauth.ts'
import type { Server } from 'node:http'
import type { BlockList } from 'node:net'
import { trustedProxiesFrom, wideTrustedProxies } from './http/clientIp.ts'
import { WORKSPACE_FILE, type WorkspaceMigration } from '@vihko/core'
import { ConfigMigrations } from './configMigrations.ts'
import { AccessPolicy } from './access.ts'
import { PermissionsEngine, groupSource, stateDirectory } from './permissions.ts'
import { diskSpaceFolders } from './spaceFolders.ts'
import { PermissionHolds } from './permissionHolds.ts'
import { Users } from './users.ts'
import { TwoFactor } from './twoFactor.ts'
import { secretBoxFrom, type SecretBox } from './secretKey.ts'
import { VERSION } from './version.ts'
import { AdminSettings } from './adminSettings.ts'
import { Retention } from './retention.ts'

export interface Config {
  notesDir: string
  stateDir: string
  host: string
  port: number
  rescanSeconds: number
  webDir: string
  /** VIHKO_MAX_IMAGE_MB: largest image stored, from an upload or a URL (20 MB). */
  maxImageBytes: number
  /** VIHKO_EXTERNAL_IMAGES: `allow` (default) or `block` images linked from other sites. */
  externalImages: ExternalImages
  /**
   * The history's timings, for tests and tuning (vihko.yaml says what matters:
   * its mode and size limit). VIHKO_HISTORY_QUIET_SECONDS: an open version
   * closes after this long without changes (30); VIHKO_HISTORY_MAX_SECONDS: or
   * this long after it opened (300); VIHKO_HISTORY_SWEEP_SECONDS: the full
   * sweep of the folder (3600). VIHKO_GIT: the git binary.
   */
  history: { quietMs: number; maxOpenMs: number; sweepMs: number; git: string }
  /**
   * VIHKO_INTEGRATIONS=off: the API with keys and the MCP server stay off,
   * whatever the switches in the UI say.
   */
  integrationsLocked: boolean
  /**
   * VIHKO_PUBLIC_URL: the HTTPS origin where vihko is reached from outside
   * (behind a reverse proxy). With it, OAuth exists for the MCP server while
   * the MCP switch is on (oauth.ts); without it, `/mcp` takes keys only.
   */
  publicUrl: string | null
  /**
   * VIHKO_TRUSTED_PROXIES: the reverse proxies (addresses or CIDR ranges)
   * whose X-Forwarded-For says who the client is, for the login limits.
   * Unset: the socket's address, and the header is ignored.
   */
  trustedProxies: BlockList | null
  /** Its entries wider than a proxy needs (`wideTrustedProxies`): warned about on startup. */
  wideTrustedProxies: string[]
  /**
   * VIHKO_SECRET_KEY (or VIHKO_SECRET_KEY_FILE, a Docker secret): with it,
   * the TOTP secrets in state.db are stored encrypted (secretKey.ts). Only
   * the derived key is kept; the variables leave the environment once read.
   */
  secretBox: SecretBox | null
}

export function configFromEnv(env = process.env): Config {
  return {
    notesDir: resolve(env.VIHKO_NOTES_DIR ?? '/data/notes'),
    stateDir: resolve(env.VIHKO_STATE_DIR ?? '/data/state'),
    host: env.VIHKO_HOST ?? '0.0.0.0',
    port: portFrom(env.VIHKO_PORT),
    rescanSeconds: seconds(env.VIHKO_RESCAN_SECONDS, 60, 'VIHKO_RESCAN_SECONDS') / 1000,
    webDir: resolve(env.VIHKO_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
    maxImageBytes: env.VIHKO_MAX_IMAGE_MB ? positiveMb(env.VIHKO_MAX_IMAGE_MB) : DEFAULT_MAX_IMAGE_BYTES,
    externalImages: externalImagesFrom(env.VIHKO_EXTERNAL_IMAGES),
    history: {
      quietMs: seconds(env.VIHKO_HISTORY_QUIET_SECONDS, 30, 'VIHKO_HISTORY_QUIET_SECONDS'),
      maxOpenMs: seconds(env.VIHKO_HISTORY_MAX_SECONDS, 300, 'VIHKO_HISTORY_MAX_SECONDS'),
      sweepMs: seconds(env.VIHKO_HISTORY_SWEEP_SECONDS, 3600, 'VIHKO_HISTORY_SWEEP_SECONDS'),
      git: env.VIHKO_GIT || 'git',
    },
    integrationsLocked: integrationsLockedFrom(env.VIHKO_INTEGRATIONS),
    publicUrl: publicUrlFrom(env.VIHKO_PUBLIC_URL),
    trustedProxies: trustedProxiesFrom(env.VIHKO_TRUSTED_PROXIES),
    wideTrustedProxies: wideTrustedProxies(env.VIHKO_TRUSTED_PROXIES),
    secretBox: secretBoxFrom(env),
  }
}

/** A positive number of seconds, as milliseconds; anything else stops the start, naming the variable. */
function seconds(raw: string | undefined, fallback: number, name: string): number {
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: expected a positive number of seconds, not "${raw}"`)
  return n * 1000
}

/** VIHKO_PORT: 8080 by default; 0 lets the system pick one (tests). */
function portFrom(raw: string | undefined): number {
  const n = raw === undefined || raw === '' ? 8080 : Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`VIHKO_PORT: expected a port number (0-65535), not "${raw}"`)
  return n
}

function positiveMb(raw: string): number {
  const mb = Number(raw)
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`VIHKO_MAX_IMAGE_MB must be a positive number of megabytes, not "${raw}"`)
  return Math.floor(mb * 1024 * 1024)
}

function externalImagesFrom(raw: string | undefined): ExternalImages {
  const v = (raw ?? 'allow').trim().toLowerCase()
  if (v !== 'allow' && v !== 'block') throw new Error(`VIHKO_EXTERNAL_IMAGES must be "allow" or "block", not "${raw}"`)
  return v
}

export function openStores(config: Config, log?: (msg: string) => void) {
  mkdirSync(config.stateDir, { recursive: true })
  const state = openState(join(config.stateDir, 'state.db'), { log })
  const index = openIndex(join(config.stateDir, 'index.db'))
  return { state, index }
}

export interface StartOptions {
  /** vihko.yaml's format migrations (core's list by default; the tests bring their own). */
  workspaceMigrations?: readonly WorkspaceMigration[]
}

export async function start(config: Config, opts: StartOptions = {}) {
  console.log(`[vihko] vihko ${VERSION}`)
  // Both folders writable by the user vihko runs as, before anything is opened in them.
  checkVolumes(config)
  const root = rootWarning()
  if (root) console.log(`[vihko] ${root}`)
  // vihko's alone, closed to other users of the host.
  prepareStateDir(config.stateDir, (msg) => console.log(`[vihko] ${msg}`))
  // One process at a time on the state volume (a second server, or `vihko history purge`).
  const lock = lockState(config.stateDir)
  try {
    return await run(config, lock, opts)
  } catch (err) {
    lock.release()
    throw err
  }
}

async function run(config: Config, lock: StateLock, opts: StartOptions) {
  const log = (msg: string) => console.log(`[vihko] ${msg}`)
  const { state, index } = openStores(config, log)
  // Each new user gets their personal folder (people/<name>).
  const auth = new Auth(state, { notesDir: config.notesDir })
  // The product's two folders, and the personal folder of each user there is, before the first scan.
  if (auth.personalFolders) {
    auth.personalFolders.ensureLayout()
    for (const u of state.prepare('select username from users where deleted_at is null').all() as { username: string }[]) auth.personalFolders.ensure(u.username)
  }
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state, { locked: config.integrationsLocked })
  // vihko.yaml in the current format before it's read: only here, never while it runs.
  const configMigrations = new ConfigMigrations({ notesDir: config.notesDir, stateDir: config.stateDir, migrations: opts.workspaceMigrations, log })
  await configMigrations.run()
  // A file left without permissions applies once it stays so: then everything that depends on it hears.
  const workspace = new Workspace({ notesDir: config.notesDir, stateDir: config.stateDir, log, onSettle: () => reloadWorkspace() })
  const indexer = new Indexer({ notesDir: config.notesDir, db: index, linkAliases: workspace.config.links.aliases })
  // Users and groups. Ending someone's sessions ends their live connections
  // too (the hub exists further down). Their grants in vihko.yaml follow a
  // deletion or a group's rename (http/app.ts fills those hooks in).
  const users = new Users(auth, { hooks: { onSessionsEnded: (id) => hub.checkSessions(id) } })
  // Who reads what: vihko.yaml's rules over state.db's users and groups.
  const permissions = new PermissionsEngine({ source: () => workspace.permissions, directory: stateDirectory(state, groupSource(users)), folders: diskSpaceFolders(config.notesDir) })
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
    log(`moved outside vihko: ${moves.map((m) => `${m.from} → ${m.to} (${m.by})`).join(', ')}`)
    follow?.followMoves(moves)
  }
  // The history: its journal is read before the hub recovers its notes (their
  // flushes join what it left pending); it starts once they are recovered.
  const history = new History({
    notesDir: config.notesDir, stateDir: config.stateDir, config: () => workspace.config.history, log,
    git: config.history.git, quietMs: config.history.quietMs, maxOpenMs: config.history.maxOpenMs, sweepMs: config.history.sweepMs,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind === 'agent' ? keys.nameOf(a.id) ?? a.id : a.kind),
  })
  let liveTree: { viewChanged(): void } | null = null
  /** Rereads vihko.yaml and applies what the index, the history and open editors depend on. */
  const reloadWorkspace = () => {
    if (!workspace.reload()) return
    // Compiled at once: a grant written by hand starts when vihko sees it (grantStarts.ts).
    permissions.spaceRules()
    indexer.setLinkAliases(workspace.config.links.aliases)
    history.configure().catch((e) => log(`history: ${e instanceof Error ? e.message : String(e)}`))
    follow?.recheckAccess()
    // vihko.yaml changed by hand: whoever reaches something else now reads their tree again (liveTree.ts).
    liveTree?.viewChanged()
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

  // Notices to one person (notices.ts): the API shows them; a move's links given up adds one.
  const notices = new Notices(state)
  // After each rescan, the link rewrites a move couldn't make are tried again (notes, below).
  let afterRescan = () => {}
  const watcher = new Watcher({
    notesDir: config.notesDir,
    indexer,
    db: index,
    rescanMs: config.rescanSeconds * 1000,
    // The rescan also rereads vihko.yaml: its events can be lost like any other (NFS).
    onReport: (kind, r) => { if (kind === 'rescan') { runtime.lastScan = r; reloadWorkspace(); afterRescan() } },
    onError: (err) => log(`watcher: ${err instanceof Error ? err.message : String(err)}`),
    onChange: (paths) => {
      // Files that aren't notes reach the history here (notes, through the indexer).
      void history.recorder.observePaths(paths)
      if (paths.includes(WORKSPACE_FILE)) reloadWorkspace()
      for (const p of paths) if (hub.has(p)) hub.checkExternal(p).catch(() => {})
    },
  })
  watcher.start()

  // Each space's note settings (noteSettings.ts): where a space's new images go, among the rest.
  const noteSettings = new NoteSettingsStore({ notesDir: config.notesDir })
  const notes = new NoteService({
    notesDir: config.notesDir, stateDir: config.stateDir, indexer, db: index, hot: hub, maxImageBytes: config.maxImageBytes,
    attachments: (p) => (p ? noteSettings.attachmentsFor(p) : null) ?? workspace.config.attachments, history: history.recorder,
    retries: new RelinkRetries({ stateDir: config.stateDir, log }),
    // Whoever made the move is told, without names or counts; the log has the rest.
    onRelinkGaveUp: (entry, failed) => {
      log(`links in ${failed.length} note(s) still not updated after moving ${entry.reason.from} to ${entry.reason.to}: given up`)
      notices.relinkGaveUp(entry.reason.by)
    },
  })
  afterRescan = () => { notes.retryRelinks().catch((err) => log(`retrying link rewrites: ${err instanceof Error ? err.message : String(err)}`)) }
  // Saved editor states of notes that no longer exist (nor wait in the trash) go.
  const trashed = new Set(notes.trash().map((e) => e.path))
  hub.dropStaleStates((path) => trashed.has(path))
  const webDir = existsSync(join(config.webDir, 'index.html')) ? config.webDir : undefined
  if (!webDir) log(`no UI: nothing built at ${config.webDir} (npm run build); API only`)
  const profiles = new Profiles(state)
  // The second factor's secrets: encrypted with VIHKO_SECRET_KEY if there is
  // one (those still in plaintext, now). One that can't be read never stops
  // vihko: the admin is told (an alert), and `vihko user reset-2fa` fixes it.
  const twoFactor = new TwoFactor(state, { box: config.secretBox })
  const sealed = twoFactor.sealPlaintext()
  if (config.secretBox) log(`VIHKO_SECRET_KEY: second factors are stored encrypted${sealed ? ` (${sealed} encrypted now)` : ''}`)
  const unreadable = twoFactor.unreadable().length
  if (unreadable) log(`${unreadable} second factor(s) can't be read ${config.secretBox ? 'with this VIHKO_SECRET_KEY' : 'without VIHKO_SECRET_KEY'}: those people sign in with a recovery code, or run vihko user reset-2fa <name>`)
  // The trash's and the history's retention: off until the admin turns it on; it runs weekly.
  const retention = new Retention({ stateDir: config.stateDir, settings: new AdminSettings(state), trash: () => notes.trash(), history, notices, log })
  retention.start()
  const { app, services } = createServer({
    notices, retention, log,
    auth, profiles, workspace, notes, index, indexer, notesDir: config.notesDir, runtime, orphans: hub, webDir, externalImages: config.externalImages, externalMoves, history, keys, integrations, publicUrl: config.publicUrl, trustedProxies: config.trustedProxies, users, twoFactor,
    policy, holds, onPermissionsChanged: () => hub.recheckAccess(), configMigrations, noteSettings,
    // The MCP server, at /mcp (off until the admin turns it on).
    routes: (app, services) => { mountMcp(app, services, { auth, workspace, log, icons: markIcons(webDir) }) },
  })
  liveTree = services.live
  // Shared spaces of 0.1.0-rc.1 and rc.2 take their names as folders, before anyone can ask for them.
  await renameLegacySpaces({ notesDir: config.notesDir, file: services.permissionsFile, notes, refs: new FolderRefs({ state, stateDir: config.stateDir }), indexer, starts: policy.starts ?? undefined, log })
    .catch((err) => log(`renaming the shared spaces of earlier versions: ${err instanceof Error ? err.message : String(err)}`))
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }) as Server
  hub.attach(server, SESSION_COOKIE)
  // serve() opens the port asynchronously: only announced once it's actually listening.
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE'
        ? new StartupError([`port ${config.port} on ${config.host} is in use by another program: stop it, or choose another port with VIHKO_PORT`])
        : err))
    })
  }
  log(`listening on http://${config.host}:${config.port}`)
  if (config.integrationsLocked) log('VIHKO_INTEGRATIONS=off: the API with keys and the MCP server stay off')
  if (config.publicUrl) log(`public URL ${config.publicUrl}: OAuth for ${config.publicUrl}/mcp while the MCP server is on`)
  // Behind a proxy without it, every client is the proxy to the login limits: one guesser holds everyone back.
  if (config.publicUrl && !config.trustedProxies) log('VIHKO_TRUSTED_PROXIES is unset: the login limits count every client by the connection\'s address (a reverse proxy\'s, if there is one). Set it to the proxy\'s address; see guide/reverse-proxy.md')
  // A range where a single address was meant (`10.0.0.50/8`): anyone in it could say they're someone else.
  const wide = config.wideTrustedProxies
  if (wide.length) log(`VIHKO_TRUSTED_PROXIES: ${wide.join(', ')} ${wide.length === 1 ? 'is a wide range' : 'are wide ranges'}: every address in ${wide.length === 1 ? 'it' : 'them'} is believed as a proxy, and could slip past the login limits. Give the proxy's own address (such as 10.0.0.50); see guide/reverse-proxy.md`)

  const setup = auth.setupToken()
  if (setup) {
    log('first boot: no users yet. Create the admin with this one-time token')
    log(`  (in the UI, or with POST /api/setup): ${setup}`)
    log('  or from the command line: vihko user create <name> --admin')
  }

  const stop = async () => {
    retention.stop()
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
