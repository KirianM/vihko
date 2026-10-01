// Automatic retention: the two admin settings that empty the trash and thin
// the history (adminSettings.ts), both off by default, and the nightly run
// that applies them.
//
// - The trash: entries deleted more than `trashRetentionDays` ago are removed
//   for good, with the images and files that went with them. Each entry is
//   first renamed out of the trash in one step (`.expired-<id>`), then
//   removed: a run cut short never leaves half an entry that looks whole,
//   and the next one removes what it left.
// - The history (managed only): versions older than `historyRetentionDays`
//   go, but every file keeps the version it had then, and a note in the
//   trash keeps its whole history (history/retention.ts). With the history's
//   retention on, a note whose trash entry is emptied loses its history up to
//   its deletion: the run writes those notes down (`retention.json`) before
//   removing the entries, so a run cut short still takes their history out
//   the next time.
// - It runs once a night (at `hour`, the server's local time), postponed
//   while someone is writing, up to `MAX_POSTPONE_MS`. The history pauses
//   while it's rewritten: notes are still written, and their versions wait.
// - Every admin is told what it removed, with counts only (never a path: the
//   admin doesn't read other people's spaces). Turning a setting on, or
//   shortening it, shows first what the next run would remove (`preview`),
//   also counts only, and is confirmed at the moment (http/users.ts).
//
// `<state>/retention.json` keeps what a run must finish and the last run's
// counts; it holds no path but those of deleted notes waiting for their
// history to go.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminSettings } from './adminSettings.ts'
import type { History } from './history/index.ts'
import type { DeletedFile, RetentionReport } from './history/retention.ts'
import { writeAtomic } from './history/recorder.ts'
import type { Notices } from './notices.ts'
import type { TrashEntry } from './notes.ts'

const DAY_MS = 86_400_000
/** How long a busy night postpones the run, at most (then it runs anyway). */
const MAX_POSTPONE_MS = 3 * 3_600_000
/** How long it waits each time someone is writing. */
const POSTPONE_MS = 10 * 60_000
/** Trash entries removed between two turns of the event loop. */
const BATCH = 50
/** A trash entry being removed: renamed out of the trash first. */
const EXPIRED = '.expired-'

/** What a run removed, or would remove (counts and bytes only). */
export interface RetentionCounts {
  /** Trash entries, and the bytes they held. */
  trash: { entries: number; bytes: number }
  /** History versions, and the bytes no version keeps any more (null: no managed history to thin). */
  history: { versions: number; bytes: number } | null
}

export interface RetentionRun extends RetentionCounts {
  /** ISO, when it ended. */
  at: string
  /** It failed part way (the log says why): what it removed before is counted. */
  failed: boolean
}

interface State {
  version: 1
  /** Files whose trash entry this retention emptied, whose history goes at the next history run. */
  emptied: DeletedFile[]
  /** The last history run moved the history and was cut short before compacting it. */
  compactPending: boolean
  lastRun: RetentionRun | null
}

export interface RetentionOptions {
  stateDir: string
  settings: AdminSettings
  /** The trash's entries (notes.ts `trash`). */
  trash: () => TrashEntry[]
  history?: History
  notices?: Notices
  log?: (msg: string) => void
  now?: () => number
  /** The hour it runs at, the server's local time (3). */
  hour?: number
}

export class Retention {
  private opts: RetentionOptions
  private file: string
  private state: State
  private running: Promise<RetentionRun> | null = null
  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private log: (msg: string) => void
  private now: () => number

  constructor(opts: RetentionOptions) {
    this.opts = opts
    this.file = join(opts.stateDir, 'retention.json')
    this.state = read(this.file)
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
  }

  /** The last run and the next one (ISO; null while both settings are off). */
  status(): { lastRun: RetentionRun | null; nextRun: string | null } {
    const s = this.opts.settings.view()
    const on = s.trashRetentionDays !== null || s.historyRetentionDays !== null
    return { lastRun: this.state.lastRun, nextRun: on && this.next !== null ? new Date(this.next).toISOString() : null }
  }

