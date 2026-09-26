// Shared pieces of the history screens: the person's timezone, the history
// status, a note's versions (kept fresh while they're on screen), authors
// (always with an icon and text, never by colour alone) and the notice after
// restoring a version.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from 'react-aria-components'
import { useLang, useT } from '../i18n.tsx'
import { useTheme } from '../theme.ts'
import { Icon, Mark } from '../ui.tsx'
import { baseHue, userColor } from '../userColor.ts'
import { historyApi, type HistoryAuthor, type HistoryStatus, type Pending, type Reason, type RestoreReport, type Version } from './api.ts'
import { dateTimeOf, dayKey, dayLabel, groupByDay, reasonText, safeZone, timeOf } from './format.ts'
import '../actions.css'
import './history.css'

// --- Dates ---------------------------------------------------------------------

/** The person's timezone (their profile), which decides what «today» is, as for the daily note. */
export const TimeZoneContext = createContext<string>('UTC')

export function useDates() {
  const lang = useLang()
  const zone = safeZone(useContext(TimeZoneContext))
  const t = useT()
  return useMemo(() => ({
    time: (at: string) => timeOf(at, lang, zone),
    dateTime: (at: string) => dateTimeOf(at, lang, zone),
    // «Today» is asked each time: a page left open past midnight moves on.
    day: (key: string) => dayLabel(t, key, dayKey(new Date(), zone), lang),
    group: <I,>(items: readonly I[], at: (item: I) => string) => groupByDay(items, at, zone),
  }), [lang, zone, t])
}

// --- Status ----------------------------------------------------------------------

let status: HistoryStatus | null = null
let statusAt = 0
let statusLoading = false
const statusListeners = new Set<() => void>()

/** Asks the server again unless it just did: thoth.yaml can turn the history on or off at any time. */
function loadStatus(force = false) {
  if (statusLoading || (!force && Date.now() - statusAt < 5_000)) return
  statusLoading = true
  historyApi.status()
    .then((s) => { status = s; statusAt = Date.now() }, () => { /* keep the last one known */ })
    .finally(() => { statusLoading = false; statusListeners.forEach((l) => l()) })
}

const subscribeStatus = (l: () => void) => { statusListeners.add(l); return () => { statusListeners.delete(l) } }

/** The history's mode and whether it can be read; null until known. Asked again on coming back to the page. */
export function useHistoryStatus(): HistoryStatus | null {
  const s = useSyncExternalStore(subscribeStatus, () => status)
  useEffect(() => {
    loadStatus()
    const on = () => { if (document.visibilityState === 'visible') loadStatus() }
    addEventListener('focus', on)
    document.addEventListener('visibilitychange', on)
    return () => { removeEventListener('focus', on); document.removeEventListener('visibilitychange', on) }
  }, [])
  return s
}

// --- A note's versions -------------------------------------------------------------

export interface VersionsStore {
  versions: Version[]
  next: string | null
  pending: Pending | null
  loaded: boolean
  error: unknown
  loadingMore: boolean
  refresh: () => void
  loadMore: () => void
  /** A version and the one before it, loading older pages if needed; null if it isn't in the note's history. */
  find: (id: string) => Promise<{ version: Version; older: Version | null } | null>
  /** The note changed: look again soon, and more often for a while (a version closes after some calm). */
  activity: () => void
}

const PAGE = 50
/** While something is being written (or just was), how often to look; otherwise, how often. */
const FAST_POLL = 3_000
const SLOW_POLL = 30_000
const ACTIVE_FOR = 60_000

/**
 * The versions of the note at `path`, newest first. While `active` (the
 * history tab or a version on screen), they're asked again on a timer, on
 * coming back to the page and after the note changes; every request has a
 * time limit, so a lost one never freezes the list.
 */
