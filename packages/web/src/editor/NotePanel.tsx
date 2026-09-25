// Note side panel: comments, links and outline.
// Everything it writes (commenting, replying, resolving) goes to the open
// session's Y.Text, like any other edit: it merges with what others write at
// the same time.
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Tab, TabList, TabPanel, Tabs, TextArea, TextField, type Key } from 'react-aria-components'
import * as Y from 'yjs'
import type { Backlink, OutgoingLink, User } from '../api.ts'
import { useT } from '../i18n.tsx'
import { useTheme } from '../theme.ts'
import { baseHue, userColor } from '../userColor.ts'
import type { Session } from './collab.ts'
import { displayDate, formatComment, parseThreads, commentPosition, replyTo, resolveThread, type Change, type Thread } from './comments.ts'
import { setCommentStyle, threadsField } from './commentMarks.ts'
import { usePresence } from './presence.ts'
import { useViewState } from './viewUpdates.ts'
import { useBackClose } from '../mobile.ts'
import './panel.css'

export type PanelTab = 'comments' | 'links' | 'toc'
export interface LinksData { outgoing: OutgoingLink[]; backlinks: Backlink[] }

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

function ThreadCard({ tv, active, color, onSelect, onReply, onResolve }: {
  tv: ThreadView
  active: boolean
  color: (author: string) => string
  onSelect: () => void
  onReply: (text: string) => void
  onResolve: () => void
}) {
  const t = useT()
  const [replying, setReplying] = useState(false)
  const { thread, quote } = tv
  return (
    <article className={active ? 'thread thread-active' : 'thread'} data-thread={thread.id}>
      <Button className="thread-quote" onPress={onSelect}>{quote ? `«${shortQuote(quote)}»` : t('comments.general')}</Button>
      {thread.comments.map((c, i) => (
        <div key={i} className={c.reply ? 'comment comment-reply' : 'comment'}>
          <span className="avatar avatar-sm" aria-hidden="true" style={{ background: color(c.author) }}>{c.author.slice(0, 1).toUpperCase()}</span>
          <div className="comment-body">
            <b>{c.author}</b> <span className="comment-when">{displayDate(c.date)}</span>
            <div>{c.text}</div>
          </div>
        </div>
      ))}
      {replying ? (
        <Composer label={t('comments.replyPlaceholder')} submit={t('comments.reply')} onSend={(text) => { onReply(text); setReplying(false) }} onCancel={() => setReplying(false)} />
      ) : (
        <div className="thread-actions">
          <Button className="btn btn-sm" onPress={() => setReplying(true)}>{t('comments.reply')}</Button>
          <Button className="btn btn-sm" onPress={onResolve}>{t('comments.resolve')}</Button>
        </div>
      )}
    </article>
  )
}

interface Draft { at: Y.RelativePosition; newline: boolean; quote: string }

