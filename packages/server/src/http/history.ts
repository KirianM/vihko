// History API (the same principal and filter as the rest, D-014): a note's
// history is only for whoever has `edit` where it is now (D-034 3.5, D-038),
// and «Recent changes» filters file by file the same way. Everyone reads it
// through agentHistory.ts: only versions from where they could edit it (and,
// for an agent, whose text it could see). Someone who can read the note but
// not edit it gets `forbidden`; someone who can't read it, `not_found`.
// Authors come back with their current name (state.db), never the one
// stored in the commit; reasons as codes with their data, which the UI
// words (D-025).
//
//   GET  /api/history/status
//   GET  /api/history/versions?path=&cursor=&limit=   (`excluded`: history.exclude keeps it out)
//   GET  /api/history/version?path=&id=
//   GET  /api/history/diff?path=&id=&against=previous|current|<id>
//   POST /api/history/restore { path, id, ifMatch? }
//   POST /api/history/revert { path, id, ifMatch?, dryRun? }
//   GET  /api/history/changes?cursor=&limit=&author=
//   GET  /api/history/resolved?path=
//   POST /api/history/purge { path, version?, dryRun?, confirm? }   (`manage`, or the admin by name)
//   DELETE /api/history/purges/:id                      (the admin: a purge's notice, dismissed)
import type { Context, Hono } from 'hono'
import { WORKSPACE_FILE, folderOf } from '@vihko/core'
import { PurgeError, purgeTarget, type PurgeReport } from '../history/purge.ts'
import { readablePath, type Notices } from '../notices.ts'
import { parseAuthorKey, type Via } from '../actor.ts'
import type { Auth, User } from '../auth.ts'
import { AccessError, AgentDenied, type Access } from '../access.ts'
import { historyFor } from '../agentHistory.ts'
import { History, HistoryError, type AuthorRef, type HistoryReader } from '../history/index.ts'
import { wordDiff } from '../history/diff.ts'
import { UNAVAILABLE_MESSAGE, authorFilter } from '../history/reader.ts'
import { ResolvedThreads } from '../history/resolved.ts'
import { revertVersion } from '../history/revert.ts'
import { NoteError, NoteService, type Actor } from '../notes.ts'
import { agentGuard, hiddenAfterWrite, revertWritten } from '../scoped.ts'
import { written } from './written.ts'

export interface HistoryRoutesDeps {
  history: History
  notes: NoteService
  auth: Auth
  /** A key's name (`Claude Code`), for agent authors; null if unknown. */
  keyName?: (id: string) => string | null
  /** Notices addressed to one person: whoever wrote in what is purged is told (D-040 3.6). */
  notices?: Notices
  /** The confirmation at the moment (http/twoFactor.ts): the admin purging what they can't read (D-040 3.6). */
  confirm?: (c: Context<Env>, confirm: unknown) => Promise<Response | null>
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
      case 'system': return { kind: 'system', name: 'vihko', key }
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

