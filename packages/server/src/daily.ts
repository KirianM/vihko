// The daily note: the note of a series for "today" in the person's
// timezone, so the UI and, later, the agents acting on their behalf (M3) get
// the same note. Created from the series template through the normal create:
// never overwriting.
import { PEOPLE, seriesPath, type Series } from '@vihko/core'
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
  /**
   * Whether a series is offered to a person (under the spaces model: where
   * they can write today's note). One that isn't is neither their
   * default nor there when asked for by id (`not_found`, whatever is on the
   * disk). Every series by default.
   */
  offered?: (user: User, series: Series) => boolean
  /** Every series a person may be offered (vihko.yaml's and their spaces' and own settings, noteSettings.ts); vihko.yaml's by default. */
  seriesOf?: (user: User) => Series[]
  /** A series left out because a closer one gives the same notes: that one's id (noteSettings.ts `series`). */
  sameAs?: (user: User, id: string) => string | null
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
   * or, with no choice yet, the first offered in their own space (`seriesOf`
   * lists their own first, then their spaces', then vihko.yaml's). A series
   * left out for a closer one with the same notes is that one. vihko never
   * writes into a shared space by itself: with no choice and no series in
   * their own space, and with a choice that no longer exists or is no longer
   * offered, it's `series_gone`, so the person chooses. With no series,
   * daily notes are off.
   */
  seriesFor(user: User, requested?: string | null): Series {
    const all = (this.opts.seriesOf?.(user) ?? this.opts.workspace.config.daily).filter((s) => this.opts.offered?.(user, s) ?? true)
    const find = (id: string) => {
      const same = all.find((x) => x.id === id) ? id : this.opts.sameAs?.(user, id) ?? id
      return all.find((x) => x.id === same)
    }
    if (requested) {
      const s = find(requested)
      if (!s) throw new NoteError('not_found', `no daily-note series ${requested} for this person`)
      return s
    }
    if (all.length === 0) throw new NoteError('not_configured', 'no daily-note series for this person')
    const chosen = this.opts.profiles.get(user.id).dailySeries
    if (chosen === null) {
      // Never into another space by itself: the first series in the person's own space, or they choose.
      const own = `${PEOPLE}/${user.username}`
      const mine = all.find((s) => { const f = s.folder.replaceAll('{user}', user.username); return f === own || f.startsWith(`${own}/`) })
      if (mine) return mine
      throw new NoteError('series_gone', 'this person hasn\'t chosen a daily-note series and none offered is in their own space: vihko never picks one in a shared space by itself; they choose (dailySeries in the profile)')
    }
    const s = find(chosen)
    if (!s) throw new NoteError('series_gone', `the daily-note series ${chosen} this person chose no longer exists for them: they choose another (dailySeries in the profile)`)
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
    // The first time «Today's note» opens without a choice, the series it
    // used becomes the choice: a series added later (a space's, say) never
    // takes its place without the person choosing it in Preferences.
    // A choice of a series left out for a closer one with the same notes becomes that one.
    const opened = (created: boolean) => {
      const chosen = this.opts.profiles.get(user.id).dailySeries
      if (!requested && chosen !== series.id) this.opts.profiles.update(user.id, { dailySeries: series.id })
      return { series: series.id, path, created }
    }
    try {
      this.opts.notes.read(path)
      return opened(false)
    } catch (err) {
      if (!(err instanceof NoteError) || err.code !== 'not_found') throw err
    }
    try {
      const template = series.template && (opts.template?.(series.template) ?? true) ? series.template : null
      await createFromTemplate(this.opts.notes, { path, template, user, now, missing: 'empty', actor: opts.actor, mayName: opts.mayName })
      return opened(true)
    } catch (err) {
      // Created meanwhile by someone else: that one opens. A name refused (nothing there) stays refused.
      if (err instanceof NoteError && err.code === 'exists' && this.exists(path)) return opened(false)
      throw err
    }
  }
}
