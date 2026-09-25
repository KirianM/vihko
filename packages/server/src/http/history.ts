// History API (session; the same principal and filter as the rest, D-014):
// a note's history is only shown to whoever can read the note now (D-016),
// and «Recent changes» filters file by file. Authors come back with their
// current name (state.db), never the one stored in the commit; reasons as
// codes with their data, which the UI words (D-025).
//
//   GET  /api/history/status
//   GET  /api/history/versions?path=&cursor=&limit=
//   GET  /api/history/version?path=&id=
//   GET  /api/history/diff?path=&id=&against=previous|current|<id>
//   POST /api/history/restore { path, id, ifMatch? }
//   GET  /api/history/changes?cursor=&limit=&author=
import type { Context, Hono } from 'hono'
import { parseAuthorKey } from '../actor.ts'
import type { Auth, User } from '../auth.ts'
import { History, HistoryError, type AuthorRef, type HistoryReader } from '../history/index.ts'
import { wordDiff } from '../history/diff.ts'
import { authorFilter } from '../history/reader.ts'
import { NoteError, NoteService } from '../notes.ts'

export interface HistoryRoutesDeps {
  history: History
  notes: NoteService
  auth: Auth
  /** Whether `user` can read `path` now: the single permission filter (everything, until M4). */
  canRead: (user: User, path: string) => boolean
}

/** An author as the API gives it. `key` is its value for the `author` filter of `changes`. */
export interface ApiAuthor {
  kind: 'user' | 'agent' | 'system' | 'external' | 'git'
  id?: string
  name: string
  onBehalfOf?: { id: string; name: string }
  key: string
}

type Env = { Variables: { user: User; token: string } }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function historyRoutes(app: Hono<Env>, deps: HistoryRoutesDeps) {
  const { history, notes, auth } = deps
  const nameOf = (id: string) => auth.username(id) ?? id

  const author = (a: AuthorRef): ApiAuthor => {
    const key = authorFilter(a)
    switch (a.kind) {
      case 'user': return { kind: 'user', id: a.id, name: nameOf(a.id), key }
      case 'agent': return { kind: 'agent', id: a.id, name: a.id, onBehalfOf: { id: a.onBehalfOf, name: nameOf(a.onBehalfOf) }, key }
      case 'git': return { kind: 'git', id: a.email || undefined, name: a.name, key }
      case 'system': return { kind: 'system', name: 'thoth', key }
      case 'external': return { kind: 'external', name: '', key }
    }
  }

  /** A reason with `by` as an author (with its current name). */
  const reason = (r: Record<string, unknown> | null) => {
    if (!r) return null
    if (typeof r.by !== 'string') return r
    const by = parseAuthorKey(r.by)
    return { ...r, by: by ? author(by) : null }
  }

  const limitOf = (c: Context) => {
    const n = Number(c.req.query('limit') ?? DEFAULT_LIMIT)
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT
  }

  /** The note in the request, if the user can read it now; otherwise it doesn't exist for them. */
  const notePath = (c: Context<Env>, raw: string | undefined): string => {
    const path = NoteService.checkPath(raw ?? '')
    if (!deps.canRead(c.get('user'), path)) throw new NoteError('not_found', `no history for ${path}`)
    return path
  }

  const versionOf = async (reader: HistoryReader, path: string, id: string | undefined) => {
    if (!id) throw new HistoryError('invalid', 'missing id')
    const v = await reader.version(path, id)
    if (!v) throw new HistoryError('not_found', `${id} is not a version of ${path}`)
    return v
  }

  app.get('/api/history/status', (c) => c.json(history.status()))

  app.get('/api/history/versions', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const reader = history.reader()
    const page = await reader.versions(path, { cursor: c.req.query('cursor'), limit: limitOf(c) })
    const open = history.pendingOf(path)
    return c.json({
      versions: page.versions.map((v) => ({ ...v, authors: v.authors.map(author), reason: reason(v.reason) })),
      next: page.next,
      pending: open ? { authors: open.authors.map(author), since: new Date(open.since).toISOString() } : null,
    })
  })

  app.get('/api/history/version', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const v = await versionOf(history.reader(), path, c.req.query('id'))
    return c.json({ path: v.path, id: v.id, at: v.at, text: v.text })
  })

  // `ops` turn `against` into the version: what the version adds is inserted.
  app.get('/api/history/diff', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const reader = history.reader()
    const v = await versionOf(reader, path, c.req.query('id'))
    const against = c.req.query('against') ?? 'previous'
    let base: string | null
    if (against === 'previous') base = v.before
    else if (against === 'current') {
      try { base = notes.read(path).text } catch (err) { if (err instanceof NoteError && err.code === 'not_found') base = null; else throw err }
    } else base = (await versionOf(reader, path, against)).text
    return c.json(wordDiff(base ?? '', v.text ?? ''))
  })

  // Writes through the core like any edit, as the user, with the reason `restored`.
  app.post('/api/history/restore', async (c) => {
    const body = await c.req.json<{ path?: string; id?: string; ifMatch?: string }>()
    const path = notePath(c, body.path)
    const reader = history.reader()
    const v = await versionOf(reader, path, body.id)
    if (v.text === null) throw new HistoryError('invalid', 'that version deletes the note: there is no text to restore')
    const ifMatch = body.ifMatch ?? unquote(c.req.header('if-match'))
    const r = await notes.restoreVersion(path, { id: v.id, at: v.at, path: v.path, text: v.text }, {
      ifMatch, actor: { kind: 'user', id: c.get('user').id }, file: (p) => reader.file(v.id, p),
    })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  app.get('/api/history/changes', async (c) => {
    const user = c.get('user')
    const reader = history.reader()
    const page = await reader.changes({ cursor: c.req.query('cursor'), limit: limitOf(c), author: c.req.query('author') || null, canRead: (p) => deps.canRead(user, p) })
    const authors = (await reader.authors()).map(author)
    return c.json({
      changes: page.changes.map((ch) => ({ ...ch, authors: ch.authors.map(author), reason: reason(ch.reason) })),
      next: page.next,
      authors,
    })
  })
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}

/** HTTP status for each history error code. */
export function historyErrorStatus(e: HistoryError) {
  return ({ history_off: 409, history_unmanaged_unavailable: 409, history_unavailable: 503, not_found: 404, invalid: 400 } as const)[e.code]
}
