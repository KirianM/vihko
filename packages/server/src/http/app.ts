// HTTP API. Used by the UI with a session (cookie), always active. Agents
// reach the routes listed in http/routes.ts with a key (`Authorization:
// Bearer`), only while the API switch is on; everything goes through the
// access filter (access.ts, scoped.ts), for the UI and for agents alike.
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { WORKSPACE_FILE, classifyPath, conflictOriginal, type Alert, type ErrorCode } from '@thoth/core'
import { AuthError, type Auth, type User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { Indexer, ScanOptions, ScanReport } from '../indexer.ts'
import { NoteError, type MoveHooks, type NoteService } from '../notes.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'
import type { EditOp } from '../edits.ts'
import { FetchImageError, SERVED_TYPES, fetchImage } from '../attachments.ts'
import { DailyNotes } from '../daily.ts'
import { ProfileError, type Profile, type Profiles } from '../profiles.ts'
import type { Workspace } from '../workspace.ts'
import { MoveJobs } from './jobs.ts'
import type { ExternalMoves } from '../externalMoves.ts'
import { HistoryError, type History } from '../history/index.ts'
import { GitError } from '../history/git.ts'
import { historyErrorStatus, historyRoutes } from './history.ts'
import { AccessError, AccessPolicy, type Access } from '../access.ts'
import { ApiKeys, KeyError } from '../keys.ts'
import { Integrations, IntegrationsError } from '../integrations.ts'
import { RequestError, ScopedNotes, type ScopedDeps } from '../scoped.ts'
import { keyErrorStatus, keyRoutes } from './keys.ts'
import { authenticateKey, bearerToken } from './keyAuth.ts'
import { keyRouteClass } from './routes.ts'

export const SESSION_COOKIE = 'thoth_session'

export interface Runtime {
  lastScan: ScanReport | null
  rescan(opts: ScanOptions): ScanReport
}

/** What the API needs from the collaboration hub. */
export interface Orphans {
  orphans(): string[]
  restoreOrphan(path: string): Promise<{ etag: string }>
  discardOrphan(path: string): Promise<void>
}

export interface AppDeps {
  orphans?: Orphans
  auth: Auth
  /** Each person's timezone and preferences (state.db). */
  profiles: Profiles
  /** thoth.yaml, as currently in force. */
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
   * browser (`allow`, the default) or blocked for the whole installation (D-028).
   */
  externalImages?: ExternalImages
  /** The clock (tests). */
  now?: () => Date
  /**
   * How long a move asked for with `background` may take before the request
   * answers with a job instead of the report (1 s by default).
   */
  moveWaitMs?: number
  /** Notes moved outside thoth, pending a link update (D-031.4). */
  externalMoves?: ExternalMoves
  /** Note history (M2). Without it, the history API doesn't exist. */
  history?: History
  /**
   * Whether a user can read a path now, for the history (tests of its
   * filter); on top of the access filter (access.ts). Everything, until M4.
   */
  canRead?: (user: User, path: string) => boolean
  /** Agent keys (state.db). By default, over the same state.db as `auth`. */
  keys?: ApiKeys
  /** The integration switches (state.db). By default, over the same state.db as `auth`, unlocked. */
  integrations?: Integrations
  /** More routes outside /api (the MCP server), mounted before the UI's catch-all. */
  routes?: (app: Hono<Env>, services: Services) => void
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
  scoped(access: Access): ScopedNotes
  history?: History
}

export type ExternalImages = 'allow' | 'block'

// The UI only talks to its own origin: no CDNs or third parties. The one
// exception is images linked in notes, unless the administrator blocks them.
function uiHeaders(external: ExternalImages) {
  const img = external === 'allow' ? "img-src 'self' data: blob: https: http:" : "img-src 'self' data: blob:"
  return {
    'Content-Security-Policy': `default-src 'self'; ${img}; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }
}

// Files from the notes folder are served inert: nothing in them runs, even
// an SVG opened on its own (sandboxed, no scripts).
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

/**
 * `user`: who the request acts for (a key's user, for an agent); `access`:
 * who is asking and what they may reach; `token`: the session (cookie only).
 */
export type ApiEnv = { Variables: { user: User; token: string; access: Access } }
type Env = ApiEnv

function noteErrorStatus(e: NoteError) {
  return ({ not_found: 404, exists: 409, precondition_failed: 412, invalid_path: 400, edit_mismatch: 409, too_large: 413, unsupported_type: 415, not_configured: 409, not_empty: 409 } as const)[e.code]
}

function fetchErrorStatus(e: FetchImageError) {
  return ({ invalid: 400, too_large: 413, unsupported_type: 415, fetch_failed: 502 } as const)[e.code]
}

/**
 * Error response: `error` is the stable code the UI translates; `message`
 * is a hint for developers, which the UI never shows.
 */
function fail(c: Context, status: ContentfulStatusCode, error: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, ...extra }, status)
}

/** The API alone (see `createServer` for the services under it). */
export function createApp(deps: AppDeps) {
  return createServer(deps).app
}

/** The API and the services under it (keys, switches, access, scoped operations). */
export function createServer(deps: AppDeps): { app: Hono<Env>; services: Services } {
  const { auth, notes, index, profiles, workspace } = deps
  const externalImages = deps.externalImages ?? 'allow'
  const now = deps.now ?? (() => new Date())
  const daily = new DailyNotes({ workspace, profiles, notes, now })
  const jobs = new MoveJobs()
  const moveWaitMs = deps.moveWaitMs ?? 1000
  const keys = deps.keys ?? new ApiKeys(auth.state)
  const integrations = deps.integrations ?? new Integrations(auth.state)
  const policy = new AccessPolicy({ index })
  const scopedDeps: ScopedDeps = { notes, index, notesDir: deps.notesDir, daily, profiles, attachments: () => workspace.config.attachments, now }
  const services: Services = { keys, integrations, policy, scoped: (access) => new ScopedNotes(scopedDeps, access), history: deps.history }
  const app = new Hono<Env>()
  /** The request's operations, as whoever is asking. */
  const scoped = (c: Context<Env>) => services.scoped(c.get('access'))

  app.onError((err, c) => {
    if (err instanceof NoteError) {
      if (err.etag) c.header('ETag', `"${err.etag}"`)
      return fail(c, noteErrorStatus(err), err.code, err.message, { etag: err.etag })
    }
    if (err instanceof RequestError) return fail(c, err.status, err.code, err.message)
    if (err instanceof AccessError) return fail(c, 403, 'forbidden', err.message)
    if (err instanceof FetchImageError) return fail(c, fetchErrorStatus(err), err.code, err.message)
    if (err instanceof ProfileError) return fail(c, 400, err.code, err.message)
    if (err instanceof HistoryError) return fail(c, historyErrorStatus(err), err.code, err.message)
    if (err instanceof GitError) return fail(c, 503, 'history_unavailable', err.message)
    if (err instanceof AuthError) return fail(c, err.code === 'user_exists' || err.code === 'already_setup' ? 409 : 400, err.code, err.message)
    if (err instanceof KeyError) return fail(c, keyErrorStatus(err), err.code, err.message)
    if (err instanceof IntegrationsError) return fail(c, err.code === 'integrations_locked' ? 409 : 400, err.code, err.message)
    // Body that isn't JSON.
    if (err instanceof SyntaxError) return fail(c, 400, 'invalid', err.message)
    console.error(err)
    return fail(c, 500, 'internal', 'internal error')
  })

  // --- A key (`Authorization: Bearer`) ----------------------------------------
  // Judged by the key alone, never the cookie. Only the routes http/routes.ts
  // opens to keys; any other, or any with the API off, is 404 as if it didn't
  // exist (before anything else, the CSRF check included: off, there's
  // nothing there). A read-only key gets 403 on a write route.
  app.use('/api/*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === null) return next()
    if (!integrations.apiEnabled()) return fail(c, 404, 'not_found', 'does not exist')
    const route = keyRouteClass(c.req.method, c.req.path)
    if (!route) return fail(c, 404, 'not_found', 'does not exist')
    const r = authenticateKey({ keys, integrations }, token, 'api')
    if (!r.ok) return fail(c, r.status, r.error, r.status === 401 ? 'invalid key' : 'does not exist')
    if (route === 'write' && !r.principal.key.canWrite) return fail(c, 403, 'forbidden', 'this key is read-only')
    c.set('user', r.principal.user)
    c.set('access', policy.for(r.principal))
    await next()
  })

  // CSRF: a request that modifies something and comes from another origin is rejected.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).host !== new URL(c.req.url).host) return fail(c, 403, 'forbidden', 'origin not allowed')
    }
    await next()
  })

  // --- No session required: health, first boot and login --------------------

  // For Docker's healthcheck. Reveals nothing beyond the process responding.
  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/setup', (c) => c.json({ needed: auth.userCount() === 0 }))

  app.post('/api/setup', async (c) => {
    const { token, username, password } = await c.req.json<{ token: string; username: string; password: string }>()
    const user = await auth.setup(token, username, password)
    return c.json({ user })
  })

  app.post('/api/auth/login', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>()
    const s = await auth.login(username ?? '', password ?? '')
    if (!s) return fail(c, 401, 'invalid_credentials', 'incorrect username or password')
    setCookie(c, SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: isHttps(c),
      expires: s.expiresAt,
    })
    return c.json({ user: s.user })
  })

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

  /** Who writes: the user, or an agent on their behalf. */
  const actor = (c: Context<Env>) => c.get('access').actor

  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('access').isAgent || c.get('user').role !== 'admin') return fail(c, 403, 'forbidden', 'admins only')
    await next()
  }

  app.post('/api/auth/logout', (c) => {
    auth.logout(c.get('token'))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }))

  // What the UI needs to know about this installation's settings.
  app.get('/api/config', (c) => c.json({ externalImages, maxImageBytes: notes.maxImageBytes }))

  // Notes and folders: a folder with no notes (just created, or emptied) still shows.
  app.get('/api/tree', (c) => c.json(scoped(c).tree()))

  // Tags in use, most used first (D-019: case-insensitive, nested with `/`).
  // `count`: the notes that carry the tag (inline or in the frontmatter);
  // `total`: those that carry it or any tag nested under it (the tags view).
  app.get('/api/tags', (c) => c.json({ tags: scoped(c).tags() }))

  // A note's headings, in order (link anchors: `[[Note#Heading]]`).
  app.get('/api/note/headings', (c) => c.json({ headings: scoped(c).headings(c.req.query('path') ?? '') }))

  // A note's comment threads as the index first saw them (D-031.6): the text
  // each one was anchored to, and whether the note's text there has changed
  // since. Only threads the index knows (the note as last saved); the editor
  // compares the same originals with what is being typed.
  app.get('/api/note/comments', (c) => c.json({ threads: scoped(c).comments(c.req.query('path') ?? '') }))

  // Folders only exist on disk: these create, move (with every note in them,
  // links kept as in a note move) and delete them (only when empty).
  app.post('/api/folder', async (c) => {
    const { path } = await c.req.json<{ path: string }>()
    return c.json(notes.createFolder(path, actor(c)), 201)
  })

  app.delete('/api/folder', (c) => c.json(notes.deleteFolder(c.req.query('path') ?? '', actor(c))))

  // With `background`, a move that takes long answers 202 with a job as soon
  // as the folder (or note) is in place; GET /api/move-jobs/:id follows it.
  app.post('/api/folder/move', async (c) => {
    const { from, to, dryRun, background } = await c.req.json<{ from: string; to: string; dryRun?: boolean; background?: boolean }>()
    const by = actor(c)
    if (!background || dryRun) return c.json(await notes.moveFolder(from, to, { actor: by, dryRun }))
    const r = await jobs.start(c.get('user').username, 'folder', from, to, (hooks) => notes.moveFolder(from, to, { actor: by, ...hooks }), moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  app.get('/api/move-jobs/:id', (c) => {
    const job = jobs.get(c.get('user').username, c.req.param('id'))
    return job ? c.json(job) : fail(c, 404, 'not_found', 'no such move job')
  })

  app.get('/api/note', (c) => {
    const r = scoped(c).read(c.req.query('path') ?? '')
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // A new note, with the given text or from a template note (its variables
  // filled in with the person's date and name, D-030). Never overwrites.
  app.post('/api/note', async (c) => {
    const { path, text, template, freshUid } = await c.req.json<{ path: string; text?: string; template?: string; freshUid?: boolean }>()
    if (template !== undefined && typeof template !== 'string') return fail(c, 400, 'invalid', 'template must be a note path')
    if (text !== undefined && typeof text !== 'string') return fail(c, 400, 'invalid', 'text must be text')
    const r = await scoped(c).create(path, { text, template, freshUid })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r, 201)
  })

  // The workspace settings the UI needs from thoth.yaml (reloaded when it changes).
  app.get('/api/workspace', (c) => {
    const w = workspace.config
    return c.json({ daily: w.daily, templates: w.templates, links: w.links })
  })

  app.get('/api/profile', (c) => c.json(profiles.get(c.get('user').id)))

  app.put('/api/profile', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    if (typeof body !== 'object' || body === null) return fail(c, 400, 'invalid', 'expected an object')
    const patch: Partial<Profile> = {}
    for (const k of ['timezone', 'dailySeries', 'openDailyOnStart'] as const) if (k in body) (patch as Record<string, unknown>)[k] = body[k]
    return c.json(profiles.update(c.get('user').id, patch))
  })

  // Today's note (D-030): GET says where it is and whether it exists, POST
  // opens or creates it. `series` picks one other than the person's own.
  app.get('/api/daily', (c) => c.json(scoped(c).dailyToday(c.req.query('series'))))

  app.post('/api/daily', async (c) => {
    const { series } = await c.req.json<{ series?: string }>().catch(() => ({ series: undefined }))
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
    const { text } = await c.req.json<{ text: string }>()
    if (typeof text !== 'string') return fail(c, 400, 'invalid', 'text must be text')
    const r = await scoped(c).write(c.req.query('path') ?? '', text, { ifMatch, ifNoneMatch })
    c.header('ETag', `"${r.etag}"`)
    return c.json({ etag: r.etag }, r.created ? 201 : 200)
  })

  // Edits by operation: atomic on the current text, even with the note open.
  // `ifMatch` (or If-Match): only over that text; an agent must give it for
  // substitutions (D-017). `dryRun`: what it would change, without writing.
  app.post('/api/note/edit', async (c) => {
    const { path, ops, ifMatch, dryRun } = await c.req.json<{ path: string; ops: EditOp[]; ifMatch?: string; dryRun?: boolean }>()
    const r = await scoped(c).editOps(path, ops, { ifMatch: unquote(ifMatch ?? c.req.header('if-match')), dryRun: dryRun === true })
    if (!('dryRun' in r)) c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  app.delete('/api/note', async (c) => {
    const entry = await scoped(c).delete(c.req.query('path') ?? '', { ifMatch: unquote(c.req.header('if-match')) })
    return c.json(entry)
  })

  // An agent's move is always answered with its report (no jobs for keys).
  app.post('/api/note/move', async (c) => {
    const { from, to, dryRun, background } = await c.req.json<{ from: string; to: string; dryRun?: boolean; background?: boolean }>()
    const s = scoped(c)
    const opts = { ifMatch: unquote(c.req.header('if-match')) }
    if (!background || dryRun || s.access.isAgent) return c.json(await s.move(from, to, { ...opts, dryRun }))
    const r = await jobs.start(c.get('user').username, 'note', from, to, (hooks) => s.move(from, to, { ...opts, ...hooks }), moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  app.get('/api/note/links', (c) => c.json(scoped(c).links(c.req.query('path') ?? '')))

  // Fixes where one ambiguous link leads (D-031.2): that occurrence (`raw`,
  // nearest to `at`) is rewritten to the shortest form that reaches `target`.
  app.post('/api/note/link/pin', async (c) => {
    const { path, raw, at, target } = await c.req.json<{ path: string; raw: string; at?: number; target: string }>()
    if (typeof raw !== 'string' || typeof target !== 'string' || (at !== undefined && typeof at !== 'number')) return fail(c, 400, 'invalid', 'expected path, raw, target and an optional numeric at')
    const r = await notes.pinLink(path, { raw, at }, target, { actor: actor(c) })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Updates the links after notes moved outside thoth (D-031.4), as a move
  // would; with `dryRun`, only what it would do. With `background`, as a move job.
  app.post('/api/external-moves/:id/relink', async (c) => {
    const group = deps.externalMoves?.get(c.req.param('id'))
    if (!group) return fail(c, 404, 'not_found', 'no such external move')
    const { dryRun, background } = await c.req.json<{ dryRun?: boolean; background?: boolean }>().catch(() => ({}) as { dryRun?: boolean; background?: boolean })
    const by = actor(c)
    if (dryRun) return c.json(await notes.relinkMoved(group.moves, { actor: by, dryRun: true }))
    // Done once every rewrite went through; with failures it stays, to try again.
    const run = async (hooks: MoveHooks) => {
      const report = await notes.relinkMoved(group.moves, { actor: by, ...hooks })
      if (report.failed.length === 0) deps.externalMoves?.drop(group.id)
      return report
    }
    if (!background) return c.json(await run({}))
    const first = group.moves[0]!
    const r = await jobs.start(c.get('user').username, 'relink', first.from, first.to, run, moveWaitMs)
    return 'job' in r ? c.json(r, 202) : c.json(r.report)
  })

  // Images (D-028). Upload and paste are the same: the raw bytes of the file
  // in the body. It is stored next to the note and the editor links it.
  app.post('/api/attachments',
    bodyLimit({ maxSize: notes.maxImageBytes, onError: (c) => fail(c, 413, 'too_large', `the limit is ${notes.maxImageBytes} bytes`) }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(await scoped(c).attach(c.req.query('note') ?? '', bytes), 201)
    })

  // A copy of an image from a URL, stored like an upload. Only on this explicit
  // request from a user: the server never fetches URLs written in notes.
  app.post('/api/attachments/fetch', async (c) => {
    const { note, url } = await c.req.json<{ note: string; url: string }>()
    notes.read(note ?? '') // nothing is downloaded for a note that doesn't exist
    const { bytes } = await fetchImage(String(url ?? ''), { maxBytes: notes.maxImageBytes })
    return c.json(await notes.attach(note, bytes, actor(c)), 201)
  })

  // A file in the notes folder that isn't a note (images and other attachments).
  // Same path rules as notes: relative, inside the root, no hidden or ignored
  // segments, and no symlink leading out of the folder.
  app.get('/api/file', (c) => {
    const path = c.req.query('path') ?? ''
    const norm = posix.normalize(path)
    if (!path || norm !== path || path.startsWith('/') || norm.split('/').includes('..')) return fail(c, 400, 'invalid_path', `invalid file path: ${path}`)
    // thoth.yaml isn't content: once it holds permissions (M4), it's not for every reader.
    if (classifyPath(norm) !== 'other' || norm === WORKSPACE_FILE) return fail(c, 404, 'not_found', `not a servable file: ${path}`)
    // An agent: only in its folders, and only a file a note it can read uses.
    scoped(c).assertFile(norm)
    let file: string
    let st: ReturnType<typeof statSync>
    try {
      const root = realpathSync(deps.notesDir)
      file = realpathSync(join(deps.notesDir, norm))
      if (!file.startsWith(root + sep)) return fail(c, 404, 'not_found', `outside the notes folder: ${path}`)
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
    if (!type.startsWith('image/')) c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(norm))}`)
    if (c.req.header('if-none-match')?.split(/\s*,\s*/).includes(etag)) return c.body(null, 304)
    c.header('Content-Type', type)
    return c.body(readFileSync(file))
  })

  // Full text plus `tag:` and `path:` filters (http/search.ts).
  app.get('/api/search', (c) => {
    const results = scoped(c).search(c.req.query('q') ?? '')
    return c.json({ results, highlight: { start: HIGHLIGHT_START, end: HIGHLIGHT_END } })
  })

  app.get('/api/trash', (c) => c.json({ entries: notes.trash() }))
  app.post('/api/trash/:id/restore', async (c) => {
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({ to: undefined }))
    return c.json(await notes.restore(c.req.param('id'), actor(c), to))
  })

  // Workspace alerts: codes with their data, never text. Admin actions are
  // only offered to those who can perform them; the endpoint enforces it again.
  app.get('/api/alerts', (c) => {
    const admin = c.get('user').role === 'admin'
    const alerts: Alert[] = []
    const scan = deps.runtime.lastScan
    if (scan?.aborted === 'mass_delete' && scan.massDelete) {
      alerts.push({ code: 'scan_aborted_mass_delete', ...scan.massDelete, actions: admin ? ['rescan', 'confirm_removal'] : [] })
    } else if (scan?.aborted === 'root_unavailable') {
      alerts.push({ code: 'scan_aborted_root_unavailable', actions: admin ? ['rescan'] : [] })
    }
    for (const path of deps.orphans?.orphans() ?? []) alerts.push({ code: 'orphaned_note', path, actions: ['keep_copy', 'discard_copy'] })
    for (const m of deps.externalMoves?.pending() ?? []) alerts.push({ code: 'external_move', ...m, actions: ['update_links'] })
    for (const u of deps.indexer.uidConflicts()) alerts.push({ code: 'uid_conflict', uid: u.uid, paths: u.paths, actions: [] })
    const noteExists = index.prepare('select 1 from notes where path = ?')
    const ws = workspace.status
    if (ws.errors.length) alerts.push({ code: 'config_invalid', file: WORKSPACE_FILE, errors: ws.errors, fallback: ws.fallback, actions: [] })
    if (ws.warnings.length) alerts.push({ code: 'config_warnings', file: WORKSPACE_FILE, warnings: ws.warnings, actions: [] })
    for (const s of workspace.config.daily) {
      if (s.template && !noteExists.get(s.template)) alerts.push({ code: 'config_template_missing', series: s.id, template: s.template, actions: [] })
    }
    for (const { path } of index.prepare("select path from alerts where kind = 'sync_conflict' order by path").all() as { path: string }[]) {
      const note = conflictOriginal(path)
      alerts.push({ code: 'sync_conflict', path, note: noteExists.get(note) ? note : null, actions: [] })
    }
    alerts.push(...(deps.history?.alerts() ?? []))
    // Agents writing with no version of their own to undo them by (D-034 3.8).
    const mode = workspace.config.history.mode
    const api = integrations.apiEnabled()
    const mcp = integrations.mcpEnabled()
    if ((api || mcp) && mode !== 'managed') alerts.push({ code: 'integrations_unversioned', mode, api, mcp, actions: [] })
    return c.json({ alerts })
  })

  // Text of a conflict copy, to compare it with the note. Only for those the
  // indexer has detected: this can't be used to read an arbitrary file.
  app.get('/api/conflict', (c) => {
    const path = c.req.query('path') ?? ''
    const known = classifyPath(path) === 'conflict' && index.prepare("select 1 from alerts where path = ? and kind = 'sync_conflict'").get(path)
    let text: string | null = null
    if (known) try { text = readFileSync(join(deps.notesDir, path), 'utf8') } catch { /* no longer exists */ }
    if (text === null) return fail(c, 404, 'not_found', `there's no conflict copy at ${path}`)
    return c.json({ path, text })
  })

  // Note deleted from outside with an open copy: keep it or treat it as deleted.
  app.post('/api/note/orphan', async (c) => {
    const { path, action } = await c.req.json<{ path: string; action: 'restore' | 'discard' }>()
    if (!deps.orphans) return fail(c, 404, 'not_found', 'no collaboration hub')
    if (action === 'restore') return c.json(await deps.orphans.restoreOrphan(path))
    if (action === 'discard') { await deps.orphans.discardOrphan(path); return c.json({ ok: true }) }
    return fail(c, 400, 'invalid', 'action must be restore or discard')
  })

  // `confirmRemoval`: the number of notes the alert said would be removed.
  // The mass deletion is only accepted if that number still matches (Indexer.scan).
  app.post('/api/admin/rescan', adminOnly, async (c) => {
    const body = await c.req.json<{ force?: boolean; confirmRemoval?: number }>().catch(() => ({}) as { force?: boolean; confirmRemoval?: number })
    const confirmRemoval = Number.isInteger(body.confirmRemoval) ? body.confirmRemoval : undefined
    return c.json(deps.runtime.rescan({ force: body.force === true, confirmRemoval }))
  })

  app.post('/api/admin/users', adminOnly, async (c) => {
    const { username, password, role } = await c.req.json<{ username: string; password: string; role?: 'admin' | 'member' }>()
    return c.json({ user: await auth.createUser(username, password, role ?? 'member') }, 201)
  })

  if (deps.history) historyRoutes(app, { history: deps.history, notes, auth, keyName: (id) => keys.nameOf(id), canRead: deps.canRead ?? (() => true) })

  keyRoutes(app, { keys, integrations })

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

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}
