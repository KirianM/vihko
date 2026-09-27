// Note side panel: comments, links, outline and history.
// Everything it writes (commenting, replying, resolving) goes to the open
// session's Y.Text, like any other edit: it merges with what others write at
// the same time.
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Tab, TabList, TabPanel, Tabs, TextArea, TextField, type Key } from 'react-aria-components'
import * as Y from 'yjs'
import { api, canEdit, type CommentOp, type CommentOriginal, type Level, type NoteLinks, type OutgoingLink, type User } from '../api.ts'
import { errorText, useT } from '../i18n.tsx'
import { useTheme } from '../theme.ts'
import { Icon } from '../ui.tsx'
import { baseHue, userColor } from '../userColor.ts'
import type { Session } from './collab.ts'
import { anchorChanged, commentContext, commentKey, displayDate, formatComment, parseThreads, commentPosition, removedThread, replyTo, resolveThread, type Change, type Thread } from './comments.ts'
import { setCommentStyle, threadsField } from './commentMarks.ts'
import { usePresence } from './presence.ts'
import { ResolvedSection, useHistoryState, useResolved } from './ResolvedThreads.tsx'
import { useViewState } from './viewUpdates.ts'
import { useBackClose } from '../mobile.ts'
import type { AmbiguousLink } from './AmbiguousPicker.tsx'
import './panel.css'

export type PanelTab = 'comments' | 'links' | 'toc' | 'history'
export type LinksData = NoteLinks

// --- Panel state ----------------------------------------------------------

const STORE = 'thoth.panel'
const NARROW = '(max-width: 1099px)'

