// Comment threads resolved from a note (D-023, D-032.5): the ones that left it
// in the last 30 days, found by comparing its versions. Only through the
// HistoryReader interface, so it works on any history (thoth's own, or the
// notes folder's git in unmanaged mode).
//
// - A thread was resolved by the version that removed it: its first comment
//   (author, date and text) was in the text before that version and is nowhere
//   in the version's text. The newest removal counts, and a thread whose first
//   comment is in the note now isn't resolved (it came back).
// - What isn't a version yet (managed mode: what was typed in the last
//   seconds) counts too: the note's text now against its newest version, by
//   whoever has it open. Resolving shows up at once, not when the version
//   closes.
// - Bounded work: versions come in pages and the walk stops 30 days back; only
//   versions that removed words are read (a thread can't leave otherwise),
//   each at most once: what a version removed is kept in memory (a version
//   never changes), so asking again only reads the new ones. One request reads
//   up to MAX_READS versions or for TIME_BUDGET_MS; past that it answers with
//   what it found and `complete: false`, and the next one goes on.
import { commentKey, goneThreads, parseComments, parseThreads, removedThread, reopener, type RemovedThread } from '@thoth/core/comments'
import type { AuthorRef, HistoryReader, RawVersion } from './reader.ts'

export const RESOLVED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const PAGE = 50
/** Versions listed in one request (a very busy note)… */
const MAX_LISTED = 2000
/** …versions read… */
const MAX_READS = 200
/** …and time spent reading, before answering with what was found. */
const TIME_BUDGET_MS = 2500
/** Versions whose removed threads are remembered. */
const CACHE = 5000

export interface ResolvedThread extends RemovedThread {
  resolvedAt: string
  /** The authors of the version that removed it (of what is still open, for a thread resolved seconds ago). */
  resolvedBy: AuthorRef[]
  /** That version; null: it isn't a version yet. */
  version: string | null
  /** Its text is still in the note: reopening puts it back there. */
  reopenable: boolean
}

interface Snapshot {
  /** The threads this version removed. */
  gone: RemovedThread[]
  /** The threads in its text; only for a note's newest version, which what is still open is compared with. */
  present: RemovedThread[] | null
}

/** Whether a version can have removed a thread: it removed words (or a reader didn't count them). */
function mayRemove(v: RawVersion) {
  return v.change !== 'deleted' && (v.removed > 0 || (v.added === 0 && v.change === 'modified'))
}

export class ResolvedThreads {
  private cache = new Map<string, Promise<Snapshot>>()
  private now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /**
   * The threads resolved from the note at `path` in the last 30 days, newest
   * first. `current`: its text now (null if it doesn't exist); `pending`: who
   * has changes that aren't a version yet (null: nothing open).
   */
  async list(reader: HistoryReader, path: string, opts: { current: string | null; pending: AuthorRef[] | null }): Promise<{ threads: ResolvedThread[]; complete: boolean }> {
    const started = this.now()
    const cutoff = started - RESOLVED_WINDOW_MS
    const here = new Set(opts.current === null ? [] : parseComments(opts.current).map(commentKey))
    const found = new Map<string, Omit<ResolvedThread, 'reopenable'>>()
    const record = (threads: RemovedThread[], at: string, by: AuthorRef[], version: string | null) => {
      for (const t of threads) if (!here.has(t.id) && !found.has(t.id)) found.set(t.id, { ...t, resolvedAt: at, resolvedBy: by, version })
    }
    const budget = { reads: 0, until: started + TIME_BUDGET_MS }
    let complete = true
    let cursor: string | null = null
    let listed = 0
    walk: for (;;) {
      const page = await reader.versions(path, { cursor, limit: PAGE })
      for (const v of page.versions) {
        const newest = listed++ === 0
        if (newest && opts.pending && opts.current !== null) {
          const s = await this.snapshot(reader, path, v, true, budget)
          record(s.present!, new Date(this.now()).toISOString(), opts.pending, null)
        }
        if (Date.parse(v.at) < cutoff) break walk
        if (listed > MAX_LISTED) { complete = false; break walk }
        // The newest is always read: it keeps the threads it has, for when something is open.
        if (!newest && !mayRemove(v)) continue
        if (!this.cache.has(key(v)) && (budget.reads >= MAX_READS || this.now() > budget.until)) { complete = false; break walk }
        record((await this.snapshot(reader, path, v, newest, budget)).gone, v.at, v.authors, v.id)
      }
      if (!page.next) break
      cursor = page.next
    }
    const reopen = opts.current === null ? () => null : reopener(opts.current)
    return { threads: [...found.values()].map((t) => ({ ...t, reopenable: reopen(t) !== null })), complete }
  }

  /** What version `v` removed (and, `withPresent`, the threads it has), read once. */
  private async snapshot(reader: HistoryReader, path: string, v: RawVersion, withPresent: boolean, budget: { reads: number }): Promise<Snapshot> {
    const k = key(v)
    const hit = this.cache.get(k)
    if (hit) {
      // Most recently used last: the oldest entries go first.
      this.cache.delete(k)
      this.cache.set(k, hit)
      const s = await hit
      if (!withPresent || s.present) return s
    }
    budget.reads++
    const p = reader.version(path, v.id).then((vt): Snapshot => {
      if (!vt || vt.text === null) return { gone: [], present: withPresent ? [] : null }
      const text = vt.text
      return {
        gone: vt.before === null ? [] : goneThreads(vt.before, text),
        present: withPresent ? parseThreads(text).map((t) => removedThread(text, t)) : null,
      }
    })
    this.cache.set(k, p)
    p.catch(() => { if (this.cache.get(k) === p) this.cache.delete(k) })
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!)
    return p
  }
}

const key = (v: RawVersion) => `${v.id}\0${v.path}`