export function useVersions(path: string | null, active: boolean): VersionsStore {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const data = useRef<{ versions: Version[]; next: string | null; pending: Pending | null; loaded: boolean; error: unknown; loadingMore: boolean }>(
    { versions: [], next: null, pending: null, loaded: false, error: null, loadingMore: false },
  )
  const seq = useRef(0)
  const lastActivity = useRef(0)
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const set = (patch: Partial<typeof data.current>) => { data.current = { ...data.current, ...patch }; rerender() }

  const refresh = useCallback(async () => {
    const p = pathRef.current
    if (!p) return
    const mine = ++seq.current
    try {
      const r = await historyApi.versions(p, { limit: PAGE })
      if (mine !== seq.current || p !== pathRef.current) return
      // The first page again; older pages already loaded stay after it.
      const old = data.current.versions
      const last = r.versions.at(-1)
      const j = last ? old.findIndex((v) => v.id === last.id) : -1
      const keep = j !== -1 && j + 1 < old.length
      set({ versions: keep ? [...r.versions, ...old.slice(j + 1)] : r.versions, next: keep ? data.current.next : r.next, pending: r.pending, loaded: true, error: null })
    } catch (err) {
      if (mine === seq.current) set({ loaded: true, error: err })
    }
  }, [])

  const moreInFlight = useRef<Promise<void> | null>(null)
  /** The next older page (the one already on its way, if asked twice). */
  const more = useCallback((): Promise<void> => {
    const p = pathRef.current
    const cursor = data.current.next
    if (!p || !cursor) return Promise.resolve()
    if (moreInFlight.current) return moreInFlight.current
    set({ loadingMore: true })
    const run = (async () => {
      try {
        const r = await historyApi.versions(p, { cursor, limit: PAGE })
        if (p !== pathRef.current || cursor !== data.current.next) return set({ loadingMore: false })
        const known = new Set(data.current.versions.map((v) => v.id))
        set({ versions: [...data.current.versions, ...r.versions.filter((v) => !known.has(v.id))], next: r.next, loadingMore: false })
      } catch (err) {
        set({ loadingMore: false, error: err })
      } finally {
        moreInFlight.current = null
      }
    })()
    moreInFlight.current = run
    return run
  }, [])

  const find = useCallback(async (id: string) => {
    if (!data.current.loaded) await refresh()
    for (let pages = 0; pages < 20; pages++) {
      const list = data.current.versions
      const i = list.findIndex((v) => v.id === id)
      if (i !== -1 && (i + 1 < list.length || !data.current.next)) return { version: list[i]!, older: list[i + 1] ?? null }
      if (!data.current.next) return null
      const before = list.length
      await more()
      if (data.current.versions.length === before) return i === -1 ? null : { version: list[i]!, older: null }
    }
    return null
  }, [refresh, more])

  const activity = useCallback(() => {
    lastActivity.current = Date.now()
    if (soon.current) clearTimeout(soon.current)
    soon.current = setTimeout(() => { soon.current = null; void refresh() }, 800)
  }, [refresh])

  useEffect(() => {
    data.current = { versions: [], next: null, pending: null, loaded: false, error: null, loadingMore: false }
    rerender()
  }, [path])

  useEffect(() => {
    if (!path || !active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (stopped) return
      const fast = data.current.pending !== null || Date.now() - lastActivity.current < ACTIVE_FOR
      timer = setTimeout(() => { void refresh().finally(schedule) }, fast ? FAST_POLL : SLOW_POLL)
    }
    void refresh().finally(schedule)
    const on = () => { if (document.visibilityState === 'visible') void refresh() }
    addEventListener('focus', on)
    document.addEventListener('visibilitychange', on)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      removeEventListener('focus', on)
      document.removeEventListener('visibilitychange', on)
    }
  }, [path, active, refresh])

  useEffect(() => () => { if (soon.current) clearTimeout(soon.current) }, [])

  const refreshNow = useCallback(() => void refresh(), [refresh])
  const loadMore = useCallback(() => void more(), [more])
  return { ...data.current, refresh: refreshNow, loadMore, find, activity }
}

// --- Icons -------------------------------------------------------------------------