function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches)
  useEffect(() => {
    const m = matchMedia(NARROW)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

/** Request to the panel from outside (editor, shortcut): `seq` makes the same one repeat. */
type Request = { seq: number; thread: string | null }

export interface Panel {
  narrow: boolean
  open: boolean
  setOpen: (open: boolean) => void
  tab: PanelTab
  setTab: (tab: PanelTab) => void
  request: Request | null
  /** The panel already handled the request. */
  done: () => void
  /** Opens comments: on a thread or, with null, to comment on the selection. */
  showComments: (thread: string | null) => void
}

/**
 * On a wide screen the panel is open unless the person closes it (remembered
 * in this browser). On narrow it starts closed and opens over the editor.
 */
export function usePanel(): Panel {
  const narrow = useNarrow()
  const [wideOpen, setWideOpen] = useState(() => {
    try { return localStorage.getItem(STORE) !== 'closed' } catch { return true }
  })
  const [narrowOpen, setNarrowOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('comments')
  const [request, setRequest] = useState<Request | null>(null)
  const setOpen = (open: boolean) => {
    if (narrow) return setNarrowOpen(open)
    try { localStorage.setItem(STORE, open ? 'open' : 'closed') } catch { /* no persistence */ }
    setWideOpen(open)
  }
  return {
    narrow,
    open: narrow ? narrowOpen : wideOpen,
    setOpen,
    tab,
    setTab,
    request,
    done: () => setRequest(null),
    showComments: (thread) => {
      setTab('comments')
      setOpen(true)
      setRequest((r) => ({ seq: (r?.seq ?? 0) + 1, thread }))
    },
  }
}

const PanelIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
  </svg>
)
const CommentIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

export function PanelToggle({ panel }: { panel: Panel }) {
  const t = useT()
  return (
    <Button className="btn btn-icon" aria-label={t(panel.open ? 'panel.hide' : 'panel.show')} aria-expanded={panel.open} onPress={() => panel.setOpen(!panel.open)}>
      {PanelIcon}
    </Button>
  )
}

// --- Utilities --------------------------------------------------------------------

/** Applies a change to the Y.Text in a single transaction. */
function apply(session: Session, c: Change) {
  session.doc.transact(() => {
    if (c.to > c.from) session.text.delete(c.from, c.to - c.from)
    if (c.insert) session.text.insert(c.from, c.insert)
  })
}

/** Nodes a comment must not split: it is inserted after them. */
const INLINE = new Set(['Link', 'Image', 'WikiLink', 'WikiEmbed', 'InlineCode', 'Autolink', 'URL', 'Tag', 'Comment', 'HTMLTag'])
/** Blocks where a comment wouldn't be a comment (or would break the block): it goes on the next line. */
const OPAQUE = new Set(['Frontmatter', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Table', 'LinkReference'])

function safePosition(state: EditorState, pos: number): { pos: number; newline: boolean } {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (OPAQUE.has(n.name) && n.from <= pos && pos <= n.to) {
      return { pos: state.doc.lineAt(Math.max(n.from, n.to - (state.doc.sliceString(n.to - 1, n.to) === '\n' ? 1 : 0))).to, newline: true }
    }
    if (INLINE.has(n.name) && n.from < pos && pos < n.to) pos = n.to
  }
  return { pos, newline: false }
}

function useAuthorColor(session: Session) {
  const peers = usePresence(session.provider)
  const { effective } = useTheme()
  // Whoever is in the note, with their cursor's color; whoever isn't, with the hue of their name.
  return useMemo(() => {
    const hues = new Map(peers.map((p) => [p.name, p.hue]))
    return (author: string) => userColor(hues.get(author) ?? baseHue(author), effective)
  }, [peers, effective])
}

function scrollTo(view: EditorView, pos: number, select = true) {
  view.dispatch({ selection: select ? { anchor: pos } : undefined, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 48 }) })
  view.focus()
}

// --- Comments -------------------------------------------------------------------

interface ThreadView { thread: Thread; quote: string }
const readThreads = (s: EditorState) => ({
  threads: s.field(threadsField).map((thread): ThreadView => ({ thread, quote: s.doc.sliceString(thread.anchorFrom, thread.anchorTo) })),
  head: s.selection.main.head,
})

function shortQuote(q: string) {
  const one = q.replace(/\s+/g, ' ')
  return one.length > 60 ? one.slice(0, 57).trimEnd() + '…' : one
}


function Composer({ label, submit, onSend, onCancel }: { label: string; submit: string; onSend: (text: string) => void; onCancel: () => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const send = () => { if (text.trim()) onSend(text) }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }
  return (
    <div className="composer">
      <TextField aria-label={label} value={text} onChange={setText} autoFocus>
        <TextArea className="composer-input" placeholder={label} rows={2} onKeyDown={onKeyDown} />
      </TextField>
      <div className="thread-actions">
        <Button className="btn btn-sm" onPress={onCancel}>{t('common.cancel')}</Button>
        <Button className="btn btn-sm btn-primary" isDisabled={!text.trim()} onPress={send}>{submit}</Button>
      </div>
    </div>
  )
}

function ThreadCard({ tv, original, active, color, confirm, onSelect, onReply, onResolve }: {
  tv: ThreadView
  /** The commented text as the index first saw it, when it differs from the text now. */
  original: string | null
  active: boolean
  color: (author: string) => string
  /** What to ask before resolving; null: nothing (the history keeps it, D-032.5). */
  confirm: string | null
  onSelect: () => void
  /** Null: the person can't reply (they may only read). */
  onReply: ((text: string) => void) | null
  /** Null: the person can't resolve this thread (D-038.5: with `comment`, only their own, with no one else's replies). */
  onResolve: (() => void) | null
}) {
  const t = useT()
  const [replying, setReplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { thread, quote } = tv
  return (
    <article className={active ? 'thread thread-active' : 'thread'} data-thread={thread.id}>
      <Button className="thread-quote" onPress={onSelect}>{quote ? `«${shortQuote(quote)}»` : t('comments.general')}</Button>
      {original !== null && (
        <div className="thread-changed">
          <span className="thread-changed-badge">{t('comments.changed')}</span>
          <span className="thread-original">{t('comments.original', { text: shortQuote(original) })}</span>
        </div>
      )}
      {thread.comments.map((c, i) => (
        <div key={i} className={c.reply ? 'comment comment-reply' : 'comment'}>
          <span className="avatar avatar-sm" aria-hidden="true" style={{ background: color(c.author) }}>{c.author.slice(0, 1).toUpperCase()}</span>
          <div className="comment-body">
            <b>{c.author}</b> <span className="comment-when">{displayDate(c.date)}</span>
            <div>{c.text}</div>
          </div>
        </div>
      ))}
      {replying && onReply ? (
        <Composer label={t('comments.replyPlaceholder')} submit={t('comments.reply')} onSend={(text) => { onReply(text); setReplying(false) }} onCancel={() => setReplying(false)} />
      ) : confirming && confirm !== null && onResolve ? (
        <div className="thread-confirm" role="group" aria-label={t('comments.resolve')}>
          <p>{confirm}</p>
          <div className="thread-actions">
            <Button className="btn btn-sm" autoFocus onPress={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button className="btn btn-sm btn-danger" onPress={() => { setConfirming(false); onResolve() }}>{t('comments.resolveYes')}</Button>
          </div>
        </div>
      ) : (onReply || onResolve) && (
        <div className="thread-actions">
          {onReply && <Button className="btn btn-sm" onPress={() => setReplying(true)}>{t('comments.reply')}</Button>}
          {onResolve && <Button className="btn btn-sm" onPress={() => (confirm === null ? onResolve() : setConfirming(true))}>{t('comments.resolve')}</Button>}
        </div>
      )}
    </article>
  )
}

interface Draft { at: Y.RelativePosition; newline: boolean; quote: string }

function CommentsTab({ view, session, user, originals, request, done, level }: {
  view: EditorView | null
  session: Session
  user: User
  originals: CommentOriginal[] | null
  request: Request | null
  done: () => void
  /** What the person may do in the note (D-038.5): `read` only reads; `comment` comments through the server. */
  level: Level
}) {
  const t = useT()
  const color = useAuthorColor(session)
  const editing = canEdit(level)
  const commenting = level !== 'read'
  // With `comment`, the editor is read-only: the server writes the comment (commenting.ts), and it arrives like anyone's edit.
  const [failed, setFailed] = useState<string | null>(null)
  const viaServer = (op: CommentOp) => {
    setFailed(null)
    api.comment(session.path, op).catch((e) => setFailed(errorText(t, e)))
  }
  const { threads, head } = useViewState(view, readThreads, { threads: [], head: 0 })
  // Compared with the live text, so the mark follows what is being typed.
  const originalOf = useMemo(() => new Map((originals ?? []).map((o) => [o.id, o.original])), [originals])
  const changedFrom = (tv: ThreadView) => {
    const was = originalOf.get(tv.thread.id)
    return was !== undefined && anchorChanged(was, tv.quote) ? was : null
  }
  const [picked, setPicked] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const list = useRef<HTMLDivElement>(null)

  // With history, resolving can be undone from «Resolved» (D-032.5): managed,
  // no need to ask; unmanaged, only what reaches a commit; off or unavailable, asked as before.
  // Without `edit` there's no history to see (D-034 3.5): resolving is asked, and «Resolved» isn't there.
  const history = useHistoryState()
  const mode = history?.available && editing ? history.mode : 'off'
  const confirm = mode === 'managed' ? null : mode === 'unmanaged' ? t('comments.resolved.confirmUnmanaged') : t('comments.resolveConfirm')
  const live = useMemo(() => threads.map((tv) => tv.thread), [threads])
  const resolved = useResolved(session, live, editing && history !== null && history.mode !== 'off')
  // A thread reopened from «Resolved» becomes the active one once it is back in the text.
  const [reopened, setReopened] = useState<string | null>(null)

  // Active thread: the one picked in the panel or, failing that, the one whose text holds the cursor.
  const underCursor = threads.find(({ thread: th }) => head >= Math.min(th.anchorFrom, th.from) && head <= th.to)?.thread.id ?? null
  const active = picked && threads.some((x) => x.thread.id === picked) ? picked : underCursor

  useEffect(() => {
    view?.dispatch({ effects: setCommentStyle.of({ color, active }) })
  }, [view, color, active])

  const startDraft = () => {
    if (!view) return
    const doc = session.text.toString()
    const { from, to } = view.state.selection.main
    const { pos, newline } = safePosition(view.state, commentPosition(doc, from, to))
    // The text that will end up anchored: the comment is simulated and its anchor is read.
    const at = pos + (newline ? 1 : 0)
    const probe = doc.slice(0, pos) + (newline ? '\n' : '') + formatComment(user.username, new Date(), '·') + doc.slice(pos)
    const th = parseThreads(probe).find((x) => x.comments.some((c) => c.from === at))
    const quote = th && th.anchorTo > th.anchorFrom ? probe.slice(th.anchorFrom, th.anchorTo) : ''
    setDraft({ at: Y.createRelativePositionFromTypeIndex(session.text, pos, -1), newline, quote })
  }

  useEffect(() => {
    if (!request) return
    done()
    if (request.thread === null) return commenting ? startDraft() : undefined
    setPicked(request.thread)
    list.current?.querySelector(`[data-thread="${CSS.escape(request.thread)}"]`)?.scrollIntoView({ block: 'nearest' })
    // Only reacts to new requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const send = (text: string) => {
    if (!draft) return
    const doc = session.text.toString()
    let pos = Y.createAbsolutePositionFromRelativePosition(draft.at, session.doc)?.index ?? doc.length
    // If meanwhile someone commented right there, the new one goes after that thread.
    for (const th of parseThreads(doc)) if (pos > th.from && pos < th.to) pos = th.to
    if (editing) apply(session, { from: pos, to: pos, insert: (draft.newline ? '\n' : '') + formatComment(user.username, new Date(), text) })
    else viaServer({ op: 'add', at: pos, context: commentContext(doc, pos), text, ...(draft.newline ? { newline: true } : {}) })
    setDraft(null)
  }
  // Replying and resolving reread the text on the spot: the thread is looked up by its id.
  const current = (id: string) => {
    const doc = session.text.toString()
    const th = parseThreads(doc).find((x) => x.id === id)
    return th ? { doc, th } : null
  }
  const reply = (id: string, text: string) => {
    if (!editing) return viaServer({ op: 'reply', thread: id, text })
    const c = current(id)
    if (c) apply(session, replyTo(c.doc, c.th, user.username, new Date(), text))
  }
  const resolve = (id: string) => {
    if (!editing) viaServer({ op: 'resolve', thread: id })
    else {
      const c = current(id)
      if (c) {
        // Listed at once as resolved by you; the history lists it once the text is saved.
        if (mode === 'managed') {
          resolved.add({ ...removedThread(c.doc, c.th), resolvedAt: new Date().toISOString(), resolvedBy: [{ kind: 'user', id: user.id, name: user.username }], version: null, reopenable: true })
        }
        apply(session, resolveThread(c.doc, c.th))
      }
    }
    if (picked === id) setPicked(null)
  }
  // With `comment`, only one's own threads (D-038.5); with `edit`, anyone's.
  // With `comment`, only a thread they started and nobody else replied to (D-038.5, D-040 3.7): resolving takes the replies out too.
  const mayResolve = (th: Thread) => editing || (commenting && th.comments.every((c) => c.author === user.username))
  const select = (th: Thread) => {
    setPicked(th.id)
    if (view) scrollTo(view, th.anchorTo > th.anchorFrom ? th.anchorFrom : th.from, false)
  }

  useEffect(() => {
    if (!reopened) return
    const back = threads.find((tv) => commentKey(tv.thread.comments[0]!) === reopened)
    if (!back) return
    setReopened(null)
    select(back.thread)
    list.current?.querySelector(`[data-thread="${CSS.escape(back.thread.id)}"]`)?.scrollIntoView({ block: 'nearest' })
    // Only when the reopened thread shows up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, reopened])

  return (
    <div className="panel-scroll" ref={list}>
      {!commenting ? null : draft ? (
        <div className="thread thread-draft">
          {draft.quote && <div className="thread-quote">«{shortQuote(draft.quote)}»</div>}
          <Composer label={t('comments.placeholder')} submit={t('comments.send')} onSend={send} onCancel={() => setDraft(null)} />
        </div>
      ) : (
        <Button className="btn panel-new" onPress={startDraft} isDisabled={!view}>{CommentIcon}{t('comments.new')}</Button>
      )}
      {failed && <p className="error-text" role="alert">{failed}</p>}
      {threads.length === 0 && !draft && <p className="panel-empty">{t(commenting ? 'comments.empty' : 'comments.emptyRead')}</p>}
      {threads.map((tv) => (
        <ThreadCard
          key={tv.thread.id}
          tv={tv}
          original={changedFrom(tv)}
          active={tv.thread.id === active}
          color={color}
          confirm={confirm}
          onSelect={() => select(tv.thread)}
          onReply={commenting ? (text) => reply(tv.thread.id, text) : null}
          onResolve={mayResolve(tv.thread) ? () => resolve(tv.thread.id) : null}
        />
      ))}
      {editing && <ResolvedSection items={resolved.list} view={view} session={session} color={color} onReopened={setReopened} />}
      <p className="panel-note">{t(!commenting ? 'comments.noteRead' : mode === 'managed' ? 'comments.resolved.noteManaged' : mode === 'unmanaged' ? 'comments.resolved.noteUnmanaged' : 'comments.note')}</p>
    </div>
  )
}

// --- Links -----------------------------------------------------------------------

function linkLabel(l: OutgoingLink) {
  if (l.kind === 'md') return /^\[([^\]]*)\]/.exec(l.raw)?.[1] || l.raw
  const inner = l.raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '')
  const bar = inner.indexOf('|')
  return bar === -1 ? inner.replace(/^\//, '').replace(/\.md$/i, '') : inner.slice(bar + 1)
}

const noteName = (path: string) => path.replace(/^.*\//, '').replace(/\.md$/i, '')

function Context({ text, raw }: { text: string; raw: string }) {
  const i = text.indexOf(raw)
  if (i === -1) return <span className="backlink-context">{text}</span>
  return <span className="backlink-context">{text.slice(0, i)}<mark>{raw}</mark>{text.slice(i + raw.length)}</span>
}

/**
 * The outgoing links the panel lists: each written form once, and none that
 * leads to the note itself (`[[#Heading]]`, its own name), which isn't a link
 * between notes and is never a backlink either (the same rule as the MCP tools).
 */
function listedOutgoing(links: LinksData): OutgoingLink[] {
  const seen = new Set<string>()
  return links.outgoing.filter((l) => !l.self && !seen.has(l.raw) && seen.add(l.raw))
}

/** The panel's view of an ambiguous link: where it is (as indexed) and its candidates. */
const ambiguous = (l: OutgoingLink): AmbiguousLink => ({ raw: l.raw, at: l.pos_from, candidates: l.candidates ?? [] })

function LinksTab({ links, onNavigate, onPickAmbiguous, onOpenCandidate }: {
  links: LinksData | null
  onNavigate: (p: string) => void
  onPickAmbiguous: (link: AmbiguousLink, anchor: HTMLElement) => void
  onOpenCandidate: (link: AmbiguousLink, target: string) => void
}) {
  const t = useT()
  if (!links) return <div className="panel-scroll"><p className="panel-empty">{t('common.loading')}</p></div>
  const outgoing = listedOutgoing(links)
  return (
    <div className="panel-scroll">
      <h3 className="panel-h">{t('links.outgoing', { n: outgoing.length })}</h3>
      {outgoing.length === 0 && <p className="panel-empty">{t('links.noneOut')}</p>}
      <ul className="link-list">
        {outgoing.map((l) => (
          <li key={l.raw} className={`link link-${l.status}`}>
            {l.status === 'resolved' && l.dst_path ? (
              <Button className="link-btn" onPress={() => onNavigate(l.dst_path!)}>
                <span className="link-name">{linkLabel(l)}</span>
                <span className="link-path">{l.dst_path}</span>
              </Button>
            ) : l.status === 'ambiguous' ? (
              // Opens the picker: open one of the candidates, or pin the link to it.
              <Button className="link-btn link-static link-pick" aria-haspopup="dialog" onPress={(e) => onPickAmbiguous(ambiguous(l), e.target as HTMLElement)}>
                <span className="link-name">{linkLabel(l)}</span>
                <span className="link-badge">{t('editor.linkAmbiguous', { n: l.candidates?.length ?? 0 })}</span>
              </Button>
            ) : l.status === 'no_access' ? (
              // Exists, not the person's to read (D-024): no path, no title, nothing to create.
              <div className="link-btn link-static">
                <span className="link-name">{linkLabel(l)}</span>
                <span className="link-badge">{Icon.lock}{t('editor.linkNoAccess')}</span>
              </div>
            ) : (
              <div className="link-btn link-static">
                <span className="link-name">{linkLabel(l)}</span>
                <span className="link-badge">{t('editor.linkMissing')}</span>
              </div>
            )}
            {l.status === 'ambiguous' && (
              <ul className="link-candidates">
                {(l.candidates ?? []).map((c) => (
                  <li key={c}><Button className="link-btn link-candidate" onPress={() => onOpenCandidate(ambiguous(l), c)}>{c}</Button></li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <h3 className="panel-h">{t('links.incoming', { n: links.backlinks.length })}</h3>
      {links.backlinks.length === 0 && <p className="panel-empty">{t('links.noneIn')}</p>}
      <ul className="link-list">
        {links.backlinks.map((b, i) => (
          <li key={`${b.path}:${i}`} className="link">
            <Button className="link-btn backlink" onPress={() => onNavigate(b.path)}>
              <span className="link-name">{b.title || noteName(b.path)}</span>
              <Context text={b.context} raw={b.raw} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Outline ------------------------------------------------------------------------

interface HeadingItem { level: number; text: string; from: number }

function headingText(line: string) {
  return line
    .replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}

const readHeadings = (s: EditorState) => {
  const items: HeadingItem[] = []
  syntaxTree(s).iterate({
    enter: (n) => {
      if (n.name === 'Frontmatter') return false
      const m = /^(ATX|Setext)Heading(\d)$/.exec(n.name)
      if (!m) return
      items.push({ level: Number(m[2]), text: headingText(s.doc.lineAt(n.from).text), from: n.from })
      return false
    },
  })
  return { items, head: s.selection.main.head }
}

function TocTab({ view }: { view: EditorView | null }) {
  const t = useT()
  const { items, head } = useViewState(view, readHeadings, { items: [], head: 0 })
  if (items.length === 0) return <div className="panel-scroll"><p className="panel-empty">{t('toc.empty')}</p></div>
  const min = Math.min(...items.map((h) => h.level))
  let current = -1
  items.forEach((h, i) => { if (h.from <= head) current = i })
  return (
    <div className="panel-scroll">
      <ul className="toc">
        {items.map((h, i) => (
          <li key={`${h.from}`}>
            <Button className={i === current ? 'toc-item toc-current' : 'toc-item'} style={{ paddingLeft: 8 + (h.level - min) * 14 }} onPress={() => view && scrollTo(view, h.from)}>
              {h.text || '—'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Panel ---------------------------------------------------------------------------

export function NotePanel({ panel, view, session, user, level, links, originals, history, onNavigate, onPickAmbiguous, onOpenCandidate }: {
  panel: Panel
  view: EditorView | null
  session: Session | null
  user: User
  /** What the person may do in the note (D-038.5). */
  level: Level
  links: LinksData | null
  /** Comment threads' text as the index first saw it (null until loaded). */
  originals: CommentOriginal[] | null
  /** The «History» tab's content; null when the history is off (no tab). */
  history: ReactNode | null
  onNavigate: (p: string) => void
  /** An ambiguous link was pressed: the picker of its candidates. */
  onPickAmbiguous: (link: AmbiguousLink, anchor: HTMLElement) => void
  /** One of its candidates was pressed: open it and offer to pin the link there. */
  onOpenCandidate: (link: AmbiguousLink, target: string) => void
}) {
  const t = useT()
  const count = useViewState(view, (s) => s.field(threadsField).length, 0)
  const aside = useRef<HTMLElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const linkCount = links ? listedOutgoing(links).length + links.backlinks.length : 0
  // Overlaid, it's a screen of its own: the back button closes it.
  useBackClose(panel.narrow && panel.open, () => panel.setOpen(false))

  // Overlaid (narrow screen): Escape closes it and focus returns to the editor.
  useEffect(() => {
    if (!panel.narrow || !panel.open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && aside.current?.contains(document.activeElement)) { panel.setOpen(false); view?.focus() }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [panel, view])

  // Not every tab fits once they carry counts (the list scrolls): the chosen one is always in sight.
  useEffect(() => {
    head.current?.querySelector('.panel-tab[data-selected]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [panel.tab, panel.open, session])

  if (!panel.open || !session) return null
  return (
    <aside ref={aside} className={panel.narrow ? 'panel panel-overlay' : 'panel'} aria-label={t('panel.label')}>
      <Tabs selectedKey={panel.tab} onSelectionChange={(k: Key) => panel.setTab(k as PanelTab)} className="panel-tabs">
        <div className="panel-head" ref={head}>
          <TabList aria-label={t('panel.label')} className="panel-tablist">
            <Tab id="comments" className="panel-tab">{count ? t('panel.commentsN', { n: count }) : t('panel.comments')}</Tab>
            <Tab id="links" className="panel-tab">{linkCount ? t('panel.linksN', { n: linkCount }) : t('panel.links')}</Tab>
            <Tab id="toc" className="panel-tab">{t('panel.toc')}</Tab>
            {history && <Tab id="history" className="panel-tab">{t('history.tab')}</Tab>}
          </TabList>
          {panel.narrow && (
            <Button className="btn btn-icon panel-close" aria-label={t('panel.hide')} onPress={() => panel.setOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </Button>
          )}
        </div>
        <TabPanel id="comments" className="panel-body"><CommentsTab view={view} session={session} user={user} originals={originals} request={panel.request} done={panel.done} level={level} /></TabPanel>
        <TabPanel id="links" className="panel-body"><LinksTab links={links} onNavigate={onNavigate} onPickAmbiguous={onPickAmbiguous} onOpenCandidate={onOpenCandidate} /></TabPanel>
        <TabPanel id="toc" className="panel-body"><TocTab view={view} /></TabPanel>
        {history && <TabPanel id="history" className="panel-body">{history}</TabPanel>}
      </Tabs>
    </aside>
  )
}
