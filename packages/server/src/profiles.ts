// Each person's profile in state.db: their timezone, which decides what day
// "today" is for them (for the UI and, later, for agents acting on their
// behalf), their daily-note series (D-030), what vihko opens when they come
// in (D-056.35) and the language of their UI. Preferences, never note
// content.
import { canonicalTimeZone, civilNow, isLanguage, type CivilDateTime, type Language } from '@vihko/core'
import type { Db } from './db.ts'

/**
 * What vihko opens when the person comes in with nothing else asked for
 * (D-056.35): `home` (the default), `last` (the last note they had open on
 * that device: the UI keeps it), `note` (one they chose, `onOpenNote`) or
 * `daily` (today's note of their series, only if it exists: never created
 * on coming in). Made to take more.
 */
export const ON_OPEN = ['home', 'last', 'note', 'daily'] as const
export type OnOpen = (typeof ON_OPEN)[number]

export interface Profile {
  /** IANA timezone; null until the browser reports one on the first sign-in. */
  timezone: string | null
  /** Id of the daily-note series their «Today» uses; null = the first one in vihko.yaml. */
  dailySeries: string | null
  /** What vihko opens when they come in (OnOpen). */
  onOpen: OnOpen
  /** With `onOpen: note`, the note's path; null otherwise. */
  onOpenNote: string | null
  /** Deprecated (0.1.0-rc.3): `onOpen` is `daily`. Still taken: true makes it `daily`, false turns `daily` into `home`. */
  openDailyOnStart: boolean
  /** The UI's language; null = automatic, the browser's. */
  language: Language | null
}

/** Timezone used while a person has none: UTC, never the server's (D-030). */
export const FALLBACK_TIMEZONE = 'UTC'

const SERIES_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A profile change that isn't valid. The API answers `invalid`. */
export class ProfileError extends Error {
  readonly code = 'invalid'
}

/** Whether a value is written as a note's path (relative, `.md`, no empty, `.` or `..` segment): «On opening»'s note. */
export const isNotePath = (p: unknown): p is string =>
  typeof p === 'string' && /\.md$/i.test(p) && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..')

const isOnOpen = (v: unknown): v is OnOpen => typeof v === 'string' && (ON_OPEN as readonly string[]).includes(v)

export class Profiles {
  private db: Db

  constructor(stateDb: Db) {
    this.db = stateDb
  }

  get(userId: string): Profile {
    const r = this.db.prepare('select timezone, daily_series, on_open, on_open_note, language from profiles where user_id = ?').get(userId) as
      { timezone: string | null; daily_series: string | null; on_open: string | null; on_open_note: string | null; language: string | null } | undefined
    // One this version doesn't know (a hand edit, a later version's) is home.
    const onOpen: OnOpen = isOnOpen(r?.on_open) ? r.on_open : 'home'
    const onOpenNote = onOpen === 'note' ? r?.on_open_note ?? null : null
    return {
      timezone: r?.timezone ?? null,
      dailySeries: r?.daily_series ?? null,
      onOpen: onOpen === 'note' && onOpenNote === null ? 'home' : onOpen,
      onOpenNote,
      openDailyOnStart: onOpen === 'daily',
      // One this version doesn't know (a hand edit, a later version's) is the browser's.
      language: isLanguage(r?.language) ? r.language : null,
    }
  }

  /**
   * Changes the fields given; the rest stay. Throws ProfileError if a value
   * isn't valid. `onOpenNote` is only checked as a note's path here: whether
   * the person reads it is the caller's (http/app.ts).
   */
  update(userId: string, patch: Partial<Profile>): Profile {
    const next = { ...this.get(userId) }
    if ('timezone' in patch) {
      const tz = patch.timezone === null ? null : canonicalTimeZone(patch.timezone)
      if (patch.timezone !== null && !tz) throw new ProfileError(`not an IANA timezone: ${String(patch.timezone)}`)
      next.timezone = tz
    }
    if ('dailySeries' in patch) {
      const id = patch.dailySeries
      if (id !== null && (typeof id !== 'string' || !SERIES_ID.test(id))) throw new ProfileError(`not a series id: ${String(id)}`)
      next.dailySeries = id ?? null
    }
    if ('openDailyOnStart' in patch) {
      if (typeof patch.openDailyOnStart !== 'boolean') throw new ProfileError('openDailyOnStart must be true or false')
      if (patch.openDailyOnStart) next.onOpen = 'daily'
      else if (next.onOpen === 'daily') next.onOpen = 'home'
    }
    if ('onOpen' in patch) {
      if (!isOnOpen(patch.onOpen)) throw new ProfileError(`onOpen must be one of ${ON_OPEN.join(', ')}`)
      next.onOpen = patch.onOpen
    }
    if ('onOpenNote' in patch) {
      const p = patch.onOpenNote
      if (p !== null && !isNotePath(p)) {
        throw new ProfileError(`not a note's path: ${String(p)}`)
      }
      next.onOpenNote = p === null ? null : p.normalize('NFC')
    }
    if (next.onOpen === 'note' && next.onOpenNote === null) throw new ProfileError('onOpen note needs onOpenNote')
    if (next.onOpen !== 'note') next.onOpenNote = null
    next.openDailyOnStart = next.onOpen === 'daily'
    if ('language' in patch) {
      if (patch.language !== null && !isLanguage(patch.language)) throw new ProfileError(`not a language of the UI: ${String(patch.language)}`)
      next.language = patch.language ?? null
    }
    this.db.prepare(`insert into profiles (user_id, timezone, daily_series, open_daily, on_open, on_open_note, language) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (user_id) do update set timezone = excluded.timezone, daily_series = excluded.daily_series, open_daily = excluded.open_daily,
        on_open = excluded.on_open, on_open_note = excluded.on_open_note, language = excluded.language`)
      .run(userId, next.timezone, next.dailySeries, next.openDailyOnStart ? 1 : 0, next.onOpen, next.onOpenNote, next.language)
    return next
  }

  /** The person's timezone, or UTC while they have none. */
  timezone(userId: string): string {
    return this.get(userId).timezone ?? FALLBACK_TIMEZONE
  }

  /** Today's date and the time for this person, in their timezone. */
  now(userId: string, instant: Date = new Date()): CivilDateTime {
    return civilNow(this.timezone(userId), instant)
  }
}
