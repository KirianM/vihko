// The history (D-016, D-032): its mode (thoth.yaml `history.mode`), the
// recorder that keeps the managed repository, and the reader the API uses for
// the mode in force: the managed repository, or the user's own git
// (unmanaged). The two are never mixed: switching modes keeps the managed
// repository as it is, and nothing is ever written to the user's.
import type { Alert, HistoryConfig, HistoryMode } from '@thoth/core'
import type { Author } from '../actor.ts'
import { Recorder, type RecorderOptions } from './recorder.ts'
import { ManagedReader } from './managed.ts'
import { UnmanagedReader } from './unmanaged.ts'
import { HistoryError, type HistoryReader } from './reader.ts'

export interface HistoryOptions extends Omit<RecorderOptions, 'maxFileBytes'> {
  /** thoth.yaml's `history`, as currently in force. */
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

  constructor(opts: HistoryOptions) {
    this.opts = opts
    this.mode = opts.config().mode
    this.maxFileSize = opts.config().maxFileSize
    this.recorder = new Recorder({ ...opts, maxFileBytes: () => Math.floor(opts.config().maxFileSize * 1024 * 1024) })
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

  /** thoth.yaml was read again: the mode, and a new size limit (a sweep says which files it leaves out now). */
  async configure() {
    const { mode, maxFileSize } = this.opts.config()
    const limitChanged = maxFileSize !== this.maxFileSize
    this.maxFileSize = maxFileSize
    if (mode !== this.mode) {
      this.mode = mode
      // Looked for right away, so the status says at once whether there is one.
      if (mode === 'unmanaged') await this.unmanaged.refresh()
      await this.recorder.configure(mode)
    } else if (limitChanged && mode === 'managed') await this.recorder.sweep('periodic')
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
    if (this.mode === 'off') throw new HistoryError('history_off', 'history is off in thoth.yaml')
    if (this.mode === 'unmanaged') return this.unmanaged
    return this.managed
  }

  /** What is still open on a note (managed only: in unmanaged mode only commits are versions): who and since when. */
  pendingOf(path: string): { authors: Author[]; since: number } | null {
    return this.mode === 'managed' ? this.recorder.pendingOf(path) : null
  }

  alerts(): Alert[] {
    if (this.mode === 'unmanaged') return this.unmanaged.alerts()
    return this.recorder.alerts()
  }
}

export { repositoryOf } from './unmanaged.ts'
export { HistoryError, type HistoryReader } from './reader.ts'
export type { AuthorRef, ChangeKind, RawChange, RawVersion, VersionText } from './reader.ts'
