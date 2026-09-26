// Pure helpers for the history screens (no DOM, no React): days in the
// person's timezone, how authors, reasons and changes are worded, and the
// changes of a diff. Tested by the Node test runner.
import type { ChangeKind, DiffOp, HistoryAuthor, Reason } from './api.ts'

/**
 * The texts these helpers ask for. They live in i18n.tsx (not imported here,
 * so this stays a plain module): passing `useT()` checks that each exists.
 */
export type HistoryText =
  | 'history.today' | 'history.yesterday' | 'history.agent' | 'history.agentPlain' | 'history.external' | 'history.system' | 'history.by'
  | 'history.reason.linksUpdated' | 'history.reason.renamed' | 'history.reason.moved' | 'history.reason.folderMoved'
  | 'history.reason.externalMoveOne' | 'history.reason.externalMoveMany' | 'history.reason.alias'
  | 'history.reason.historyEnabled' | 'history.reason.historyResumed' | 'history.reason.recovered'
  | 'history.change.created' | 'history.change.modified' | 'history.change.deleted' | 'history.change.movedPlain'
  | 'history.change.renamed' | 'history.change.moved' | 'history.change.restored' | 'history.change.restoredFrom' | 'history.change.trashRestored'
  | 'history.change.revertedFrom'
  | 'changes.system' | 'changes.agents'
type T = (key: HistoryText, vars?: Record<string, string | number>) => string

