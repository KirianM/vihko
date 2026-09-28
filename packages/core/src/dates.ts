// Civil dates: what day and time it is for a person in their timezone, the
// arithmetic the daily-note series need (days, ISO weeks, months) and the
// small date format language of templates. No Moment: a handful of tokens
// covers what a template or a file name needs.

/** A calendar day, with no timezone: what a person means by "today". */
export interface CivilDate { year: number; month: number; day: number }
/** A calendar day and a wall-clock time, with no timezone. */
export interface CivilDateTime extends CivilDate { hour: number; minute: number }

/**
 * `tz` if it is an IANA timezone name (`Europe/Madrid`, `UTC`), or null if
 * it isn't one. Offsets like `+02:00` are rejected: they don't follow daylight
 * saving time, so "today" would drift for half of the year.
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz) || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Date and wall-clock time at `instant` in the timezone `tz` (IANA name). */
export function civilNow(tz: string, instant: Date = new Date()): CivilDateTime {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    })
    formatters.set(tz, f)
  }
  const parts: Record<string, number> = {}
  for (const p of f.formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! }
}

const DAY_MS = 86_400_000
const toUtc = (d: CivilDate) => Date.UTC(d.year, d.month - 1, d.day)
function fromUtc(ms: number): CivilDate {
  const t = new Date(ms)
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** true if the day exists (no 31 February). */
export function isValidDate(d: CivilDate): boolean {
  if (![d.year, d.month, d.day].every(Number.isInteger) || d.year < 1 || d.year > 9999) return false
  const r = fromUtc(toUtc(d))
  return r.year === d.year && r.month === d.month && r.day === d.day
}

export const addDays = (d: CivilDate, n: number): CivilDate => fromUtc(toUtc(d) + n * DAY_MS)

/** ISO 8601 week: weeks start on Monday and week 1 holds the year's first Thursday. */
export function isoWeek(d: CivilDate): { year: number; week: number } {
  const t = new Date(toUtc(d))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow) // the Thursday of this week decides the year
  const year = t.getUTCFullYear()
  return { year, week: Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1 }
}

/** Monday of ISO week `week` of `year`, or null if that year has no such week. */
export function isoWeekStart(year: number, week: number): CivilDate | null {
  const jan4 = Date.UTC(year, 0, 4)
  const dow = new Date(jan4).getUTCDay() || 7
  const monday = fromUtc(jan4 - (dow - 1) * DAY_MS + (week - 1) * 7 * DAY_MS)
  const w = isoWeek(monday)
  return week >= 1 && w.year === year && w.week === week ? monday : null
}

/** Compares two days: negative, zero or positive. */
export const compareDates = (a: CivilDate, b: CivilDate) => toUtc(a) - toUtc(b)

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/**
 * Formats a date with these tokens (anything else is copied as is, and text
 * in `[brackets]` is never read as tokens):
 *
 * | Token | Meaning | Example |
 * |---|---|---|
 * | `YYYY` / `YY` | year | `2026` / `26` |
 * | `MM` / `M` | month | `09` / `9` |
 * | `DD` / `D` | day of the month | `05` / `5` |
 * | `GGGG` | ISO week-numbering year | `2026` |
 * | `WW` / `W` | ISO week | `09` / `9` |
 * | `HH` / `mm` | hour (00-23) and minute | `08` / `05` |
 *
 * Month and weekday names aren't offered: they depend on a language the
 * server doesn't know.
 */
export function formatDate(format: string, dt: CivilDate & Partial<CivilDateTime>): string {
  const week = () => isoWeek(dt)
  // A `[` with no `]` after it is plain text: past the last `]` none is looked
  // for (from every `[` there, that search ran to the end, in quadratic time).
  const close = format.lastIndexOf(']') + 1
  const token = (tok: string, literal: string | undefined) => {
    if (literal !== undefined) return literal
    switch (tok) {
      case 'YYYY': return pad(dt.year, 4)
      case 'YY': return pad(dt.year % 100)
      case 'MM': return pad(dt.month)
      case 'M': return String(dt.month)
      case 'DD': return pad(dt.day)
      case 'D': return String(dt.day)
      case 'GGGG': return pad(week().year, 4)
      case 'WW': return pad(week().week)
      case 'W': return String(week().week)
      case 'HH': return pad(dt.hour ?? 0)
      default: return pad(dt.minute ?? 0) // mm
    }
  }
  return format.slice(0, close).replace(/\[([^\]]*)\]|YYYY|GGGG|YY|MM|M|DD|D|WW|W|HH|mm/g, token)
    + format.slice(close).replace(/YYYY|GGGG|YY|MM|M|DD|D|WW|W|HH|mm/g, (tok) => token(tok, undefined))
}
