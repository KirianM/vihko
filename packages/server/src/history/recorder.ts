// The managed history's recorder (D-016, D-032, D-033): turns every change to
// the notes folder into versions with their authors, and commits them to a
// git repository of vihko's own in the state volume (`history.git`).
//
// Product rules it implements (docs: M2 specification, §3 and §4):
// - What people type in the editor accumulates in one open version per note
//   (the hub reports who typed and each flush), closed after `quietMs`
//   without changes or `maxOpenMs` after it opened. Someone who starts
//   writing where others were closes their version first, with the text
//   from right before their change, and starts one of their own (D-034 3.4);
//   whoever was already writing goes on in it with them.
// - Any other write is its own version, and right before it whatever was
//   pending on that file is closed with the content from before the write:
//   there is always «the version right before the agent». Writes in a row by
//   the same user or agent with the same reason accumulate with the same
//   30 s / 5 min rule.
// - System operations (moves with their link rewrites, restores…) are one
//   commit at once with everything they touched (`operation`).
// - A content that isn't the last one vihko knows for a path is an external
//   change, by `external`: whatever else was pending on the path closes
//   first. External changes in a row to one file accumulate in one open
//   version with the same 30 s / 5 min rule (an editor that saves on every
//   pause), and any write of vihko's to that file closes it first. External
//   versions that close together are one commit. Moves and deletions made
//   outside, and what vihko finds at startup, are versions at once. vihko's
//   own writes are expected before anything can see them on disk.
// - What `vihko history purge` took out of the history and the folder still
//   holds is known by its content (the journal's `baseline`), not recorded
//   again at startup; it enters with the file's next version.
// - Paths excluded in vihko.yaml (`history.exclude`) aren't there for the
//   recorder: nothing about them is recorded (a file moved into one leaves
//   the history, one moved out of it enters), and what is stored stays.
// - A kill -9 loses no authorship: what is pending, and the commits not yet
//   in git, live in a journal in the state volume (temporary file, fsync,
//   rename), confirmed against the files when vihko starts. What git itself
//   was writing when the kill came (its lock files, a pack half done) is
//   removed before anything else runs on the repository (leftovers.ts).
// - The history never blocks or fails a note write: if git fails, the note is
//   written, the commit waits in the journal and is retried, and there is an
//   alert (`history_unavailable`). If it fails for so long that 5,000 commits
//   wait, the oldest are merged into later ones: versions lose granularity,
//   never content or authors, and there is an alert while it lasts
//   (`history_versions_merged`).
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKSPACE_FILE, classifyPath, isIgnoredDir, type Alert, type HistoryMode } from '@vihko/core'
import { authorKey, authorOf, parseAuthorKey, reasonJson, type Actor, type Author, type Reason } from '../actor.ts'
import { Git, GitError, Serial, blobOid, fastImport, readTree, resolveRef, type FastCommit, type FastOp } from './git.ts'
import { removeCrashLeftovers } from './leftovers.ts'
import { spelledAsOnDisk } from '../fsutil.ts'
import { formatMessage } from './trailers.ts'

export const HISTORY_REF = 'refs/heads/main'

export interface RecorderOptions {
  notesDir: string
  /** State volume: the repository is `history.git`, the journal and caches go in `history/`. */
  stateDir: string
  /** Largest file that enters the history, in bytes (asked every time: vihko.yaml can change it). */
  maxFileBytes: () => number
  /**
   * Paths kept out of the history (`history.exclude`; asked every time). The
   * recorder sees the folder as if they weren't there: nothing about them is
   * recorded, and what is already stored stays.
   */
  excluded?: (path: string) => boolean
  /** The git binary. */
  git?: string
  /** An open version closes after this long without changes (30 s)… */
  quietMs?: number
  /** …or this long after it opened (5 min). */
  maxOpenMs?: number
  /** How often open versions are checked (1 s). */
  tickMs?: number
  /** The full sweep of the folder against the history (1 h). */
  sweepMs?: number
  /** First wait before retrying git after a failure (doubles up to 5 min). */
  retryMs?: number
  /** Commits between two background `git gc --auto`. */
  gcEvery?: number
  /** Commits that wait for git (it keeps failing) before the oldest are merged into later ones (5,000). */
  queueMax?: number
  /** The name git shows for an author (the user's current name). */
  nameOf?: (author: Author) => string
  log?: (msg: string) => void
  now?: () => number
}

/** A change a writer makes (or is about to make) to one path. */
export interface FileChange {
  path: string
  /**
   * What the disk held right before the write, when the writer read it (null:
   * nothing there), at `from` for a rename. If the history doesn't know it,
   * it's an external change, recorded before this write.
   */
  before?: string | null
  /** The new content (text for notes, bytes otherwise); null: the file is gone. Undefined with `from`: renamed as it was. */
  after?: string | Uint8Array | null
  /** It comes from this path: a file renamed (or a whole folder, with `folder`). */
  from?: string
  folder?: boolean
}

/** A write in progress: `done` once it reached disk (optionally with what it finally did), `abort` if it didn't happen. */
export interface WriteHandle {
  done(changes?: FileChange[]): void
  abort(): void
}

/** What the indexer applied: notes with their text, removed notes and moves it detected. */
export interface IndexedChanges {
  upserts: { path: string; text: string; mtimeMs: number }[]
  removed: string[]
  moved: { from: string; to: string }[]
}

type ReasonData = Record<string, unknown> | null

/** One file in a commit waiting for git. */
export interface QChange {
  path: string
  /** Renamed from (a folder, with `folder`). */
  from?: string
  folder?: boolean
  /** The content's blob id; null: deleted; undefined (with `from`): renamed unchanged. */
  oid?: string | null
  /** The content, for text files. */
  text?: string
  /** The content is read from the file when committing (it must still have `oid`). */
  file?: boolean
}

export interface QCommit {
  authors: string[]
  reason: ReasonData
  /** Author time, ms. */
  at: number
  foundAtStartup?: boolean
  changes: QChange[]
}

/** A version still open on one path. */
export interface Pending {
  /** `typed`: from the editor; `write`: writes of one user or agent with one reason; `external`: changes made outside vihko. */
  kind: 'typed' | 'write' | 'external'
  key: string
  authors: string[]
  reason: ReasonData
  since: number
  last: number
  /** An external version's author time: its last change's mtime, bounded by the version before it and by when it was seen. */
  at?: number
  /** What the history knew for the path before it opened. */
  base: string | null
  /** Contents vihko wrote (or saw, external) for it, in order (the last one is the version's). */
  oids: string[]
  /** The last content, for text files. */
  text: string
  /** Bytes, not text (an external change to an image): not in the journal, read from the file when committed. */
  file?: boolean
}

/** An operation that commits everything it touched at once. */
interface Group {
  authors: string[]
  reason: ReasonData
  changes: Map<string, QChange>
}

export interface Journal {
  version: 1
  mode: HistoryMode
  typing: Record<string, string[]>
  pending: Record<string, Pending>
  queue: QCommit[]
  /** A fast-import started on top of `parent` with the first `count` commits of the queue. */
  inflight: { parent: string | null; count: number } | null
  /** Operations under way: the files they wrote so far (without contents). */
  groups: { authors: string[]; reason: ReasonData; refs: { path: string; oid: string | null }[] }[]
  /** Writes to disk under way: who, why and what each file will hold (without contents). */
  writes: { authors: string[]; reason: ReasonData; changes: QChange[] }[]
  /** The queue reached its cap: how many commits were merged into later ones, and since when (ms). */
  merged: { count: number; since: number } | null
  /**
   * What the files hold now for paths `vihko history purge` rewrote (path →
   * blob id): known without being in git, so what the purge took out of the
   * history and is still on disk isn't recorded again as a change made with
   * vihko stopped. It enters with the file's next version.
   */
  baseline?: Record<string, string>
}

/** Where the recorder keeps its journal and its cache of the sweep's `stat`s, in the state volume. */
export const journalFile = (stateDir: string) => join(stateDir, 'history', 'journal.json')
export const cacheFile = (stateDir: string) => join(stateDir, 'history', 'files.json')
/** The managed repository. */
export const repositoryDir = (stateDir: string) => join(stateDir, 'history.git')

interface CacheEntry { size: number; mtimeMs: number; ctimeMs: number; ino: number; oid: string; checkedAt: number }

export type SweepKind = 'startup' | 'periodic' | 'enabled' | 'resumed'

const NOOP: WriteHandle = { done() {}, abort() {} }
const OWN_TTL = 5 * 60_000
const OWN_MAX = 16
const QUEUE_MAX = 5000
const BATCH = 64
/** Contents kept in memory for queued commits, to avoid reading files twice. */
const BLOB_CACHE_BYTES = 64 * 1024 * 1024
const CONCURRENCY = 16

/** Tests only: `VIHKO_TEST_CRASH_AT=<point>` kills the process there, like a kill -9 landing at that moment. */
export function crashPoint(point: string, paths?: Iterable<string>) {
  if (process.env.VIHKO_TEST_CRASH_AT !== point) return
  // With VIHKO_TEST_CRASH_PATH, only for what touches that path: a system commit at startup doesn't set it off.
  const only = process.env.VIHKO_TEST_CRASH_PATH
  if (only && paths && ![...paths].includes(only)) return
  process.kill(process.pid, 'SIGKILL')
}

/**
 * Tests only: `VIHKO_TEST_CRASH_AT=history-importing` kills git in the middle
 * of a commit, holding the history's ref lock, and vihko with it (a kill -9 of
 * the whole container at the worst moment). git's reference-transaction hook
 * runs once the locks are taken and before the ref moves; the history's git
 * runs no other hook.
 */