/** A timezone Intl accepts: the profile's, or UTC if it is unknown to this browser. */
export function safeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function dayKey(at: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The day `days` after (or before) a `YYYY-MM-DD` day. */
export function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export interface DayGroup<I> { key: string; items: I[] }

/** Items (newest first) by day in the timezone, in the order the days first appear. */
export function groupByDay<I>(items: readonly I[], at: (item: I) => string, timeZone: string): DayGroup<I>[] {
  const groups = new Map<string, I[]>()
  for (const item of items) {
    const key = dayKey(at(item), timeZone)
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups].map(([key, list]) => ({ key, items: list }))
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1)

/** «Today», «Yesterday» or the date («Thursday, 24 September»; with the year if it isn't this one). */
export function dayLabel(t: T, key: string, today: string, lang: string): string {
  if (key === today) return t('history.today')
  if (key === shiftDay(today, -1)) return t('history.yesterday')
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const sameYear = key.slice(0, 4) === today.slice(0, 4)
  const label = new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
    .format(new Date(Date.UTC(y, m - 1, d, 12)))
  return capitalize(label)
}

/** `10:05`, in the timezone. */
export function timeOf(at: string, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

/** `25 sept, 10:05` (with the year if it isn't this one), in the timezone. */
export function dateTimeOf(at: string, lang: string, timeZone: string, now = new Date()): string {
  const sameYear = dayKey(at, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4)
  return new Intl.DateTimeFormat(lang, { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) })
    .format(new Date(at))
}

// --- Paths --------------------------------------------------------------------

/** A note's name: the file name without `.md`. */
export const noteName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
/** `hogar/Proxy.md` → `hogar / Proxy`, like the header breadcrumbs. */
export const pathLabel = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')
export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
/** Only notes have versions to open; images and other files are listed. */
export const isNote = (path: string) => /\.md$/i.test(path)

/** The frontmatter `uid` of a note's text: its identity, which survives moves (D-005). */
export function uidOf(text: string | null): string | null {
  if (!text) return null
  const fm = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  const line = fm && /^uid:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]!)
  if (!line) return null
  return line[1]!.replace(/^(['"])(.*)\1$/, '$2') || null
}

// --- Authors, reasons and changes -------------------------------------------------

/** An author as plain text, for «…, by Noa». */
export function authorName(t: T, a: HistoryAuthor): string {
  switch (a.kind) {
    case 'user':
    case 'git': return a.name
    case 'agent': return a.onBehalfOf ? t('history.agentPlain', { name: a.name, user: a.onBehalfOf.name }) : a.name
    case 'external': return t('history.external')
    case 'system': return t('history.system')
  }
}

/** What the system did and for whom («Links updated when “X” was renamed to “Y”, by Noa»); null if there is nothing to say. */
export function reasonText(t: T, r: Reason | null): string | null {
  if (!r) return null
  const by = r.by ? t('history.by', { name: authorName(t, r.by) }) : ''
  switch (r.code) {
    case 'note_moved':
      if (!r.from || !r.to) return t('history.reason.linksUpdated') + by
      return (folderOf(r.from) === folderOf(r.to)
        ? t('history.reason.renamed', { from: noteName(r.from), to: noteName(r.to) })
        : t('history.reason.moved', { name: noteName(r.from), to: pathLabel(r.to) })) + by
    case 'folder_moved':
      return (r.from && r.to ? t('history.reason.folderMoved', { from: r.from, to: r.to }) : t('history.reason.linksUpdated')) + by
    case 'links_after_external_move': {
      const moves = r.moves ?? []
      return (moves.length === 1
        ? t('history.reason.externalMoveOne', { name: noteName(moves[0]!.to) })
        : t('history.reason.externalMoveMany', { n: moves.length })) + by
    }
    case 'alias_added':
      return t('history.reason.alias', { alias: r.alias ?? '', from: noteName(r.from ?? '') }) + by
    case 'history_enabled': return t('history.reason.historyEnabled')
    case 'history_resumed': return t('history.reason.historyResumed')
    case 'recovered': return t('history.reason.recovered')
    default: return null
  }
}

/** What happened to the file, when it isn't a plain edit: created, moved (from → to), deleted, restored, or an edit that reverted a change. */
export function changeText(t: T, v: { change: ChangeKind; path: string; from?: string; reason: Reason | null }, date: (at: string) => string): string | null {
  if (v.change === 'modified' && v.reason?.code === 'reverted' && v.reason.at) return t('history.change.revertedFrom', { date: date(v.reason.at) })
  switch (v.change) {
    case 'created': return t('history.change.created')
    case 'deleted': return t('history.change.deleted')
    case 'moved':
      if (!v.from) return t('history.change.movedPlain')
      return folderOf(v.from) === folderOf(v.path)
        ? t('history.change.renamed', { from: noteName(v.from), to: noteName(v.path) })
        : t('history.change.moved', { from: pathLabel(v.from), to: pathLabel(v.path) })
    case 'restored':
      if (v.reason?.code === 'restored' && v.reason.at) return t('history.change.restoredFrom', { date: date(v.reason.at) })
      if (v.reason?.code === 'trash_restored') return t('history.change.trashRestored')
      return t('history.change.restored')
    default: return null
  }
}

/** The kind of change as one word, for a file's icon. */
export function changeKindText(t: T, kind: ChangeKind): string {
  return t(({ created: 'history.change.created', modified: 'history.change.modified', moved: 'history.change.movedPlain', deleted: 'history.change.deleted', restored: 'history.change.restored' } as const)[kind])
}

/** How an author is offered in the «Recent changes» filter. */
export function filterLabel(t: T, a: HistoryAuthor): string {
  if (a.kind === 'agent') return a.onBehalfOf ? t('history.agent', { name: a.name, user: a.onBehalfOf.name }) : a.name
  if (a.kind === 'external') return t('history.external')
  if (a.kind === 'system') return t('changes.system')
  return a.name
}

/** The filter's options: people, agents (all of them too, if there are several), outside thoth, the system and git authors. */
export function filterOptions(t: T, authors: readonly HistoryAuthor[]): { key: string; label: string }[] {
  const order = { user: 0, agent: 1, external: 3, system: 4, git: 5 } as const
  const seen = new Map<string, HistoryAuthor>()
  for (const a of authors) if (!seen.has(a.key)) seen.set(a.key, a)
  const list = [...seen.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
  const options: { key: string; label: string; rank: number }[] = list.map((a) => ({ key: a.key, label: filterLabel(t, a), rank: order[a.kind] }))
  if (list.filter((a) => a.kind === 'agent').length > 1) options.push({ key: 'agent', label: t('changes.agents'), rank: 2 })
  return options.sort((a, b) => a.rank - b.rank).map(({ key, label }) => ({ key, label }))
}

// --- Diff -------------------------------------------------------------------------

/**
 * Which change each op belongs to (-1: text that didn't change), and how many
 * changes there are. Edits separated only by spaces on a line are one change.
 */
export function changeGroups(ops: readonly DiffOp[]): { group: number[]; count: number } {
  const group: number[] = []
  let n = -1
  let open = false
  ops.forEach(([op, text], i) => {
    if (op === 0) {
      const joins = open && ops[i + 1] !== undefined && ops[i + 1]![0] !== 0 && /^[ \t]*$/.test(text)
      if (!joins) open = false
      group.push(-1)
      return
    }
    if (!open) { n++; open = true }
    group.push(n)
  })
  return { group, count: n + 1 }
}
