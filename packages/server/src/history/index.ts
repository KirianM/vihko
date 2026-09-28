// The history (D-016, D-032): its mode (vihko.yaml `history.mode`), the
// recorder that keeps the managed repository, and the reader the API uses for
// the mode in force: the managed repository, or the user's own git
// (unmanaged). The two are never mixed: switching modes keeps the managed
// repository as it is, and nothing is ever written to the user's.
import { pathMatcher, type Alert, type HistoryConfig, type HistoryMode } from '@vihko/core'
import type { Author } from '../actor.ts'
import { Recorder, type RecorderOptions } from './recorder.ts'
import { ManagedReader } from './managed.ts'
import { UnmanagedReader } from './unmanaged.ts'
import { HistoryError, type HistoryReader } from './reader.ts'
import { purgeRunning, type PurgeReport } from './purge.ts'
import { PurgeNotices, type PurgeNotice } from './notices.ts'

export interface HistoryOptions extends Omit<RecorderOptions, 'maxFileBytes'> {
  /** vihko.yaml's `history`, as currently in force. */
  config: () => HistoryConfig
}

export interface HistoryStatus {
  mode: HistoryMode
  /** Whether versions can be read (and, managed, recorded) now. */
  available: boolean
  /** Why not: a code, and a hint for developers. */
  error: { code: string; message: string } | null
}

export class History {
  readonly recorder: Recorder
  private managed: ManagedReader
  private unmanaged: UnmanagedReader
  private opts: HistoryOptions
  private mode: HistoryMode
  private maxFileSize: number
  /** `history.exclude` as last compiled, and what it was compiled from. */
  private exclude: { key: string; match: (path: string) => boolean } = { key: '', match: () => false }
  private excludeKey: string
  /** Purges made while running, for the admin (D-038.9). */
  readonly notices: PurgeNotices
  /** One purge at a time. */
  private purges: Promise<unknown> = Promise.resolve()

  constructor(opts: HistoryOptions) {
    this.opts = opts
    this.mode = opts.config().mode
    this.maxFileSize = opts.config().maxFileSize
    this.excludeKey = keyOf(opts.config().exclude)
    this.recorder = new Recorder({
      ...opts,
      maxFileBytes: () => Math.floor(opts.config().maxFileSize * 1024 * 1024),
      excluded: (path) => this.excludedNow(path),
    })
    this.notices = new PurgeNotices(opts.stateDir)
    this.managed = new ManagedReader(this.recorder.git)
    this.unmanaged = new UnmanagedReader({ notesDir: opts.notesDir, binary: opts.git, log: opts.log, now: opts.now })
  }

  /** Before the collaboration hub recovers its notes. */
  async open() {
    if (this.mode === 'unmanaged') await this.unmanaged.refresh()
    await this.recorder.open(this.mode)
  }

  /** After the hub recovered: confirms the journal and sweeps the folder (managed). */
  start() {
    return this.recorder.start()
  }

  /**
   * vihko.yaml was read again: the mode, and a new size limit or exclusion
   * list, which apply at once (a sweep records what enters the history now).
   */
  async configure() {
    const { mode, maxFileSize, exclude } = this.opts.config()
    const limitChanged = maxFileSize !== this.maxFileSize
    this.maxFileSize = maxFileSize
    const excludeChanged = keyOf(exclude) !== this.excludeKey
    this.excludeKey = keyOf(exclude)
    if (mode !== this.mode) {
      this.mode = mode
      // Looked for right away, so the status says at once whether there is one.
      if (mode === 'unmanaged') await this.unmanaged.refresh()
      await this.recorder.configure(mode)
    } else if ((limitChanged || excludeChanged) && mode === 'managed') await this.recorder.sweep('periodic')
  }

  /** Whether `history.exclude` keeps this path out of the managed history. */
  excluded(path: string): boolean {
    return this.mode === 'managed' && this.excludedNow(path)
  }

  private excludedNow(path: string): boolean {
    const list = this.opts.config().exclude
    const key = keyOf(list)
    if (key !== this.exclude.key) this.exclude = { key, match: pathMatcher(list) }
    return this.exclude.match(path)
  }

  close() {
    return this.recorder.close()
  }

  status(): HistoryStatus {
    if (this.mode === 'managed') return { mode: 'managed', available: this.recorder.available, error: this.recorder.lastError }
    if (this.mode === 'unmanaged') return { mode: 'unmanaged', ...this.unmanaged.status() }
    return { mode: 'off', available: false, error: null }
  }

  /** The reader for the mode in force. Throws a HistoryError when there is none. */
  reader(): HistoryReader {
    if (this.mode === 'off') throw new HistoryError('history_off', 'history is off in vihko.yaml')
    if (this.mode === 'unmanaged') return this.unmanaged
    return this.managed
  }

  /** What is still open on a note (managed only: in unmanaged mode only commits are versions): who and since when. */
  pendingOf(path: string): { authors: Author[]; since: number } | null {
    return this.mode === 'managed' ? this.recorder.pendingOf(path) : null
  }

  /**
   * Purges a path (a file or a folder; with `exact`, that file alone) or one
   * version of a file from the managed history, while vihko runs (D-038.9):
   * history/purge.ts `purgeRunning`, one at a time. Whoever may ask is the
   * caller's to judge. `by`: the user, for the admin's notice.
   */
  async purge(req: { path: string; version?: string; dryRun?: boolean; exact?: boolean; by: string }): Promise<PurgeReport> {
    const run = () => purgeRunning({
      stateDir: this.opts.stateDir, notesDir: this.opts.notesDir, path: req.path, version: req.version, dryRun: req.dryRun, exact: req.exact,
      mode: this.mode, excluded: (p) => this.excludedNow(p), git: this.opts.git,
    }, this.recorder)
    const done = this.purges.then(run, run)
    this.purges = done.catch(() => {})
    const report = await done
    if (!report.dryRun) {
      this.notices.add({ path: report.path, version: report.version, by: req.by, at: new Date(this.opts.now?.() ?? Date.now()).toISOString() })
      this.opts.log?.(`history: ${report.version ? `a version of ${report.path}` : report.path} purged from the UI`)
    }
    return report
  }

  alerts(): Alert[] {
    const purged = this.notices.all().map((n: PurgeNotice): Alert => ({
      code: 'history_purged', id: n.id, path: n.path, version: n.version, by: this.opts.nameOf?.({ kind: 'user', id: n.by }) ?? n.by, at: n.at, actions: ['dismiss'],
    }))
    if (this.mode === 'unmanaged') return [...this.unmanaged.alerts(), ...purged]
    return [...this.recorder.alerts(), ...purged]
  }
}

const keyOf = (patterns: readonly string[]) => patterns.join('\n')

export { repositoryOf } from './unmanaged.ts'
export { HistoryError, type HistoryReader } from './reader.ts'
export type { AuthorRef, ChangeKind, RawChange, RawVersion, VersionText } from './reader.ts'
