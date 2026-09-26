// Comment threads resolved in the last 30 days (D-032.5), at the end of the
// Comments tab. The history lists them (GET /api/history/resolved); reopening
// one puts it back through the editor session, the way resolving took it out:
// there is no endpoint that writes them (one core for every write).
//
// The list follows the note live: a thread whose first comment is in the note
// again (reopened here or by someone else) leaves it at once, and when a
// thread leaves the note the list is asked for again once the hub has saved
// the text. Meanwhile, one resolved here shows as resolved by you, now.
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import { request } from '../api.ts'
import { useHistoryStatus } from '../history/ui.tsx'
import { useT } from '../i18n.tsx'
import type { Session } from './collab.ts'
import { commentKey, displayDate, reopener, type Change, type Comment, type RemovedThread, type Thread } from './comments.ts'
import { useViewState } from './viewUpdates.ts'
import './resolved.css'

type Translate = ReturnType<typeof useT>

/** The history's mode, and whether it can be read now (GET /api/history/status). */
export interface HistoryState { mode: 'managed' | 'unmanaged' | 'off'; available: boolean }

/** An author as the history gives it, with their current name. */
export interface ResolvedBy { kind: 'user' | 'agent' | 'system' | 'external' | 'git'; id?: string; name: string; onBehalfOf?: { id: string; name: string } }

export interface ResolvedThread extends RemovedThread {
  resolvedAt: string
  resolvedBy: ResolvedBy[]
  /** The version that resolved it; null: not a version yet. */
  version: string | null
  /** Whether its text was in the note when the history was asked (the list checks it again, live). */
  reopenable: boolean
}

/**
 * The history's state: null until known, or if it can't be asked. The same
 * one the «History» tab and «Recent changes» use, asked again when a note
 * opens (unless it just was) and on coming back to the page.
 */
export function useHistoryState(): HistoryState | null {
  return useHistoryStatus()
}

/** Requests in a row while the server is still reading a long history. */
const MAX_ROUNDS = 10
/** Asked again this long after a thread left the note, if the hub hasn't said it saved it. */
const STALE_MS = 4000

/**
 * The note's resolved threads: the history's, and the ones resolved here that
 * it doesn't list yet (`add`); never one whose first comment is in the note.
 */
export function useResolved(session: Session, threads: Thread[], enabled: boolean) {
  const [listed, setListed] = useState<ResolvedThread[]>([])
  const [mine, setMine] = useState<ResolvedThread[]>([])
  const stale = useRef(() => {})

  useEffect(() => {
    setListed([])
    setMine([])
    if (!enabled) return
    let live = true
    let rounds = 0
    let waiting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      clearTimeout(timer)
      waiting = false
      request<{ threads: ResolvedThread[]; complete: boolean }>('GET', `/api/history/resolved?${new URLSearchParams({ path: session.path })}`)
        .then((r) => {
          if (!live) return
          setListed(r.threads)
          setMine((m) => m.filter((x) => !r.threads.some((y) => y.id === x.id)))
          // A long history is read over several requests.
          if (!r.complete && ++rounds < MAX_ROUNDS) timer = setTimeout(load, 300)
        })
        .catch(() => {})
    }
    stale.current = () => {
      waiting = true
      rounds = 0
      clearTimeout(timer)
      timer = setTimeout(load, STALE_MS)
    }
    const onStateless = ({ payload }: { payload: string }) => {
      if (!waiting) return
      try {
        if ((JSON.parse(payload) as { type?: string }).type === 'thoth:saved') load()
      } catch { /* not a message of ours */ }
    }
    session.provider.on('stateless', onStateless)
    load()
    return () => {
      live = false
      clearTimeout(timer)
      stale.current = () => {}
      session.provider.off('stateless', onStateless)
    }
  }, [session, enabled])

  // Every comment in the note now. One that was here and isn't: a thread left, the list is stale.
  const here = useMemo(() => new Set(threads.flatMap((t) => t.comments.map(commentKey))), [threads])
  const before = useRef(here)
  useEffect(() => {
    for (const k of before.current) if (!here.has(k)) { stale.current(); break }
    before.current = here
  }, [here])

  const list = useMemo(() => {
    const seen = new Set<string>()
    return [...mine, ...listed].filter((t) => !here.has(t.id) && !seen.has(t.id) && seen.add(t.id))
  }, [mine, listed, here])
  return { list, add: (t: ResolvedThread) => setMine((m) => [t, ...m.filter((x) => x.id !== t.id)]) }
}

function applyChange(session: Session, c: Change) {
  session.doc.transact(() => {
    if (c.to > c.from) session.text.delete(c.from, c.to - c.from)
    if (c.insert) session.text.insert(c.from, c.insert)
  })
}

