// Reading the managed history (the repository in the state volume). A note's
// versions follow its moves through the `Thoth-Move` trailers; authors come
// from `Thoth-Actor`. Reads run one at a time, in their own queue: a commit
// being written never makes the history page wait, and git itself is safe
// with one writer and readers at once.
import type { Author } from '../actor.ts'
import { LOG_FORMAT, Serial, parseLog, readObjects, resolveRef, type Git, type LogCommit, type RawFile } from './git.ts'
import { HISTORY_REF, isTextPath } from './recorder.ts'
import { movedFrom, parseMessage, type ParsedMessage } from './trailers.ts'
import { wordStats } from './diff.ts'
import { HistoryError, decodeCursor, encodeCursor, matchesAuthor, type AuthorRef, type ChangeKind, type HistoryReader, type RawChange, type RawVersion, type VersionText } from './reader.ts'

interface Step {
  commit: LogCommit
  file: RawFile
  /** The note's path in this commit. */
  path: string
  /** Where it was before, when this commit moved it here. */
  src: string | null
  meta: ParsedMessage
}

interface Resume { rev: string; path: string }

const isResume = (v: unknown): v is Resume => typeof v === 'object' && v !== null && typeof (v as Resume).rev === 'string' && typeof (v as Resume).path === 'string'
const isRev = (v: unknown): v is { rev: string } => typeof v === 'object' && v !== null && typeof (v as { rev: unknown }).rev === 'string'

/** Commits looked at for one page of «Recent changes» before answering with what was found. */
const MAX_SCAN = 2000
/** Versions walked to find one version of a note. */
const MAX_WALK = 20_000
const STATS_CACHE = 5000

export class ManagedReader implements HistoryReader {
  private git: Git
  private reads = new Serial()
  private stats = new Map<string, { added: number; removed: number }>()
  private authorsSeen: { head: string | null; list: Map<string, AuthorRef> } = { head: null, list: new Map() }

  constructor(git: Git) {
    this.git = git
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.reads.run(fn)
  }

  private async log(args: string[]): Promise<LogCommit[]> {
    const { stdout } = await this.git.run(['log', '-z', '--raw', '--no-renames', '--no-abbrev', LOG_FORMAT, ...args], { timeoutMs: 30_000 })
    return parseLog(stdout)
  }

  /** The note's commits from `start` (or HEAD) back, following its moves. */
  private async *walk(path: string, start: Resume | null, batch: number): AsyncGenerator<{ step: Step; resume: Resume }> {
    let rev = start?.rev ?? HISTORY_REF
    let cur = start?.path ?? path
    if (!start && (await resolveRef(this.git, HISTORY_REF)) === null) return
    for (;;) {
      const commits = await this.log(['-n', String(batch), rev, '--', cur])
      if (commits.length === 0) return
      let switched = false
      for (const c of commits) {
        const file = c.files.find((f) => f.path === cur)
        if (!file) continue
        const meta = parseMessage(c.message)
        const src = file.status === 'A' ? movedFrom(cur, meta.moves) : null
        yield { step: { commit: c, file, path: cur, src, meta }, resume: { rev: c.id, path: cur } }
        if (src && c.parent) {
          rev = c.parent
          cur = src
          switched = true
          break
        }
      }
      if (switched) continue
      const last = commits.at(-1)!
      if (commits.length < batch || !last.parent) return
      rev = last.parent
    }
  }

  versions(path: string, page: { cursor?: string | null; limit: number }) {
    return this.run(async () => {
      const start = decodeCursor(page.cursor, isResume)
      const steps: Step[] = []
      let next: string | null = null
      for await (const { step, resume } of this.walk(path, start, page.limit + 1)) {
        if (steps.length === page.limit) { next = encodeCursor(resume); break }
        steps.push(step)
      }
      const counts = await this.countAll(steps.map((s) => ({ path: s.path, before: beforeSpec(s), after: s.file.newOid })))
      const versions: RawVersion[] = steps.map((s, i) => ({
        id: s.commit.id,
        at: iso(s.commit.authorTime),
        authors: authorsOf(s.meta),
        reason: s.meta.reason,
        foundAtStartup: s.meta.foundAtStartup,
        path: s.path,
        change: changeOf(s),
        ...(s.src ? { from: s.src } : {}),
        ...counts[i]!,
      }))
      return { versions, next }
    })
  }

  version(path: string, id: string) {
    return this.run(async (): Promise<VersionText | null> => {
      let found: Step | null = null
      let walked = 0
      for await (const { step } of this.walk(path, null, 200)) {
        if (step.commit.id === id) { found = step; break }
        if (++walked >= MAX_WALK) break
      }
      if (!found) return null
      const before = beforeSpec(found)
      const specs = [before, found.file.newOid].filter((s): s is string => s !== null)
      const got = await readObjects(this.git, specs)
      const blob = (spec: string | null) => (spec === null ? null : got[specs.indexOf(spec)]?.toString('utf8') ?? null)
      return { path: found.path, id: found.commit.id, at: iso(found.commit.authorTime), text: blob(found.file.newOid), before: blob(before) }
    })
  }

  file(id: string, path: string) {
    return this.run(async () => {
      if (!/^[0-9a-f]{40}$/.test(id)) return null
      const [bytes] = await readObjects(this.git, [`${id}:${path}`])
      return bytes ?? null
    })
  }

  changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string) => boolean }) {
    return this.run(async () => {
      const start = decodeCursor(page.cursor, isRev)
      let rev = start?.rev ?? HISTORY_REF
      if (!start && (await resolveRef(this.git, HISTORY_REF)) === null) return { changes: [], next: null }
      const found: { commit: LogCommit; meta: ParsedMessage; files: PairedFile[] }[] = []
      let next: string | null = null
      let scanned = 0
      outer: for (;;) {
        const commits = await this.log(['-n', '100', rev])
        if (commits.length === 0) break
        for (const c of commits) {
          if (found.length === page.limit || scanned >= MAX_SCAN) { next = encodeCursor({ rev: c.id }); break outer }
          scanned++
          const meta = parseMessage(c.message)
          if (!matchesAuthor(authorsOf(meta), page.author)) continue
          const files = pairFiles(c.files, meta).filter((f) => page.canRead(f.path))
          if (files.length) found.push({ commit: c, meta, files })
        }
        const last = commits.at(-1)!
        if (commits.length < 100 || !last.parent) break
        rev = last.parent
      }
      const flat = found.flatMap((f) => f.files)
      const counts = await this.countAll(flat)
      let k = 0
      const changes: RawChange[] = found.map((f) => ({
        id: f.commit.id,
        at: iso(f.commit.authorTime),
        authors: authorsOf(f.meta),
        reason: f.meta.reason,
        foundAtStartup: f.meta.foundAtStartup,
        files: f.files.map((file) => ({ path: file.path, change: file.change, ...(file.from ? { from: file.from } : {}), ...counts[k++]! })),
      }))
      return { changes, next }
    })
  }

  authors() {
    return this.run(async () => {
      const head = await resolveRef(this.git, HISTORY_REF)
      if (head === null) return []
      if (this.authorsSeen.head !== head) {
        const range = this.authorsSeen.head ? `${this.authorsSeen.head}..${head}` : head
        const { stdout } = await this.git.run(['log', '--format=%B%x00', range], { timeoutMs: 120_000 })
        for (const message of stdout.toString('utf8').split('\0')) {
          for (const a of authorsOf(parseMessage(message.trim()))) this.authorsSeen.list.set(JSON.stringify(a), a)
        }
        this.authorsSeen.head = head
      }
      return [...this.authorsSeen.list.values()]
    })
  }

  /** Words added and removed for each file, between two blobs (text files only). */
  private async countAll(files: { path: string; before: string | null; after: string | null }[]): Promise<{ added: number; removed: number }[]> {
    const want = new Set<string>()
    for (const f of files) {
      if (!isTextPath(f.path) || f.before === f.after || this.stats.has(`${f.before}:${f.after}`)) continue
      if (f.before) want.add(f.before)
      if (f.after) want.add(f.after)
    }
    const specs = [...want]
    const blobs = new Map<string, string>()
    const read = await readObjects(this.git, specs)
    specs.forEach((s, i) => blobs.set(s, read[i]?.toString('utf8') ?? ''))
    return files.map((f) => {
      if (!isTextPath(f.path) || f.before === f.after) return { added: 0, removed: 0 }
      const key = `${f.before}:${f.after}`
      let s = this.stats.get(key)
      if (!s) {
        s = wordStats(f.before ? blobs.get(f.before) ?? '' : '', f.after ? blobs.get(f.after) ?? '' : '')
        this.stats.set(key, s)
        if (this.stats.size > STATS_CACHE) this.stats.delete(this.stats.keys().next().value!)
      }
      return s
    })
  }
}

interface PairedFile { path: string; change: ChangeKind; from?: string; before: string | null; after: string | null }

/** A commit's files as versions: a removal and an addition that a `Thoth-Move` names are one file moved. */
function pairFiles(raw: RawFile[], meta: ParsedMessage): PairedFile[] {
  const deleted = new Map(raw.filter((f) => f.status === 'D').map((f) => [f.path, f]))
  const restored = meta.reason?.code === 'restored' || meta.reason?.code === 'trash_restored'
  const out: PairedFile[] = []
  for (const f of raw) {
    if (f.status === 'D') continue
    const src = f.status === 'A' ? movedFrom(f.path, meta.moves) : null
    const gone = src ? deleted.get(src) : undefined
    if (src && gone) {
      deleted.delete(src)
      out.push({ path: f.path, change: 'moved', from: src, before: gone.oldOid, after: f.newOid })
      continue
    }
    const change: ChangeKind = restored && isTextPath(f.path) ? 'restored' : f.status === 'A' ? 'created' : 'modified'
    out.push({ path: f.path, change, before: f.oldOid, after: f.newOid })
  }
  for (const d of deleted.values()) out.push({ path: d.path, change: 'deleted', before: d.oldOid, after: null })
  return out
}

function changeOf(s: Step): ChangeKind {
  const code = s.meta.reason?.code
  if ((code === 'restored' || code === 'trash_restored') && s.file.status !== 'D') return 'restored'
  if (s.file.status === 'D') return 'deleted'
  if (s.src) return 'moved'
  return s.file.status === 'A' ? 'created' : 'modified'
}

/** What the note was right before this step: the moved-from file in the parent, or the same path's old blob. */
function beforeSpec(s: Step): string | null {
  if (s.src) return s.commit.parent ? `${s.commit.parent}:${s.src}` : null
  return s.file.oldOid
}

function authorsOf(meta: ParsedMessage): AuthorRef[] {
  return meta.parsedAuthors.length ? meta.parsedAuthors.map((a: Author) => a) : [{ kind: 'system' }]
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export { HistoryError }