  /**
   * The note in the request, if whoever asks may see its history now:
   * `edit` where it is. One they can't read doesn't exist for them (except
   * for an agent naming a note that exists but is hidden from it:
   * `agent_denied`, access.ts); one they only read is `forbidden`.
   */
  const notePath = (c: Context<Env>, raw: string | undefined): string => {
    const path = NoteService.checkPath(raw ?? '')
    const access = c.get('access')
    access.assertRead(path)
    if (!access.canHistory(path)) throw new AccessError('the history of a note is for whoever can edit it')
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

  // Why it isn't available, as a code: what git said is the admin's, in the alerts.
  app.get('/api/history/status', (c) => {
    const s = history.status()
    return c.json({ ...s, error: s.error && { code: s.error.code, message: UNAVAILABLE_MESSAGE } })
  })

  app.get('/api/history/versions', async (c) => {
    const path = notePath(c, c.req.query('path'))
    const reader = readerOf(c)
    const page = await reader.versions(path, { cursor: c.req.query('cursor'), limit: limitOf(c) })
    const open = history.pendingOf(path)
    return c.json({
      versions: page.versions.map((v) => ({ ...v, authors: v.authors.map(author), reason: reason(v.reason) })),
      next: page.next,
      pending: open ? { authors: open.authors.map(author), since: new Date(open.since).toISOString() } : null,
      // Kept out of the managed history by vihko.yaml: what is listed is from before.
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
    const access = c.get('access')
    // The images it brings back: only from folders whoever asks can read, and to where they can write.
    const r = await notes.restoreVersion(path, { id: v.id, at: v.at, path: v.path, text: v.text }, {
      ifMatch, actor: access.actor, file: (p) => reader.file(v.id, p), canWrite: (p) => access.canWrite(p),
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
    const access = c.get('access')
    const actor: Actor = access.actor
    const ifMatch = body.ifMatch ?? unquote(c.req.header('if-match'))
    const r = await revertVersion({ reader: readerOf(c), notes, recorder: history.recorder }, path, body.id, {
      actor, ifMatch, dryRun: body.dryRun === true, guard: agentGuard(access, path),
    })
    // A revert that leaves the note hidden from the agent that made it stands, with `nowHidden` (scoped.ts).
    return c.json(written(c, revertWritten(r, () => {
      const nowHidden = hiddenAfterWrite(access, notes, path)
      return nowHidden ? { ...(ifMatch !== undefined ? { etag: r.etag } : {}), nowHidden } : { etag: r.etag }
    })))
  })

  app.get('/api/history/changes', async (c) => {
    const reader = readerOf(c)
    const access = c.get('access')
    const page = await reader.changes({ cursor: c.req.query('cursor'), limit: limitOf(c), author: c.req.query('author') || null, canRead: (p) => access.canHistory(p) })
    // The authors to filter by: an agent, those of what it sees; a person, the
    // people (every name is visible to everyone), their own agents and those of what they see.
    const authors = distinctAuthors([...(await reader.authors()), ...page.changes.flatMap((ch) => ch.authors)]).map(author)
    return c.json({
      changes: page.changes.map((ch) => ({ ...ch, authors: ch.authors.map(author), reason: reason(ch.reason) })),
      next: page.next,
      authors,
    })
  })

  // Purging from the UI (D-038.9): a note or one of its versions, by whoever
  // manages the folder it is in (a note deleted since, too: its history is
  // still there), never anything else (with `path` alone, that file only,
  // not what is under it; with `version`, only that note's content in that
  // version, whatever else the version changed); or any path by its name
  // (a file or a folder) by the vihko admin, who needn't read it. With
  // `dryRun`, what it would take out, for the confirmation. The history
  // pauses while it's rewritten; the admin gets a notice (who and what,
  // never the content), and so does every other person who wrote in what
  // went (D-040 3.6: its path only while they can read it). The admin
  // purging anything they can't read (the path, or a file under it) confirms
  // at the moment, as for a key (`confirmRequired` in the dry run says so).
  // The answer names no other path the person can't read, and nothing of
  // the content.
  app.post('/api/history/purge', async (c) => {
    const body = await c.req.json<{ path?: unknown; version?: unknown; dryRun?: unknown; confirm?: unknown }>()
    if (typeof body.path !== 'string' || (body.version !== undefined && typeof body.version !== 'string')) throw new HistoryError('invalid', 'expected a path and, optionally, a version')
    const access = c.get('access')
    const user = c.get('user')
    const admin = !access.isAgent && user.role === 'admin'
    // Whoever manages a folder purges notes (their path); the admin, any path.
    const path = admin ? purgeTarget(body.path) : NoteService.checkPath(body.path)
    const manages = !access.isAgent && path !== WORKSPACE_FILE && access.canManage(folderOf(path))
    if (!admin && !manages) {
      if (!access.isAgent && access.canRead(path)) throw new AccessError('purging a note\'s history is for whoever manages its folder')
      throw new NoteError('not_found', `does not exist: ${path}`)
    }
    const run = (dryRun: boolean) => history.purge({ path, version: body.version as string | undefined, dryRun, exact: !admin, by: user.id })
    // Whether it takes out anything the person can't read: only the admin gets that far with it.
    const blind = (p: PurgeReport) => !readablePath(access, p.path) || p.commits.some((v) => v.files.some((f) => !readablePath(access, f.path)))
    let r: PurgeReport
    if (body.dryRun === true) r = await run(true)
    else {
      if (admin && deps.confirm && blind(await run(true))) {
        const refused = await deps.confirm(c, body.confirm)
        if (refused) return refused
      }
      r = await run(false)
      // Whoever else wrote in it (people, not agents) is told, without the content.
      deps.notices?.purged(r.commits.flatMap((v) => v.people), user.id, r.path, r.version !== null)
    }
    const shown = (list: string[]) => list.filter((p) => access.canRead(p))
    return c.json({
      path: r.path,
      version: r.version,
      dryRun: r.dryRun,
      // The versions whose change it takes out, oldest first: when, and how many files (never their content).
      versions: r.commits.map((v) => ({ id: v.id, at: v.at, files: v.files.length, dropped: v.dropped })),
      filesRemoved: r.filesRemoved,
      // Files still in the folder: they enter the history again with their next version.
      onDisk: r.stillOnDisk.length,
      sharedWith: shown(r.sharedWith),
      movedFrom: shown(r.movedFrom),
      // The real purge will ask for the confirmation at the moment (the admin, something they can't read).
      ...(r.dryRun ? { confirmRequired: admin && !!deps.confirm && blind(r) } : {}),
    })
  })

  // The admin's notice of a purge, dismissed.
  app.delete('/api/history/purges/:id', (c) => {
    if (c.get('access').isAgent || c.get('user').role !== 'admin') throw new AccessError('admins only')
    if (!history.notices.dismiss(c.req.param('id'))) throw new HistoryError('not_found', 'no such notice')
    return c.json({ ok: true })
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

/** HTTP status for each purge error code. */
export function purgeErrorStatus(e: PurgeError) {
  return ({ history_unmanaged: 409, history_no_repository: 409, invalid_path: 400, invalid_version: 400, not_found: 404, not_a_version: 404, history_moved: 409 } as const)[e.code]
}

/**
 * The message a client gets with a purge error: its own, except the two that
 * carry what git said or where the state volume is (`vihko history purge`
 * shows them whole to whoever runs it): logged here.
 */
export function purgeClientMessage(e: PurgeError): string {
  if (e.code === 'history_moved') {
    console.error(`history: purge: ${e.message}`)
    return 'the history changed while it was being rewritten; nothing was changed'
  }
  if (e.code === 'history_no_repository') return 'there is no managed history yet'
  return e.message
}