function crashHooks(dir: string): Record<string, string> {
  if (process.env.VIHKO_TEST_CRASH_AT !== 'history-importing') return {}
  const hooks = join(dir, 'test-hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'reference-transaction')
  // With VIHKO_TEST_CRASH_PATH, only when what comes in touches that path (as crashPoint).
  const only = process.env.VIHKO_TEST_CRASH_PATH
  const filter = only === undefined ? '' : [
    'hit=0',
    'while read old new ref; do',
    '  case "$old" in *[!0]*) range="$old..$new" ;; *) range="$new" ;; esac',
    `  git log --name-only --format= "$range" | grep -qxF ${JSON.stringify(only)} && hit=1`,
    'done',
    '[ "$hit" = 1 ] || exit 0',
  ].join('\n') + '\n'
  writeFileSync(hook, `#!/bin/sh\n[ "$1" = prepared ] || exit 0\n${filter}kill -9 ${process.pid} "$PPID"\n`)
  chmodSync(hook, 0o755)
  return { 'core.hooksPath': hooks }
}

/** Whether a path of the notes folder can have a history: not ignored by the indexer, and a name git and the trailers can hold. */
export function historyPath(path: string): boolean {
  return path !== '' && !/[\u0000-\u001f\u007f]/.test(path) && classifyPath(path) !== 'ignored'
}

/** Notes (and vihko.yaml) are kept as text; anything else as bytes. */
export function isTextPath(path: string): boolean {
  const k = classifyPath(path)
  return k === 'note' || k === 'conflict' || path === WORKSPACE_FILE
}

/** Writes a whole file in one step: temporary file, fsync, rename. */
export function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

const writeKey = (authors: string[], reason: ReasonData) => `${authors.join(',')}|${reason ? JSON.stringify(reason) : ''}`
const under = (path: string, dir: string) => path.startsWith(dir + '/')

export class Recorder {
  readonly git: Git
  private opts: RecorderOptions
  private dir: string
  private journalFile: string
  private cacheFile: string
  private log: (m: string) => void
  private now: () => number

  private mode: HistoryMode = 'managed'
  /** Managed and able to read the repository: events are recorded. */
  private recording = false
  /** After `start`: the startup sweep ran, observations count. */
  private started = false
  private ready = false

  private head: string | null = null
  private headTime = 0
  /** The files at `head`. */
  private committed = new Map<string, string>()
  /** The files at `head` with the queued commits applied. */
  private tree = new Map<string, string>()
  private lastAt = new Map<string, number>()
  private pending = new Map<string, Pending>()
  private typists = new Map<string, Set<string>>()
  /**
   * Who has been typing in each note since it was last quiet (in memory
   * only): a person already writing there doesn't close the open version
   * when they go on in someone else's (`typing`).
   */
  private writers = new Map<string, { keys: Set<string>; last: number }>()
  private queue: QCommit[] = []
  private inflight: Journal['inflight'] = null
  private groups = new Map<Actor, Group>()
  /** Journaled refs of operations cut short by a crash, confirmed at `start`. */
  private leftoverGroups: Journal['groups'] = []
  /** Writes to disk under way (between `prepare` and `done`), journaled. */
  private writesInFlight = new Map<number, Journal['writes'][number]>()
  private writeSeq = 0
  /** Writes a crash cut short, confirmed at `start`. */
  private leftoverWrites: Journal['writes'] = []
  private own = new Map<string, { oid: string | null; at: number }[]>()
  private blobs = new Map<string, Uint8Array>()
  private blobBytes = 0
  private tooLarge = new Map<string, number>()
  private statCache = new Map<string, CacheEntry>()
  /** Paths recorded while a sweep runs: its view of them may be stale. */
  private touched: Set<string> | null = null
  private sweeping: Promise<void> | null = null
  private draining: Promise<void> | null = null
  private error: { code: string; message: string } | null = null
  private retryDelay: number
  private retryTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Immediate | null = null
  private writes = new Serial()
  private sinceGc = 0
  /** The `git gc` running now: stopped on close. */
  private gc: { stop: AbortController; done: Promise<void> } | null = null
  /** After git was unavailable: the first sweep records what changed meanwhile, unattributed. */
  private resumeOnReady = false
  /** Commits merged at the queue's cap, until the queue is in git again. */
  private merged: Journal['merged'] = null
  /** Contents known without being in git (see `Journal.baseline`), until the path's next version. */
  private baseline = new Map<string, string>()
  private closed = false
  /** A purge is rewriting the repository (`purging`): nothing goes to git, and no sweep runs, until it ends. */
  private paused = false

  constructor(opts: RecorderOptions) {
    this.opts = opts
    this.dir = join(opts.stateDir, 'history')
    this.journalFile = journalFile(opts.stateDir)
    this.cacheFile = cacheFile(opts.stateDir)
    this.git = new Git({ gitDir: repositoryDir(opts.stateDir), binary: opts.git, config: crashHooks(this.dir) })
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
    this.retryDelay = opts.retryMs ?? 5000
  }

  // --- Lifecycle ------------------------------------------------------------------

  /**
   * Loads the journal and the repository. Before the hub recovers its notes
   * (their flushes are recorded into what the journal left pending), before
   * `start`.
   */
  async open(mode: HistoryMode) {
    mkdirSync(this.dir, { recursive: true })
    // Before any git command, whatever the mode: what a crash left in vihko's
    // own repository (a stale lock would fail every commit). Whoever opens the
    // recorder holds the state volume's lock (main.ts), so no other vihko
    // process is using it.
    removeCrashLeftovers(this.git.gitDir, this.log)
    const j = this.readJournal()
    const lastMode = j?.mode ?? null
    if (j) {
      for (const [p, list] of Object.entries(j.typing)) this.typists.set(p, new Set(list))
      for (const [p, entry] of Object.entries(j.pending)) this.pending.set(p, entry)
      this.queue = j.queue
      this.inflight = j.inflight
      this.leftoverGroups = j.groups
      this.leftoverWrites = j.writes
      this.merged = j.merged
      this.baseline = new Map(Object.entries(j.baseline ?? {}))
    }
    this.readCache()
    this.mode = mode
    const repoExisted = existsSync(join(this.git.gitDir, 'HEAD'))
    // Whatever the journal holds was recorded while managed: it's committed even if the history is now off.
    if (mode === 'managed' || this.queue.length || this.pending.size) await this.ensureReady()
    this.recording = mode === 'managed'
    // Coming back from off or unmanaged: what changed meanwhile is nobody's.
    if (mode === 'managed' && repoExisted && lastMode !== null && lastMode !== 'managed') this.resumeOnReady = true
  }

  /**
   * After the hub recovered its notes: confirms what the journal left pending
   * against the files, then sweeps the folder against the history (external
   * changes made while vihko was stopped), and starts the timers.
   */
  async start() {
    if (this.mode !== 'managed') {
      await this.stopRecording()
      this.started = true
      return
    }
    this.confirmJournal()
    this.started = true
    if (this.ready) await this.sweep(this.startKind())
    else this.resumeOnReady = true
    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000)
    this.tickTimer.unref()
    this.sweepTimer = setInterval(() => { this.sweep('periodic').catch((e) => this.log(`history sweep: ${e}`)) }, this.opts.sweepMs ?? 3_600_000)
    this.sweepTimer.unref()
    this.scheduleDrain()
  }

  private startKind(): SweepKind {
    if (this.head === null && this.queue.length === 0) return 'enabled'
    if (this.resumeOnReady) { this.resumeOnReady = false; return 'resumed' }
    return 'startup'
  }

  /** vihko.yaml changed: from managed to off (or unmanaged) stops recording; back to managed resumes. */
  async configure(mode: HistoryMode) {
    if (mode === this.mode) return
    const was = this.mode
    this.mode = mode
    this.log(`history: ${was} → ${mode}`)
    if (was === 'managed') return this.stopRecording()
    if (mode !== 'managed') return
    this.own.clear()
    this.recording = true
    this.saveJournal()
    if (!this.started) return
    if (await this.ensureReady()) await this.sweep(this.head === null && this.queue.length === 0 ? 'enabled' : 'resumed')
    else this.resumeOnReady = true
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000)
      this.tickTimer.unref()
    }
  }

  /** What was recorded goes to git; nothing more is recorded. The repository stays. */
  private async stopRecording() {
    this.closeMany([...this.pending.keys()])
    this.typists.clear()
    this.writers.clear()
    this.recording = false
    this.saveJournal()
    await this.drain()
  }

  async close() {
    this.closed = true
    for (const t of [this.tickTimer, this.sweepTimer, this.retryTimer]) if (t) clearInterval(t)
    if (this.saveTimer) clearImmediate(this.saveTimer)
    await this.draining
    // A gc stopped with SIGTERM removes its own locks; it's done again later.
    if (this.gc) {
      this.gc.stop.abort()
      await this.gc.done
    }
    if (existsSync(this.dir)) this.saveJournal()
  }

  /** Initializes and reads the repository; false (with the error kept) if git can't. */
  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true
    try {
      // `git init` writes HEAD before it creates `objects/`: one cut short in between is finished by running it again.
      if (!['HEAD', 'objects', 'refs'].every((f) => existsSync(join(this.git.gitDir, f)))) {
        await this.git.run(['init', '--bare', '-q', '--initial-branch=main', this.git.gitDir], { bare: true })
      }
      await this.reload()
      if (this.inflight) {
        // The ref only moves when a whole fast-import went through: if it moved, that batch is in.
        if (this.head !== this.inflight.parent) this.queue.splice(0, this.inflight.count)
        this.inflight = null
        this.rebuildTree()
        this.saveJournal()
      }
      this.ready = true
      this.clearError()
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  private async reload() {
    this.head = await resolveRef(this.git, HISTORY_REF)
    this.committed = this.head ? await readTree(this.git, this.head) : new Map()
    if (this.head) {
      const { stdout } = await this.git.run(['log', '-1', '--format=%at', this.head])
      this.headTime = Number(stdout.toString('latin1').trim()) * 1000
    }
    this.rebuildTree()
  }

  private rebuildTree() {
    this.tree = new Map(this.committed)
    for (const q of this.queue) this.applyToTree(q)
  }

  // --- Status -------------------------------------------------------------------------

  /**
   * Whether events are recorded: managed, with the repository read. Without
   * it (git missing from the start) nothing is known to compare with; when
   * git comes back, a sweep records what changed meanwhile, unattributed.
   */
  private get live(): boolean {
    return this.recording && this.ready
  }

  get available(): boolean {
    return this.mode === 'managed' && this.ready && this.error === null
  }

  get lastError(): { code: string; message: string } | null {
    return this.error
  }

  /** Alerts for «Alerts» (codes; the UI words them). */
  alerts(): Alert[] {
    const out: Alert[] = []
    if (this.mode === 'managed' && this.error) out.push({ code: 'history_unavailable', detail: this.error.message, actions: [] })
    if (this.mode === 'managed' && this.tooLarge.size) {
      out.push({ code: 'history_files_too_large', paths: [...this.tooLarge.keys()].sort(), limitMb: Math.round((this.opts.maxFileBytes() / 1048576) * 100) / 100, actions: [] })
    }
    if (this.mode === 'managed' && this.merged) out.push({ code: 'history_versions_merged', versions: this.merged.count, since: new Date(this.merged.since).toISOString(), actions: [] })
    return out
  }

  /** What is still open on a path (not yet a version): who and since when. */
  pendingOf(path: string): { authors: Author[]; since: number } | null {
    const p = this.pending.get(path)
    const typing = this.typists.get(path)
    if (!p && !typing?.size) return null
    const keys = new Set([...(p?.authors ?? []), ...(typing ?? [])])
    return { authors: [...keys].map(parseAuthorKey).filter((a): a is Author => a !== null), since: p?.since ?? this.now() }
  }

  /** The commit the history is at (for readers that cache by it). */
  get headId(): string | null {
    return this.head
  }

  /** Waits until everything recorded so far is in git (tests, shutdown). */
  async settle() {
    while (this.draining || (this.queue.length && this.ready && !this.error)) {
      if (!this.draining) this.scheduleDrain(0)
      await (this.draining ?? new Promise((r) => setTimeout(r, 10)))
    }
  }

  /** Closes every open version now (tests; the timers do it otherwise). */
  closeAll() {
    this.closeMany([...this.pending.keys()])
    this.scheduleDrain(0)
  }

  // --- A purge while vihko runs (D-038.9) ----------------------------------------------

  /**
   * Runs `rewrite` (history/purge.ts, with the lock this process already
   * holds) with the history paused: what is on its way to git gets there
   * first, then nothing more goes to git and no sweep runs until it ends.
   * Notes are still written meanwhile, and recorded: their versions wait in
   * the queue (and the journal), as when git is unavailable. Afterwards the
   * recorder forgets what the purge took out, as `vihko history purge` does
   * with the journal when vihko is stopped: the open versions, typing and
   * queued changes of the purged paths (`forget`), and their cached `stat`s;
   * it reads the rewritten history, and what the notes folder still holds
   * for a purged path (`pathsOnDisk`), if it's what the history knew before
   * and not what it knows now, stays known by its content (`baseline`): it
   * enters with the file's next version, never as a change made outside.
   */
  async purging<T>(rewrite: () => Promise<{ result: T; forget: (path: string) => boolean; pathsOnDisk: string[] }>): Promise<{ result: T; stillOnDisk: string[]; counts: { pending: number; queued: number } }> {
    if (this.paused) throw new Error('a purge is already running')
    this.paused = true
    try {
      await this.draining
      await this.sweeping
      if (this.gc) {
        this.gc.stop.abort()
        await this.gc.done
      }
      const { result, forget, pathsOnDisk } = await rewrite()
      // What the recorder knew for those paths before the purge, and what the folder holds.
      const onDisk = new Map<string, string>()
      for (const p of pathsOnDisk) {
        const content = this.readNow(p)
        if (content !== null) onDisk.set(p, blobOid(content))
      }
      const before = new Map([...onDisk.keys()].map((p) => [p, this.known(p)]))
      const counts = { pending: 0, queued: 0 }
      for (const p of [...this.pending.keys()]) if (forget(p)) { this.pending.delete(p); counts.pending++ }
      for (const p of [...this.typists.keys()]) if (forget(p)) this.typists.delete(p)
      for (const p of [...this.writers.keys()]) if (forget(p)) this.writers.delete(p)
      for (const g of this.groups.values()) for (const p of [...g.changes.keys()]) if (forget(p)) g.changes.delete(p)
      const kept = (c: QChange): QChange | null => {
        if (forget(c.path)) { counts.queued++; return null }
        if (c.from === undefined || !forget(c.from)) return c
        // A rename from a purged path: only its content is left to say.
        const { from: _from, folder: _folder, ...rest } = c
        return rest.oid === undefined ? null : rest
      }
      this.queue = this.queue.map((q) => ({ ...q, changes: q.changes.map(kept).filter((c): c is QChange => c !== null) })).filter((q) => q.changes.length)
      for (const [id, w] of [...this.writesInFlight]) {
        const changes = w.changes.filter((c) => !forget(c.path) && !(c.from !== undefined && forget(c.from)))
        if (changes.length) this.writesInFlight.set(id, { ...w, changes })
        else this.writesInFlight.delete(id)
      }
      for (const p of [...this.baseline.keys()]) if (forget(p) || onDisk.has(p)) this.baseline.delete(p)
      for (const p of [...this.statCache.keys()]) if (forget(p) || pathsOnDisk.includes(p)) this.statCache.delete(p)
      for (const p of [...this.tooLarge.keys()]) if (forget(p)) this.tooLarge.delete(p)
      await this.reload()
      const stillOnDisk: string[] = []
      for (const [p, oid] of onDisk) {
        if (this.known(p) === oid) continue
        stillOnDisk.push(p)
        // Only what the history knew already: a change it hadn't seen yet is still one.
        if (oid === before.get(p)) this.baseline.set(p, oid)
      }
      this.saveJournal()
      this.saveCache()
      this.log(`history: purged; ${counts.pending} open and ${counts.queued} queued changes of what was purged dropped`)
      return { result, stillOnDisk, counts }
    } finally {
      this.paused = false
      this.scheduleDrain(0)
    }
  }

  // --- Recording: the collaboration hub -----------------------------------------

  /**
   * Whether `actor` starting to type in `path` now closes the open version
   * (D-034 3.4): what others typed is open (a version, or typing not yet
   * flushed) and they aren't in it, nor among those who have been writing
   * in the note since it was last quiet (`writers`).
   */
  startsVersion(path: string, actor: Actor): boolean {
    if (!this.live || !this.takes(path)) return false
    const key = authorKey(authorOf(actor))
    if (this.writers.get(path)?.keys.has(key)) return false
    const p = this.pending.get(path)
    const typing = this.typists.get(path)
    if (typing?.has(key) || p?.authors.includes(key)) return false
    return p?.kind === 'typed' || !!typing?.size
  }

  /**
   * Someone typed in the editor of `path` since its last flush (the first
   * keystroke per flush and person). `before`: the note's text right before
   * it, when it may start a version (`startsVersion`): then what others typed
   * until that moment closes first as their version, with that text, and
   * this person's first write starts one of their own (D-034 3.4). Whoever
   * was writing goes on in it with them; the next one to come in closes it
   * again. Once the note is quiet, it starts over.
   */
  typing(path: string, actor: Actor, before?: string) {
    if (!this.live || !this.takes(path)) return
    const key = authorKey(authorOf(actor))
    let writers = this.writers.get(path)
    if (!writers) this.writers.set(path, (writers = { keys: new Set(), last: 0 }))
    if (before !== undefined && this.startsVersion(path, actor)) {
      for (const a of [...(this.pending.get(path)?.authors ?? []), ...(this.typists.get(path) ?? [])]) writers.keys.add(a)
      this.flushing(path, before)
      this.closePending(path)
    }
    writers.keys.add(key)
    writers.last = this.now()
    let set = this.typists.get(path)
    if (!set) this.typists.set(path, (set = new Set()))
    if (set.has(key)) return
    set.add(key)
    this.saveJournal()
  }

  /**
   * The hub is about to write what was typed: it joins the note's open typed
   * version, with who typed since the last flush. `fallback` is the author
   * when nobody is known to have typed it.
   */
  flushing(path: string, text: string, fallback?: Actor) {
    if (!this.live || !this.takes(path)) return
    const oid = blobOid(text)
    this.expect(path, oid)
    this.touch(path)
    const typing = this.typists.get(path) ?? new Set<string>()
    this.typists.delete(path)
    const p = this.pending.get(path)
    // What people typed goes on in their version; with nobody typing since the
    // last flush (the hub adding a uid after an agent's write), in whatever is
    // open, unless it's an external version: vihko writing closes that one.
    if (p?.kind === 'typed' || (p && p.kind !== 'external' && typing.size === 0)) {
      if (oid !== p.oids.at(-1)) {
        p.oids.push(oid)
        p.text = text
        p.last = this.now()
      }
      for (const a of typing) if (!p.authors.includes(a)) p.authors.push(a)
    } else {
      if (oid === this.known(path)) {
        if (typing.size) this.saveJournal()
        return
      }
      if (p) this.closePending(path)
      const authors = [...typing]
      if (authors.length === 0 && fallback) authors.push(authorKey(authorOf(fallback)))
      const now = this.now()
      this.pending.set(path, { kind: 'typed', key: 'typed', authors, reason: null, since: now, last: now, base: this.known(path), oids: [oid], text })
    }
    this.saveJournal()
    crashPoint('history-flushing')
  }

  /**
   * A direct write to a note open in the editor (agent, API, system): `typed`
   * is the document right before it, which closes what people typed; `after`
   * is the write's own version.
   */
  write(path: string, w: { typed: string; after: string; actor: Actor }) {
    if (!this.live || !this.takes(path)) return
    this.flushing(path, w.typed)
    this.prepare([{ path, after: w.after }], { actor: w.actor, inMemory: true }).done()
  }

  /** The hub integrated a change made outside vihko (what is now on disk): it joins the note's open external version. */
  external(path: string, text: string) {
    this.observe([{ path, content: text }])
  }

  // --- Recording: the note service ---------------------------------------------------

  /**
   * A write vihko is about to make. What the writer read that the history
   * doesn't know is recorded first as external; what was pending on those
   * paths closes with the content from before; the new contents are expected
   * as vihko's own. `done` records the write: in the actor's open operation,
   * at once (`immediate`, or the system's), or accumulated with the actor's
   * previous writes (users and agents editing notes).
   */
  prepare(changes: FileChange[], opts: { actor: Actor; reason?: Reason; immediate?: boolean; inMemory?: boolean }): WriteHandle {
    if (!this.live) return NOOP
    const max = this.opts.maxFileBytes()
    changes = this.admit(changes).filter((c) => {
      if (c.after === undefined || c.after === null || byteLength(c.after) <= max) return true
      this.tooLarge.set(c.path, byteLength(c.after))
      return false
    })
    if (changes.length === 0) return NOOP
    const authors = [authorKey(authorOf(opts.actor))]
    const reasonObj = opts.reason ?? (opts.actor.kind === 'system' ? opts.actor.reason : undefined)
    const reason = reasonObj ? reasonJson(reasonObj) : null
    const key = writeKey(authors, reason)
    const group = this.groups.get(opts.actor)
    const accumulate = !group && !opts.immediate && opts.actor.kind !== 'system'
      && changes.every((c) => c.from === undefined && typeof c.after === 'string')

    const external: Observation[] = []
    for (const c of changes) {
      if (c.before === undefined || c.folder) continue
      // What a rename read is its source.
      const at = c.from ?? c.path
      const oid = c.before === null ? null : blobOid(c.before)
      if (oid !== this.known(at) && !this.isOwn(at, oid)) external.push({ path: at, content: c.before })
    }
    if (external.length) this.recordExternal(external, {})

    for (const c of changes) {
      for (const p of this.pathsOf(c)) {
        const open = this.pending.get(p)
        if (open && !(accumulate && open.kind === 'write' && open.key === key)) this.closePending(p)
      }
    }
    const expected = changes.flatMap((c) => this.expectChange(c))
    for (const c of changes) this.touch(c.path)
    // A write to disk: journaled before it happens, so a kill -9 right after
    // it reaches the disk doesn't leave it without its author (`confirmJournal`).
    const id = ++this.writeSeq
    if (!group && !opts.inMemory) {
      this.writesInFlight.set(id, { authors, reason, changes: changes.map((c) => this.refOf(c)) })
      this.saveJournal()
    }
    let settled = false
    return {
      done: (final = changes) => {
        if (settled) return
        settled = true
        if (this.writesInFlight.has(id)) crashPoint('history-written')
        const journaled = this.writesInFlight.delete(id)
        if (!this.live) { if (journaled) this.saveJournal(); return }
        final = this.admit(final)
        const g = this.groups.get(opts.actor)
        if (g) this.addToGroup(g, final)
        else if (accumulate) this.accumulate(final, authors, reason, key)
        else this.enqueue({ authors, reason, at: this.now(), changes: final.map((c) => this.qchange(c)) })
        for (const c of final) if (c.from !== undefined) this.transferTyping(c.from, c.path, !!c.folder)
      },
      abort: () => {
        if (settled) return
        settled = true
        for (const [path, oid] of expected) this.unexpect(path, oid)
        if (this.writesInFlight.delete(id)) this.saveJournal()
      },
    }
  }

  /** A change as the journal keeps a write in progress: where, and the content's id (not the content). */
  private refOf(c: FileChange): QChange {
    const base: QChange = { path: c.path, ...(c.from !== undefined ? { from: c.from } : {}), ...(c.folder ? { folder: true } : {}) }
    if (c.after === undefined) return base
    return { ...base, oid: c.after === null ? null : blobOid(c.after) }
  }

  /**
   * Runs `fn` as one operation: every write it makes with `actor` (the same
   * object) goes into a single commit, made when it ends.
   */
  async operation<T>(actor: Actor, reason: Reason | null, fn: () => Promise<T>): Promise<T> {
    if (!this.live) return fn()
    const r = reason ?? (actor.kind === 'system' ? actor.reason : null)
    const group: Group = { authors: [authorKey(authorOf(actor))], reason: r ? reasonJson(r) : null, changes: new Map() }
    this.groups.set(actor, group)
    try {
      return await fn()
    } finally {
      this.groups.delete(actor)
      this.flushGroup(group)
    }
  }

  // --- Recording: what the indexer, the watcher and the sweep find ------------------

  /** Notes the indexer applied (a watcher batch or a rescan): anything vihko doesn't know is external. */
  observeIndexed(c: IndexedChanges) {
    if (!this.live || !this.started) return
    const text = new Map(c.upserts.map((u) => [u.path, u]))
    const moved = new Set(c.moved.map((m) => m.to))
    const obs: Observation[] = []
    for (const m of c.moved) {
      const u = text.get(m.to)
      obs.push({ path: m.to, from: m.from, content: u ? u.text : undefined, mtimeMs: u?.mtimeMs })
    }
    for (const u of c.upserts) if (!moved.has(u.path)) obs.push({ path: u.path, content: u.text, mtimeMs: u.mtimeMs })
    for (const p of c.removed) obs.push({ path: p, content: null })
    this.observe(obs)
  }

  private observing: Promise<void> = Promise.resolve()

  /**
   * Paths the watcher saw change that aren't notes (images, attachments,
   * vihko.yaml, conflict copies): read and compared with the history, in the
   * order they came. A folder is looked at whole.
   */
  observePaths(paths: readonly string[]): Promise<void> {
    if (!this.live || !this.started) return this.observing
    const wanted = paths.filter((p) => this.takes(p) && classifyPath(p) !== 'note')
    if (wanted.length === 0) return this.observing
    this.observing = this.observing.then(() => this.readPaths(wanted)).catch((e) => this.log(`history: reading changed files: ${e}`))
    return this.observing
  }

  private async readPaths(paths: readonly string[]) {
    const obs: Observation[] = []
    const seen = new Set<string>()
    const add = async (rel: string) => {
      if (seen.has(rel) || !this.takes(rel) || classifyPath(rel) === 'note') return
      seen.add(rel)
      const abs = join(this.opts.notesDir, rel)
      let st
      try { st = await stat(abs) } catch { st = null }
      // Spelled otherwise than on the disk (fsutil.ts spelledAsOnDisk), it isn't there: its versions go by the disk's spelling.
      if (st && !spelledAsOnDisk(this.opts.notesDir, rel)) st = null
      if (st?.isDirectory()) {
        for (const f of await listFiles(abs, rel)) await add(f)
        return
      }
      if (!st) {
        // Gone: a file, or a folder with files the history knows.
        for (const k of this.knownPaths()) if (under(k, rel) && classifyPath(k) !== 'note') await add(k)
        obs.push({ path: rel, content: null })
        return
      }
      if (!st.isFile()) return
      if (st.size > this.opts.maxFileBytes()) { this.tooLarge.set(rel, st.size); return }
      this.tooLarge.delete(rel)
      let bytes: Buffer
      try { bytes = await readFile(abs) } catch { obs.push({ path: rel, content: null }); return }
      if (isTextPath(rel)) { obs.push({ path: rel, content: bytes.toString('utf8'), mtimeMs: st.mtimeMs }); return }
      // Only the id is kept (a folder of images can be large): the commit reads the file again.
      const oid = blobOid(bytes)
      if (oid !== this.known(rel)) this.cacheBlob(oid, bytes)
      obs.push({ path: rel, oid, mtimeMs: st.mtimeMs, fileRef: true })
    }
    for (const p of paths) await add(p)
    this.observe(pairMoves(obs, (p) => this.known(p)))
  }

  /** Compares what was seen with what the history knows; the differences are external changes. */
  private observe(list: Observation[], opts: { foundAtStartup?: boolean } = {}) {
    if (!this.live) return
    const ext: Observation[] = []
    for (const seen of list) {
      const o = this.admitSeen(seen)
      if (!o) continue
      if (o.content !== undefined && o.content !== null && byteLength(o.content) > this.opts.maxFileBytes()) {
        this.tooLarge.set(o.path, byteLength(o.content))
        continue
      }
      if (o.content === null) this.tooLarge.delete(o.path)
      const oid = o.content === null ? null
        : o.content !== undefined ? blobOid(o.content)
          : o.oid !== undefined ? o.oid
            : o.from !== undefined ? this.known(o.from) : undefined
      if (oid === undefined) continue
      if (o.from !== undefined) {
        const ownMove = this.consumeOwn(o.path, oid) && this.consumeOwn(o.from, null)
        if (ownMove || (this.known(o.path) === oid && this.known(o.from) === null)) continue
        if (this.known(o.from) === null) { ext.push({ ...o, from: undefined, oid }); continue }
        ext.push({ ...o, oid })
        continue
      }
      if (this.consumeOwn(o.path, oid) || this.known(o.path) === oid) continue
      ext.push({ ...o, oid })
    }
    if (ext.length) this.recordExternal(ext, opts)
  }

  /**
   * External changes: a new content for a file joins its open external
   * version (or opens one, closing what else was pending on it); a move or a
   * deletion, and anything found at startup, is one commit at once, after
   * closing what was pending on those paths.
   */
  private recordExternal(ext: Observation[], opts: { foundAtStartup?: boolean }) {
    const now = this.now()
    const joining = opts.foundAtStartup ? [] : ext.filter(joinsVersion)
    const commit = joining.length ? ext.filter((o) => !joining.includes(o)) : ext
    if (commit.length) this.commitExternal(commit, opts, now)
    if (joining.length) this.openExternal(joining, now)
  }

  private openExternal(list: Observation[], now: number) {
    for (const o of list) {
      const oid = o.oid ?? blobOid(o.content as string | Uint8Array)
      if (o.content instanceof Uint8Array) this.cacheBlob(oid, o.content)
      let p = this.pending.get(o.path)
      if (p && p.kind !== 'external') { this.closePending(o.path); p = undefined }
      this.flushGroupsTouching(o.path)
      this.own.delete(o.path)
      this.touch(o.path)
      // The last change's time, bounded by the version before it and by now.
      const floor = Math.max(this.lastAt.get(o.path) ?? this.headTime, p?.at ?? 0)
      const at = o.mtimeMs === undefined ? now : Math.min(now, Math.max(floor, o.mtimeMs))
      const text = typeof o.content === 'string' ? o.content : null
      if (p) {
        const prev = p.oids.at(-1)!
        if (oid !== prev) {
          p.oids.push(oid)
          // An in-between content of an image never reaches git: its cached bytes can go.
          if (p.file) this.releaseBlob(prev)
        }
        p.text = text ?? ''
        if (text === null) p.file = true
        else delete p.file
        p.last = now
        p.at = at
      } else {
        this.pending.set(o.path, {
          kind: 'external', key: 'external', authors: ['external'], reason: null, since: now, last: now, at,
          base: this.known(o.path), oids: [oid], text: text ?? '', ...(text === null ? { file: true } : {}),
        })
      }
    }
    this.saveJournal()
    crashPoint('history-external')
  }

  private commitExternal(ext: Observation[], opts: { foundAtStartup?: boolean }, now: number) {
    let at = 0
    for (const o of ext) {
      for (const p of [o.path, ...(o.from !== undefined ? [o.from] : [])]) {
        this.closePending(p)
        this.flushGroupsTouching(p)
        this.own.delete(p)
        this.touch(p)
      }
      const floor = Math.max(this.lastAt.get(o.path) ?? this.headTime, o.from !== undefined ? this.lastAt.get(o.from) ?? 0 : 0)
      at = Math.max(at, o.mtimeMs === undefined ? now : Math.min(now, Math.max(floor, o.mtimeMs)))
    }
    const changes = ext.map((o): QChange => {
      const base: QChange = { path: o.path, ...(o.from !== undefined ? { from: o.from } : {}) }
      if (o.content === null || o.oid === null) return { ...base, oid: null }
      if (typeof o.content === 'string') return { ...base, oid: o.oid ?? blobOid(o.content), text: o.content }
      if (o.content instanceof Uint8Array) {
        const oid = o.oid ?? blobOid(o.content)
        this.cacheBlob(oid, o.content)
        return { ...base, oid, file: true }
      }
      // Seen by its id only (read again when committed), or a rename seen without its content.
      if (o.oid !== undefined && !(o.from !== undefined && o.oid === this.known(o.from))) return { ...base, oid: o.oid, file: true }
      return base
    })
    for (const o of ext) if (o.from !== undefined) this.transferTyping(o.from, o.path, false)
    this.enqueue({ authors: ['external'], reason: null, at: at || now, foundAtStartup: opts.foundAtStartup, changes })
  }

  // --- The sweep ---------------------------------------------------------------------

  /**
   * The whole folder against the history: a stat of every file, and a read of
   * those whose size, times or inode changed since they were last hashed (a
   * cache in the state volume). What differs is one commit: external changes
   * (`foundAtStartup` when vihko starts), or the system's when the history
   * starts or resumes.
   */
  sweep(kind: SweepKind): Promise<void> {
    if (!this.live || this.paused) return Promise.resolve()
    if (this.sweeping) return this.sweeping
    this.sweeping = this.sweepNow(kind).finally(() => { this.sweeping = null; this.touched = null })
    return this.sweeping
  }

  private async sweepNow(kind: SweepKind) {
    try {
      if (!(await stat(this.opts.notesDir)).isDirectory()) return
    } catch {
      this.log('history sweep skipped: the notes folder is not available')
      return
    }
    this.touched = new Set()
    const max = this.opts.maxFileBytes()
    const seen = new Map<string, { oid: string; mtimeMs: number }>()
    const tooLarge = new Map<string, number>()
    const unreadable: string[] = []
    const all: string[] = []
    await walk(this.opts.notesDir, '', all, unreadable)
    // Excluded files aren't there for the history: neither read nor missed.
    const excluded = this.opts.excluded ?? (() => false)
    const files = all.filter((p) => !excluded(p))
    const contents = new Map<string, string | Uint8Array>()
    let kept = 0
    await pool(files, async (rel) => {
      const abs = join(this.opts.notesDir, rel)
      let st
      try { st = await stat(abs, { bigint: false }) } catch { return }
      if (!st.isFile()) return
      if (st.size > max) { tooLarge.set(rel, st.size); return }
      const cached = this.statCache.get(rel)
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.ino === st.ino && cached.checkedAt - Math.max(st.mtimeMs, st.ctimeMs) > 2000) {
        seen.set(rel, { oid: cached.oid, mtimeMs: st.mtimeMs })
        return
      }
      let bytes: Buffer
      try { bytes = await readFile(abs) } catch { return }
      const content = isTextPath(rel) ? bytes.toString('utf8') : bytes
      const oid = blobOid(content)
      this.statCache.set(rel, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, oid, checkedAt: Date.now() })
      seen.set(rel, { oid, mtimeMs: st.mtimeMs })
      if (oid !== this.known(rel) && kept + bytes.byteLength <= BLOB_CACHE_BYTES) { contents.set(rel, content); kept += bytes.byteLength }
    })
    for (const k of [...this.statCache.keys()]) if (!seen.has(k)) this.statCache.delete(k)
    this.tooLarge = tooLarge
    const touched = this.touched
    const obs: Observation[] = []
    for (const [rel, s] of seen) {
      if (touched.has(rel) || s.oid === this.known(rel)) continue
      const content = contents.get(rel)
      obs.push({ path: rel, oid: s.oid, mtimeMs: s.mtimeMs, content, fileRef: content === undefined })
    }
    const inUnreadable = (p: string) => unreadable.some((d) => d === '' || under(p, d))
    const gone = this.knownPaths().filter((p) => !seen.has(p) && !tooLarge.has(p) && !touched.has(p) && !inUnreadable(p) && !excluded(p))
    const total = this.knownPaths().length
    if (gone.length > 10 && gone.length > 0.5 * total) {
      // Like the indexer's guard: an unmounted share looks empty. Nothing is recorded as deleted.
      this.log(`history sweep: ${gone.length} of ${total} files look deleted; not recorded (is the notes folder mounted?)`)
    } else for (const p of gone) obs.push({ path: p, content: null })
    this.saveCache()
    const list = pairMoves(obs, (p) => this.known(p))
    if (list.length === 0) return
    this.closeMany(list.flatMap((o) => (o.from !== undefined ? [o.path, o.from] : [o.path])))
    const system = kind === 'enabled' || kind === 'resumed'
    const now = this.now()
    let at = 0
    for (const o of list) at = Math.max(at, o.mtimeMs === undefined ? now : Math.min(now, Math.max(this.lastAt.get(o.path) ?? this.headTime, o.mtimeMs)))
    const changes = list.map((o): QChange => {
      const base: QChange = { path: o.path, ...(o.from !== undefined ? { from: o.from } : {}) }
      if (o.content === null) return { ...base, oid: null }
      if (o.from !== undefined && o.oid === this.known(o.from)) return base
      if (typeof o.content === 'string') return { ...base, oid: o.oid!, text: o.content }
      if (o.content instanceof Uint8Array) this.cacheBlob(o.oid!, o.content)
      return { ...base, oid: o.oid!, file: true }
    })
    for (const o of list) if (o.from !== undefined) this.transferTyping(o.from, o.path, false)
    this.log(`history sweep (${kind}): ${changes.length} changes`)
    this.enqueue({
      authors: [system ? 'system' : 'external'],
      reason: system ? { code: kind === 'enabled' ? 'history_enabled' : 'history_resumed' } : null,
      at: system ? now : at || now,
      foundAtStartup: kind === 'startup',
      changes,
    })
  }

  // --- The journal at startup ----------------------------------------------------------

  /**
   * What a kill -9 left pending, against the files: if a file still has the
   * content vihko last wrote for it, the version is its authors'. An earlier
   * content of the same version means the later writes never reached disk;
   * the content from before it, that none did. Anything else means the file
   * changed afterwards: the version is kept as it was (its text is in the
   * journal) and the sweep records the rest as external. An external version
   * was all on disk already, seen while vihko ran: it stays open if the file
   * still has its last content, and otherwise closes as it was (an image's,
   * whose bytes aren't in the journal, is left to the sweep).
   */
  private confirmJournal() {
    for (const [path, p] of [...this.pending]) {
      let bytes: Buffer | null = null
      try { bytes = readFileSync(join(this.opts.notesDir, path)) } catch { /* gone */ }
      const content = bytes === null ? null : isTextPath(path) ? bytes.toString('utf8') : bytes
      const oid = content === null ? null : blobOid(content)
      if (oid === p.oids.at(-1)) continue
      if (p.kind === 'external') {
        if (p.file) this.pending.delete(path)
        else this.closePending(path)
        continue
      }
      const i = oid === null ? -1 : p.oids.indexOf(oid)
      if (i >= 0) {
        p.oids = p.oids.slice(0, i + 1)
        p.text = content as string
        continue
      }
      if (oid === p.base) { this.pending.delete(path); continue }
      this.closePending(path)
    }
    // Typing the hub didn't recover: nothing of it reached a file.
    this.typists.clear()
    // Operations cut short: what they wrote that is still on disk as written is theirs.
    for (const g of this.leftoverGroups) {
      const changes: QChange[] = []
      for (const ref of g.refs) {
        let bytes: Buffer | null = null
        try { bytes = readFileSync(join(this.opts.notesDir, ref.path)) } catch { /* gone */ }
        const content = bytes === null ? null : isTextPath(ref.path) ? bytes.toString('utf8') : bytes
        const oid = content === null ? null : blobOid(content)
        if (oid !== ref.oid) continue
        changes.push(content === null ? { path: ref.path, oid: null } : typeof content === 'string' ? { path: ref.path, oid: oid!, text: content } : { path: ref.path, oid: oid!, file: true })
      }
      if (changes.length) this.enqueue({ authors: g.authors, reason: g.reason, at: this.now(), changes })
    }
    this.leftoverGroups = []
    // Writes a kill cut short between the disk and the journal: those that are on disk whole are their authors'.
    for (const w of this.leftoverWrites) {
      if (!w.changes.every((c) => this.onDisk(c))) continue
      this.enqueue({ authors: w.authors, reason: w.reason, at: this.now(), changes: w.changes.map((c) => (c.oid ? { ...c, file: true } : c)) })
    }
    this.leftoverWrites = []
    this.saveJournal()
  }

  /** Whether the notes folder shows this change done. */
  private onDisk(c: QChange): boolean {
    const abs = (p: string) => join(this.opts.notesDir, p)
    if (c.folder && c.from !== undefined) return !existsSync(abs(c.from)) && existsSync(abs(c.path))
    if (c.from !== undefined && existsSync(abs(c.from))) return false
    if (c.oid === undefined) return existsSync(abs(c.path))
    let bytes: Buffer | null = null
    try { bytes = readFileSync(abs(c.path)) } catch { /* gone */ }
    if (c.oid === null || bytes === null) return c.oid === null && bytes === null
    return blobOid(isTextPath(c.path) ? bytes.toString('utf8') : bytes) === c.oid
  }

  // --- Versions ---------------------------------------------------------------------

  private lastPrune = 0

  /** Closes every open version whose time is up (and, now and then, forgets expired expectations). */
  private tick() {
    const now = this.now()
    const quiet = this.opts.quietMs ?? 30_000
    const max = this.opts.maxOpenMs ?? 300_000
    const due = [...this.pending].filter(([, p]) => now - p.last >= quiet || now - p.since >= max).map(([path]) => path)
    // A note gone quiet: whoever types in it next starts over (see `typing`).
    for (const [path, w] of [...this.writers]) if (now - w.last >= quiet) this.writers.delete(path)
    // External versions closing together are one commit: when one closes, those
    // of other files that are nearly as quiet close with it (a sync tool writes
    // a batch of files over a few seconds).
    if (due.some((path) => this.pending.get(path)!.kind === 'external')) {
      for (const [path, p] of this.pending) if (p.kind === 'external' && now - p.last >= quiet * 0.8 && !due.includes(path)) due.push(path)
    }
    if (due.length) this.closeMany(due)
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now
      for (const [path, list] of [...this.own]) {
        const live = list.filter((e) => now - e.at < OWN_TTL)
        if (live.length) this.own.set(path, live)
        else this.own.delete(path)
      }
    }
  }

  private closePending(path: string) {
    const p = this.pending.get(path)
    if (!p) return
    this.pending.delete(path)
    this.flushGroupsTouching(path)
    if (p.kind === 'external') return this.enqueue({ authors: ['external'], reason: null, at: p.at ?? p.last, changes: [pendingChange(path, p)] })
    const authors = p.authors.length ? p.authors : ['system']
    const reason = p.authors.length ? p.reason : { code: 'recovered' }
    this.enqueue({ authors, reason, at: p.last, changes: [{ path, oid: p.oids.at(-1)!, text: p.text }] })
  }

  /** Closes these open versions; the external ones among them are one commit, as their author is one. */
  private closeMany(paths: readonly string[]) {
    const external: [string, Pending][] = []
    for (const path of paths) {
      const p = this.pending.get(path)
      if (!p) continue
      if (p.kind !== 'external') { this.closePending(path); continue }
      this.pending.delete(path)
      this.flushGroupsTouching(path)
      external.push([path, p])
    }
    if (external.length === 0) return
    this.enqueue({
      authors: ['external'], reason: null,
      at: Math.max(...external.map(([, p]) => p.at ?? p.last)),
      changes: external.map(([path, p]) => pendingChange(path, p)),
    })
  }

  private accumulate(changes: FileChange[], authors: string[], reason: ReasonData, key: string) {
    const now = this.now()
    for (const c of changes) {
      const text = c.after as string
      const oid = blobOid(text)
      const open = this.pending.get(c.path)
      if (open && open.kind === 'write' && open.key === key) {
        if (oid !== open.oids.at(-1)) { open.oids.push(oid); open.text = text }
        open.last = now
      } else {
        if (open) this.closePending(c.path)
        this.pending.set(c.path, { kind: 'write', key, authors, reason, since: now, last: now, base: this.known(c.path), oids: [oid], text })
      }
    }
    this.saveJournal()
  }

  private addToGroup(g: Group, changes: FileChange[]) {
    for (const c of changes) {
      for (const p of this.pathsOf(c)) this.pending.has(p) && this.closePending(p)
      g.changes.set(c.path, this.qchange(c))
    }
    this.saveJournalSoon()
  }

  private flushGroup(g: Group) {
    if (g.changes.size === 0) return
    const changes = [...g.changes.values()]
    g.changes = new Map()
    this.enqueue({ authors: g.authors, reason: g.reason, at: this.now(), changes })
  }

  /** An operation that wrote `path` commits what it has so far, so anything later on that path comes after it. */
  private flushGroupsTouching(path: string) {
    for (const g of this.groups.values()) if (g.changes.has(path)) this.flushGroup(g)
  }

  private qchange(c: FileChange): QChange {
    const base: QChange = { path: c.path, ...(c.from !== undefined ? { from: c.from } : {}), ...(c.folder ? { folder: true } : {}) }
    if (c.after === undefined) return base
    if (c.after === null) return { ...base, oid: null }
    const oid = blobOid(c.after)
    if (typeof c.after === 'string') return { ...base, oid, text: c.after }
    this.cacheBlob(oid, c.after)
    return { ...base, oid, file: true }
  }

  // --- What the history knows -------------------------------------------------------

  /** The last content the history knows for a path: an open version, an operation's, or the last commit (queued or not). */
  private known(path: string): string | null {
    const p = this.pending.get(path)
    if (p) return p.oids.at(-1)!
    for (const g of this.groups.values()) {
      const c = g.changes.get(path)
      if (c && c.oid !== undefined) return c.oid
    }
    return this.baseline.get(path) ?? this.tree.get(path) ?? null
  }

  private knownPaths(): string[] {
    const out = new Set([...this.tree.keys(), ...this.baseline.keys()])
    for (const [p, v] of this.pending) if (v.oids.length) out.add(p)
    for (const g of this.groups.values()) for (const [p, c] of g.changes) if (c.oid) out.add(p)
    return [...out]
  }

  /** Whether a path's changes are recorded: a name the history can hold, and not excluded in vihko.yaml. */
  private takes(path: string): boolean {
    return historyPath(path) && !this.opts.excluded?.(path)
  }

  /**
   * A writer's changes as the history sees them: paths it can't hold are
   * left out, and excluded ones (`history.exclude`) aren't there. A file moved
   * into an excluded path leaves the history (a deletion by whoever moved it);
   * one moved out of it enters as a new file, with its content. A folder
   * moved out of an excluded path isn't known file by file: its files enter
   * when the indexer or the watcher sees them.
   */
  private admit(changes: FileChange[]): FileChange[] {
    const ex = this.opts.excluded
    const out: FileChange[] = []
    for (const c of changes) {
      if (!historyPath(c.path) || (c.from !== undefined && !historyPath(c.from))) continue
      if (!ex) { out.push(c); continue }
      if (c.from === undefined) { if (!ex(c.path)) out.push(c); continue }
      const from = c.from
      const inFrom = !ex(from)
      const inTo = !ex(c.path)
      if (c.folder) {
        if (!inFrom) continue
        const known = this.knownPaths().filter((p) => under(p, from) && !ex(p))
        const dest = (p: string) => c.path + p.slice(from.length)
        if (inTo && !known.some((p) => ex(dest(p)))) { out.push(c); continue }
        for (const p of known) out.push(ex(dest(p)) ? { path: p, after: null } : { path: dest(p), from: p })
        continue
      }
      if (inFrom && inTo) out.push(c)
      else if (inFrom) out.push({ path: from, ...(c.before !== undefined ? { before: c.before } : {}), after: null })
      else if (inTo) {
        const after = c.after !== undefined ? c.after : this.readNow(from) ?? this.readNow(c.path)
        if (after !== null) out.push({ path: c.path, after })
      }
    }
    return out
  }

  /** What was seen, as the history sees it (see `admit`); null: nothing it records. */
  private admitSeen(o: Observation): Observation | null {
    if (!historyPath(o.path)) return null
    const ex = this.opts.excluded
    if (!ex) return o
    if (o.from === undefined) return ex(o.path) ? null : o
    const inFrom = !ex(o.from)
    const inTo = !ex(o.path)
    if (inFrom && inTo) return o
    if (inFrom) return { path: o.from, content: null }
    if (!inTo) return null
    if (o.content !== undefined || o.oid !== undefined) return { ...o, from: undefined }
    const content = this.readNow(o.path)
    return content === null ? null : { ...o, from: undefined, content }
  }

  /** A file's content now (text for notes), or null if it can't be read. */
  private readNow(path: string): string | Uint8Array | null {
    try {
      const bytes = readFileSync(join(this.opts.notesDir, path))
      return isTextPath(path) ? bytes.toString('utf8') : bytes
    } catch { return null }
  }

  /** The paths a change affects: itself, where it comes from, and for a folder every known path under it. */
  private pathsOf(c: FileChange): string[] {
    if (c.folder && c.from !== undefined) {
      return this.knownPaths().filter((p) => under(p, c.from!) || under(p, c.path)).concat([...this.pending.keys()].filter((p) => under(p, c.from!)))
    }
    return c.from !== undefined ? [c.path, c.from] : [c.path]
  }

  private expect(path: string, oid: string | null) {
    const list = (this.own.get(path) ?? []).filter((e) => this.now() - e.at < OWN_TTL)
    list.push({ oid, at: this.now() })
    this.own.set(path, list.slice(-OWN_MAX))
  }

  private unexpect(path: string, oid: string | null) {
    const list = this.own.get(path)
    if (!list) return
    const i = list.findLastIndex((e) => e.oid === oid)
    if (i >= 0) list.splice(i, 1)
  }

  /** Registers a change's contents as vihko's own. Returns them, to take them back on abort. */
  private expectChange(c: FileChange): [string, string | null][] {
    const out: [string, string | null][] = []
    const add = (p: string, oid: string | null) => { this.expect(p, oid); out.push([p, oid]) }
    if (c.folder && c.from !== undefined) {
      for (const p of this.knownPaths()) if (under(p, c.from)) { add(p, null); add(c.path + p.slice(c.from.length), this.known(p)) }
      return out
    }
    if (c.from !== undefined) add(c.from, null)
    const oid = c.after === undefined ? (c.from !== undefined ? this.known(c.from) : null) : c.after === null ? null : blobOid(c.after)
    add(c.path, oid)
    return out
  }

  private isOwn(path: string, oid: string | null): boolean {
    return (this.own.get(path) ?? []).some((e) => e.oid === oid && this.now() - e.at < OWN_TTL)
  }

  /** Whether `oid` at `path` is vihko's own write; consumes it and anything written before it. */
  private consumeOwn(path: string, oid: string | null): boolean {
    const list = this.own.get(path)
    if (!list) return false
    const i = list.findLastIndex((e) => e.oid === oid && this.now() - e.at < OWN_TTL)
    if (i < 0) return false
    list.splice(0, i + 1)
    if (list.length === 0) this.own.delete(path)
    return true
  }

  private touch(path: string) {
    this.touched?.add(path)
  }

  private transferTyping(from: string, to: string, folder: boolean) {
    for (const [p, set] of [...this.typists]) {
      const dest = p === from ? to : folder && under(p, from) ? to + p.slice(from.length) : null
      if (dest === null) continue
      this.typists.delete(p)
      const d = this.typists.get(dest) ?? new Set<string>()
      for (const a of set) d.add(a)
      this.typists.set(dest, d)
    }
    for (const [p, w] of [...this.writers]) {
      const dest = p === from ? to : folder && under(p, from) ? to + p.slice(from.length) : null
      if (dest === null) continue
      this.writers.delete(p)
      this.writers.set(dest, w)
    }
  }

  private cacheBlob(oid: string, bytes: Uint8Array) {
    if (this.blobs.has(oid) || this.blobBytes + bytes.byteLength > BLOB_CACHE_BYTES) return
    this.blobs.set(oid, bytes)
    this.blobBytes += bytes.byteLength
  }

  // --- The queue and git -------------------------------------------------------------

  private enqueue(q: QCommit) {
    if (q.changes.length === 0) return
    this.queue.push(q)
    this.applyToTree(q)
    for (const c of q.changes) {
      this.touch(c.path)
      // A new version of a path the purge left known only by its content: from now on, the queue and git know it.
      if (this.baseline.size === 0) continue
      this.baseline.delete(c.path)
      if (c.from !== undefined) {
        this.baseline.delete(c.from)
        if (c.folder) for (const p of [...this.baseline.keys()]) if (under(p, c.from)) this.baseline.delete(p)
      }
    }
    this.compact()
    this.saveJournal()
    crashPoint('history-queued', q.changes.map((c) => c.path))
    this.scheduleDrain()
  }

  /** Keeps the queue at its cap, merging commits (never dropping one). */
  private compact() {
    const max = this.opts.queueMax ?? QUEUE_MAX
    while (this.queue.length > max && this.mergeOldest()) {
      if (this.merged?.count === 1) this.log(`history: ${max} commits waiting for git; merging the oldest into later ones (fewer versions, the same contents and authors)`)
    }
  }

  /**
   * The queue is at its cap (git has failed for a long time): one commit
   * fewer, losing granularity and never content or authors. In order:
   * 1. The oldest commit whose files a later commit writes again goes into
   *    that later commit, as if its version had stayed open longer: the later
   *    content wins, and the version has the authors of both.
   * 2. Otherwise (no waiting commit's files are written again), the oldest one
   *    that has a later commit with the same authors and reason goes into it:
   *    every file keeps its content and exact authors; only its date moves.
   * 3. Otherwise, the oldest goes into the next commit, with both authors.
   * Moves are never merged away (the history of a note follows them), nor
   * anything already on its way to git. False if nothing could be merged.
   */
  private mergeOldest(): boolean {
    const q = this.queue
    const start = this.inflight?.count ?? 0
    const plain = (i: number) => q[i]!.changes.every((c) => c.from === undefined && !c.folder)
    // Where each path is written (or moved from) from `start` on, in queue order.
    const at = new Map<string, number[]>()
    const inFolder = new Map<string, number[]>()
    for (let j = start; j < q.length; j++) {
      for (const c of q[j]!.changes) {
        for (const p of c.from !== undefined ? [c.path, c.from] : [c.path]) {
          const map = c.folder ? inFolder : at
          const list = map.get(p)
          if (list) { if (list.at(-1) !== j) list.push(j) } else map.set(p, [j])
        }
      }
    }
    const firstAfter = (list: number[] | undefined, i: number) => {
      if (!list) return -1
      let lo = 0, hi = list.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]! <= i) lo = mid + 1; else hi = mid }
      return lo < list.length ? list[lo]! : -1
    }
    const nextWriting = (i: number) => {
      let best = -1
      const take = (k: number) => { if (k >= 0 && (best < 0 || k < best)) best = k }
      for (const c of q[i]!.changes) {
        take(firstAfter(at.get(c.path), i))
        for (let s = c.path.lastIndexOf('/'); s > 0; s = c.path.lastIndexOf('/', s - 1)) take(firstAfter(inFolder.get(c.path.slice(0, s)), i))
      }
      return best
    }
    for (let i = start; i < q.length - 1; i++) {
      if (!plain(i)) continue
      const k = nextWriting(i)
      if (k >= 0) return this.fold(i, k), true
    }
    // No waiting commit's files are written again: any of them can go into any later commit.
    const sig = (c: QCommit) => JSON.stringify([[...c.authors].sort(), c.reason, !!c.foundAtStartup])
    const nextSame = new Map<string, number>()
    const same: number[] = []
    for (let j = q.length - 1; j >= start; j--) {
      const s = sig(q[j]!)
      same[j] = nextSame.get(s) ?? -1
      nextSame.set(s, j)
    }
    for (let i = start; i < q.length - 1; i++) if (plain(i) && same[i]! >= 0) return this.fold(i, same[i]!), true
    for (let i = start; i < q.length - 1; i++) if (plain(i)) return this.fold(i, i + 1), true
    return false
  }

  /**
   * Commit `i` goes into the later commit `k`, which no commit in between
   * writes any of its files: its changes first (a file that `k` writes again
   * keeps `k`'s content), then `k`'s, with the authors of both.
   */
  private fold(i: number, k: number) {
    const a = this.queue[i]!
    const b = this.queue[k]!
    const rewritten = (c: QChange) => b.changes.some((d) => d.path === c.path && d.from === undefined && !d.folder && d.oid !== undefined)
      && !b.changes.some((d) => d.from !== undefined && (d.from === c.path || (!!d.folder && under(c.path, d.from))))
    const gone = a.changes.filter(rewritten)
    b.changes = [...a.changes.filter((c) => !gone.includes(c)), ...b.changes]
    for (const x of a.authors) if (!b.authors.includes(x)) b.authors.push(x)
    // A reason explains the system as an author; a person's (restored…) was about the content that is now gone.
    if (!b.reason && a.authors.includes('system')) b.reason = a.reason
    if (a.foundAtStartup) b.foundAtStartup = true
    this.queue.splice(i, 1)
    for (const c of gone) if (c.file && c.oid) this.releaseBlob(c.oid)
    this.merged = { count: (this.merged?.count ?? 0) + 1, since: this.merged?.since ?? this.now() }
  }

  private applyToTree(q: QCommit) {
    for (const c of q.changes) {
      if (c.folder && c.from !== undefined) {
        for (const [p, oid] of [...this.tree]) if (under(p, c.from)) { this.tree.delete(p); this.tree.set(c.path + p.slice(c.from.length), oid) }
      } else {
        let oid = c.oid
        if (c.from !== undefined) {
          const was = this.tree.get(c.from)
          this.tree.delete(c.from)
          if (oid === undefined) oid = was
        }
        if (oid === null || oid === undefined) this.tree.delete(c.path)
        else this.tree.set(c.path, oid)
      }
      this.lastAt.set(c.path, q.at)
    }
  }

  private scheduleDrain(delay = 0) {
    if (this.closed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.drain().catch((e) => this.log(`history: ${e}`))
    }, delay)
    this.retryTimer.unref()
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = this.drainNow().finally(() => { this.draining = null })
    return this.draining
  }

  private async drainNow() {
    if (this.paused) return
    if (!(await this.ensureReady())) return this.retryLater()
    if (this.resumeOnReady && this.started && this.recording) {
      this.resumeOnReady = false
      await this.sweep(this.head === null && this.queue.length === 0 ? 'enabled' : 'resumed')
    }
    while (this.queue.length && !this.paused) {
      const n = Math.min(this.queue.length, BATCH)
      const batch = this.queue.slice(0, n)
      const { commits, working, skipped } = this.build(batch)
      let ids: string[] = []
      if (commits.length) {
        this.inflight = { parent: this.head, count: n }
        this.saveJournal()
        crashPoint('history-inflight')
        try {
          const bytes = batch.reduce((s, q) => s + q.changes.reduce((t, c) => t + (c.text?.length ?? 0), 0), 0)
          ids = await this.writes.run(() => fastImport(this.git, HISTORY_REF, this.head, commits, 300_000 + bytes / 1000))
        } catch (err) {
          this.inflight = null
          // What came in while this batch was on its way couldn't be merged into it: now it can.
          this.compact()
          this.saveJournal()
          this.fail(err)
          return this.retryLater()
        }
        crashPoint('history-committed', batch.flatMap((q) => q.changes.map((c) => c.path)))
        this.head = ids.at(-1)!
        this.headTime = Math.max(this.headTime, ...commits.map((c) => c.authorTime * 1000))
        this.committed = working
        if (skipped.length) {
          // Some file changed again before it could be committed: what git has is the truth.
          await this.reload().catch((e) => this.log(`history: reloading the tree: ${e}`))
        }
      }
      this.queue.splice(0, n)
      this.inflight = null
      if (skipped.length) this.rebuildTree()
      for (const q of batch) for (const c of q.changes) if (c.file && c.oid) this.dropBlob(c.oid)
      if (this.merged && this.queue.length === 0) {
        this.log(`history: the ${this.merged.count} merged commits are in git`)
        this.merged = null
      }
      this.saveJournal()
      this.clearError()
      this.gcMaybe(commits.length)
    }
  }

  private dropBlob(oid: string) {
    const b = this.blobs.get(oid)
    if (!b) return
    this.blobs.delete(oid)
    this.blobBytes -= b.byteLength
  }

  /** Cached bytes that no commit waiting for git needs any more. */
  private releaseBlob(oid: string) {
    if (this.blobs.has(oid) && !this.queue.some((q) => q.changes.some((c) => c.oid === oid))) this.dropBlob(oid)
  }

  /**
   * The commits for a batch of the queue, over the files at `head`: changes
   * that change nothing are left out, and a commit left with nothing isn't
   * made (so a batch that reached git before a crash is never repeated).
   */
  private build(batch: QCommit[]) {
    const working = new Map(this.committed)
    const commits: FastCommit[] = []
    const skipped: string[] = []
    for (const q of batch) {
      const ops: FastOp[] = []
      const moves: { from: string; to: string }[] = []
      const created = new Set<string>()
      for (const c of q.changes) {
        if (c.folder && c.from !== undefined) {
          const inside = [...working.keys()].filter((p) => under(p, c.from!))
          if (inside.length === 0) continue
          ops.push({ op: 'R', from: c.from, to: c.path })
          for (const p of inside) { const oid = working.get(p)!; working.delete(p); working.set(c.path + p.slice(c.from.length), oid) }
          moves.push({ from: c.from, to: c.path })
          continue
        }
        if (c.from !== undefined && c.from !== c.path) {
          const was = working.get(c.from)
          if (was !== undefined && !working.has(c.path)) {
            ops.push({ op: 'R', from: c.from, to: c.path })
            working.delete(c.from)
            working.set(c.path, was)
            moves.push({ from: c.from, to: c.path })
          } else if (was !== undefined) {
            ops.push({ op: 'D', path: c.from })
            working.delete(c.from)
          }
        }
        if (c.oid === undefined) continue
        if (c.oid === null) {
          if (working.has(c.path)) { ops.push({ op: 'D', path: c.path }); working.delete(c.path) }
          continue
        }
        if (working.get(c.path) === c.oid) continue
        if (!working.has(c.path)) created.add(c.path)
        working.set(c.path, c.oid)
        ops.push({ op: 'M', path: c.path, data: () => this.contentOf(c, skipped) })
      }
      if (ops.length === 0) continue
      const first = parseAuthorKey(q.authors[0] ?? 'system') ?? { kind: 'system' as const }
      commits.push({
        author: this.gitAuthor(first),
        authorTime: Math.floor(q.at / 1000),
        committerTime: Math.floor(this.now() / 1000),
        message: formatMessage(subjectOf(q, ops, created), {
          authors: q.authors, reason: q.reason, foundAtStartup: !!q.foundAtStartup, moves,
          restoredFrom: q.reason?.code === 'restored' && typeof q.reason.id === 'string' ? q.reason.id : null,
        }),
        ops,
      })
    }
    return { commits, working, skipped }
  }

  /** A queued change's bytes: inline, cached, or from its file if it still has that content (null otherwise: left out). */
  private async contentOf(c: QChange, skipped: string[]): Promise<Uint8Array | null> {
    if (c.text !== undefined) return Buffer.from(c.text, 'utf8')
    const cached = this.blobs.get(c.oid!)
    if (cached) return cached
    try {
      const bytes = await readFile(join(this.opts.notesDir, c.path))
      const content = isTextPath(c.path) ? Buffer.from(bytes.toString('utf8'), 'utf8') : bytes
      if (blobOid(content) === c.oid) return content
    } catch { /* gone */ }
    skipped.push(c.path)
    return null
  }

  private gitAuthor(a: Author): { name: string; email: string } {
    const name = this.opts.nameOf?.(a) ?? (a.kind === 'user' || a.kind === 'agent' ? a.id : a.kind)
    if (a.kind === 'user') return { name, email: `${a.id}@users.vihko.invalid` }
    if (a.kind === 'agent') return { name, email: `${a.id}@agents.vihko.invalid` }
    return { name: a.kind === 'system' ? 'vihko' : 'external', email: `${a.kind}@vihko.invalid` }
  }

  private gcMaybe(commits: number) {
    this.sinceGc += commits
    if (this.sinceGc < (this.opts.gcEvery ?? 200) || this.gc || this.closed) return
    this.sinceGc = 0
    const stop = new AbortController()
    // Outside the write queue: git takes its own locks, and fast-import can run
    // meanwhile. In the foreground (`gc --auto` detaches by default), so it
    // ends with vihko: no git outlives the state volume's lock, and the next
    // holder can take whatever lock is left as a crash's (leftovers.ts).
    const done = new Git({ gitDir: this.git.gitDir, binary: this.opts.git, config: { 'gc.auto': '6700', 'gc.autoPackLimit': '50', 'gc.autoDetach': 'false' } })
      .run(['gc', '--auto', '--quiet'], { timeoutMs: 600_000, signal: stop.signal })
      .then(() => {}, (e) => { if (!stop.signal.aborted) this.log(`history: git gc: ${e instanceof Error ? e.message : String(e)}`) })
      .finally(() => { if (this.gc?.stop === stop) this.gc = null })
    this.gc = { stop, done }
  }

  private fail(err: unknown) {
    const code = err instanceof GitError ? `git_${err.code}` : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    if (this.error?.message !== message) this.log(`history unavailable: ${message}`)
    this.error = { code, message }
  }

  private clearError() {
    if (this.error) this.log('history available again')
    this.error = null
    this.retryDelay = this.opts.retryMs ?? 5000
  }

  private retryLater() {
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 300_000)
    this.scheduleDrain(delay)
  }

  // --- Files in the state volume ------------------------------------------------------

  private readJournal(): Journal | null {
    let text: string
    try { text = readFileSync(this.journalFile, 'utf8') } catch { return null }
    try {
      const j = JSON.parse(text) as Journal
      if (j.version !== 1) throw new Error(`version ${String(j.version)}`)
      return { version: 1, mode: j.mode ?? 'managed', typing: j.typing ?? {}, pending: j.pending ?? {}, queue: j.queue ?? [], inflight: j.inflight ?? null, groups: j.groups ?? [], writes: j.writes ?? [], merged: j.merged ?? null, baseline: j.baseline ?? {} }
    } catch (err) {
      this.log(`history: the journal can't be read (${err instanceof Error ? err.message : String(err)}); starting without it`)
      return null
    }
  }

  /** The journal on disk now (before whatever it protects happens). */
  private saveJournal() {
    if (this.saveTimer) { clearImmediate(this.saveTimer); this.saveTimer = null }
    const j: Journal = {
      version: 1,
      mode: this.mode,
      typing: Object.fromEntries([...this.typists].map(([p, s]) => [p, [...s]])),
      pending: Object.fromEntries(this.pending),
      queue: this.queue,
      inflight: this.inflight,
      groups: [...this.groups.values()].filter((g) => g.changes.size).map((g) => ({
        authors: g.authors, reason: g.reason, refs: [...g.changes.values()].filter((c) => c.oid !== undefined && !c.folder && c.from === undefined).map((c) => ({ path: c.path, oid: c.oid! })),
      })),
      writes: [...this.leftoverWrites, ...this.writesInFlight.values()],
      merged: this.merged,
      ...(this.baseline.size ? { baseline: Object.fromEntries(this.baseline) } : {}),
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      writeAtomic(this.journalFile, JSON.stringify(j))
    } catch (err) {
      this.fail(err)
    }
  }

  /** Operations write many files in a row: one save for all of them. */
  private saveJournalSoon() {
    if (this.saveTimer) return
    this.saveTimer = setImmediate(() => { this.saveTimer = null; this.saveJournal() })
  }

  private readCache() {
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Record<string, CacheEntry>
      this.statCache = new Map(Object.entries(data))
    } catch { this.statCache = new Map() }
  }

  private saveCache() {
    try { writeAtomic(this.cacheFile, JSON.stringify(Object.fromEntries(this.statCache))) } catch (err) { this.log(`history: saving the file cache: ${err}`) }
  }
}