function ago(t: Translate, iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return t('comments.resolved.now')
  if (s < 3600) return t('comments.resolved.minutes', { n: Math.floor(s / 60) })
  if (s < 86400) return t('comments.resolved.hours', { n: Math.floor(s / 3600) })
  const days = Math.floor(s / 86400)
  return days === 1 ? t('comments.resolved.yesterday') : t('comments.resolved.days', { n: days })
}

function authorName(t: Translate, a: ResolvedBy) {
  if (a.kind === 'agent') return t('comments.resolved.agent', { name: a.name, user: a.onBehalfOf?.name ?? '' })
  if (a.kind === 'external') return t('comments.resolved.external')
  if (a.kind === 'system') return 'thoth'
  return a.name
}

function byLine(t: Translate, r: ResolvedThread) {
  const when = ago(t, r.resolvedAt)
  if (r.resolvedBy.length === 0) return t('comments.resolved.byUnknown', { when })
  return t('comments.resolved.by', { who: r.resolvedBy.map((a) => authorName(t, a)).join(', '), when })
}

function CommentLine({ c, color }: { c: Pick<Comment, 'author' | 'date' | 'text' | 'reply'>; color: (author: string) => string }) {
  return (
    <div className={c.reply ? 'comment comment-reply' : 'comment'}>
      <span className="avatar avatar-sm" aria-hidden="true" style={{ background: color(c.author) }}>{c.author.slice(0, 1).toUpperCase()}</span>
      <div className="comment-body">
        <b>{c.author}</b> <span className="comment-when">{displayDate(c.date)}</span>
        <div>{c.text}</div>
      </div>
    </div>
  )
}

function ResolvedCard({ r, reopenable, color, onReopen }: {
  r: ResolvedThread
  reopenable: boolean
  color: (author: string) => string
  onReopen: () => void
}) {
  const t = useT()
  const [showReplies, setShowReplies] = useState(false)
  const [first, ...replies] = r.comments
  return (
    <article className="resolved-thread" data-resolved={r.id}>
      <div className="resolved-quote">{r.anchor ? `«${r.anchor}»` : t('comments.general')}</div>
      {first && <CommentLine c={first} color={color} />}
      {replies.length > 0 && (
        <Button className="resolved-replies" aria-expanded={showReplies} onPress={() => setShowReplies(!showReplies)}>
          {showReplies ? t('comments.resolved.hideReplies') : replies.length === 1 ? t('comments.resolved.reply') : t('comments.resolved.replies', { n: replies.length })}
        </Button>
      )}
      {showReplies && replies.map((c, i) => <CommentLine key={i} c={c} color={color} />)}
      <p className="resolved-by">{byLine(t, r)}</p>
      {reopenable ? (
        <div className="thread-actions">
          <Button className="btn btn-sm" onPress={onReopen}>{t('comments.resolved.reopen')}</Button>
        </div>
      ) : (
        <p className="resolved-gone">{t('comments.resolved.gone')}</p>
      )}
    </article>
  )
}

/** Open: whether each one can be reopened is worked out on the note as it is now, as it changes. */
function ResolvedList({ items, view, session, color, onReopened }: {
  items: ResolvedThread[]
  view: EditorView | null
  session: Session
  color: (author: string) => string
  onReopened: (id: string) => void
}) {
  const doc = useViewState<Text | null>(view, (s) => s.doc, null)
  const reopen = useMemo(() => (doc ? reopener(doc.toString()) : null), [doc])
  const act = (r: ResolvedThread) => {
    const change = reopener(session.text.toString())(r)
    if (!change) return
    applyChange(session, change)
    onReopened(r.id)
  }
  return (
    <div className="resolved-list">
      {items.map((r) => (
        <ResolvedCard key={r.id} r={r} reopenable={reopen ? reopen(r) !== null : r.reopenable} color={color} onReopen={() => act(r)} />
      ))}
    </div>
  )
}

export function ResolvedSection({ items, view, session, color, onReopened }: {
  items: ResolvedThread[]
  view: EditorView | null
  session: Session
  color: (author: string) => string
  /** A thread went back into the note (its id: its first comment's key). */
  onReopened: (id: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Folded again once there is nothing in it.
  useEffect(() => { if (items.length === 0) setOpen(false) }, [items.length])
  if (items.length === 0) return null
  const title = t('comments.resolved.title', { n: items.length })
  return (
    <section className="resolved" aria-label={title}>
      <Button className="resolved-toggle" aria-expanded={open} onPress={() => setOpen(!open)}>
        <svg className="resolved-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {title}
      </Button>
      {open && <ResolvedList items={items} view={view} session={session} color={color} onReopened={onReopened} />}
    </section>
  )
}