  /**
   * What the next run would remove with these periods (null: off), as if it
   * ran now: counts and bytes, never a path.
   */
  async preview(periods: { trashRetentionDays: number | null; historyRetentionDays: number | null }): Promise<RetentionCounts> {
    const now = this.now()
    const entries = this.opts.trash()
    const expired = periods.trashRetentionDays === null ? [] : entries.filter((e) => expiredAt(e, now, periods.trashRetentionDays!))
    const kept = entries.filter((e) => !expired.includes(e))
    let history: RetentionCounts['history'] = null
    if (periods.historyRetentionDays !== null && this.opts.history) {
      const r = await this.opts.history.retain({
        cutoff: now - periods.historyRetentionDays * DAY_MS,
        keep: kept.flatMap(filesOf),
        drop: [...this.state.emptied, ...expired.flatMap(filesOf)],
      }, { dryRun: true })
      history = r && { versions: r.versions, bytes: r.bytes }
    }
    return { trash: { entries: expired.length, bytes: expired.reduce((n, e) => n + this.entryBytes(e.id), 0) }, history }
  }

  /** Runs now with the settings in force (one run at a time: a second call waits for it). */
  run(): Promise<RetentionRun> {
    this.running ??= this.runOnce().finally(() => { this.running = null })
    return this.running
  }

  /** Starts the nightly runs. */
  start() {
    this.schedule()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.next = null
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    const now = this.now()
    this.next = nextAt(now, this.opts.hour ?? 3)
    this.timer = setTimeout(() => { void this.nightly(this.next!) }, this.next - now)
    this.timer.unref()
  }

