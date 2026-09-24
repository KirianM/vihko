// API HTTP. La usa la UI con sesión (cookie) y siempre está activa; el acceso de
// integraciones con API keys llegará en M3 y será opcional (D-010).
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthError, type Auth, type User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { Indexer, ScanReport } from '../indexer.ts'
import { NoteError, type Actor, type NoteService } from '../notes.ts'
import { ftsQuery, HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'

export const SESSION_COOKIE = 'thoth_session'

export interface Runtime {
  lastScan: ScanReport | null
  rescan(force: boolean): ScanReport
}

export interface AppDeps {
  auth: Auth
  notes: NoteService
  index: Db
  indexer: Indexer
  notesDir: string
  runtime: Runtime
}

type Env = { Variables: { user: User; token: string } }

const actorOf = (u: User): Actor => ({ kind: 'user', id: u.username })

function noteErrorStatus(e: NoteError) {
  return ({ not_found: 404, exists: 409, precondition_failed: 412, invalid_path: 400 } as const)[e.code]
}

export function createApp(deps: AppDeps) {
  const { auth, notes, index } = deps
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof NoteError) {
      if (err.etag) c.header('ETag', `"${err.etag}"`)
      return c.json({ error: err.code, message: err.message, etag: err.etag }, noteErrorStatus(err))
    }
    if (err instanceof AuthError) return c.json({ error: 'invalid', message: err.message }, 400)
    console.error(err)
    return c.json({ error: 'internal', message: 'error interno' }, 500)
  })

  // CSRF: una petición que modifica algo y viene de otro origen se rechaza.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'forbidden', message: 'origen no permitido' }, 403)
    }
    await next()
  })

  // --- Sin sesión: primer arranque y login -----------------------------------

  app.get('/api/setup', (c) => c.json({ needed: auth.userCount() === 0 }))

  app.post('/api/setup', async (c) => {
    const { token, username, password } = await c.req.json<{ token: string; username: string; password: string }>()
    const user = await auth.setup(token, username, password)
    return c.json({ user })
  })

  app.post('/api/auth/login', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>()
    const s = await auth.login(username ?? '', password ?? '')
    if (!s) return c.json({ error: 'unauthorized', message: 'usuario o contraseña incorrectos' }, 401)
    setCookie(c, SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: isHttps(c),
      expires: s.expiresAt,
    })
    return c.json({ user: s.user })
  })

  // --- A partir de aquí, sesión obligatoria --------------------------------

  app.use('/api/*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    const user = auth.session(token)
    if (!user) return c.json({ error: 'unauthorized', message: 'inicia sesión' }, 401)
    c.set('user', user)
    c.set('token', token!)
    await next()
  })

  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'forbidden', message: 'solo administradores' }, 403)
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
    if (!ifMatch) return c.json({ error: 'precondition_required', message: 'falta If-Match: no se sobrescribe una nota que no se ha leído' }, 428)
    const { text } = await c.req.json<{ text: string }>()
    const r = await notes.write(c.req.query('path') ?? '', text, { ifMatch, actor: actorOf(c.get('user')) })
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
    notes.read(path) // 404 si no existe
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

  app.get('/api/alerts', (c) => {
    const conflicts = index.prepare('select path, kind from alerts order by path').all()
    const scan = deps.runtime.lastScan
    return c.json({
      syncConflicts: conflicts,
      uidConflicts: deps.indexer.uidConflicts(),
      scanAborted: scan?.aborted ?? null,
    })
  })

  app.post('/api/admin/rescan', adminOnly, async (c) => {
    const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }))
    return c.json(deps.runtime.rescan(!!force))
  })

  app.post('/api/admin/users', adminOnly, async (c) => {
    const { username, password, role } = await c.req.json<{ username: string; password: string; role?: 'admin' | 'member' }>()
    return c.json({ user: await auth.createUser(username, password, role ?? 'member') }, 201)
  })

  return app
}

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}

/** Fragmento de texto alrededor de un enlace, para mostrar backlinks con contexto. */
function context(text: string, from: number, to: number, radius = 80) {
  const start = Math.max(0, text.lastIndexOf('\n', from - 1) + 1, from - radius)
  const nl = text.indexOf('\n', to)
  const end = Math.min(text.length, nl === -1 ? text.length : nl, to + radius)
  return text.slice(start, end)
}
