// Each person's profile in state.db: their timezone, which decides what day
// "today" is for them (for the UI and, later, for agents acting on their
// behalf), their daily-note preferences (D-030) and the language of their UI.
// Preferences, never note content.
import { canonicalTimeZone, civilNow, isLanguage, type CivilDateTime, type Language } from '@vihko/core'
import type { Db } from './db.ts'

export interface Profile {
  /** IANA timezone; null until the browser reports one on the first sign-in. */
  timezone: string | null
  /** Id of the daily-note series their «Today» uses; null = the first one in vihko.yaml. */
  dailySeries: string | null
  /** Open today's note (only if it exists) when vihko opens with nothing else asked for. */
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

export class Profiles {
  private db: Db

  constructor(stateDb: Db) {
    this.db = stateDb
  }

  get(userId: string): Profile {
    const r = this.db.prepare('select timezone, daily_series, open_daily, language from profiles where user_id = ?').get(userId) as
      { timezone: string | null; daily_series: string | null; open_daily: number; language: string | null } | undefined
    return {
      timezone: r?.timezone ?? null,
      dailySeries: r?.daily_series ?? null,
      openDailyOnStart: !!r?.open_daily,
      // One this version doesn't know (a hand edit, a later version's) is the browser's.
      language: isLanguage(r?.language) ? r.language : null,
    }
  }

  /** Changes the fields given; the rest stay. Throws ProfileError if a value isn't valid. */
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
      next.openDailyOnStart = patch.openDailyOnStart
    }
    if ('language' in patch) {
      if (patch.language !== null && !isLanguage(patch.language)) throw new ProfileError(`not a language of the UI: ${String(patch.language)}`)
      next.language = patch.language ?? null
    }
    this.db.prepare(`insert into profiles (user_id, timezone, daily_series, open_daily, language) values (?, ?, ?, ?, ?)
      on conflict (user_id) do update set timezone = excluded.timezone, daily_series = excluded.daily_series, open_daily = excluded.open_daily, language = excluded.language`)
      .run(userId, next.timezone, next.dailySeries, next.openDailyOnStart ? 1 : 0, next.language)
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