  /** At night: postponed while someone is writing (up to a limit), then run, and the next night scheduled. */
  private async nightly(due: number) {
    const s = this.opts.settings.view()
    const on = s.trashRetentionDays !== null || s.historyRetentionDays !== null || this.state.compactPending
    if (on && this.opts.history?.busy() && this.now() - due < MAX_POSTPONE_MS) {
      this.timer = setTimeout(() => { void this.nightly(due) }, POSTPONE_MS)
      this.timer.unref()
      return
    }
    try {
      if (on) await this.run()
    } catch (err) {
      this.log(`retention: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.schedule()
  }

  private async runOnce(): Promise<RetentionRun> {
    const s = this.opts.settings.view()
    const now = this.now()
    const run: RetentionRun = { at: '', trash: { entries: 0, bytes: 0 }, history: null, failed: false }
    try {
      this.cleanExpired()
      // The trash first: its emptied notes' history goes in the same run.
      if (s.trashRetentionDays !== null) {
        const expired = this.opts.trash().filter((e) => expiredAt(e, now, s.trashRetentionDays!))
        if (expired.length && s.historyRetentionDays !== null && this.opts.history?.status().mode === 'managed') {
          this.state.emptied.push(...expired.flatMap(filesOf))
          this.save()
        }
        for (let i = 0; i < expired.length; i++) {
          const e = expired[i]!
          const bytes = this.entryBytes(e.id)
          if (this.removeEntry(e.id)) { run.trash.entries++; run.trash.bytes += bytes }
          if ((i + 1) % BATCH === 0) await new Promise((r) => setImmediate(r))
        }
      }
      if (s.historyRetentionDays !== null || this.state.compactPending) {
        const r = await this.thinHistory(s.historyRetentionDays === null ? null : now - s.historyRetentionDays * DAY_MS)
        if (r) run.history = { versions: r.versions, bytes: r.bytes }
      } else if (this.state.emptied.length) {
        // The history's retention went off meanwhile: it keeps everything.
        this.state.emptied = []
        this.save()
      }
    } catch (err) {
      run.failed = true
      this.log(`retention: ${err instanceof Error ? err.message : String(err)}`)
    }
    run.at = new Date(this.now()).toISOString()
    this.state.lastRun = run
    this.save()
    const versions = run.history?.versions ?? 0
    if (run.trash.entries || versions || run.failed) {
      this.opts.notices?.retentionRan({ trashEntries: run.trash.entries, versions, failed: run.failed })
    }
    this.log(`retention: ${run.trash.entries} trash entr${run.trash.entries === 1 ? 'y' : 'ies'} and ${versions} history version(s) removed${run.failed ? ' (failed part way)' : ''}`)
    return run
  }

  /** The history's part: older versions, and those of the notes whose trash entry was emptied. */
  private async thinHistory(cutoff: number | null): Promise<RetentionReport | null> {
    const history = this.opts.history
    if (!history) return null
    const drop = [...this.state.emptied]
    const r = await history.retain({ cutoff, keep: this.opts.trash().flatMap(filesOf), drop }, {
      // Notes still waiting whose versions are already out: a run moved the history and stopped before writing it down.
      compactPending: this.state.compactPending || drop.length > 0,
      // Once the history moved, what it had to take out is out: only compacting is left.
      afterMove: () => {
        this.state.emptied = this.state.emptied.slice(drop.length)
        this.state.compactPending = true
        this.save()
      },
    })
    if (r === null) {
      // No managed history (any more): nothing of theirs to take out.
      if (this.state.emptied.length) { this.state.emptied = []; this.save() }
      return null
    }
    // Compacted (or nothing in the history for them): nothing is left to finish.
    if (r.rewritten === 0) this.state.emptied = this.state.emptied.slice(drop.length)
    this.state.compactPending = false
    this.save()
    return r
  }

  /** Removes a trash entry for good: out of the trash in one step, then from the disk. */
  private removeEntry(id: string): boolean {
    if (!/^[0-9A-Z]{26}$/.test(id)) return false
    const root = join(this.opts.stateDir, 'trash')
    const aside = join(root, EXPIRED + id)
    try {
      renameSync(join(root, id), aside)
    } catch {
      return false // restored or gone meanwhile
    }
    rmSync(aside, { recursive: true, force: true })
    return true
  }

  /** What a run cut short left aside. */
  private cleanExpired() {
    const root = join(this.opts.stateDir, 'trash')
    let names: string[]
    try { names = readdirSync(root) } catch { return }
    for (const n of names) if (n.startsWith(EXPIRED)) rmSync(join(root, n), { recursive: true, force: true })
  }

  /** The bytes a trash entry holds on disk. */
  private entryBytes(id: string): number {
    return sizeUnder(join(this.opts.stateDir, 'trash', id))
  }

  private save() {
    mkdirSync(this.opts.stateDir, { recursive: true })
    writeAtomic(this.file, JSON.stringify(this.state))
  }
}

/** Whether a trash entry was deleted more than `days` ago. */
function expiredAt(e: TrashEntry, now: number, days: number): boolean {
  const at = Date.parse(e.deletedAt)
  return Number.isFinite(at) && at < now - days * DAY_MS
}

/** The files of a trash entry, as the history knows them: the note and what went with it. */
function filesOf(e: TrashEntry): DeletedFile[] {
  const deletedAt = Date.parse(e.deletedAt)
  if (!Number.isFinite(deletedAt)) return []
  const out: DeletedFile[] = e.kind === 'files' ? [] : [{ path: e.path, deletedAt }]
  for (const f of e.files ?? []) out.push({ path: f.path, deletedAt })
  return out
}

/** The next time it's `hour`:00 (local time) after `now`. */
export function nextAt(now: number, hour: number): number {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

function sizeUnder(path: string): number {
  let st
  try { st = statSync(path) } catch { return 0 }
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const n of readdirSync(path)) total += sizeUnder(join(path, n))
  return total
}

function read(file: string): State {
  const empty: State = { version: 1, emptied: [], compactPending: false, lastRun: null }
  if (!existsSync(file)) return empty
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>
    return {
      version: 1,
      emptied: Array.isArray(s.emptied) ? s.emptied.filter((d) => typeof d?.path === 'string' && typeof d.deletedAt === 'number') : [],
      compactPending: s.compactPending === true,
      lastRun: s.lastRun && typeof s.lastRun.at === 'string' ? s.lastRun : null,
    }
  } catch {
    return empty
  }
}
