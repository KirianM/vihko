// Moves that go on in the background. A rename of a heavily linked note
// rewrites hundreds of notes, and on a network filesystem each safe write
// costs several round trips: the request answers once the note (or folder)
// is in place, and the rewrites go on here, with their progress. Jobs live in
// memory only: a restart forgets them, and the files are consistent anyway
// (each rewrite is an independent safe write, and the move happened first).
import { randomUUID } from 'node:crypto'
import type { ErrorCode } from '@thoth/core'
import { NoteError, type MoveHooks } from '../notes.ts'

export type MoveJob<R> = {
  id: string
  kind: 'note' | 'folder'
  from: string
  to: string
  /** Notes rewritten so far, of `total`. */
  done: number
  total: number
} & (
  | { state: 'running' }
  | { state: 'done'; report: R }
  | { state: 'failed'; error: ErrorCode; message: string }
)

type Entry = { owner: string; job: MoveJob<unknown>; finishedAt: number | null }

/** How long a finished job can still be read. */
const KEEP_MS = 10 * 60_000

export class MoveJobs {
  private jobs = new Map<string, Entry>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Starts a move and answers when it is done or, if the rewrites take longer
   * than `waitMs`, as soon as the move itself is: `{ report }` or `{ job }`.
   * An error before the move happened is thrown as usual (nothing changed).
   */
  async start<R>(owner: string, kind: 'note' | 'folder', from: string, to: string, run: (hooks: MoveHooks) => Promise<R>, waitMs: number): Promise<{ report: R } | { job: MoveJob<R> }> {
    this.sweep()
    const entry: Entry = { owner, finishedAt: null, job: { id: randomUUID(), kind, from, to, done: 0, total: 0, state: 'running' } }
    let moved!: () => void
    const inPlace = new Promise<void>((resolve) => { moved = resolve })
    const finished = run({
      onMoved: (total) => { entry.job.total = total; moved() },
      onProgress: (done, total) => { entry.job.done = done; entry.job.total = total },
    })
    finished.then(
      (report) => { entry.job = { ...entry.job, state: 'done', report }; entry.finishedAt = this.now() },
      (err: unknown) => {
        const e = err instanceof NoteError ? { error: err.code, message: err.message } : { error: 'internal' as const, message: err instanceof Error ? err.message : String(err) }
        entry.job = { ...entry.job, state: 'failed', ...e }
        entry.finishedAt = this.now()
      },
    )
    // Until the note is in place, a failure is the request's own error.
    const first = await Promise.race([inPlace.then(() => 'moved' as const), finished.then(() => 'done' as const)])
    if (first === 'done') return { report: await finished }
    let timer: NodeJS.Timeout | undefined
    const soon = await Promise.race([
      finished.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), waitMs) }),
    ])
    clearTimeout(timer)
    if (soon) return { report: await finished }
    this.jobs.set(entry.job.id, entry)
    return { job: entry.job as MoveJob<R> }
  }

  /** A job, only for whoever started it. */
  get(owner: string, id: string): MoveJob<unknown> | null {
    this.sweep()
    const e = this.jobs.get(id)
    return e && e.owner === owner ? e.job : null
  }

  private sweep() {
    const now = this.now()
    for (const [id, e] of this.jobs) if (e.finishedAt !== null && now - e.finishedAt > KEEP_MS) this.jobs.delete(id)
  }
}