const svg = (children: ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export const HistoryIcon = {
  history: svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, 16),
  external: svg(<><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /></>),
  commit: svg(<><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>),
  created: svg(<path d="M12 5v14M5 12h14" />),
  modified: svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>),
  moved: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  deleted: svg(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />),
  restored: svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>),
  up: svg(<path d="m6 15 6-6 6 6" />, 16),
  down: svg(<path d="m6 9 6 6 6-6" />, 16),
}

// --- Authors -----------------------------------------------------------------------

/**
 * Who made a change, each with its shape and words: a person, their presence
 * colour's dot and name; an agent, the diamond in accent and «Claude · on
 * behalf of Noa»; the system, thoth's mark and what it did; outside
 * thoth, its icon (and «while thoth was stopped»); a git author, their name.
 */
export function Authors({ authors, reason, foundAtStartup }: { authors: readonly HistoryAuthor[]; reason?: Reason | null; foundAtStartup?: boolean }) {
  const t = useT()
  const { effective } = useTheme()
  return (
    <span className="h-authors">
      {authors.map((a, i) => {
        const key = `${a.key}#${i}`
        switch (a.kind) {
          case 'user':
            return <span key={key} className="h-author"><span className="h-dot" aria-hidden="true" style={{ background: userColor(baseHue(a.id ?? a.name), effective) }} />{a.name}</span>
          case 'agent':
            return <span key={key} className="h-author h-agent"><span className="h-diamond" aria-hidden="true" />{a.onBehalfOf ? t('history.agent', { name: a.name, user: a.onBehalfOf.name }) : a.name}</span>
          case 'system':
            return <span key={key} className="h-author h-system"><span className="h-icon"><Mark size={14} /></span>{reasonText(t, reason ?? null) ?? t('history.system')}</span>
          case 'external':
            return <span key={key} className="h-author h-external"><span className="h-icon">{HistoryIcon.external}</span>{t(foundAtStartup ? 'history.externalStopped' : 'history.external')}</span>
          case 'git':
            return <span key={key} className="h-author"><span className="h-icon">{HistoryIcon.commit}</span>{a.name}</span>
        }
      })}
    </span>
  )
}

/** `+12 −3`, read out as words by screen readers; nothing when neither changed. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  const t = useT()
  if (!added && !removed) return null
  return (
    <span className="h-counts">
      <span aria-hidden="true">
        {added > 0 && <span className="h-add">+{added}</span>}
        {removed > 0 && <span className="h-del">−{removed}</span>}
      </span>
      <span className="visually-hidden">{t(!removed ? 'history.countsAdded' : !added ? 'history.countsRemoved' : 'history.counts', { added, removed })}</span>
    </span>
  )
}

// --- After restoring ---------------------------------------------------------------

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** «Version restored», and what happened to the images that version linked. */
export function RestoreToast({ report, onDismiss }: { report: RestoreReport; onDismiss: () => void }) {
  const t = useT()
  const { restored, missing } = report.images
  const list = (reason: 'not_in_history' | 'exists') => missing.filter((m) => m.reason === reason).map((m) => fileName(m.path)).join(', ')
  const gone = list('not_in_history')
  const taken = list('exists')
  const warn = missing.length > 0
  const text = [
    t('version.restored'),
    restored.length === 1 && t('version.imagesRestoredOne', { images: fileName(restored[0]!) }),
    restored.length > 1 && t('version.imagesRestored', { n: restored.length, images: restored.map(fileName).join(', ') }),
    gone && t('version.imagesNotInHistory', { images: gone }),
    taken && t('version.imagesExist', { images: taken }),
  ].filter(Boolean).join(' ')
  // A plain «done» goes away on its own; one that tells about images waits to be read.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (warn) return
    const timer = setTimeout(() => dismiss.current(), 6000)
    return () => clearTimeout(timer)
  }, [warn])
  return (
    <div className={warn ? 'toast toast-warn' : 'toast'}>
      <span className="toast-icon">{warn ? Icon.alert : Icon.check}</span>
      <span className="toast-text" role={warn ? 'alert' : 'status'}>{text}</span>
      <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
    </div>
  )
}
