// API HTTP. La usa la UI con sesión (cookie) y siempre está activa; el acceso de
// integraciones con API keys llegará en M3 y será opcional (D-010).
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyPath, conflictOriginal, type Alert, type ErrorCode } from '@thoth/core'
import { AuthError, type Auth, type User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { Indexer, ScanOptions, ScanReport } from '../indexer.ts'
import { NoteError, type Actor, type NoteService } from '../notes.ts'
import { ftsQuery, HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'
import { applyEdits, type EditOp } from '../edits.ts'

export const SESSION_COOKIE = 'thoth_session'

export interface Runtime {
  lastScan: ScanReport | null
  rescan(opts: ScanOptions): ScanReport
}

/** Lo que la API necesita del hub de colaboración. */
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
  /** UI compilada (packages/web/dist). Sin ella, el servidor solo expone la API. */
  webDir?: string
}

// La UI solo habla con su propio origen: ni CDNs ni terceros (regla 4).
const UI_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}

type Env = { Variables: { user: User; token: string } }

const actorOf = (u: User): Actor => ({ kind: 'user', id: u.username })

function noteErrorStatus(e: NoteError) {
  return ({ not_found: 404, exists: 409, precondition_failed: 412, invalid_path: 400, edit_mismatch: 409 } as const)[e.code]
}

/**
 * Respuesta de error: `error` es el código estable que traduce la UI (D-025);
 * `message`, una pista para quien desarrolla, que la UI no muestra.
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
    if (err instanceof AuthError) return fail(c, err.code === 'user_exists' || err.code === 'already_setup' ? 409 : 400, err.code, err.message)
    // Cuerpo que no es JSON.
    if (err instanceof SyntaxError) return fail(c, 400, 'invalid', err.message)
    console.error(err)
    return fail(c, 500, 'internal', 'error interno')
  })

  // CSRF: una petición que modifica algo y viene de otro origen se rechaza.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).host !== new URL(c.req.url).host) return fail(c, 403, 'forbidden', 'origen no permitido')
    }
    await next()
  })

  // --- Sin sesión: salud, primer arranque y login ---------------------------

  // Para el healthcheck de Docker. No revela nada salvo que el proceso responde.
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
    if (!s) return fail(c, 401, 'invalid_credentials', 'usuario o contraseña incorrectos')
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
    if (!user) return fail(c, 401, 'unauthorized', 'inicia sesión')
    c.set('user', user)
    c.set('token', token!)
    await next()
  })

  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('user').role !== 'admin') return fail(c, 403, 'forbidden', 'solo administradores')
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
    if (!ifMatch) return fail(c, 428, 'precondition_required', 'falta If-Match: no se sobrescribe una nota que no se ha leído')
    const { text } = await c.req.json<{ text: string }>()
    const r = await notes.write(c.req.query('path') ?? '', text, { ifMatch, actor: actorOf(c.get('user')) })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Ediciones por operación: atómicas sobre el texto actual, también con la nota abierta.
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

  // Avisos del espacio: códigos con sus datos, nunca texto (D-025). Las acciones
  // de admin solo se ofrecen a quien puede hacerlas; el endpoint lo vuelve a exigir.
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

  // Texto de una copia de conflicto, para compararla con la nota. Solo de las
  // que el indexador ha detectado: no sirve para leer cualquier archivo.
  app.get('/api/conflict', (c) => {
    const path = c.req.query('path') ?? ''
    const known = classifyPath(path) === 'conflict' && index.prepare("select 1 from alerts where path = ? and kind = 'sync_conflict'").get(path)
    let text: string | null = null
    if (known) try { text = readFileSync(join(deps.notesDir, path), 'utf8') } catch { /* ya no existe */ }
    if (text === null) return fail(c, 404, 'not_found', `no hay ninguna copia de conflicto en ${path}`)
    return c.json({ path, text })
  })

  // Nota borrada desde fuera con una copia abierta: conservarla o darla por borrada.
  app.post('/api/note/orphan', async (c) => {
    const { path, action } = await c.req.json<{ path: string; action: 'restore' | 'discard' }>()
    if (!deps.orphans) return fail(c, 404, 'not_found', 'sin hub de colaboración')
    if (action === 'restore') return c.json(await deps.orphans.restoreOrphan(path))
    if (action === 'discard') { await deps.orphans.discardOrphan(path); return c.json({ ok: true }) }
    return fail(c, 400, 'invalid', 'action debe ser restore o discard')
  })

  // `confirmRemoval`: el número de notas que el aviso decía que se iban a retirar.
  // El borrado masivo solo se acepta si sigue siendo ese (Indexer.scan).
  app.post('/api/admin/rescan', adminOnly, async (c) => {
    const body = await c.req.json<{ force?: boolean; confirmRemoval?: number }>().catch(() => ({}) as { force?: boolean; confirmRemoval?: number })
    const confirmRemoval = Number.isInteger(body.confirmRemoval) ? body.confirmRemoval : undefined
    return c.json(deps.runtime.rescan({ force: body.force === true, confirmRemoval }))
  })

  app.post('/api/admin/users', adminOnly, async (c) => {
    const { username, password, role } = await c.req.json<{ username: string; password: string; role?: 'admin' | 'member' }>()
    return c.json({ user: await auth.createUser(username, password, role ?? 'member') }, 201)
  })

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'no existe'))

  if (deps.webDir) {
    const root = deps.webDir
    app.use('*', async (c, next) => {
      await next()
      for (const [k, v] of Object.entries(UI_HEADERS)) c.header(k, v)
      // index.html sin caché, para que una actualización se vea al recargar.
      if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache')
    })
    // Los assets llevan hash en el nombre: se pueden cachear para siempre.
    app.use('/assets/*', async (c, next) => {
      await next()
      if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
    })
    app.get('*', serveStatic({ root }))
    // Cualquier otra ruta es de la aplicación (SPA): index.html.
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

/** Fragmento de texto alrededor de un enlace, para mostrar backlinks con contexto. */
function context(text: string, from: number, to: number, radius = 80) {
  const start = Math.max(0, text.lastIndexOf('\n', from - 1) + 1, from - radius)
  const nl = text.indexOf('\n', to)
  const end = Math.min(text.length, nl === -1 ? text.length : nl, to + radius)
  return text.slice(start, end)
}
