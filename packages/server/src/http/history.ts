// History API (the same principal and filter as the rest, D-014): a note's
// history is only shown to whoever can read the note now (D-016), and
// «Recent changes» filters file by file. An agent reads it through
// agentHistory.ts: only versions it could have seen. Authors come back with their
// current name (state.db), never the one stored in the commit; reasons as
// codes with their data, which the UI words (D-025).
//
//   GET  /api/history/status
//   GET  /api/history/versions?path=&cursor=&limit=   (`excluded`: history.exclude keeps it out)
//   GET  /api/history/version?path=&id=
//   GET  /api/history/diff?path=&id=&against=previous|current|<id>
//   POST /api/history/restore { path, id, ifMatch? }
//   POST /api/history/revert { path, id, ifMatch?, dryRun? }
//   GET  /api/history/changes?cursor=&limit=&author=
//   GET  /api/history/resolved?path=
import type { Context, Hono } from 'hono'
import { parseAuthorKey, type Via } from '../actor.ts'
import type { Auth, User } from '../auth.ts'
import { AgentDenied, type Access } from '../access.ts'
import { historyFor } from '../agentHistory.ts'
import { History, HistoryError, type AuthorRef, type HistoryReader } from '../history/index.ts'
import { wordDiff } from '../history/diff.ts'
import { authorFilter } from '../history/reader.ts'
import { ResolvedThreads } from '../history/resolved.ts'
import { revertVersion } from '../history/revert.ts'
import { NoteError, NoteService, type Actor } from '../notes.ts'

export interface HistoryRoutesDeps {
  history: History
  notes: NoteService
  auth: Auth
  /** A key's name (`Claude Code`), for agent authors; null if unknown. */
  keyName?: (id: string) => string | null
  /** Whether `user` can read `path` now, on top of the access filter (everything, until M4). */
  canRead: (user: User, path: string) => boolean
}

/**
 * An author as the API gives it. `key` is its value for the `author` filter
 * of `changes`. An agent: `name` is its key's name, `via` how it came.
 */
export interface ApiAuthor {
  kind: 'user' | 'agent' | 'system' | 'external' | 'git'
  id?: string
  name: string
  onBehalfOf?: { id: string; name: string }
  via?: Via
  key: string
}

type Env = { Variables: { user: User; token: string; access: Access } }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** An agent reads the history version by version (agentHistory.ts): smaller pages. */
const MAX_AGENT_LIMIT = 50

