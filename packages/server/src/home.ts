// «Home»: what a person finds when they come in. Everything comes
// from what vihko already keeps (the index, the history and their notices):
// nothing is stored for it, in the notes folder or anywhere else. And nothing
// of it is anything they can't read now: each note is asked of their access
// at the moment.
//
// - `recent`: notes they changed lately, from the history (theirs, and their
//   agents'); without a history, the notes of their own space changed last.
// - `changed`: what others changed lately in notes they read. Where they may
//   see the history (`edit`), from it, with who did it; where they only read
//   (or without a history), from the index, by when the file last changed,
//   without a name (that is the history's to say). Never their own
//   space's notes by the index alone: those are theirs.
// - `shared`: what someone added them to or shared with them in the last
//   days (their `shared_with_you` notices, while they can see it), newest
//   first. Dismissing the notice takes it off.
import { parseSpacePath, personalRoot } from '@vihko/core'
import type { Access } from './access.ts'
import type { AuthorRef, HistoryReader } from './history/index.ts'
import type { Db } from './db.ts'
import type { Notices } from './notices.ts'

/** How many notes each list has at most. */
export const HOME_LIST = 8
/** How far back «shared with you» goes. */
export const HOME_SHARED_DAYS = 30
/** How many changes of the history are looked at (newest first). */
const HISTORY_PAGE = 200
/** How many notes of the index, by when they changed, are looked at. */
const INDEX_PAGE = 400

export interface HomeNote {
  path: string
  title: string
  /** When it changed (ISO). */
  at: string
}

export interface HomeView {
  recent: HomeNote[]
  /** `by`: who changed it (a person's name, or an agent's key name and whose); null when not said. */
  changed: (HomeNote & { by: { kind: 'user' | 'agent' | 'external'; name: string | null; onBehalfOf?: string } | null })[]
  shared: { kind: 'space' | 'folder'; path: string; name: string; owner: string | null; by: string; at: string }[]
}

export interface HomeDeps {
  index: Db
  /** The history as this person may read it (agentHistory.ts `historyFor`); null when it's off or can't be read. */
  history: HistoryReader | null
  notices: Notices
  nameOf: (userId: string) => string
  keyName: (keyId: string) => string | null
  now: () => Date
  /** Notes left out (templates: skeletons, not notes anyone wrote). */
  excluded?: (path: string) => boolean
}

/** Whether a history author is the person, or an agent acting for them. */
const isMe = (a: AuthorRef, me: string) => (a.kind === 'user' && a.id === me) || (a.kind === 'agent' && a.onBehalfOf === me)

/** What `access`'s person finds at Home (see the header). */
export async function homeView(access: Access, deps: HomeDeps): Promise<HomeView> {
  const me = access.user
  const title = deps.index.prepare('select title from notes where path = ?')
  const titleOf = (path: string) => (title.get(path) as { title: string } | undefined)?.title ?? null
  const readable = (path: string) => /\.md$/i.test(path) && access.canRead(path) && !deps.excluded?.(path) && titleOf(path) !== null
  const recent: HomeNote[] = []
  const changed: HomeView['changed'] = []
  const seenRecent = new Set<string>()
  const seenChanged = new Set<string>()

  let historyRead = false
  if (deps.history) {
    try {
      const page = await deps.history.changes({ limit: HISTORY_PAGE, canRead: (p) => access.canHistory(p) && access.canRead(p) })
      historyRead = true
      for (const ch of page.changes) {
        const mine = ch.authors.some((a) => isMe(a, me.id))
        const other = ch.authors.find((a) => !isMe(a, me.id) && (a.kind === 'user' || a.kind === 'agent' || a.kind === 'external'))
        for (const f of ch.files) {
          if (f.change === 'deleted' || !readable(f.path)) continue
          if (mine && !seenRecent.has(f.path) && recent.length < HOME_LIST) {
            seenRecent.add(f.path)
            recent.push({ path: f.path, title: titleOf(f.path)!, at: ch.at })
          }
          if (other && !seenChanged.has(f.path)) {
            seenChanged.add(f.path)
            const by = other.kind === 'user' ? { kind: 'user' as const, name: deps.nameOf(other.id) }
              : other.kind === 'agent' ? { kind: 'agent' as const, name: deps.keyName(other.id), onBehalfOf: deps.nameOf(other.onBehalfOf) }
              : { kind: 'external' as const, name: null }
            changed.push({ path: f.path, title: titleOf(f.path)!, at: ch.at, by })
          }
        }
      }
    } catch {
      // The history can't be read now: Home goes by the index alone.
      historyRead = false
    }
  }

  // The index: when each note's file last changed.
  const own = personalRoot(me.username)
  // Only among what they read, in the query: notes they can't read, however many changed, never push theirs out.
  const w = access.notesWhere('n')
  const rows = deps.index.prepare(`select n.path, n.title, n.mtime_ms from notes n where ${w.sql} order by n.mtime_ms desc limit ?`).all(...w.params, INDEX_PAGE) as { path: string; title: string; mtime_ms: number }[]
  for (const r of rows) {
    if (!access.canRead(r.path) || deps.excluded?.(r.path)) continue
    const inOwn = parseSpacePath(r.path)?.space.root === own
    const at = new Date(r.mtime_ms).toISOString()
    if (!historyRead && inOwn && recent.length < HOME_LIST && !seenRecent.has(r.path)) {
      seenRecent.add(r.path)
      recent.push({ path: r.path, title: r.title, at })
    }
    // Where the history says who (`edit`), it already has; elsewhere, when, without a name.
    if (inOwn || seenChanged.has(r.path) || (historyRead && access.canHistory(r.path))) continue
    seenChanged.add(r.path)
    changed.push({ path: r.path, title: r.title, at, by: null })
  }
  changed.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  // What was shared with them lately, while they can see it.
  const since = deps.now().getTime() - HOME_SHARED_DAYS * 86_400_000
  const shared: HomeView['shared'] = []
  for (const n of deps.notices.of(me.id).reverse()) {
    const d = n.data
    if (d.code !== 'shared_with_you' || Date.parse(n.at) < since) continue
    const s = parseSpacePath(d.path)
    if (!s || access.level(d.path) === null) continue
    const name = d.kind === 'space' && s.space.kind === 'shared' ? s.space.name : d.path.slice(d.path.lastIndexOf('/') + 1)
    shared.push({ kind: d.kind, path: d.path, name, owner: s.space.kind === 'personal' ? s.space.owner : null, by: deps.nameOf(d.by), at: n.at })
    if (shared.length >= HOME_LIST) break
  }

  return { recent: recent.slice(0, HOME_LIST), changed: changed.slice(0, HOME_LIST), shared }
}
