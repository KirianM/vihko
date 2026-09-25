// HTTP API. Used by the UI with a session (cookie) and always active; access
// for integrations with API keys will arrive later and be optional.
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { classifyPath, conflictOriginal, type Alert, type ErrorCode } from '@thoth/core'
import { AuthError, type Auth, type User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { Indexer, ScanOptions, ScanReport } from '../indexer.ts'
import { NoteError, type Actor, type NoteService } from '../notes.ts'
import { ftsQuery, HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'
import { applyEdits, type EditOp } from '../edits.ts'
import { FetchImageError, SERVED_TYPES, fetchImage } from '../attachments.ts'

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
  notes: NoteService
  index: Db
  indexer: Indexer
  notesDir: string
  runtime: Runtime
  /** Compiled UI (packages/web/dist). Without it, the server only exposes the API. */
  webDir?: string
}

// The UI only talks to its own origin: no CDNs or third parties.
const UI_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}

// Files from the notes folder are served inert: nothing in them runs, even
// an SVG opened on its own (sandboxed, no scripts).
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

type Env = { Variables: { user: User; token: string } }

const actorOf = (u: User): Actor => ({ kind: 'user', id: u.username })

function noteErrorStatus(e: NoteError) {
  return ({ not_found: 404, exists: 409, precondition_failed: 412, invalid_path: 400, edit_mismatch: 409, too_large: 413, unsupported_type: 415 } as const)[e.code]
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

export function createApp(deps: AppDeps) {
  const { auth, notes, index } = deps
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof NoteError) {
      if (err.etag) c.header('ETag', `"${err.etag}"`)
      return fail(c, noteErrorStatus(err), err.code, err.message, { etag: err.etag })
    }
    if (err instanceof FetchImageError) return fail(c, fetchErrorStatus(err), err.code, err.message)
    if (err instanceof AuthError) return fail(c, err.code === 'user_exists' || err.code === 'already_setup' ? 409 : 400, err.code, err.message)
    // Body that isn't JSON.
    if (err instanceof SyntaxError) return fail(c, 400, 'invalid', err.message)
    console.error(err)
    return fail(c, 500, 'internal', 'internal error')
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
    const token = getCookie(c, SESSION_COOKIE)
    const user = auth.session(token)
    if (!user) return fail(c, 401, 'unauthorized', 'please log in')
    c.set('user', user)
    c.set('token', token!)
    await next()
  })

  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('user').role !== 'admin') return fail(c, 403, 'forbidden', 'admins only')
    await next()
  }

  app.post('/api/auth/logout', (c) => {
    auth.logout(c.get('token'))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }))

  app.get('/api/tree', (c) => {
    const rows = index.prepare('select path, title, uid from notes order by path').all()
    return c.json({ notes: rows })
  })

  app.get('/api/note', (c) => {
    const path = c.req.query('path') ?? ''
    const r = notes.read(path)
    const meta = index.prepare('select title, uid, fm_error from notes where path = ?').get(path) ?? null
    c.header('ETag', `"${r.etag}"`)
    return c.json({ ...r, meta })
  })

  app.post('/api/note', async (c) => {
    const { path, text } = await c.req.json<{ path: string; text: string }>()
    return c.json(await notes.create(path, text ?? '', actorOf(c.get('user'))), 201)
  })

  app.put('/api/note', async (c) => {
    const ifMatch = unquote(c.req.header('if-match'))
    if (!ifMatch) return fail(c, 428, 'precondition_required', 'missing If-Match: a note that hasn\'t been read won\'t be overwritten')
    const { text } = await c.req.json<{ text: string }>()
    const r = await notes.write(c.req.query('path') ?? '', text, { ifMatch, actor: actorOf(c.get('user')) })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Edits by operation: atomic on the current text, even with the note open.
  app.post('/api/note/edit', async (c) => {
    const { path, ops } = await c.req.json<{ path: string; ops: EditOp[] }>()
    const r = await notes.edit(path, (t) => applyEdits(t, ops), { ifMatch: unquote(c.req.header('if-match')), actor: actorOf(c.get('user')) })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  app.delete('/api/note', async (c) => {
    const entry = await notes.delete(c.req.query('path') ?? '', { ifMatch: unquote(c.req.header('if-match')), actor: actorOf(c.get('user')) })
    return c.json(entry)
  })

  app.post('/api/note/move', async (c) => {
    const { from, to, dryRun } = await c.req.json<{ from: string; to: string; dryRun?: boolean }>()
    return c.json(await notes.move(from, to, { ifMatch: unquote(c.req.header('if-match')), actor: actorOf(c.get('user')), dryRun }))
  })

  app.get('/api/note/links', (c) => {
    const path = c.req.query('path') ?? ''
    notes.read(path) // 404 if it doesn't exist
    const outgoing = index.prepare(`select raw, kind, target, anchor, status, dst_path, anchor_ok, candidates
      from links where src_path = ? order by ord`).all(path) as { candidates: string | null }[]
    const incoming = index.prepare(`select l.src_path, n.title, l.raw, l.pos_from, l.pos_to
      from links l join notes n on n.path = l.src_path where l.dst_path = ? and l.src_path != ? order by l.src_path, l.ord`)
      .all(path, path) as { src_path: string; title: string; raw: string; pos_from: number; pos_to: number }[]
    const texts = new Map<string, string>()
    const backlinks = incoming.map((l) => {
      if (!texts.has(l.src_path)) {
        try { texts.set(l.src_path, readFileSync(join(deps.notesDir, l.src_path), 'utf8')) } catch { texts.set(l.src_path, '') }
      }
      const t = texts.get(l.src_path)!
      return { path: l.src_path, title: l.title, raw: l.raw, context: context(t, l.pos_from, l.pos_to) }
    })
    return c.json({
      outgoing: outgoing.map((l) => ({ ...l, candidates: l.candidates ? JSON.parse(l.candidates) : null })),
      backlinks,
    })
  })

  // Images (D-028). Upload and paste are the same: the raw bytes of the file
  // in the body. It is stored next to the note and the editor links it.
  app.post('/api/attachments',
    bodyLimit({ maxSize: notes.maxImageBytes, onError: (c) => fail(c, 413, 'too_large', `the limit is ${notes.maxImageBytes} bytes`) }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(await notes.attach(c.req.query('note') ?? '', bytes, actorOf(c.get('user'))), 201)
    })

  // A copy of an image from a URL, stored like an upload. Only on this explicit
  // request from a user: the server never fetches URLs written in notes.
  app.post('/api/attachments/fetch', async (c) => {
    const { note, url } = await c.req.json<{ note: string; url: string }>()
    notes.read(note ?? '') // nothing is downloaded for a note that doesn't exist
    const { bytes } = await fetchImage(String(url ?? ''), { maxBytes: notes.maxImageBytes })
    return c.json(await notes.attach(note, bytes, actorOf(c.get('user'))), 201)
  })

  // A file in the notes folder that isn't a note (images and other attachments).
  // Same path rules as notes: relative, inside the root, no hidden or ignored
  // segments, and no symlink leading out of the folder.
  app.get('/api/file', (c) => {
    const path = c.req.query('path') ?? ''
    const norm = posix.normalize(path)
    if (!path || norm !== path || path.startsWith('/') || norm.split('/').includes('..')) return fail(c, 400, 'invalid_path', `invalid file path: ${path}`)
    if (classifyPath(norm) !== 'other') return fail(c, 404, 'not_found', `not a servable file: ${path}`)
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

  app.get('/api/search', (c) => {
    const q = ftsQuery(c.req.query('q') ?? '')
    if (!q) return c.json({ results: [] })
    const results = index.prepare(`select path, title,
        snippet(notes_fts, 3, ?, ?, '…', 12) as snippet
      from notes_fts where notes_fts match ? order by bm25(notes_fts, 0, 10.0, 8.0, 1.0) limit 50`)
      .all(HIGHLIGHT_START, HIGHLIGHT_END, q)
    return c.json({ results, highlight: { start: HIGHLIGHT_START, end: HIGHLIGHT_END } })
  })

  app.get('/api/trash', (c) => c.json({ entries: notes.trash() }))
  app.post('/api/trash/:id/restore', async (c) => {
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({ to: undefined }))
    return c.json(await notes.restore(c.req.param('id'), actorOf(c.get('user')), to))
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
    for (const u of deps.indexer.uidConflicts()) alerts.push({ code: 'uid_conflict', uid: u.uid, paths: u.paths, actions: [] })
    const noteExists = index.prepare('select 1 from notes where path = ?')
    for (const { path } of index.prepare("select path from alerts where kind = 'sync_conflict' order by path").all() as { path: string }[]) {
      const note = conflictOriginal(path)
      alerts.push({ code: 'sync_conflict', path, note: noteExists.get(note) ? note : null, actions: [] })
    }
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

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'does not exist'))

  if (deps.webDir) {
    const root = deps.webDir
    app.use('*', async (c, next) => {
      await next()
      for (const [k, v] of Object.entries(UI_HEADERS)) c.header(k, v)
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

  return app
}

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}

/** Text fragment around a link, to show backlinks with context. */
function context(text: string, from: number, to: number, radius = 80) {
  const start = Math.max(0, text.lastIndexOf('\n', from - 1) + 1, from - radius)
  const nl = text.indexOf('\n', to)
  const end = Math.min(text.length, nl === -1 ? text.length : nl, to + radius)
  return text.slice(start, end)
}