/** Something seen in the folder (or read by a writer): `content` null is a missing file. */
interface Observation {
  path: string
  from?: string
  /** undefined: not read (a rename seen by the indexer, or a sweep's file reference). */
  content?: string | Uint8Array | null
  oid?: string | null
  mtimeMs?: number
  fileRef?: boolean
}

const byteLength = (c: string | Uint8Array) => (typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.byteLength)

/**
 * An external change that joins its file's open version: a new content (not
 * a move or a deletion) that vihko holds, or can read again from the file.
 */
function joinsVersion(o: Observation): boolean {
  if (o.from !== undefined || o.content === null || o.oid === null) return false
  if (typeof o.content === 'string' || o.content instanceof Uint8Array) return true
  return typeof o.oid === 'string' && !isTextPath(o.path)
}

/** The change an open version commits: its text, or its bytes read again (an external change to an image). */
function pendingChange(path: string, p: Pending): QChange {
  return p.file ? { path, oid: p.oids.at(-1)!, file: true } : { path, oid: p.oids.at(-1)!, text: p.text }
}

/**
 * Among missing and new files, those with the same content and no other
 * candidate are one file renamed (images of a folder moved with another tool).
 */
function pairMoves(obs: Observation[], known: (p: string) => string | null): Observation[] {
  const gone = new Map<string, Observation[]>()
  const added = new Map<string, Observation[]>()
  for (const o of obs) {
    if (o.from !== undefined) continue
    if (o.content === null) {
      const oid = known(o.path)
      if (oid) gone.set(oid, [...(gone.get(oid) ?? []), o])
    } else if (known(o.path) === null) {
      const oid = o.oid ?? (o.content === undefined ? null : blobOid(o.content))
      if (oid) added.set(oid, [...(added.get(oid) ?? []), { ...o, oid }])
    }
  }
  const drop = new Set<Observation>()
  const out: Observation[] = []
  for (const [oid, g] of gone) {
    const a = added.get(oid)
    if (g.length !== 1 || a?.length !== 1) continue
    drop.add(g[0]!)
    drop.add(obs.find((o) => o.path === a[0]!.path && o.content !== null)!)
    out.push({ ...a[0]!, from: g[0]!.path })
  }
  return [...obs.filter((o) => !drop.has(o)), ...out]
}