function CommentsTab({ view, session, user, request, done }: { view: EditorView | null; session: Session; user: User; request: Request | null; done: () => void }) {
  const t = useT()
  const color = useAuthorColor(session)
  const { threads, head } = useViewState(view, readThreads, { threads: [], head: 0 })
  const [picked, setPicked] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const list = useRef<HTMLDivElement>(null)

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
    if (request.thread === null) return startDraft()
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
    apply(session, { from: pos, to: pos, insert: (draft.newline ? '\n' : '') + formatComment(user.username, new Date(), text) })
    setDraft(null)
  }
  // Replying and resolving reread the text on the spot: the thread is looked up by its id.
  const current = (id: string) => {
    const doc = session.text.toString()
    const th = parseThreads(doc).find((x) => x.id === id)
    return th ? { doc, th } : null
  }
  const reply = (id: string, text: string) => {
    const c = current(id)
    if (c) apply(session, replyTo(c.doc, c.th, user.username, new Date(), text))
  }
  const resolve = (id: string) => {
    const c = current(id)
    if (c) apply(session, resolveThread(c.doc, c.th))
    if (picked === id) setPicked(null)
  }
  const select = (th: Thread) => {
    setPicked(th.id)
    if (view) scrollTo(view, th.anchorTo > th.anchorFrom ? th.anchorFrom : th.from, false)
  }

  return (
    <div className="panel-scroll" ref={list}>
      {draft ? (
        <div className="thread thread-draft">
          {draft.quote && <div className="thread-quote">«{shortQuote(draft.quote)}»</div>}
          <Composer label={t('comments.placeholder')} submit={t('comments.send')} onSend={send} onCancel={() => setDraft(null)} />
        </div>
      ) : (
        <Button className="btn panel-new" onPress={startDraft} isDisabled={!view}>{CommentIcon}{t('comments.new')}</Button>
      )}
      {threads.length === 0 && !draft && <p className="panel-empty">{t('comments.empty')}</p>}
      {threads.map((tv) => (
        <ThreadCard
          key={tv.thread.id}
          tv={tv}
          active={tv.thread.id === active}
          color={color}
          onSelect={() => select(tv.thread)}
          onReply={(text) => reply(tv.thread.id, text)}
          onResolve={() => resolve(tv.thread.id)}
        />
      ))}
      <p className="panel-note">{t('comments.note')}</p>
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

function LinksTab({ links, onNavigate }: { links: LinksData | null; onNavigate: (p: string) => void }) {
  const t = useT()
  if (!links) return <div className="panel-scroll"><p className="panel-empty">{t('common.loading')}</p></div>
  const seen = new Set<string>()
  const outgoing = links.outgoing.filter((l) => !seen.has(l.raw) && seen.add(l.raw))
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
            ) : (
              <div className="link-btn link-static">
                <span className="link-name">{linkLabel(l)}</span>
                <span className="link-badge">{l.status === 'missing' ? t('editor.linkMissing') : t('editor.linkAmbiguous', { n: l.candidates?.length ?? 0 })}</span>
              </div>
            )}
            {l.status === 'ambiguous' && (
              <ul className="link-candidates">
                {(l.candidates ?? []).map((c) => (
                  <li key={c}><Button className="link-btn link-candidate" onPress={() => onNavigate(c)}>{c}</Button></li>
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

export function NotePanel({ panel, view, session, user, links, onNavigate }: {
  panel: Panel
  view: EditorView | null
  session: Session | null
  user: User
  links: LinksData | null
  onNavigate: (p: string) => void
}) {
  const t = useT()
  const count = useViewState(view, (s) => s.field(threadsField).length, 0)
  const aside = useRef<HTMLElement>(null)
  const linkCount = links ? new Set(links.outgoing.map((l) => l.raw)).size + links.backlinks.length : 0
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

  if (!panel.open || !session) return null
  return (
    <aside ref={aside} className={panel.narrow ? 'panel panel-overlay' : 'panel'} aria-label={t('panel.label')}>
      <Tabs selectedKey={panel.tab} onSelectionChange={(k: Key) => panel.setTab(k as PanelTab)} className="panel-tabs">
        <div className="panel-head">
          <TabList aria-label={t('panel.label')} className="panel-tablist">
            <Tab id="comments" className="panel-tab">{count ? t('panel.commentsN', { n: count }) : t('panel.comments')}</Tab>
            <Tab id="links" className="panel-tab">{linkCount ? t('panel.linksN', { n: linkCount }) : t('panel.links')}</Tab>
            <Tab id="toc" className="panel-tab">{t('panel.toc')}</Tab>
          </TabList>
          {panel.narrow && (
            <Button className="btn btn-icon panel-close" aria-label={t('panel.hide')} onPress={() => panel.setOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </Button>
          )}
        </div>
        <TabPanel id="comments" className="panel-body"><CommentsTab view={view} session={session} user={user} request={panel.request} done={panel.done} /></TabPanel>
        <TabPanel id="links" className="panel-body"><LinksTab links={links} onNavigate={onNavigate} /></TabPanel>
        <TabPanel id="toc" className="panel-body"><TocTab view={view} /></TabPanel>
      </Tabs>
    </aside>
  )
}
