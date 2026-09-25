// The history (D-016, D-032): its mode (thoth.yaml `history.mode`), the
// recorder that keeps the managed repository, and the reader the API uses for
// the mode in force.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Alert, HistoryConfig, HistoryMode } from '@thoth/core'
import type { Author } from '../actor.ts'
import { Recorder, type RecorderOptions } from './recorder.ts'
import { ManagedReader } from './managed.ts'
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
  private opts: HistoryOptions
  private mode: HistoryMode
  private maxFileSize: number

  constructor(opts: HistoryOptions) {
    this.opts = opts
    this.mode = opts.config().mode
    this.maxFileSize = opts.config().maxFileSize
    this.recorder = new Recorder({ ...opts, maxFileBytes: () => Math.floor(opts.config().maxFileSize * 1024 * 1024) })
    this.managed = new ManagedReader(this.recorder.git)
  }

  /** Before the collaboration hub recovers its notes. */
  open() {
    return this.recorder.open(this.mode)
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
      await this.recorder.configure(mode)
    } else if (limitChanged && mode === 'managed') await this.recorder.sweep('periodic')
  }

  close() {
    return this.recorder.close()
  }

  status(): HistoryStatus {
    if (this.mode === 'managed') return { mode: 'managed', available: this.recorder.available, error: this.recorder.lastError }
    if (this.mode === 'unmanaged') {
      return {
        mode: 'unmanaged',
        available: false,
        error: repositoryOf(this.opts.notesDir) === null
          ? { code: 'history_no_repository', message: 'the notes folder is not inside a git repository' }
          : { code: 'history_unmanaged_unavailable', message: 'reading the notes folder\'s own repository is not available yet' },
      }
    }
    return { mode: 'off', available: false, error: null }
  }

  /** The reader for the mode in force. Throws a HistoryError when there is none. */
  reader(): HistoryReader {
    if (this.mode === 'off') throw new HistoryError('history_off', 'history is off in thoth.yaml')
    if (this.mode === 'unmanaged') throw new HistoryError('history_unmanaged_unavailable', 'reading the notes folder\'s own repository is not available yet')
    return this.managed
  }

  /** What is still open on a note (managed only): who and since when. */
  pendingOf(path: string): { authors: Author[]; since: number } | null {
    return this.mode === 'managed' ? this.recorder.pendingOf(path) : null
  }

  alerts(): Alert[] {
    if (this.mode === 'unmanaged') return repositoryOf(this.opts.notesDir) === null ? [{ code: 'history_no_repository', actions: [] }] : []
    return this.recorder.alerts()
  }
}

/** The git repository the notes folder is in (a `.git` in it or above it), or null. */
export function repositoryOf(notesDir: string): string | null {
  for (let dir = resolve(notesDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

export { HistoryError, type HistoryReader } from './reader.ts'
export type { AuthorRef, ChangeKind, RawChange, RawVersion, VersionText } from './reader.ts'
