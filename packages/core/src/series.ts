// Daily-note series (D-030): a folder and a name pattern declared in
// vihko.yaml. Daily, weekly, monthly or yearly are just different patterns.
// A note belongs to a series by its path alone, computed from the pattern:
// no index, no marker in the file.
import { compareDates, isValidDate, isoWeek, isoWeekStart, type CivilDate } from './dates.ts'

export type Period = 'day' | 'week' | 'month' | 'year'

export interface Series {
  /** Stable key in vihko.yaml; each person's choice refers to it. */
  id: string
  /** Name shown in the UI; the id if there isn't one. */
  label: string | null
  /** Folder pattern from the notes root ('' = the root). */
  folder: string
  /** File name pattern, without `.md`. */
  name: string
  /** Template note, from the notes root, or null. */
  template: string | null
  period: Period
}

/** Tokens a series pattern understands. */
export const SERIES_TOKENS = ['YYYY', 'MM', 'DD', 'GGGG', 'WW', 'user'] as const
export type SeriesToken = (typeof SERIES_TOKENS)[number]

const TOKEN = /\{([^{}]*)\}/g

/** Full pattern of the note path: folder + name + `.md`. */
export const seriesPattern = (s: Pick<Series, 'folder' | 'name'>) => `${s.folder ? `${s.folder}/` : ''}${s.name}.md`

/** Tokens in a pattern; `unknown` lists those vihko doesn't understand. */
export function patternTokens(pattern: string): { tokens: Set<SeriesToken>; unknown: string[] } {
  const tokens = new Set<SeriesToken>()
  const unknown: string[] = []
  for (const m of pattern.matchAll(TOKEN)) {
    if ((SERIES_TOKENS as readonly string[]).includes(m[1]!)) tokens.add(m[1] as SeriesToken)
    else unknown.push(m[1]!)
  }
  return { tokens, unknown }
}

/**
 * The period a pattern names one note for, or null if its tokens don't pin
 * down exactly one day, ISO week, month or year: a day needs `{YYYY}`,
 * `{MM}` and `{DD}`; a week `{GGGG}` and `{WW}` (with `{YYYY}` the last days
 * of December would land in the wrong year's week 1); a month `{YYYY}` and
 * `{MM}`; a year `{YYYY}`. Mixing weeks with months or days is refused.
 */
export function patternPeriod(tokens: Set<SeriesToken>): Period | null {
  const has = (t: SeriesToken) => tokens.has(t)
  const weekly = has('GGGG') || has('WW')
  if (has('DD')) return has('YYYY') && has('MM') && !weekly ? 'day' : null
  if (weekly) return has('GGGG') && has('WW') && !has('YYYY') && !has('MM') ? 'week' : null
  if (has('MM')) return has('YYYY') ? 'month' : null
  return has('YYYY') ? 'year' : null
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function fill(pattern: string, date: CivilDate, user: string): string {
  const week = isoWeek(date)
  const values: Record<SeriesToken, string> = {
    YYYY: pad(date.year, 4), MM: pad(date.month), DD: pad(date.day), GGGG: pad(week.year, 4), WW: pad(week.week), user,
  }
  return pattern.replace(TOKEN, (whole, name: string) => values[name as SeriesToken] ?? whole)
}

/** Path of the series note that covers `date`, for the person `user` (used only if the pattern has `{user}`). */
export function seriesPath(series: Pick<Series, 'folder' | 'name'>, date: CivilDate, user: string): string {
  return fill(seriesPattern(series), date, user)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * If `path` is a note of the series: the first day of its period and the
 * person in `{user}` (null without it). The path must be exactly the one the
 * pattern gives for that date, so `2026-02-31.md` or `2026-9-25.md` don't count.
 */
export function matchSeries(series: Pick<Series, 'folder' | 'name' | 'period'>, path: string): { date: CivilDate; user: string | null } | null {
  const pattern = seriesPattern(series)
  const order: string[] = []
  let source = '^'
  let at = 0
  for (const m of pattern.matchAll(TOKEN)) {
    source += escape(pattern.slice(at, m.index))
    at = m.index + m[0].length
    const name = m[1]!
    if (!(SERIES_TOKENS as readonly string[]).includes(name)) { source += escape(m[0]); continue }
    order.push(name)
    source += name === 'user' ? '([^/]+)' : name === 'YYYY' || name === 'GGGG' ? '(\\d{4})' : '(\\d{2})'
  }
  source += escape(pattern.slice(at)) + '$'
  const m = new RegExp(source).exec(path)
  if (!m) return null
  const values: Record<string, string> = {}
  for (const [i, name] of order.entries()) {
    const v = m[i + 1]!
    if (name in values && values[name] !== v) return null // the same token with two values
    values[name] = v
  }
  let date: CivilDate | null
  if (series.period === 'week') date = isoWeekStart(Number(values.GGGG), Number(values.WW))
  else date = { year: Number(values.YYYY), month: Number(values.MM ?? 1), day: Number(values.DD ?? 1) }
  if (!date || !isValidDate(date)) return null
  const user = values.user ?? null
  if (seriesPath(series, date, user ?? '') !== path) return null
  return { date, user }
}

/**
 * The notes of the same series (and the same person, for a personal series)
 * just before and after `current`, among `paths`: the nearest ones that
 * exist, skipping the days with no note. null if `current` isn't in the series.
 */
export function seriesNeighbors(series: Pick<Series, 'folder' | 'name' | 'period'>, paths: Iterable<string>, current: string): { prev: string | null; next: string | null } | null {
  const me = matchSeries(series, current)
  if (!me) return null
  let prev: { path: string; date: CivilDate } | null = null
  let next: { path: string; date: CivilDate } | null = null
  for (const path of paths) {
    const m = matchSeries(series, path)
    if (!m || m.user !== me.user) continue
    const c = compareDates(m.date, me.date)
    if (c < 0 && (!prev || compareDates(m.date, prev.date) > 0)) prev = { path, date: m.date }
    if (c > 0 && (!next || compareDates(m.date, next.date) < 0)) next = { path, date: m.date }
  }
  return { prev: prev?.path ?? null, next: next?.path ?? null }
}