export function historyRoutes(app: Hono<Env>, deps: HistoryRoutesDeps) {
  const { history, notes, auth } = deps
  const nameOf = (id: string) => auth.username(id) ?? id

  const author = (a: AuthorRef): ApiAuthor => {
    const key = authorFilter(a)
    switch (a.kind) {
      case 'user': return { kind: 'user', id: a.id, name: nameOf(a.id), key }
      case 'agent': return { kind: 'agent', id: a.id, name: deps.keyName?.(a.id) ?? a.id, onBehalfOf: { id: a.onBehalfOf, name: nameOf(a.onBehalfOf) }, ...(a.via ? { via: a.via } : {}), key }
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

  const limitOf = (c: Context<Env>) => {
    const max = c.get('access').isAgent ? MAX_AGENT_LIMIT : MAX_LIMIT
    const n = Number(c.req.query('limit') ?? DEFAULT_LIMIT)
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : Math.min(DEFAULT_LIMIT, max)
  }

  /** Whether whoever asks may read `path` now. */
  const readable = (c: Context<Env>, path: string) => c.get('access').canRead(path) && deps.canRead(c.get('user'), path)

  /**
   * The note in the request, if whoever asks can read it now; otherwise it
   * doesn't exist for them, except for an agent naming a note that exists
   * but is hidden from it (`agent_denied`, access.ts).
   */
  const notePath = (c: Context<Env>, raw: string | undefined): string => {
    const path = NoteService.checkPath(raw ?? '')
    if (!deps.canRead(c.get('user'), path)) throw new NoteError('not_found', `no history for ${path}`)
    c.get('access').assertRead(path)
    return path
  }

  /** The history reader, as whoever asks may see it. */
  const readerOf = (c: Context<Env>) => historyFor(c.get('access'), history.reader())

  /**
   * The note of a request that writes it (restore, revert): one whoever asks
   * can read and write now; for an agent, its text too (a note hidden since
   * it was indexed doesn't exist for it either). `forbidden` for a read-only key.
   */
  const writableNote = (c: Context<Env>, raw: string | undefined): string => {
    const path = notePath(c, raw)
    const access = c.get('access')
    access.assertWrite(path)
    if (access.isAgent) {
      // A note deleted since has no text now, and can be restored.
      let text: string | null = null
      try { text = notes.read(path).text } catch (err) { if (!(err instanceof NoteError && err.code === 'not_found')) throw err }
      if (text !== null && access.hides(text)) throw new AgentDenied(access.reasonFor(path))
    }
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
    const reader = readerOf(c)
    const page = await reader.versions(path, { cursor: c.req.query('cursor'), limit: limitOf(c) })
    const open = history.pendingOf(path)
    return c.json({
      versions: page.versions.map((v) => ({ ...v, authors: v.authors.map(author), reason: reason(v.reason) })),
      next: page.next,
      pending: open ? { authors: open.authors.map(author), since: new Date(open.since).toISOString() } : null,
      // Kept out of the managed history by thoth.yaml: what is listed is from before.
      excluded: history.excluded(path),
    })
  })

  app.get('/api/history/version', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const v = await versionOf(readerOf(c), path, c.req.query('id'))
    return c.json({ path: v.path, id: v.id, at: v.at, text: v.text })
  })

  // `ops` turn `against` into the version: what the version adds is inserted.
  app.get('/api/history/diff', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const reader = readerOf(c)
    const v = await versionOf(reader, path, c.req.query('id'))
    const against = c.req.query('against') ?? 'previous'
    let base: string | null
    if (against === 'previous') base = v.before
    else if (against === 'current') {
      try { base = notes.read(path).text } catch (err) { if (err instanceof NoteError && err.code === 'not_found') base = null; else throw err }
      if (base !== null && c.get('access').hides(base)) throw new AgentDenied(c.get('access').reasonFor(path))
    } else base = (await versionOf(reader, path, against)).text
    return c.json(wordDiff(base ?? '', v.text ?? ''))
  })

  // Writes through the core like any edit, as whoever asks (the user, or an
  // agent on their behalf), with the reason `restored`.
  app.post('/api/history/restore', async (c) => {
    const body = await c.req.json<{ path?: string; id?: string; ifMatch?: string }>()
    const path = writableNote(c, body.path)
    const reader = readerOf(c)
    const v = await versionOf(reader, path, body.id)
    if (v.text === null) throw new HistoryError('invalid', 'that version deletes the note: there is no text to restore')
    const ifMatch = body.ifMatch ?? unquote(c.req.header('if-match'))
    const r = await notes.restoreVersion(path, { id: v.id, at: v.at, path: v.path, text: v.text }, {
      ifMatch, actor: c.get('access').actor, file: (p) => reader.file(v.id, p),
    })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  // Undoes what one version changed, on the note as it is now (history/revert.ts):
  // what was changed later and clashes is left and reported (`skipped`). With
  // `dryRun`, only what it would do. One write through the core, as whoever
  // asks (the user, or an agent on their behalf), with the reason `reverted`.
  // An agent reverts only a version it can see (agentHistory.ts).
  app.post('/api/history/revert', async (c) => {
    const body = await c.req.json<{ path?: string; id?: string; ifMatch?: string; dryRun?: boolean }>()
    const path = writableNote(c, body.path)
    if (typeof body.id !== 'string' || !body.id) throw new HistoryError('invalid', 'missing id')
    const actor: Actor = c.get('access').actor
    const r = await revertVersion({ reader: readerOf(c), notes, recorder: history.recorder }, path, body.id, {
      actor, ifMatch: body.ifMatch ?? unquote(c.req.header('if-match')), dryRun: body.dryRun === true,
    })
    c.header('ETag', `"${r.etag}"`)
    return c.json(r)
  })

  app.get('/api/history/changes', async (c) => {
    const reader = readerOf(c)
    const page = await reader.changes({ cursor: c.req.query('cursor'), limit: limitOf(c), author: c.req.query('author') || null, canRead: (p) => readable(c, p) })
    // An agent learns of the authors of what it sees, nobody else.
    const authors = c.get('access').isAgent ? distinctAuthors(page.changes.flatMap((ch) => ch.authors)).map(author) : (await reader.authors()).map(author)
    return c.json({
      changes: page.changes.map((ch) => ({ ...ch, authors: ch.authors.map(author), reason: reason(ch.reason) })),
      next: page.next,
      authors,
    })
  })

  // Comment threads that left the note in the last 30 days (D-032.5): each one
  // whole, with what it takes to put it back (`place`), who resolved it and
  // whether its text is still there. Reopening is an edit in the editor
  // session, like resolving: there is no endpoint that writes it.
  const resolved = new ResolvedThreads()
  app.get('/api/history/resolved', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const reader = readerOf(c)
    let current: string | null
    try { current = notes.read(path).text } catch (err) { if (err instanceof NoteError && err.code === 'not_found') current = null; else throw err }
    const r = await resolved.list(reader, path, { current, pending: history.pendingOf(path)?.authors ?? null })
    return c.json({
      threads: r.threads.map((t) => ({ ...t, resolvedBy: t.resolvedBy.map(author) })),
      complete: r.complete,
    })
  })
}

function distinctAuthors(list: AuthorRef[]): AuthorRef[] {
  const seen = new Map<string, AuthorRef>()
  for (const a of list) seen.set(JSON.stringify(a), a)
  return [...seen.values()]
}

function unquote(etag: string | undefined) {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined
}

/** HTTP status for each history error code. */
export function historyErrorStatus(e: HistoryError) {
  return ({ history_off: 409, history_unavailable: 503, not_found: 404, invalid: 400, not_revertible: 409 } as const)[e.code]
}
