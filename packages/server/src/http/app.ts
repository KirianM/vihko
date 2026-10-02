// HTTP API. Used by the UI with a session (cookie), always active. Agents
// reach the routes listed in http/routes.ts with a key (`Authorization:
// Bearer`), only while the API switch is on; everything goes through the
// access filter (access.ts, scoped.ts), for the UI and for agents alike:
// every route that touches notes, folders or their names asks it, and each
// is classified in routes.ts (with what it needs, for the leak tests).
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { NoteSettingsFileError, WORKSPACE_FILE, noteSettingsPath, parseNoteSettings, writeNoteSettings, classifyPath, conflictOriginal, imageMarkdown, parseSpacePath, personalRoot, rulesInFile, seriesPath, setRule, spaceRootOf, type Alert, type ConfigError, type ErrorCode, type RuleValue, type Series, type WorkspaceConfig } from '@vihko/core'
import { AuthError, type Auth, type User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { Indexer, ScanOptions, ScanReport } from '../indexer.ts'
import { ExistsAs, FolderNotEmpty, MovedAway, NoteError, type MoveHooks, type NoteService } from '../notes.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'
import type { EditOp } from '../edits.ts'
import { commentOp } from '../commenting.ts'
import { FetchImageError, SERVED_TYPES, fetchImage, type FetchImageOptions } from '../attachments.ts'
import { ImageSlots } from '../imageSlots.ts'
import { DailyNotes } from '../daily.ts'
import { ProfileError, isNotePath, type Profile, type Profiles } from '../profiles.ts'
import { historyFor } from '../agentHistory.ts'
import { homeView } from '../home.ts'
import { LiveTree } from '../liveTree.ts'
import { NoteSettingsStore, settingsKind } from '../noteSettings.ts'
import { settingsFromBody } from './settingsBody.ts'
import { streamSSE } from 'hono/streaming'
import type { Workspace } from '../workspace.ts'
import { MoveJobs } from './jobs.ts'
import type { ExternalMoves } from '../externalMoves.ts'
import { HistoryError, type History } from '../history/index.ts'
import { GitError } from '../history/git.ts'
import { historyErrorStatus, historyRoutes, purgeClientMessage, purgeErrorStatus } from './history.ts'
import { UNAVAILABLE_MESSAGE, clientMessage } from '../history/reader.ts'
import { PurgeError } from '../history/purge.ts'
import { AccessError, AccessPolicy, AgentDenied, type Access } from '../access.ts'
import { PermissionsEngine, groupSource, stateDirectory, type GroupSource, type PermissionsModel } from '../permissions.ts'
import { diskSpaceFolders } from '../spaceFolders.ts'
import { ConfigInvalidError, PermissionsFile } from '../permissionsFile.ts'
import type { PermissionHolds } from '../permissionHolds.ts'
import { permissionRoutes, rulesWithoutFolder } from './permissions.ts'
import { redactPermissionsWarning, spaceAlerts } from '../spaceAlerts.ts'
import { ApiKeys, KeyError } from '../keys.ts'
import { Integrations, IntegrationsError } from '../integrations.ts'
import { AudienceWidens, RequestError, ScopedNotes, type ScopedDeps } from '../scoped.ts'
import { keyErrorStatus, keyRoutes } from './keys.ts'
import { authenticateKey, bearerToken } from './keyAuth.ts'
import { keyRouteClass } from './routes.ts'
import { OAuthServer } from '../oauth.ts'
import type { ClientMetadataFetcher } from '../cimd.ts'
import { oauthRoutes } from './oauth.ts'
import type { BlockList } from 'node:net'
import { LoginLimiter, SETUP_ACCOUNT, type AttemptResult } from '../loginLimit.ts'
import { clientIp, ipKey } from './clientIp.ts'
import { written } from './written.ts'
import { followable } from '../fsutil.ts'
import { sameHost } from './origin.ts'
import { Users, UsersError } from '../users.ts'
import { AdminSettings, AdminSettingsError } from '../adminSettings.ts'
import { Retention } from '../retention.ts'
import { inviteRoutes, userRoutes, usersErrorStatus, type UserRoutesDeps } from './users.ts'
import { TwoFactor } from '../twoFactor.ts'
import { twoFactorHttp } from './twoFactor.ts'
import { Notices, noticeAlert } from '../notices.ts'
import { VERSION } from '../version.ts'
import type { ConfigMigrations } from '../configMigrations.ts'
import { dismissStateMigration, stateMigrationAlerts } from '../state.ts'
import { FolderRefs } from '../folderRefs.ts'
import { GrantStarts } from '../grantStarts.ts'
import { SpaceError, SpaceService } from '../spaceService.ts'
import { spaceRoutes } from './spaces.ts'
import { jsonBody } from './jsonBody.ts'
import { scrub } from '../logging.ts'

export const SESSION_COOKIE = 'vihko_session'
/** A browser that signed in before, for the login limits (loginLimit.ts). */
export const DEVICE_COOKIE = 'vihko_device'
const DEVICE_DAYS = 365
/**
 * Bodies that carry a password (login, first boot, one-time links, a new
 * password): a name, a password or two and a token fit well within this.
 */
export const MAX_AUTH_BODY = 16 * 1024
/**
 * Any other body the API reads, which it holds in memory whole: the text of
 * a note (JSON-escaped) or a batch of edits to one. The same as an image's
 * default limit: a note this size is already far beyond anything written
 * by hand, and a request can't make the server hold more. Images have
 * their own limit (`maxImageBytes`), on their route.
 */
export const MAX_API_BODY = 20 * 1024 * 1024

export interface Runtime {
  lastScan: ScanReport | null
  rescan(opts: ScanOptions): ScanReport
}

/** What the API needs from the collaboration hub. */
export interface Orphans {
  orphans(): string[]
  restoreOrphan(path: string): Promise<{ etag: string }>
  discardOrphan(path: string): Promise<void>
  /** Open notes it can't save right now (a full disk, no permission), and why. */
  unsaved?(): { path: string; reason: 'disk_full' | 'write_denied' | 'write_failed'; volume: 'notes' | 'state' }[]
}

export interface AppDeps {
  /**
   * How long a confirmation at the moment lasts for its browser session
   * (http/twoFactor.ts, CONFIRM_WINDOW_MS by default). The tests of what each
   * route asks for set 0: every one asks.
   */
  confirmWindowMs?: number
  orphans?: Orphans
  auth: Auth
  /** Each person's timezone and preferences (state.db). */
  profiles: Profiles
  /** vihko.yaml, as currently in force. */
  workspace: Workspace
  notes: NoteService
  index: Db
  indexer: Indexer
  notesDir: string
  runtime: Runtime
  /** Compiled UI (packages/web/dist). Without it, the server only exposes the API. */
  webDir?: string
  /**
   * External images already in notes (`![](https://…)`): loaded by the
   * browser (`allow`, the default) or blocked for the whole installation.
   */
  externalImages?: ExternalImages
  /** The clock (tests). */
  now?: () => Date
  /**
   * How long a move asked for with `background` may take before the request
   * answers with a job instead of the report (1 s by default).
   */
  moveWaitMs?: number
  /** Notes moved outside vihko, pending a link update. */
  externalMoves?: ExternalMoves
  /** Note history (M2). Without it, the history API doesn't exist. */
  history?: History
  /**
   * The groups users belong to (state.db). None until it exists:
   * a grant to a group then reaches nobody (and is reported as unknown).
   */
  groups?: Partial<GroupSource>
  /** Kept for callers written during the transition to spaces: only `spaces` exists (permissions.ts PermissionsModel). */
  permissionsModel?: PermissionsModel
  /**
   * The access policy, when the caller shares it with others (the
   * collaboration hub, main.ts). One of its own over `index` by default.
   */
  policy?: AccessPolicy
  /** Notes held after moves made outside vihko (permissionHolds.ts). */
  holds?: PermissionHolds
  /** After vihko changes the permissions (vihko.yaml): open editors are checked again. */
  onPermissionsChanged?: () => void
  /** Agent keys (state.db). By default, over the same state.db as `auth`. */
  keys?: ApiKeys
  /** The integration switches (state.db). By default, over the same state.db as `auth`, unlocked. */
  integrations?: Integrations
  /** More routes outside /api (the MCP server), mounted before the UI's catch-all. */
  routes?: (app: Hono<Env>, services: Services) => void
  /**
   * VIHKO_PUBLIC_URL: the HTTPS origin vihko is reached at from outside. With
   * it (and the MCP server on), OAuth exists for `/mcp` (oauth.ts).
   */
  publicUrl?: string | null
  /**
   * VIHKO_TRUSTED_PROXIES: the reverse proxies whose X-Forwarded-For is
   * believed, for the login limits (clientIp.ts). Without them, the socket's address.
   */
  trustedProxies?: BlockList | null
  /** The login limits (tests: other rules or clock). One of its own by default. */
  loginLimiter?: LoginLimiter
  /**
   * Fetches OAuth clients' metadata documents (cimd.ts). One of its own by
   * default; only tests pass one (that may reach a local server).
   */
  clientMetadata?: ClientMetadataFetcher
  /**
   * Users and groups (users.ts). One of its own over `auth` by default;
   * main.ts passes one whose sessions ending also ends the hub's connections.
   */
  users?: Users
  /** The admin's settings (state.db). By default, over the same state.db as `auth`. */
  adminSettings?: AdminSettings
  /**
   * The trash's and the history's retention (retention.ts). By default, one
   * over the app's settings, notes and history, without its nightly runs
   * (main.ts passes the one it starts).
   */
  retention?: Retention
  /** The second factor (state.db). By default, over the same state.db as `auth`, on the app's clock. */
  twoFactor?: TwoFactor
  /** Notices addressed to one person (state.db). By default, over the same state.db as `auth`, on the app's clock. */
  notices?: Notices
  /** vihko.yaml rewritten to the current format at start (configMigrations.ts): the admins' alerts. */
  configMigrations?: ConfigMigrations
  /** Each space's note settings (noteSettings.ts); one of its own by default. main.ts shares its NoteService's. */
  noteSettings?: NoteSettingsStore
  /** Only tests: how «Save a copy» resolves names and which addresses count as public. */
  imageFetchTesting?: FetchImageOptions['testing']
  /** The server's log (main.ts): what the admins' actions leave on record. Nothing by default. */
  log?: (msg: string) => void
}

/**
 * What the API is built on, for whatever else serves agents (the MCP
 * server): keys, switches, the access policy, and the operations as a
 * principal (`scoped(access)`).
 */
export interface Services {
  keys: ApiKeys
  integrations: Integrations
  policy: AccessPolicy
  /** vihko.yaml's permissions, as vihko writes them (`removeSubjectGrants` when a user is deleted). */
  permissionsFile: PermissionsFile
  scoped(access: Access): ScopedNotes
  history?: History
  /** OAuth for the MCP server (it says whether it exists: `available()`). */
  oauth: OAuthServer
  /** Users and groups: `groupsOf(userId)` is how the permissions read someone's groups. */
  users: Users
  /** Images being received, by the API and the MCP server alike (imageSlots.ts). */
  imageSlots: ImageSlots
  /** Spaces: what each person reaches, for the MCP server's instructions and `list_folder("")` too. */
  /** The tree, live (liveTree.ts): main.ts tells it when vihko.yaml was changed by hand. */
  live: LiveTree
  /** Each space's note settings: the MCP server adds their guides for agents. */
  noteSettings: NoteSettingsStore
  spaces: SpaceService
}

/**
 * Images notes link from other sites: `allow` loads them; `ask` shows a box
 * with the site's name until the reader presses «Show» (or saves a copy);
 * `block` never loads them (the page's policy forbids it), and offers only
 * to save a copy, which the server downloads.
 */
export type ExternalImages = 'allow' | 'ask' | 'block'

// The UI only talks to its own origin: no CDNs or third parties. The one
// exception is images linked in notes, unless the administrator blocks them.
function uiHeaders(external: ExternalImages) {
  const img = external === 'block' ? "img-src 'self' data: blob:" : "img-src 'self' data: blob: https: http:"
  return {
    'Content-Security-Policy': `default-src 'self'; ${img}; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }
}

// Files from the notes folder are served inert: nothing in them runs, even
// an SVG opened on its own (sandboxed, no scripts).
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
// A PDF from the notes folder: the browser's own viewer shows it, which a
// sandbox (or a policy on what it may load) can stop, so the policy only
// keeps it from being framed. It is never read as a page: its type is
// `application/pdf`, with `nosniff`.
const PDF_CSP = "frame-ancestors 'none'"

// Everything else (the API's JSON, errors, /mcp): nothing in it is a page.
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * `user`: who the request acts for (a key's user, for an agent); `access`:
 * who is asking and what they may reach; `token`: the session (cookie only).
 */
export type ApiEnv = { Variables: { user: User; token: string; access: Access } }
type Env = ApiEnv

function noteErrorStatus(e: NoteError) {
  return ({ not_found: 404, exists: 409, precondition_failed: 412, invalid_path: 400, control_characters: 400, edit_mismatch: 409, too_large: 413, note_too_large: 413, unsupported_type: 415, not_configured: 409, not_empty: 409, series_gone: 409 } as const)[e.code]
}

function fetchErrorStatus(e: FetchImageError) {
  return ({ invalid: 400, too_large: 413, unsupported_type: 415, fetch_failed: 502, private_address: 403 } as const)[e.code]
}

/**
 * Error response: `error` is the stable code the UI translates; `message`
 * is a hint for developers, which the UI never shows.
 */
function fail(c: Context, status: ContentfulStatusCode, error: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, ...extra }, status)
}

/** The rules a vihko.yaml's text writes (none if it isn't YAML). */
function keptRules(text: string): Map<string, RuleValue> {
  try { return rulesInFile(text) } catch { return new Map() }
}

/** The API alone (see `createServer` for the services under it). */
export function createApp(deps: AppDeps) {
  return createServer(deps).app
}

/** The API and the services under it (keys, switches, access, scoped operations). */
export function createServer(deps: AppDeps): { app: Hono<Env>; services: Services } {
  const { auth, notes, index, profiles, workspace } = deps
  const log = deps.log ?? (() => {})
  const externalImages = deps.externalImages ?? 'allow'
  const now = deps.now ?? (() => new Date())
  // Under the spaces model, a person's series are those where they can write today's note.
  const offered = (user: User, s: Series) => permissions.viewer(user).can(seriesPath(s, profiles.now(user.id, now()), user.username), 'edit')
  // Each space's note settings (noteSettings.ts): series, images and agents' guides of a space or a person.
  const noteSettings = deps.noteSettings ?? new NoteSettingsStore({ notesDir: deps.notesDir })
  /** The shared spaces someone belongs to: whose settings add to theirs. */
  const spacesOf = (user: { id: string; username: string }) => permissions.spacesFor(user).spaces.map((s) => s.path)
  const seriesOf = (user: User) => noteSettings.series(workspace.config.daily, spacesOf(user), personalRoot(user.username), user.username).list
  const sameSeries = (user: User, id: string) => noteSettings.series(workspace.config.daily, spacesOf(user), personalRoot(user.username), user.username).sameAs.get(id) ?? null
  const daily = new DailyNotes({ workspace, profiles, notes, now, offered, seriesOf, sameAs: sameSeries })
  const jobs = new MoveJobs()
  const moveWaitMs = deps.moveWaitMs ?? 1000
  const keys = deps.keys ?? new ApiKeys(auth.state)
  const integrations = deps.integrations ?? new Integrations(auth.state)
  const users = deps.users ?? new Users(auth)
  const adminSettings = deps.adminSettings ?? new AdminSettings(auth.state)
  const policy = deps.policy ?? new AccessPolicy({
    index, holds: deps.holds,
    permissions: new PermissionsEngine({
      source: () => workspace.permissions, directory: stateDirectory(auth.state, deps.groups ?? groupSource(users)),
      folders: diskSpaceFolders(deps.notesDir), model: deps.permissionsModel,
    }),
  })
  const permissions = policy.permissions
  // When each grant began (grantStarts.ts): each person sees the past only from when they could read it.
  const grantStarts = policy.starts ?? new GrantStarts(auth.state, { now })
  if (!policy.starts) {
    policy.starts = grantStarts
    // Not while vihko.yaml has lost its permissions (pasted over, deleted, caught half written):
    // giving them back mustn't start everyone's grants anew, and so hide their past from them.
    permissions.onRules((rules) => { if (!workspace.permissionsMissing) grantStarts.sync(rules) })
  }
  // The tree and the sidebar, live (liveTree.ts): told what changes the tree, and when who reaches what may have.
  const live = new LiveTree({
    policy,
    viewOf: (user) => {
      const rules = permissions.spaceRules()
      // Only what they see: a rule of a folder they don't reach never weighs in.
      const seen = rules.rules.map((r) => [r.folder, permissions.levelFor(user, r.folder, rules), r.ai] as const).filter(([, level]) => level !== null)
      return { spaces: permissions.spacesFor(user), seen }
    },
  })
  deps.indexer.onTreeChange((paths) => live.pathsChanged(paths))
  // The rules are compiled at once: a grant starts when it's written (grantStarts.ts), not when someone next asks.
  const permissionsChanged = () => { permissions.spaceRules(); deps.onPermissionsChanged?.(); live.viewChanged() }
  const permissionsFile = new PermissionsFile({
    notesDir: deps.notesDir, workspace, engine: permissions, history: deps.history?.recorder, onChange: permissionsChanged,
    // Whoever a share or a new member reaches is told (spaceService.ts `notifyShared`).
    onRuleSet: (folder, before, actor) => { spaces.notifyShared(folder, before, actor) },
  })
  const twoFactor = deps.twoFactor ?? new TwoFactor(auth.state, { now })
  const notices = deps.notices ?? new Notices(auth.state, { now })
  // A notice for someone reaches their open pages at once (GET /api/live `notices`).
  notices.onAdded = (userId) => live.noticeFor(userId)
  const retention = deps.retention ?? new Retention({ stateDir: notes.stateDir, settings: adminSettings, trash: () => notes.trash(), history: deps.history, notices, now: () => now().getTime() })
  const oauth = new OAuthServer({ state: auth.state, keys, integrations, publicUrl: deps.publicUrl ?? null, now, clientMetadata: deps.clientMetadata, clientDomains: () => workspace.config.mcp.clientDomains })
  // Keys' folders, pins and the trash follow a folder moved from vihko (folderRefs.ts).
  const refs = new FolderRefs({ state: auth.state, stateDir: notes.stateDir })
  const scopedDeps: ScopedDeps = {
    notes, index, notesDir: deps.notesDir, daily, profiles, attachments: (p) => (p ? noteSettings.attachmentsFor(p) : null) ?? workspace.config.attachments, now, links: () => deps.indexer.links,
    permissions, permissionsFile, keys: () => keys.listAll(), orphans: deps.orphans, externalMoves: deps.externalMoves, holds: deps.holds,
    onFolderMoved: (from, to) => { refs.moved(from, to) },
    onNoteMoved: (from, to) => { refs.noteMoved(from, to) },
    onFolderMoving: (from, to) => { grantStarts.moving(from, to) },
    onMovedOut: (m) => {
      const owner = auth.state.prepare('select id from users where username = ? and deleted_at is null').get(m.owner) as { id: string } | undefined
      if (owner) notices.add(owner.id, { code: 'moved_out', kind: m.kind, by: m.by, from: m.from, to: m.to })
    },
  }
  // A user deleted, a group renamed or deleted: their grants in vihko.yaml
  // follow, first (if vihko.yaml can't be written, nothing changes).
  users.hooks.onUserDeleted ??= async (name, by) => { await permissionsFile.removeSubjectGrants(name, { actor: by }) }
  // Someone invited renamed: the grants to them, and their folder's own rules, follow.
  users.hooks.onUserRenamed ??= async (from, to, by) => {
    await permissionsFile.renameSubject(from, to, { actor: by })
    if (permissionsFile.read().text?.includes(personalRoot(from))) await permissionsFile.moveRules(personalRoot(from), personalRoot(to), { actor: by })
  }
  users.hooks.onGroupRenamed ??= async (from, to, by) => { await permissionsFile.renameSubject(`@${from}`, `@${to}`, { actor: by }) }
  users.hooks.onGroupDeleted ??= async (name, by) => { await permissionsFile.removeSubjectGrants(`@${name}`, { actor: by }) }
  // Deleting someone closes their space for everyone: open editors are checked again at once.
  users.hooks.onUserRemoved ??= () => { permissionsChanged() }
  // The event streams open (GET /api/live), each with its session: those of a session that ends go at once,
  // after whatever else hears it (the hub's editors).
  const streams = new Set<{ userId: string; token: string; end: () => void }>()
  const sessionsEnded = users.hooks.onSessionsEnded
  users.hooks.onSessionsEnded = (userId) => {
    sessionsEnded?.(userId)
    for (const s of streams) if (s.userId === userId && !auth.session(s.token)) s.end()
    // A confirmation doesn't outlive a change of who may be signed in (a new password, sessions ended).
    tf.endConfirmations(userId)
  }
  // So does taking someone out of a group: they stop seeing what it gave them at once.
  users.hooks.onMembersChanged ??= () => { permissionsChanged() }
  const spaces = new SpaceService({
    notesDir: deps.notesDir, state: auth.state, engine: permissions, file: permissionsFile, users, notices, settings: adminSettings, refs, notes, indexer: deps.indexer, now,
    deleteFolder: (access, path, o) => new ScopedNotes(scopedDeps, access).deleteFolder(path, o),
    moveFolder: (access, from, to, o) => new ScopedNotes(scopedDeps, access).moveFolder(from, to, o),
    pastPaths: deps.history ? () => deps.history!.pastPaths() : undefined,
    starts: grantStarts,
  })
  const services: Services = { keys, integrations, policy, permissionsFile, scoped: (access) => new ScopedNotes(scopedDeps, access), history: deps.history, oauth, users, imageSlots: new ImageSlots(), spaces, live, noteSettings }
  const app = new Hono<Env>()
  /** The request's operations, as whoever is asking. */
  const scoped = (c: Context<Env>) => services.scoped(c.get('access'))

  app.onError((err, c) => {
    if (err instanceof NoteError) {
      if (err.etag) c.header('ETag', `"${err.etag}"`)
      return fail(c, noteErrorStatus(err), err.code, err.message, { etag: err.etag, ...(err instanceof FolderNotEmpty ? { contents: err.contents } : {}), ...(err instanceof ExistsAs ? { path: err.path } : {}), ...(err instanceof MovedAway ? { movedTo: err.movedTo } : {}) })
    }
    if (err instanceof RequestError) return fail(c, err.status, err.code, err.message)
    if (err instanceof AccessError) return fail(c, 403, 'forbidden', err.message)
    if (err instanceof AgentDenied) return fail(c, 403, 'agent_denied', err.message, { reason: err.reason })
    if (err instanceof AudienceWidens) return fail(c, 409, 'audience_widens', err.message, { audience: err.audience })
    if (err instanceof FetchImageError) return fail(c, fetchErrorStatus(err), err.code, err.message)
    if (err instanceof ProfileError) return fail(c, 400, err.code, err.message)
    // What git said stays on the server (history/reader.ts `clientMessage`).
    if (err instanceof HistoryError) return fail(c, historyErrorStatus(err), err.code, clientMessage(err))
    if (err instanceof PurgeError) return fail(c, purgeErrorStatus(err), err.code, purgeClientMessage(err))
    if (err instanceof GitError) {
      console.error(scrub(`history: ${err.message}`))
      return fail(c, 503, 'history_unavailable', UNAVAILABLE_MESSAGE)
    }
    if (err instanceof AuthError) return fail(c, err.code === 'user_exists' || err.code === 'already_setup' || err.code === 'personal_folder_exists' ? 409 : 400, err.code, err.message)
    if (err instanceof SpaceError) return fail(c, err.status, err.code, err.message, err.extra)
    if (err instanceof KeyError) return fail(c, keyErrorStatus(err), err.code, err.message)
    if (err instanceof IntegrationsError) return fail(c, err.code === 'integrations_locked' ? 409 : 400, err.code, err.message)
    if (err instanceof ConfigInvalidError) return fail(c, 409, 'config_invalid', err.message)
    if (err instanceof UsersError) return fail(c, usersErrorStatus(err), err.code, err.message)
    if (err instanceof AdminSettingsError) return fail(c, 400, err.code, err.message)
    // Body that isn't JSON.
    if (err instanceof SyntaxError) return fail(c, 400, 'invalid', err.message)
    console.error(scrub(err instanceof Error ? err.stack ?? err.message : String(err)))
    return fail(c, 500, 'internal', 'internal error')
  })

  // Every answer, whatever answered it: never sniffed as another type. One
  // without a policy of its own (the API's JSON, errors) is no page: opened
  // on its own, or framed, it can run and load nothing. The UI and the files
  // from the notes folder set theirs.
  // Nor is it kept by any cache, the browser's disk or a proxy's: it holds
  // notes, names and keys (unless it says otherwise, as OAuth's do).
  app.use('*', async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    if (c.res.headers.has('Content-Security-Policy')) return
    c.header('Content-Security-Policy', API_CSP)
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  })

  // No body over MAX_API_BODY, before anything else (who is asking included).
  // An image upload has its own limit, on its route.
  const apiBody = bodyLimit({ maxSize: MAX_API_BODY, onError: (c) => fail(c, 413, 'invalid', `the limit is ${MAX_API_BODY} bytes`) })
  app.use('/api/*', (c, next) => (c.req.method === 'POST' && c.req.path === '/api/attachments' ? next() : apiBody(c, next)))

  // --- A key (`Authorization: Bearer`) ----------------------------------------
  // Judged by the key alone, never the cookie. Only the routes http/routes.ts
  // opens to keys; any other, or any with the API off, is 404 as if it didn't
  // exist (before anything else, the CSRF check included: off, there's
  // nothing there). A read-only key gets 403 on a write route. The health
  // check and the first boot need no key and ignore one (routes.ts).
  app.use('/api/*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === null) return next()
    const route = keyRouteClass(c.req.method, c.req.path)
    if (route === 'ignored') return next()
    if (!integrations.apiEnabled()) return fail(c, 404, 'not_found', 'does not exist')
    if (!route) return fail(c, 404, 'not_found', 'does not exist')
    const r = authenticateKey({ keys, integrations }, token, 'api')
    if (!r.ok) return fail(c, r.status, r.error, r.status === 401 ? 'invalid key' : r.status === 403 ? 'this key is suspended while the admin doesn\'t let members have keys' : 'does not exist')
    if (route === 'write' && !r.principal.key.canWrite) return fail(c, 403, 'forbidden', 'this key is read-only')
    c.set('user', r.principal.user)
    c.set('access', policy.for(r.principal))
    await next()
  })

  // CSRF: a request that modifies something and comes from another origin is rejected.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && !sameHost(origin, new URL(c.req.url).host)) return fail(c, 403, 'forbidden', 'origin not allowed')
    }
    await next()
  })

  // --- No session required: health, first boot and login --------------------

  // For Docker's healthcheck and monitoring: the process responds. Nothing
  // else, not even the version: that is for who signs in (/api/config) or
  // holds a key (MCP), not for anyone who reaches the port.
  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/setup', (c) => c.json({ needed: auth.userCount() === 0 }))

  // Guessing the first-boot token or a password is limited (loginLimit.ts):
  // while a wait is in force, 429 with Retry-After, before anything is checked.
  const limiter = deps.loginLimiter ?? new LoginLimiter()
  const authBody = bodyLimit({ maxSize: MAX_AUTH_BODY, onError: (c) => fail(c, 413, 'invalid', `the limit is ${MAX_AUTH_BODY} bytes`) })
  const ipOf = (c: Context) => ipKey(clientIp(socketAddress(c), c.req.header('x-forwarded-for'), deps.trustedProxies ?? null))
  const tooMany = (c: Context, retryAfter: number) => {
    c.header('Retry-After', String(retryAfter))
    return fail(c, 429, 'too_many_attempts', `too many failed attempts: try again in ${retryAfter} s`, { retryAfter })
  }
  const text = (v: unknown) => (typeof v === 'string' ? v : '')

  app.post('/api/setup', authBody, async (c) => {
    const { token, username, password } = await jsonBody<{ token?: unknown; username?: unknown; password?: unknown }>(c)
    const attempt: AttemptResult = limiter.begin({ ip: ipOf(c), account: SETUP_ACCOUNT, byAddress: true })
    if (!attempt.ok) return tooMany(c, attempt.retryAfter)
    try {
      const user = await auth.setup(text(token), text(username), text(password))
      attempt.passed()
      return c.json({ user })
    } catch (err) {
      // Only a wrong token is a guess; a weak password came with the right one.
      if (!(err instanceof AuthError) || err.code !== 'invalid_token') attempt.passed()
      else {
        const wait = attempt.failed()
        if (wait > 0) return tooMany(c, wait)
      }
      throw err
    }
  })

  /** The session cookie of someone who just signed in, and their device's for the login limits. */
  const signedIn = (c: Context, username: string, s: { token: string; expiresAt: Date }) => {
    setCookie(c, SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: isHttps(c),
      expires: s.expiresAt,
    })
    // This browser is known for this account from now on: other people's failures don't hold it back,
    // at a sign-in or when confirming at the moment (keys, OAuth, the admin's actions: all under /api).
    setCookie(c, DEVICE_COOKIE, limiter.deviceToken(username), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/api',
      secure: isHttps(c),
      maxAge: DEVICE_DAYS * 86_400,
    })
    // The one an earlier version left under /api/auth would be sent first there, and outlive a restart's new key.
    deleteCookie(c, DEVICE_COOKIE, { path: '/api/auth', secure: isHttps(c) })
  }

  // The second factor (http/twoFactor.ts): after the password, the session or the second step.
  const tf = twoFactorHttp({
    auth, users, twoFactor, settings: adminSettings, limiter, deviceCookie: DEVICE_COOKIE, ipOf, tooMany, signedIn, notices,
    publicUrl: deps.publicUrl ?? null, now: () => now().getTime(), confirmWindowMs: deps.confirmWindowMs, log,
  })

  // The password: the session, or (with a second factor) a pending sign-in
  // that its second step completes (http/twoFactor.ts).
  app.post('/api/auth/login', authBody, async (c) => {
    const body = await jsonBody<{ username?: unknown; password?: unknown }>(c)
    const username = text(body?.username)
    const device = limiter.deviceFor(getCookie(c, DEVICE_COOKIE), username)
    const attempt = limiter.begin({ ip: ipOf(c), account: username, device })
    if (!attempt.ok) return tooMany(c, attempt.retryAfter)
    const user = await auth.verifyLogin(username, text(body?.password))
    if (!user) {
      // The failure that starts a wait says so at once.
      const wait = attempt.failed()
      return wait > 0 ? tooMany(c, wait) : fail(c, 401, 'invalid_credentials', 'incorrect username or password')
    }
    attempt.passed()
    return tf.passwordAccepted(c, user)
  })

  app.use('/api/auth/login/code', authBody)
  app.use('/api/auth/2fa/*', authBody)
  tf.publicRoutes(app)

  const userDeps: UserRoutesDeps = {
    auth, users, settings: adminSettings, limiter, ipOf, tooMany, publicUrl: deps.publicUrl ?? null,
    deviceOf: (c, username) => limiter.deviceFor(getCookie(c, DEVICE_COOKIE), username),
    passwordAccepted: tf.passwordAccepted, confirm: tf.confirmIdentity, notices,
    retention, managedHistory: () => deps.history?.status().mode === 'managed', log, keys,
  }
  // A one-time link (an invitation or a reset): no session yet.
  app.use('/api/invite/*', authBody)
  inviteRoutes(app, userDeps)
  // A new password (userRoutes, with a session): the current one and the new one.
  app.use('/api/auth/password', authBody)

  // --- From here on, a session is required -----------------------------------

  app.use('/api/*', async (c, next) => {
    if (c.get('access')) return next() // a key, already judged
    const token = getCookie(c, SESSION_COOKIE)
    const user = auth.session(token)
    if (!user) return fail(c, 401, 'unauthorized', 'please log in')
    c.set('user', user)
    c.set('token', token!)
    c.set('access', policy.for({ kind: 'user', user }))
    await next()
  })

  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('access').isAgent || c.get('user').role !== 'admin') return fail(c, 403, 'forbidden', 'admins only')
    await next()
  }

  app.post('/api/auth/logout', (c) => {
    auth.logout(c.get('token'))
    // Its editors in other tabs (the same cookie) end too.
    users.hooks.onSessionsEnded?.(c.get('user').id)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }))

  // What the UI needs to know about this installation's settings.
  // `secretsEncrypted`: VIHKO_SECRET_KEY is set (the privacy page says how the second factor's secret is kept).
  // `version`: vihko's, for the account page.
  app.get('/api/config', (c) => c.json({ externalImages, maxImageBytes: notes.maxImageBytes, secretsEncrypted: twoFactor.encrypted, version: VERSION }))

  // Notes and folders: a folder with no notes (just created, or emptied) still shows.
  app.get('/api/tree', (c) => c.json(scoped(c).tree()))

  // Tags in use, most used first (case-insensitive, nested with `/`).
  // `count`: the notes that carry the tag (inline or in the frontmatter);
  // `total`: those that carry it or any tag nested under it (the tags view).
  app.get('/api/tags', (c) => c.json({ tags: scoped(c).tags() }))

  // A note's headings, in order (link anchors: `[[Note#Heading]]`).
  app.get('/api/note/headings', (c) => c.json({ headings: scoped(c).headings(c.req.query('path') ?? '') }))

  // A note's comment threads as the index first saw them: the text
  // each one was anchored to, and whether the note's text there has changed
  // since. Only threads the index knows (the note as last saved); the editor
  // compares the same originals with what is being typed.
  app.get('/api/note/comments', (c) => c.json({ threads: scoped(c).comments(c.req.query('path') ?? '') }))

  // A comment written by the server (commenting.ts), for whoever may comment
  // but not edit, whose editor is read-only: `{ path, op: 'add', at, context,
  // newline?, text }`, `{ path, op: 'reply', thread, text }` or `{ path, op:
  // 'resolve', thread }`. 412 if the place or the thread isn't there any more;
  // 403 to resolve someone else's thread without `edit`.
  app.post('/api/note/comment', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const op = commentOp(body)
    if (!op || typeof body.path !== 'string') return fail(c, 400, 'invalid', 'expected a path and an operation: add, reply or resolve')
    const r = await scoped(c).comment(body.path, op)
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Folders only exist on disk: these create (`edit` where it goes), move
  // (`manage` in it and `edit` in its new parent: with every note in them,
  // links kept as in a note move, and its permissions with it) and delete
  // them (`manage`: when empty, or with `trash=true`, its notes and files to
  // the trash first; otherwise 409 `not_empty` with its `contents`). A dry
  // run of a move says whose access changes (`audience`), for the UI to confirm.
  app.post('/api/folder', async (c) => {
    const { path } = await jsonBody<{ path: string }>(c)
    return c.json(await scoped(c).createFolder(path), 201)
  })

  app.delete('/api/folder', async (c) => c.json(await scoped(c).deleteFolder(c.req.query('path') ?? '', { trash: c.req.query('trash') === 'true', dryRun: c.req.query('dryRun') === 'true' })))

  // Templates are notes marked `template: true` in their frontmatter. A
  // person marks every note of a folder (its subfolders too) at once, each
  // through the normal write: `dryRun` counts what it would do, for the UI to
  // confirm. A key writes the mark like any frontmatter key (`set_frontmatter`).
  app.post('/api/folder/templates', async (c) => {
    if (c.get('access').isAgent) return fail(c, 404, 'not_found', 'does not exist')
    const { path, dryRun } = await jsonBody<{ path?: unknown; dryRun?: unknown }>(c)
    if (typeof path !== 'string') return fail(c, 400, 'invalid', 'path: the folder')
    return c.json(await scoped(c).markFolderTemplates(path, { dryRun: dryRun === true }))
  })

  // One note made a template (`template: true`) or not one any more (the key goes); nothing else of it changes.
  app.post('/api/note/template', async (c) => {
    if (c.get('access').isAgent) return fail(c, 404, 'not_found', 'does not exist')
    const { path, template } = await jsonBody<{ path?: unknown; template?: unknown }>(c)
    if (typeof path !== 'string' || typeof template !== 'boolean') return fail(c, 400, 'invalid', 'path, and template: true or false')
    return c.json(written(c, await scoped(c).markTemplate(path, template)))
  })

  // With `background`, a move that takes long answers 202 with a job as soon
  // as the folder (or note) is in place; GET /api/move-jobs/:id follows it.
  app.post('/api/folder/move', async (c) => {
    const { from, to, dryRun, background } = await jsonBody<{ from: string; to: string; dryRun?: boolean; background?: boolean }>(c)
    const s = scoped(c)
    if (!background || dryRun) return c.json(await s.moveFolder(from, to, { dryRun }))
    const r = await jobs.start(c.get('user').username, 'folder', from, to, (hooks) => s.moveFolder(from, to, hooks), moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  app.get('/api/move-jobs/:id', (c) => {
    const job = jobs.get(c.get('user').username, c.req.param('id'))
    return job ? c.json(job) : fail(c, 404, 'not_found', 'no such move job')
  })

  // `tooLarge`: over vihko.yaml's `notes.maxSize`, never opened live (the UI shows it as plain text, with a download).
  app.get('/api/note', (c) => {
    const r = scoped(c).read(c.req.query('path') ?? '')
    c.header('ETag', `"${r.etag}"`)
    return c.json(deps.indexer.isTooLarge(r.path) ? { ...r, tooLarge: true } : r)
  })

  // A new note, with the given text or from a template note (its variables
  // filled in with the person's date and name). Never overwrites.
  app.post('/api/note', async (c) => {
    const { path, text, template, freshUid, fromLink } = await jsonBody<{ path: string; text?: string; template?: string; freshUid?: boolean; fromLink?: string }>(c)
    if (template !== undefined && typeof template !== 'string') return fail(c, 400, 'invalid', 'template must be a note path')
    if (text !== undefined && typeof text !== 'string') return fail(c, 400, 'invalid', 'text must be text')
    // `fromLink`: the note whose broken link this creates (never one of someone else's personal space: a link there that looks broken may lead to a note this person can't read).
    if (fromLink !== undefined && typeof fromLink !== 'string') return fail(c, 400, 'invalid', 'fromLink must be a note path')
    return c.json(written(c, await scoped(c).create(path, { text, template, freshUid, fromLink })), 201)
  })

  // The workspace settings the UI needs from vihko.yaml (reloaded when it changes).
  // A series' template the person can't read isn't named. Under the spaces model, only the series
  // where the person can write today's note are offered. (Templates to create from
  // are marked in the tree: `template: true` in their frontmatter.)
  app.get('/api/workspace', (c) => {
    const w = workspace.config
    const access = c.get('access')
    const user = c.get('user')
    return c.json({
      daily: seriesOf(user).filter((s) => offered(user, s)).map((s) => ({ ...s, template: s.template !== null && access.canRead(s.template) ? s.template : null })),
      links: w.links,
    })
  })

  // Note settings (noteSettings.ts): a person's own, or a shared space's
  // (`space`: its root). One's own: read and changed by them alone. A shared
  // space's: read by its members, changed by its managers. Anything else is
  // `not_found`, as for what doesn't exist; a key has none of this.
  const settingsRoot = (c: Context<Env>, space: unknown, change: boolean): string | Response => {
    const access = c.get('access')
    if (access.isAgent) return fail(c, 404, 'not_found', 'does not exist')
    const own = personalRoot(c.get('user').username)
    if (space === undefined || space === null || space === '' || space === own) return own
    const s = typeof space === 'string' ? parseSpacePath(space.normalize('NFC')) : null
    if (!s || s.space.kind !== 'shared' || s.inner !== '' || access.level(s.space.root) === null) return fail(c, 404, 'not_found', 'no such space')
    if (change && !access.canManage(s.space.root)) return fail(c, 403, 'forbidden', 'only its managers change a space\'s settings')
    return s.space.root
  }
  /** The note a space's settings name as its guide for agents, when there's no such note (agents would get nothing from it); null otherwise. */
  const guideMissing = (r: { resolved: { agents: string | null } }): string | null => {
    const note = r.resolved.agents
    return note !== null && !index.prepare('select 1 from notes where path = ?').get(note) ? note : null
  }
  const settingsView = (r: { root: string; etag: string; settings: unknown; errors: unknown; resolved: { agents: string | null } }, canEdit: boolean) =>
    ({ space: r.root, etag: r.etag, settings: r.settings, errors: r.errors, guideMissing: guideMissing(r) !== null, canEdit })

  app.get('/api/settings', (c) => {
    const root = settingsRoot(c, c.req.query('space'), false)
    if (root instanceof Response) return root
    const own = root === personalRoot(c.get('user').username)
    return c.json(settingsView(noteSettings.read(root), own || c.get('access').canManage(root)))
  })

  app.put('/api/settings', async (c) => {
    const body = await jsonBody<{ space?: unknown; settings?: unknown; ifMatch?: unknown; remove?: unknown }>(c)
    const root = settingsRoot(c, body.space, true)
    if (root instanceof Response) return root
    const next = settingsFromBody(body.settings)
    if (next === null) return fail(c, 400, 'invalid', 'settings: version, daily, attachments, agents and guide, as GET gives them')
    // What's wrong in them is said, with where; nothing is written.
    const kind = settingsKind(root)
    const problems = parseNoteSettings(writeNoteSettings(null, next, kind), kind).errors
    if (problems.length) return fail(c, 400, 'invalid', 'the settings have problems', { errors: problems })
    if (typeof body.ifMatch !== 'string') return fail(c, 428, 'precondition_required', 'ifMatch: the ETag of the settings the change was planned on')
    // Keys vihko doesn't know, to remove from the file (their `at`, as `errors` gives them): only unknown ones are.
    const remove = body.remove ?? []
    if (!Array.isArray(remove) || remove.some((k) => typeof k !== 'string')) return fail(c, 400, 'invalid', 'remove: a list of the unknown keys to remove, as errors names them')
    try {
      const r = await noteSettings.write(root, next, { ifMatch: body.ifMatch, remove: remove as string[] })
      return c.json(settingsView(r, true))
    } catch (err) {
      if (err instanceof NoteSettingsFileError) return fail(c, 409, 'config_invalid', err.message)
      throw err
    }
  })

  /** A profile as its person may see it: the note «On opening» names only while they can read it (otherwise, home). */
  const shownProfile = (p: Profile, access: Access): Profile =>
    p.onOpen === 'note' && (p.onOpenNote === null || !access.canRead(p.onOpenNote)) ? { ...p, onOpen: 'home', onOpenNote: null } : p

  app.get('/api/profile', (c) => c.json(shownProfile(profiles.get(c.get('user').id), c.get('access'))))

  app.put('/api/profile', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    if (typeof body !== 'object' || body === null) return fail(c, 400, 'invalid', 'expected an object')
    const patch: Partial<Profile> = {}
    for (const k of ['timezone', 'dailySeries', 'openDailyOnStart', 'onOpen', 'onOpenNote', 'language'] as const) if (k in body) (patch as Record<string, unknown>)[k] = body[k]
    // «On opening» a note: one the person reads now; any other is as missing.
    if (isNotePath(patch.onOpenNote) && !c.get('access').canRead(patch.onOpenNote.normalize('NFC'))) return fail(c, 404, 'not_found', 'no such note')
    return c.json(shownProfile(profiles.update(c.get('user').id, patch), c.get('access')))
  })

  // The tree, live (liveTree.ts): a server-sent event stream that only ever
  // says «read your tree again» (`tree`), to this person, when a change
  // concerns what they see, or «read your notices again» (`notices`) when one
  // arrives for them. A comment every 25 s keeps proxies from closing it.
  app.get('/api/live', (c) => {
    const access = c.get('access')
    if (access.isAgent) return fail(c, 404, 'not_found', 'does not exist')
    c.header('Cache-Control', 'no-store')
    c.header('X-Accel-Buffering', 'no')
    const token = c.get('token')
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null
      let ended = false
      const stop = live.subscribe(c.get('user'),
        () => { void stream.writeSSE({ event: 'tree', data: '{}' }).catch(() => {}) },
        // A notice arrived for them: «read your notices again», nothing of it.
        () => { void stream.writeSSE({ event: 'notices', data: '{}' }).catch(() => {}) })
      // Its session ending (signed out, disabled, a new password) ends it at once; one that expires, at the next keep-alive.
      const open = { userId: c.get('user').id, token, end: () => { ended = true; wake?.() } }
      streams.add(open)
      stream.onAbort(() => { stop(); wake?.() })
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted && !stream.closed && !ended) {
        // Unref'd: a stream left waiting never keeps the process alive.
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 25_000).unref() })
        if (!auth.session(token)) break
        if (!stream.aborted && !stream.closed && !ended) await stream.write(': keep-alive\n\n').catch(() => {})
      }
      streams.delete(open)
      stop()
    })
  })

  // «Home» (home.ts): the person's recent notes, what others changed
  // in what they read, what was shared with them lately. A person's only.
  app.get('/api/home', async (c) => {
    const access = c.get('access')
    if (access.isAgent) return fail(c, 404, 'not_found', 'does not exist')
    const status = deps.history?.status()
    const reader = deps.history && status && status.mode !== 'off' && status.available ? historyFor(access, deps.history.reader()) : null
    // Templates stay out (skeletons, `{{title}}` and all), found once for every note Home looks at.
    const templates = scoped(c).templates()
    return c.json(await homeView(access, { index, history: reader, notices, nameOf: (id) => auth.username(id) ?? id, keyName: (id) => keys.nameOf(id), now, excluded: (p) => templates.has(p) }))
  })

  // Today's note: GET says where it is and whether it exists, POST
  // opens or creates it. `series` picks one other than the person's own.
  app.get('/api/daily', (c) => c.json(scoped(c).dailyToday(c.req.query('series'))))

  app.post('/api/daily', async (c) => {
    const { series } = await jsonBody<{ series?: string }>(c).catch(() => ({ series: undefined }))
    if (series !== undefined && series !== null && typeof series !== 'string') return fail(c, 400, 'invalid', 'series must be a series id')
    const r = await scoped(c).dailyOpen(series)
    return c.json(r, r.created ? 201 : 200)
  })

  // The whole text. `If-Match` (mandatory) writes over that ETag only, 412
  // with the current one otherwise; `If-None-Match: *` creates the note only
  // if it doesn't exist (412 if it does).
  app.put('/api/note', async (c) => {
    const ifMatch = unquote(c.req.header('if-match'))
    const ifNoneMatch = c.req.header('if-none-match')?.trim()
    if (!ifMatch && ifNoneMatch !== '*') return fail(c, 428, 'precondition_required', 'missing If-Match: a note that hasn\'t been read won\'t be overwritten')
    const { text } = await jsonBody<{ text: string }>(c)
    if (typeof text !== 'string') return fail(c, 400, 'invalid', 'text must be text')
    const { created, ...r } = await scoped(c).write(c.req.query('path') ?? '', text, { ifMatch, ifNoneMatch })
    return c.json(written(c, r), created ? 201 : 200)
  })

  // Edits by operation: atomic on the current text, even with the note open.
  // `ifMatch` (or If-Match): only over that text; an agent must give it for
  // substitutions, so it never overwrites what it didn't read. `dryRun`: what it would change, without writing.
  // An edit that hides the note from the agent making it answers `nowHidden`.
  app.post('/api/note/edit', async (c) => {
    const { path, ops, ifMatch, dryRun } = await jsonBody<{ path: string; ops: EditOp[]; ifMatch?: string; dryRun?: boolean }>(c)
    const r = await scoped(c).editOps(path, ops, { ifMatch: unquote(ifMatch ?? c.req.header('if-match')), dryRun: dryRun === true })
    return c.json('dryRun' in r ? r : written(c, r))
  })

  app.delete('/api/note', async (c) => {
    const entry = await scoped(c).delete(c.req.query('path') ?? '', { ifMatch: unquote(c.req.header('if-match')) })
    return c.json(entry)
  })

  // An agent's move is always answered with its report (no jobs for keys).
  // One that opens the note to anyone who can't see it now needs
  // `confirmAudience: true` (the person agreed), or it's 409 `audience_widens` with
  // the change; `dryRun` says it beforehand.
  app.post('/api/note/move', async (c) => {
    const { from, to, dryRun, background, confirmAudience } = await jsonBody<{ from: string; to: string; dryRun?: boolean; background?: boolean; confirmAudience?: boolean }>(c)
    const s = scoped(c)
    const opts = { ifMatch: unquote(c.req.header('if-match')), confirmAudience: confirmAudience === true }
    if (!background || dryRun || s.access.isAgent) return c.json(written(c, await s.move(from, to, { ...opts, dryRun })))
    const r = await jobs.start(c.get('user').username, 'note', from, to, (hooks) => s.move(from, to, { ...opts, ...hooks }), moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  app.get('/api/note/links', (c) => c.json(scoped(c).links(c.req.query('path') ?? '')))

  // Fixes where one ambiguous link leads: that occurrence (`raw`,
  // nearest to `at`) is rewritten to the shortest form that reaches `target`,
  // in a note the person can write, to a candidate they can see.
  app.post('/api/note/link/pin', async (c) => {
    const { path, raw, at, target } = await jsonBody<{ path: string; raw: string; at?: number; target: string }>(c)
    if (typeof raw !== 'string' || typeof target !== 'string' || (at !== undefined && typeof at !== 'number')) return fail(c, 400, 'invalid', 'expected path, raw, target and an optional numeric at')
    const r = await scoped(c).pinLink(path, { raw, at }, target)
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Updates the links after notes moved outside vihko, as a move
  // would, for the moves the person may make; with `dryRun`, only what it
  // would do. With `background`, as a move job. The report names only what
  // they can see.
  app.post('/api/external-moves/:id/relink', async (c) => {
    const { dryRun, background } = await jsonBody<{ dryRun?: boolean; background?: boolean }>(c).catch(() => ({}) as { dryRun?: boolean; background?: boolean })
    const s = scoped(c)
    const id = c.req.param('id')
    if (dryRun || !background) return c.json(await s.relinkExternal(id, { dryRun: dryRun === true }))
    const group = s.externalMoves().find((g) => g.id === id)
    if (!group) return fail(c, 404, 'not_found', 'no such external move')
    const first = group.moves[0]!
    const r = await jobs.start(c.get('user').username, 'relink', first.from, first.to, (hooks: MoveHooks) => s.relinkExternal(id, hooks), moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  // Images being received (an upload's body, a copy downloading) are held in
  // memory whole: only a few at a time, per person and in all, counted with
  // the MCP server's (imageSlots.ts). Beyond that, 429 with Retry-After;
  // nothing is read.
  const imageSlot = async (c: Context<Env>, next: () => Promise<void>) => {
    const release = services.imageSlots.take(c.get('user').id)
    if (!release) {
      c.header('Retry-After', '1')
      return fail(c, 429, 'busy', 'too many images are being received at once: try again in a moment')
    }
    try {
      await next()
    } finally {
      release()
    }
  }

  // `src` is the image's path relative to the note (the editor escapes it);
  // `markdown` is the link ready to write into the note, with what would break
  // a Markdown destination (a space, say) escaped: a script appends it as is.
  const withMarkdown = (r: { path: string; src: string }) => ({ ...r, markdown: imageMarkdown(r.src) })

  // Images. Upload and paste are the same: the raw bytes of the file
  // in the body. It is stored next to the note and the editor links it.
  app.post('/api/attachments', imageSlot,
    bodyLimit({ maxSize: notes.maxImageBytes, onError: (c) => fail(c, 413, 'too_large', `the limit is ${notes.maxImageBytes} bytes`) }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(withMarkdown(await scoped(c).attach(c.req.query('note') ?? '', bytes)), 201)
    })

  // A copy of an image from a URL, stored like an upload. Only on this explicit
  // request from a user: the server never fetches URLs written in notes.
  // Nothing is downloaded for a note that doesn't exist or they can't write.
  // Members only from public addresses, unless the admin lets them reach the
  // local network (so a member can't probe it); the vihko admin, from anywhere.
  app.post('/api/attachments/fetch', imageSlot, async (c) => {
    const { note, url } = await jsonBody<{ note: string; url: string }>(c)
    const publicOnly = c.get('user').role !== 'admin' && !adminSettings.view().membersLocalDownloads
    const r = await scoped(c).attachFromUrl(note ?? '', async () => (await fetchImage(String(url ?? ''), { maxBytes: notes.maxImageBytes, publicOnly, testing: deps.imageFetchTesting })).bytes)
    return c.json(withMarkdown(r), 201)
  })

  // A file in the notes folder that isn't a note (images and other attachments).
  // Same path rules as notes: relative, inside the root, no hidden or ignored
  // segments, and only a path vihko follows (fsutil.ts followable).
  app.get('/api/file', (c) => {
    // Or as a note names it (`note` and `name`: `![[photo.png]]`, `[[invoice.pdf]]`), by name in its space.
    const note = c.req.query('note')
    const named = note !== undefined
    const path = named ? scoped(c).resolveFile(note, c.req.query('name') ?? '') : c.req.query('path') ?? ''
    const norm = posix.normalize(path)
    if (!path || norm !== path || path.startsWith('/') || norm.split('/').includes('..')) return fail(c, 400, 'invalid_path', `invalid file path: ${path}`)
    // vihko.yaml isn't content: once it holds permissions (M4), it's not for every reader.
    if (classifyPath(norm) !== 'other' || norm === WORKSPACE_FILE) return fail(c, 404, 'not_found', `not a servable file: ${path}`)
    // Through a symbolic link, or spelled otherwise than on the disk (a case-insensitive filesystem): not there.
    if (!followable(deps.notesDir, norm)) return fail(c, 404, 'not_found', `does not exist: ${path}`)
    // An agent: only in its folders, and only a file a note it can read uses (one named by a note it reads: resolveFile checked).
    if (!named) scoped(c).assertFile(norm)
    const file = join(deps.notesDir, norm)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
    } catch {
      return fail(c, 404, 'not_found', `does not exist: ${path}`)
    }
    if (!st.isFile()) return fail(c, 404, 'not_found', `not a file: ${path}`)
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const ext = norm.slice(norm.lastIndexOf('.') + 1).toLowerCase()
    const type = SERVED_TYPES[ext] ?? 'application/octet-stream'
    c.header('ETag', etag)
    // Always revalidated: an image replaced in the folder shows up at once, and an unchanged one costs a 304.
    c.header('Cache-Control', 'private, no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', FILE_CSP)
    // Shown in the browser: images (in a page; opened alone, an SVG, which can hold scripts, is downloaded) and PDFs; the rest is downloaded.
    const inline = (type.startsWith('image/') && type !== 'image/svg+xml') || type === 'application/pdf'
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(posix.basename(norm))}`)
    // A PDF can't be shown in a sandboxed document (Chromium's viewer refuses it): no sandbox for it, and nothing else allowed.
    if (type === 'application/pdf') c.header('Content-Security-Policy', PDF_CSP)
    if (c.req.header('if-none-match')?.split(',').map((t) => t.trim()).includes(etag)) return c.body(null, 304)
    c.header('Content-Type', type)
    return c.body(readFileSync(file))
  })

  // Full text plus `tag:` and `path:` filters (http/search.ts).
  app.get('/api/search', (c) => {
    const results = scoped(c).search(c.req.query('q') ?? '')
    return c.json({ results, highlight: { start: HIGHLIGHT_START, end: HIGHLIGHT_END } })
  })

  // The trash: each person sees what was deleted where they'd have `edit`
  // now, and restores with `edit` where it goes.
  app.get('/api/trash', (c) => c.json({ entries: scoped(c).trash() }))
  app.post('/api/trash/:id/restore', async (c) => {
    const { to } = await jsonBody<{ to?: string }>(c).catch(() => ({ to: undefined }))
    return c.json(await scoped(c).restoreTrash(c.req.param('id'), to))
  })

  // Workspace alerts: codes with their data, never text. Admin actions are
  // only offered to those who can perform them; the endpoint enforces it again.
  // A note's alert goes to whoever can read the note, with only what they can
  // see; the system's (the scan, git, sign-ins, vihko.yaml and its
  // permissions), to the admin, without paths of notes they can't read: the admin manages, but doesn't read.
  const nameOf = (id: string) => auth.username(id) ?? id
  app.get('/api/alerts', (c) => {
    const access = c.get('access')
    const admin = !access.isAgent && c.get('user').role === 'admin'
    const s = scoped(c)
    const alerts: Alert[] = []
    const scan = deps.runtime.lastScan
    if (admin && scan?.aborted === 'mass_delete' && scan.massDelete) {
      alerts.push({ code: 'scan_aborted_mass_delete', ...scan.massDelete, actions: ['rescan', 'confirm_removal'] })
    } else if (scan?.aborted === 'root_unavailable') {
      alerts.push({ code: 'scan_aborted_root_unavailable', actions: admin ? ['rescan'] : [] })
    }
    // Notes vihko can't read on the disk: the admin fixes them there. A path they don't read, only by its space.
    const unreadableNotes = admin ? deps.indexer.unreadableNotes() : []
    if (unreadableNotes.length) {
      const paths = unreadableNotes.filter((p) => access.canRead(p))
      const elsewhere = [...new Set(unreadableNotes.filter((p) => !access.canRead(p)).map((p) => spaceRootOf(p) ?? p.split('/')[0]!))].sort()
      alerts.push({ code: 'unreadable_notes', paths, elsewhere, actions: [] })
    }
    // Notes over vihko.yaml's `notes.maxSize`: shown as plain text, never indexed nor edited live. The same naming.
    const tooLarge = admin ? deps.indexer.tooLargeNotes() : []
    if (tooLarge.length) {
      const paths = tooLarge.filter((p) => access.canRead(p))
      const elsewhere = [...new Set(tooLarge.filter((p) => !access.canRead(p)).map((p) => spaceRootOf(p) ?? p.split('/')[0]!))].sort()
      alerts.push({ code: 'notes_too_large', paths, elsewhere, limitMb: workspace.config.notes.maxSize, actions: [] })
    }
    for (const path of deps.orphans?.orphans() ?? []) {
      if (access.canRead(path)) alerts.push({ code: 'orphaned_note', path, actions: access.canWrite(path) ? ['keep_copy', 'discard_copy'] : [] })
    }
    // Notes vihko can't save (a full disk, a folder it may not write to): to the admins, who can fix the
    // volume. The note's path only to one who reads it; its space to all of them.
    if (admin) {
      for (const u of deps.orphans?.unsaved?.() ?? []) {
        alerts.push({ code: 'note_not_saved', path: access.canRead(u.path) ? u.path : null, space: spaceRootOf(u.path), reason: u.reason, volume: u.volume, actions: [] })
      }
    }
    for (const m of s.externalMoves()) {
      const mine = m.moves.some((x) => access.canWrite(x.to) && access.canWrite(x.from))
      alerts.push({ code: 'external_move', ...m, actions: mine ? ['update_links'] : [] })
    }
    for (const u of deps.indexer.uidConflicts()) {
      const paths = u.paths.filter((p) => access.canRead(p))
      // Only where they see two of them: one alone would say that a note they can't read has its uid.
      if (paths.length >= 2) alerts.push({ code: 'uid_conflict', uid: u.uid, paths, actions: [] })
    }
    const noteExists = index.prepare('select 1 from notes where path = ?')
    const ws = workspace.status
    if (admin) {
      if (ws.errors.length) alerts.push({ code: 'config_invalid', file: WORKSPACE_FILE, errors: ws.errors, fallback: ws.fallback, actions: [] })
      // vihko rewrote the file at start, or couldn't.
      for (const a of deps.configMigrations?.alerts() ?? []) alerts.push(a)
      // state.db migrated by this version, and where its copy is.
      for (const a of stateMigrationAlerts(auth.state)) alerts.push(a)
      // What the file leaves out, the grants that name nobody, and paths of the
      // configuration outside the spaces. A key inside a space the admin doesn't
      // read is never named to them.
      const warnings = [...ws.warnings, ...permissions.unknownSubjects(), ...outsideSpaces(workspace.config)].map((w) => redactPermissionsWarning(w, access))
      if (warnings.length) alerts.push({ code: 'config_warnings', file: WORKSPACE_FILE, warnings, actions: [] })
      if (workspace.permissionsFallback) alerts.push({ code: 'permissions_rejected', fallback: workspace.permissionsFallback, actions: [] })
      // The section gone from the file: nothing is shared, and the last one that shared something can be put back.
      const kept = workspace.permissionsMissing ? workspace.lastPermissions() : null
      if (kept !== null) alerts.push({ code: 'permissions_missing', file: WORKSPACE_FILE, folders: keptRules(kept).size, actions: ['restore_permissions', 'dismiss'] })
      for (const sr of workspace.config.daily) {
        if (sr.template && !noteExists.get(sr.template)) alerts.push({ code: 'config_template_missing', series: sr.id, template: sr.template, actions: [] })
      }
      for (const a of spaceAlerts({ notesDir: deps.notesDir, engine: permissions, state: auth.state, username: c.get('user').username })) alerts.push(a)
    }
    // Grants for folders that don't exist: to whoever manages the space they're in, never the admin as such.
    if (!access.isAgent) {
      const folders = rulesWithoutFolder(permissions, index).filter((f) => { const root = spaceRootOf(f); return root !== null && access.canManage(root) })
      if (folders.length) alerts.push({ code: 'missing_folder', folders, actions: [] })
    }
    if (!access.isAgent) for (const a of deps.holds?.alerts((p) => noteExists.get(p) !== undefined, { level: (f) => access.level(f) }) ?? []) alerts.push(a)
    for (const { path } of index.prepare("select path from alerts where kind = 'sync_conflict' order by path").all() as { path: string }[]) {
      if (!access.canRead(path)) continue
      const note = conflictOriginal(path)
      alerts.push({ code: 'sync_conflict', path, note: noteExists.get(note) && access.canRead(note) ? note : null, actions: [] })
    }
    for (const a of deps.history?.alerts() ?? []) {
      // Files over the history's limit: those the person can read; the rest of the history's, the admin's.
      if (a.code === 'history_files_too_large') {
        const paths = a.paths.filter((p) => access.canRead(p))
        if (paths.length) alerts.push({ ...a, paths })
      } else if (a.code === 'history_purged') {
        // What was purged, named only to an admin who can read where it was, or who purged it (they wrote it).
        const named = a.path !== null && (access.level(a.path) !== null || deps.history?.purgedBy(a.id) === c.get('user').id)
        if (admin) alerts.push(named ? a : { ...a, path: null })
      } else if (admin) alerts.push(a)
    }
    // Agents writing with no version of their own to undo them by.
    const mode = workspace.config.history.mode
    const api = integrations.apiEnabled()
    const mcp = integrations.mcpEnabled()
    if ((api || mcp) && mode !== 'managed') alerts.push({ code: 'integrations_unversioned', mode, api, mcp, actions: [] })
    // Someone may be guessing passwords: only for admins, who can do something about it.
    const guessing = admin ? limiter.summary() : null
    if (guessing) alerts.push({ code: 'login_attempts_blocked', ...guessing, actions: [] })
    // Second factors that can't be read with the VIHKO_SECRET_KEY in force (twoFactor.ts).
    const unreadable = admin ? twoFactor.unreadable() : []
    if (unreadable.length) alerts.push({ code: 'two_factor_unreadable', users: unreadable.map(nameOf).sort(), actions: [] })
    // Notices addressed to this person (notices.ts), last: what others did to their account or their writing.
    if (!access.isAgent) for (const n of notices.of(c.get('user').id)) alerts.push(noticeAlert(n, access, nameOf, (root) => permissions.spaceName(root), (id) => spaces.mayRestoreId(c.get('user'), id)))
    // Note settings written by hand with something wrong (noteSettings.ts): to whom they belong, the person or a space's managers.
    if (!access.isAgent) {
      const me = c.get('user')
      const own = noteSettings.read(personalRoot(me.username))
      if (own.errors.length) alerts.push({ code: 'settings_invalid', space: null, file: noteSettingsPath(own.root), errors: own.errors, actions: [] })
      const ownGuide = guideMissing(own)
      if (ownGuide !== null) alerts.push({ code: 'settings_guide_missing', space: null, note: ownGuide, actions: [] })
      for (const s of permissions.spacesFor(me).spaces) {
        if (!access.canManage(s.path)) continue
        const r = noteSettings.read(s.path)
        // (A space's guide is text in its settings, never a note: nothing to be missing.)
        if (r.errors.length) alerts.push({ code: 'settings_invalid', space: { path: s.path, name: s.name }, file: noteSettingsPath(r.root), errors: r.errors, actions: [] })
      }
    }
    return c.json({ alerts })
  })

  // Text of a conflict copy, to compare it with the note. Only for those the
  // indexer has detected, in a folder the person can read: this can't be
  // used to read an arbitrary file.
  app.get('/api/conflict', (c) => c.json(scoped(c).conflict(c.req.query('path') ?? '')))

  // Note deleted from outside with an open copy: keep it or treat it as
  // deleted (`edit` where it was).
  app.post('/api/note/orphan', async (c) => {
    const { path, action } = await jsonBody<{ path: string; action: 'restore' | 'discard' }>(c)
    if (action !== 'restore' && action !== 'discard') return fail(c, 400, 'invalid', 'action must be restore or discard')
    return c.json(await scoped(c).orphan(path, action))
  })

  // `confirmRemoval`: the number of notes the alert said would be removed.
  // The mass deletion is only accepted if that number still matches (Indexer.scan).
  app.post('/api/admin/rescan', adminOnly, async (c) => {
    const body = await jsonBody<{ force?: boolean; confirmRemoval?: number }>(c).catch(() => ({}) as { force?: boolean; confirmRemoval?: number })
    const confirmRemoval = Number.isInteger(body.confirmRemoval) ? body.confirmRemoval : undefined
    const r = deps.runtime.rescan({ force: body.force === true, confirmRemoval })
    // Numbers, never paths: what changed may be in anyone's space, which the admin doesn't read.
    return c.json({ added: r.added.length, changed: r.changed.length, removed: r.removed.length, moved: r.moved.length, unchanged: r.unchanged, aborted: r.aborted, massDelete: r.massDelete })
  })

  // The alert of a rewrite of vihko.yaml at start, dismissed (for every admin).
  app.delete('/api/admin/config-migrations/:id', adminOnly, (c) => {
    if (!deps.configMigrations?.dismiss(c.req.param('id') ?? '')) return fail(c, 404, 'not_found', 'no such alert')
    return c.json({ ok: true })
  })

  // The permissions gone from vihko.yaml: the last ones that shared something,
  // written back (each folder's rule, the rest of the file as it is), as any
  // change to them is; confirmed at the moment, as it gives access to people.
  // Or the alert dismissed: they're forgotten.
  app.post('/api/admin/permissions/restore', adminOnly, async (c) => {
    const { confirm } = await jsonBody<{ confirm?: unknown }>(c).catch(() => ({ confirm: undefined }))
    const kept = workspace.permissionsMissing ? workspace.lastPermissions() : null
    if (kept === null) return fail(c, 404, 'not_found', 'no permissions to restore')
    const refused = await tf.confirmIdentity(c, confirm)
    if (refused) return refused
    await permissionsFile.update((t) => {
      let out = t
      for (const [folder, value] of keptRules(kept)) out = setRule(out, folder, value)
      return out
    }, { actor: c.get('access').actor })
    log(`${WORKSPACE_FILE}: the last permissions were restored by ${c.get('user').username}`)
    return c.json({ ok: true, folders: keptRules(kept).size })
  })

  app.delete('/api/admin/permissions/restore', adminOnly, (c) => {
    if (!workspace.permissionsMissing) return fail(c, 404, 'not_found', 'no such alert')
    workspace.forgetLastPermissions()
    // Kept as the file says now: the grants it no longer has are gone.
    grantStarts.sync(permissions.spaceRules().rules)
    return c.json({ ok: true })
  })

  // The alert of a migration of state.db at start, dismissed (for every admin).
  app.delete('/api/admin/state-migrations/:id', adminOnly, (c) => {
    if (!dismissStateMigration(auth.state, c.req.param('id') ?? '')) return fail(c, 404, 'not_found', 'no such alert')
    return c.json({ ok: true })
  })

  // Users, groups, one's own account and the admin's settings (http/users.ts).
  userRoutes(app, userDeps)
  // One's own second factor, and the admin's reset of someone's.
  tf.routes(app)

  if (deps.history) historyRoutes(app, { history: deps.history, notes, auth, keyName: (id) => keys.nameOf(id), notices, confirm: tf.confirmIdentity })

  // Creating a key, and approving an OAuth client, confirm who is there: a session left open isn't enough.
  keyRoutes(app, {
    keys, integrations, publicUrl: oauth.publicUrl, confirm: tf.confirmIdentity,
    onKeyAdded: (userId, name) => { notices.add(userId, { code: 'account_key_added', kind: 'key', name }) },
  })

  permissionRoutes(app, { engine: permissions, file: permissionsFile, index, keys, policy, holds: deps.holds })

  // Spaces: what each person reaches, shared spaces, leaving, pins, and the admin's (http/spaces.ts).
  spaceRoutes(app, { spaces, confirm: tf.confirmIdentity })

  // OAuth for the MCP server: its addresses for clients, and the consent page's (session).
  oauthRoutes(app, {
    oauth, integrations, ui: deps.webDir !== undefined, clientAddress: ipOf, confirm: tf.confirmIdentity,
    onAppAuthorized: (userId, name) => { notices.add(userId, { code: 'account_key_added', kind: 'app', name }) },
  })

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'does not exist'))

  // More routes outside /api (the MCP server), before the UI takes every other path.
  deps.routes?.(app, services)

  if (deps.webDir) {
    const root = deps.webDir
    app.use('*', async (c, next) => {
      await next()
      for (const [k, v] of Object.entries(uiHeaders(externalImages))) c.header(k, v)
      // index.html uncached, so an update shows up on reload.
      if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache')
    })
    // Assets carry a hash in their name: they can be cached forever.
    app.use('/assets/*', async (c, next) => {
      await next()
      if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
    })
    app.get('*', serveStatic({ root }))
    // Any other route belongs to the app (SPA): index.html.
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  return { app, services }
}

/**
 * Paths of vihko.yaml outside `people/` and `spaces/`,
 * where nobody reads or writes: a series' folder, the agents' guide. Ignored, and told to the admin (`outside_spaces`). `{user}`
 * stands for any person.
 */
export function outsideSpaces(w: WorkspaceConfig): ConfigError[] {
  const out: ConfigError[] = []
  const outside = (p: string) => parseSpacePath(p.replaceAll('{user}', 'user')) === null
  for (const s of w.daily) {
    const sample = seriesPath(s, { year: 2026, month: 9, day: 30 }, 'user')
    if (parseSpacePath(sample) === null) out.push({ code: 'outside_spaces', at: `daily.${s.id}.folder`, line: null, detail: s.folder })
  }
  if (w.mcp.instructions !== null && outside(w.mcp.instructions)) out.push({ code: 'outside_spaces', at: 'mcp.instructions', line: null, detail: w.mcp.instructions })
  return out
}

/** The socket's address under @hono/node-server; undefined for a request made in-process. */
function socketAddress(c: Context): string | undefined {
  const env = c.env as { server?: Bindings; incoming?: Bindings['incoming'] } | undefined
  return (env?.server?.incoming ?? env?.incoming)?.socket?.remoteAddress
}
type Bindings = { incoming?: { socket?: { remoteAddress?: string } } }

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}