function subjectOf(q: QCommit, ops: FastOp[], created: Set<string>): string {
  const r = q.reason
  const s = (k: string) => (typeof r?.[k] === 'string' ? (r[k] as string) : '')
  const one = ops.length === 1 ? ops[0]! : null
  const target = one ? (one.op === 'R' ? one.to : one.path) : `${ops.length} files`
  switch (r?.code) {
    case 'note_moved': return `Update links after moving ${s('from')} to ${s('to')}`
    case 'folder_moved': return `Update links after moving folder ${s('from')} to ${s('to')}`
    case 'links_after_external_move': return 'Update links after moves outside vihko'
    case 'alias_added': return `Add alias ${s('alias')} to ${s('to')}`
    case 'restored': return `Restore ${target} from ${s('id').slice(0, 10)}`
    case 'trash_restored': return `Restore ${target} from the trash`
    case 'reverted': return `Revert ${s('id').slice(0, 10)} in ${target}`
    case 'history_enabled': return 'Start history'
    case 'history_resumed': return 'Resume history'
    case 'recovered': return `Recover ${target}`
  }
  const who = q.authors[0] === 'external' ? 'External change: ' : ''
  if (!one) return `${who}change ${ops.length} files`.replace(/^./, (c) => c.toUpperCase())
  const verb = one.op === 'R' ? `move ${one.from} to ${one.to}` : one.op === 'D' ? `delete ${one.path}` : `${created.has(one.path) ? 'create' : 'edit'} ${one.path}`
  return `${who}${verb}`.replace(/^./, (c) => c.toUpperCase())
}

/** Files under `abs` (relative paths from the notes root, starting at `rel`), without ignored folders. */
async function listFiles(abs: string, rel: string): Promise<string[]> {
  const out: string[] = []
  await walk(abs, '', out, [], rel)
  return out
}

async function walk(root: string, rel: string, out: string[], unreadable: string[], prefix = ''): Promise<void> {
  let entries
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch {
    unreadable.push(prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel)
    return
  }
  const dirs: string[] = []
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    const full = prefix ? `${prefix}/${r}` : r
    if (e.isDirectory()) { if (!isIgnoredDir(e.name)) dirs.push(r) } else if (e.isFile() && historyPath(full)) out.push(full)
  }
  await pool(dirs, (d) => walk(root, d, out, unreadable, prefix))
}

async function pool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => { while (i < items.length) await fn(items[i++]!) }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}
