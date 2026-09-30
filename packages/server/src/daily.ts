// The daily note (D-030): the note of a series for "today" in the person's
// timezone, so the UI and, later, the agents acting on their behalf (M3) get
// the same note. Created from the series template through the normal create:
// never overwriting.
import { seriesPath, type Series } from '@vihko/core'
import type { User } from './auth.ts'
import { NoteError, type Actor, type NoteService } from './notes.ts'
import { createFromTemplate } from './templates.ts'
import type { Profiles } from './profiles.ts'
import type { Workspace } from './workspace.ts'

export interface DailyOptions {
  workspace: Workspace
  profiles: Profiles
  notes: NoteService
  /** The clock (tests). */
  now?: () => Date
}

export interface DailyToday {
  series: string
  path: string
  exists: boolean
}

export class DailyNotes {
  private opts: DailyOptions

  constructor(opts: DailyOptions) {
    this.opts = opts
  }

  private instant() {
    return this.opts.now?.() ?? new Date()
  }

  /**
   * The series a person's «Today» uses: the one asked for, their own choice
   * or else the first in vihko.yaml. A choice that vihko.yaml no longer has
   * falls back to the first. With no series, daily notes are off.
   */
  seriesFor(user: User, requested?: string | null): Series {
    const all = this.opts.workspace.config.daily
    if (requested) {
      const s = all.find((x) => x.id === requested)
      if (!s) throw new NoteError('not_found', `no daily-note series ${requested} in vihko.yaml`)
      return s
    }
    const chosen = this.opts.profiles.get(user.id).dailySeries
    const s = all.find((x) => x.id === chosen) ?? all[0]
    if (!s) throw new NoteError('not_configured', 'no daily-note series in vihko.yaml')
    return s
  }

  /** Path of the person's note for today and whether it exists. Creates nothing. */
  today(user: User, requested?: string | null): DailyToday {
    const series = this.seriesFor(user, requested)
    const path = seriesPath(series, this.opts.profiles.now(user.id, this.instant()), user.username)
    let exists = true
    try { this.opts.notes.read(path) } catch (err) {
      if (!(err instanceof NoteError) || err.code !== 'not_found') throw err
      exists = false
    }
    return { series: series.id, path, exists }
  }

  private exists(path: string): boolean {
    try {
      this.opts.notes.read(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Today's note: opened if it exists, otherwise created from the series
   * template. Never overwrites: if someone creates it at the same moment,
   * the one that is there wins and both open it. `actor`: who creates it
   * (an agent on the user's behalf); `template`: whether the series
   * template may be used (an agent that can't read it gets an empty note);
   * `mayName`: as for any creation (NoteService.create): a name that would
   * take a link to a note it refuses is `exists`, as a taken name.
   */
  async open(user: User, requested?: string | null, opts: { actor?: Actor; template?: (path: string) => boolean; mayName?: (path: string) => boolean } = {}): Promise<{ series: string; path: string; created: boolean }> {
    const series = this.seriesFor(user, requested)
    const now = this.opts.profiles.now(user.id, this.instant())
    const path = seriesPath(series, now, user.username)
    try {
      this.opts.notes.read(path)
      return { series: series.id, path, created: false }
    } catch (err) {
      if (!(err instanceof NoteError) || err.code !== 'not_found') throw err
    }
    try {
      const template = series.template && (opts.template?.(series.template) ?? true) ? series.template : null
      await createFromTemplate(this.opts.notes, { path, template, user, now, missing: 'empty', actor: opts.actor, mayName: opts.mayName })
      return { series: series.id, path, created: true }
    } catch (err) {
      // Created meanwhile by someone else: that one opens. A name refused (nothing there) stays refused.
      if (err instanceof NoteError && err.code === 'exists' && this.exists(path)) return { series: series.id, path, created: false }
      throw err
    }
  }
}
