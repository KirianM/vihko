// The open note: header (path, save state, presence, panel toggle, more
// actions), the banner for a note deleted outside vihko, the editor (or one
// of its versions, from the history) and the side panel.
import { startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, DialogTrigger, Popover, Tooltip, TooltipTrigger } from 'react-aria-components'
import { ApiError, api, canEdit, type CommentOriginal, type Level, type MoveJob, type MoveReport, type ServerConfig, type User } from '../api.ts'
import { INSERT_IMAGE } from '../commands.ts'
import { useTheme } from '../theme.ts'
import { userColor } from '../userColor.ts'
import { errorText, useT } from '../i18n.tsx'
import { Crumbs, Diamond, Icon, MenuButton, ThemeToggle, noteName } from '../ui.tsx'
import { useMobile } from '../mobile.ts'
import { listItem, tag, wikilink, type Edit } from './insert.ts'
import { SearchButton } from '../Palette.tsx'
import { useCollab, type CollabState } from './collab.ts'
import type { Trashed } from '../TrashToast.tsx'
import { CreateLinkUi, useCreateLink } from './CreateLinkMenu.tsx'
import { AmbiguousPicker, type AmbiguousLink, type PickerState } from './AmbiguousPicker.tsx'
import type { PinOffer } from '../PinOffer.tsx'
import { Editor } from './Editor.tsx'
import { ImageInsertUi, useImageInsert } from './ImageInsert.tsx'
import { NoteActions } from './NoteActions.tsx'
import type { LinkInfo } from './livePreview.ts'
import { NotePanel, PanelToggle, usePanel, type LinksData } from './NotePanel.tsx'
import { usePresence } from './presence.ts'
import { agentLabel, useAgents } from './agents.ts'
import type { HistoryStatus, RestoreReport, RevertReport } from '../history/api.ts'
import { HistoryTab } from '../history/HistoryTab.tsx'
import { RevertToast, useVersions } from '../history/ui.tsx'
import { VersionView } from '../history/VersionView.tsx'

function SaveStatus({ c }: { c: CollabState }) {
  const t = useT()
  if (c.orphaned) return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.orphanStatus')}</span></span>
  if (c.connection === 'offline') return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.offline')}</span></span>
  if (c.connection === 'connecting') return <span className="status"><span className="status-label">{t('editor.connecting')}</span></span>
  if (c.save === 'saving') return <span className="status"><span className="status-label">{t('editor.saving')}</span></span>
  return <span className="status status-ok">{Icon.check}<span className="status-label">{t('editor.saved')}</span></span>
}

/** Who is in the note: people as circles with their initial, agents as a pill with the diamond and who they act for. */
function Presence({ c }: { c: CollabState }) {
  const t = useT()
  const peers = usePresence(c.session?.provider)
  const agents = useAgents(c.session?.provider)
  const { effective } = useTheme()
  if (peers.length === 0 && agents.length === 0) return null
  return (
    <span className="presence">
      {peers.map((p) => (
        <span key={p.key} className="avatar avatar-stack" title={p.name} style={{ background: userColor(p.hue, effective) }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {/* Announced as it arrives: an agent writing in the note you have open. */}
      <span className="presence-agents" role="status">
        {agents.map((a) => {
          const label = agentLabel(t, a)
          const via = a.via && t(a.via === 'mcp' ? 'keys.viaMcp' : a.via === 'oauth' ? 'keys.viaOauth' : 'keys.viaApi')
          return (
            <span key={`${a.name}\u0000${a.onBehalfOf}`} className="agent-pill" title={via ? `${label}, ${via}` : label}>
              <Diamond /><span className="agent-pill-text">{label}</span>{via && <span className="visually-hidden">, {via}</span>}
            </span>
          )
        })}
      </span>
    </span>
  )
}

/**
 * The frontmatter block at the start of the text, as it is now: only to tell
 * when it may have changed (the server reads it for real).
 */
function frontmatterBlock(text: string): string {
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? m[0] : /^\uFEFF?---/.test(text) ? text.slice(0, 4096) : ''
}

/**
 * Whether the note is hidden from agents (`ai: false`, or a frontmatter that
 * can't be read), as the server reads its text: asked on opening and again
 * once a change to the frontmatter is saved.
 */
function useAgentHiding(path: string, c: CollabState): 'ai' | 'frontmatter' | null {
  const [hiding, setHiding] = useState<'ai' | 'frontmatter' | null>(null)
  const [block, setBlock] = useState<string | null>(null)
  const asked = useRef<string | null>(null)
  const text = c.session?.text
  useEffect(() => {
    if (!text) return
    const read = () => setBlock(frontmatterBlock(text.toString()))
    read()
    text.observe(read)
    return () => text.unobserve(read)
  }, [text])
  useEffect(() => {
    if (c.save !== 'saved' || block === null || block === asked.current) return
    asked.current = block
    let live = true
    api.note(path).then((n) => { if (live) setHiding(n.hiddenFromAgents ?? null) }, () => { if (live) asked.current = null })
    return () => { live = false }
  }, [path, c.save, block])
  return hiding
}

/**
 * What the person may do in the note (D-038.5), from the server: asked on
 * opening, and again when the hub says it changed while open (then the
 * session is opened again: collab.ts). Null until known, and `none` when
 * they can't read it any more.
 */
function useLevel(path: string, c: CollabState): Level | 'none' | null {
  const [level, setLevel] = useState<{ path: string; value: Level | 'none' } | null>(null)
  useEffect(() => {
    if (c.access === 'none') return setLevel({ path, value: 'none' })
    let live = true
    api.note(path).then((n) => { if (live) setLevel({ path, value: n.level ?? 'edit' }) }, (e) => {
      if (live && e instanceof ApiError && e.code === 'not_found') setLevel({ path, value: 'none' })
    })
    return () => { live = false }
  }, [path, c.access])
  // Until the server answers, what the hub said (it doesn't tell `manage` from `edit`).
  if (level?.path === path) return level.value
  return c.access === 'none' ? 'none' : c.access
}

const EyeIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

/** «Read only» or «Comments only», where the save state would be: the person can't edit here. */
function ReadOnlyBadge({ level }: { level: Level }) {
  const t = useT()
  return (
    <span className="status status-readonly" role="status">
      {EyeIcon}<span className="status-label">{t(level === 'comment' ? 'note.commentOnly' : 'note.readOnly')}</span>
    </span>
  )
}

/** «Hidden from agents», discreet in the header: why, on hover or focus, and on a press (a phone has no hover). */
function HiddenFromAgents({ why }: { why: 'ai' | 'frontmatter' }) {
  const t = useT()
  const text = t(why === 'ai' ? 'note.aiHiddenWhy' : 'note.aiHiddenFrontmatter')
  return (
    <TooltipTrigger delay={300}>
      <DialogTrigger>
        <Button className="ai-hidden">{Icon.eyeOff}<span className="ai-hidden-label">{t('note.aiHidden')}</span></Button>
        <Popover className="ai-tip" placement="bottom">
          <Dialog className="ai-tip-dialog" aria-label={t('note.aiHidden')}>{text}</Dialog>
        </Popover>
      </DialogTrigger>
      <Tooltip className="ai-tip" placement="bottom">{text}</Tooltip>
    </TooltipTrigger>
  )
}

function OrphanBanner({ path }: { path: string }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const decide = (action: 'restore' | 'discard') => api.orphan(path, action).catch((e) => setError(errorText(t, e)))
  return (
    <div className="banner" role="alert">
      <div className="banner-text">
        <b>{t('editor.orphanTitle')}</b>
        <span>{t('editor.orphanBody')}</span>
        {error && <span className="error-text">{error}</span>}
      </div>
      <Button className="btn btn-primary" onPress={() => decide('restore')}>{t('editor.orphanKeep')}</Button>
      <Button className="btn" onPress={() => decide('discard')}>{t('editor.orphanDiscard')}</Button>
    </div>
  )
}

/** «Name (unsent 2026-09-25 10.12).md» next to the note; never overwrites one that exists. */
async function saveAsideCopy(path: string, text: string, name: (note: string, date: string) => string) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const note = path.slice(dir.length).replace(/\.md$/i, '')
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`
  for (let n = 1; ; n++) {
    const copy = `${dir}${name(note, date)}${n > 1 ? ` ${n}` : ''}.md`
    try {
      // A new uid: two notes with the same one would be the same note for the integrations.
      return (await api.createNote(copy, text, { freshUid: true })).path
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'exists') || n >= 20) throw e
    }
  }
}

/**
 * The hub started this note again without the document this tab had (its saved
 * state was lost, or the file no longer matched it), so the tab's copy couldn't
 * be merged without repeating text. It had changes that never arrived: keep them
 * as a copy of the note, or discard them.
 */
function SetAsideBanner({ path, c, onCreated }: { path: string; c: CollabState; onCreated: (p: string) => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!c.setAside) return null
  const text = c.setAside.text
  const keep = async () => {
    setBusy(true)
    setError(null)
    try {
      const copy = await saveAsideCopy(path, text, (note, date) => t('editor.setAsideName', { note, date }))
      c.clearSetAside()
      onCreated(copy)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner" role="alert">
      <div className="banner-text">
        <b>{t('editor.setAsideTitle')}</b>
        <span>{t('editor.setAsideBody')}</span>
        {error && <span className="error-text">{error}</span>}
      </div>
      <Button className="btn btn-primary" isDisabled={busy} onPress={keep}>{t('editor.setAsideKeep')}</Button>
      <Button className="btn" isDisabled={busy} onPress={c.clearSetAside}>{t('editor.setAsideDiscard')}</Button>
    </div>
  )
}

/**
 * Phone editor bar (link, tag, list, comment and save state), under the
 * editor. Its buttons don't take focus: the keyboard stays open.
 */
/** Previous and next note of the daily-note series: in the header, or in the editor bar on a phone. */
function DailyNav({ daily, onNavigate, bar }: { daily: { prev: string | null; next: string | null }; onNavigate: (p: string) => void; bar?: boolean }) {
  const t = useT()
  const cls = bar ? 'btn btn-icon bar-btn' : 'btn btn-icon'
  return (
    <span className="daily-nav">
      <Button className={cls} preventFocusOnPress={bar} aria-label={t('note.prevDaily')} isDisabled={!daily.prev} onPress={() => { if (daily.prev) onNavigate(daily.prev) }}>{Icon.prev}</Button>
      <Button className={cls} preventFocusOnPress={bar} aria-label={t('note.nextDaily')} isDisabled={!daily.next} onPress={() => { if (daily.next) onNavigate(daily.next) }}>{Icon.next}</Button>
    </span>
  )
}

function EditorBar({ view, c, level, onComment, onImage, daily, onNavigate }: {
  view: EditorView | null
  c: CollabState
  /** Below `edit`, only what doesn't write (commenting, with `comment`). */
  level: Level
  onComment: () => void
  onImage: () => void
  daily: { prev: string | null; next: string | null } | null
  onNavigate: (p: string) => void
}) {
  const t = useT()
  // The keyboard shrinks the visible area: keep the cursor in sight.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !view) return
    const on = () => { if (view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) }) }
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [view])
  const edit = (make: (doc: string, from: number, to: number) => Edit, suggest = false) => {
    if (!view) return
    const { from, to } = view.state.selection.main
    const e = make(view.state.doc.toString(), from, to)
    view.dispatch({ changes: { from: e.from, to: e.to, insert: e.insert }, selection: { anchor: e.cursor }, scrollIntoView: true, userEvent: 'input' })
    view.focus()
    // An empty `[[]]` or `#` opens the suggestions, as typing them would.
    if (suggest && e.from === e.to) startCompletion(view)
  }
  return (
    <div className="editor-bar" role="toolbar" aria-label={t('editor.bar')}>
      {canEdit(level) && (
        <>
          <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.insertLink')} onPress={() => edit(wikilink, true)}>[[</Button>
          <Button className="btn btn-icon bar-btn bar-hash" preventFocusOnPress aria-label={t('editor.insertTag')} onPress={() => edit(tag, true)}>#</Button>
          <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.insertList')} onPress={() => edit((doc, from) => listItem(doc, from))}>{Icon.list}</Button>
          <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('image.insertTitle')} onPress={onImage}>{Icon.image}</Button>
        </>
      )}
      {level !== 'read' && <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.comment')} onPress={onComment}>{Icon.comment}</Button>}
      <span className="spacer" />
      {daily && <DailyNav daily={daily} onNavigate={onNavigate} bar />}
      <span className={daily ? 'status-compact' : undefined}>{canEdit(level) ? <SaveStatus c={c} /> : <ReadOnlyBadge level={level} />}</span>
    </div>
  )
}

interface Props {
  path: string
  user: User
  /** Neighbours in its daily-note series, when the note belongs to one (null otherwise). */
  daily?: { prev: string | null; next: string | null } | null
  onNavigate: (p: string) => void
  /** The note changed path (renamed by you or someone else): reopen it there. With the report when you did it. */
  onMoved: (to: string, report?: MoveReport) => void
  /** Another tool moved the note's file and the note followed it: reopen it there. */
  onMovedOutside: (from: string, to: string) => void
  /** You moved it and the links are still being rewritten in the background. */
  onMoveStarted: (job: MoveJob) => void
  onTrashed: (t: Trashed) => void
  /** Template notes (vihko.yaml), offered when creating a note from a broken link. */
  templates: readonly string[]
  /** A note was created from here (a broken link): refresh the tree and open it. */
  onCreated: (path: string) => void
  /** One of an ambiguous link's candidates was chosen: open it and offer to pin the link there. */
  onPickCandidate: (offer: PinOffer) => void
  /** The history's mode (null until known): the «History» tab is there unless it's off. */
  history: HistoryStatus | null
  /** The version shown instead of the editor (`?version=`), or null. */
  version: string | null
  onVersion: (id: string | null) => void
  /** A version was restored: the notice, with what happened to its images. */
  onRestored: (report: RestoreReport) => void
}

export function NoteView({ path, user, daily, onNavigate, onMoved, onMovedOutside, onMoveStarted, onTrashed, templates, onCreated, onPickCandidate, history, version, onVersion, onRestored }: Props) {
  const t = useT()
  const c = useCollab(path)
  const hiding = useAgentHiding(path, c)
  const level = useLevel(path, c)
  const gone = level === 'none'
  const known: Level | null = level === 'none' ? null : level
  const editable = canEdit(known)
  const [linkData, setLinkData] = useState<LinksData | null>(null)
  const links = useMemo(
    () => new Map<string, LinkInfo>((linkData?.outgoing ?? []).map((l) => [l.raw, { status: l.status, path: l.dst_path, candidates: l.candidates }])),
    [linkData],
  )
  const [originals, setOriginals] = useState<CommentOriginal[] | null>(null)
  const panel = usePanel()
  const [view, setView] = useState<EditorView | null>(null)
  const mobile = useMobile()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const images = useImageInsert(path, c.session, view, config?.maxImageBytes ?? 0)
  const createLink = useCreateLink(path, templates, onCreated)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [pinned, setPinned] = useState<{ raw: string; target: string } | null>(null)
  const openPicker = (link: AmbiguousLink, anchor: HTMLElement) => { setPinned(null); setPicker({ link, anchor: { current: anchor } }) }
  const openCandidate = (link: AmbiguousLink, target: string) => { setPicker(null); onPickCandidate({ source: path, raw: link.raw, at: link.at, target }) }
  // The confirmation of a pinned link goes away on its own.
  useEffect(() => {
    if (!pinned) return
    const timer = setTimeout(() => setPinned(null), 6000)
    return () => clearTimeout(timer)
  }, [pinned])

  // Without the settings the editor can't know whether external images are
  // blocked; if they can't be read, the server's CSP still enforces it.
  useEffect(() => {
    let live = true
    api.config().then((r) => { if (live) setConfig(r) }, () => { if (live) setConfig({ externalImages: 'allow', maxImageBytes: 0 }) })
    return () => { live = false }
  }, [])

  // «Insert image» from the palette (not for someone who can't edit the note).
  const openInsert = useRef(images.openInsert)
  openInsert.current = editable ? images.openInsert : () => {}
  useEffect(() => {
    const open = () => openInsert.current()
    window.addEventListener(INSERT_IMAGE, open)
    return () => window.removeEventListener(INSERT_IMAGE, open)
  }, [])

  // Links (statuses and backlinks) come from the index: requested on open and after each save.
  useEffect(() => {
    if (c.save !== 'saved') return
    let live = true
    api.links(path).then((r) => { if (live) setLinkData(r) }).catch(() => {})
    return () => { live = false }
  }, [path, c.save])

  // What each comment thread was anchored to, from the index: also on open and after each save.
  useEffect(() => {
    if (c.save !== 'saved') return
    let live = true
    api.commentOriginals(path).then((r) => { if (live) setOriginals(r) }).catch(() => {})
    return () => { live = false }
  }, [path, c.save])

  // Moved or trashed from vihko, by you or someone else, or moved by another tool: the hub tells all its editors.
  useEffect(() => {
    if (!c.moved) return
    if (c.moved.outside) onMovedOutside(path, c.moved.to)
    else onMoved(c.moved.to)
  }, [c.moved]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (c.trashed) onTrashed({ id: c.trashed.id, path, by: c.trashed.by === user.username ? null : c.trashed.by })
  }, [c.trashed]) // eslint-disable-line react-hooks/exhaustive-deps

  // History: the note's versions, kept fresh while the tab or a version is on screen. Only with `edit` (D-034 3.5).
  const historyOn = history !== null && history.mode !== 'off' && editable
  const versions = useVersions(historyOn || version !== null ? path : null, version !== null || (historyOn && panel.open && panel.tab === 'history'))
  // Whatever is written into the note, by anyone, may open or extend a version.
  const activity = versions.activity
  useEffect(() => {
    const doc = c.session?.doc
    if (!doc) return
    const on = () => activity()
    doc.on('update', on)
    return () => doc.off('update', on)
  }, [c.session, activity])
  const { setTab } = panel
  // The tab goes away if vihko.yaml turns the history off; a version opened
  // from a link or «Recent changes» shows the list alongside.
  useEffect(() => { if (history?.mode === 'off' && panel.tab === 'history') setTab('comments') }, [history?.mode, panel.tab, setTab])
  useEffect(() => { if (version !== null && historyOn) setTab('history') }, [version !== null, historyOn, setTab]) // eslint-disable-line react-hooks/exhaustive-deps
  // After «Revert this change»: back to the note, with what was and wasn't undone.
  const [reverted, setReverted] = useState<{ seq: number; report: RevertReport } | null>(null)
  const openVersion = (id: string) => {
    onVersion(id)
    // Overlaid, the panel would cover the version.
    if (panel.narrow) panel.setOpen(false)
  }

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <Crumbs path={path} />
        {daily && !mobile && <DailyNav daily={daily} onNavigate={onNavigate} />}
        {hiding && <HiddenFromAgents why={hiding} />}
        <span className="spacer" />
        {!mobile && known && (editable || c.orphaned || c.connection === 'offline' ? <SaveStatus c={c} /> : <ReadOnlyBadge level={known} />)}
        {!gone && <Presence c={c} />}
        <SearchButton />
        <ThemeToggle />
        {!gone && <PanelToggle panel={panel} />}
        {editable && <NoteActions path={path} onMoved={onMoved} onMoveStarted={onMoveStarted} onTrashed={(id) => onTrashed({ id, path, by: null })} onInsertImage={images.openInsert} />}
      </header>
      {c.orphaned && !gone && <OrphanBanner path={path} />}
      <SetAsideBanner path={path} c={c} onCreated={onCreated} />
      <CreateLinkUi state={createLink} />
      <div className="note-body">
        <div className="note" hidden={version !== null}>
          {gone && <p className="empty" role="alert">{t('note.gone')}</p>}
          {c.session && c.connection !== 'connecting' && config && known && (
            <Editor path={path} session={c.session} user={user} links={links} onNavigate={onNavigate} onView={setView} onComments={panel.showComments}
              externalImages={config.externalImages} onImageFiles={images.onFiles} onImageUrl={images.onUrl} onCreateLink={createLink.onCreateLink}
              onPickAmbiguous={openPicker} readOnly={!editable} />
          )}
        </div>
        {version !== null && (
          // Not keyed by the version: going from one to another keeps «Compare with».
          <VersionView path={path} id={version} store={versions} exists session={c.session} closeLabel={t('version.back')}
            onClose={() => { onVersion(null); requestAnimationFrame(() => view?.focus()) }}
            onRestored={(r) => { versions.refresh(); onRestored(r) }}
            onReverted={(r) => { versions.refresh(); onVersion(null); setReverted((p) => ({ seq: (p?.seq ?? 0) + 1, report: r })) }}
            onPurged={known === 'manage' && history?.mode === 'managed' ? () => { versions.refresh(); onVersion(null) } : undefined} />
        )}
        {known && !gone && (
          <NotePanel panel={panel} view={view} session={c.session} user={user} level={known} links={linkData} originals={originals} onNavigate={onNavigate}
            onPickAmbiguous={openPicker} onOpenCandidate={openCandidate}
            history={historyOn ? <HistoryTab store={versions} status={history} current={version} onOpen={openVersion} path={path} canPurge={known === 'manage'} onPurged={() => { versions.refresh(); onVersion(null) }} /> : null} />
        )}
      </div>
      {mobile && !panel.open && version === null && known && <EditorBar view={view} c={c} level={known} onComment={() => panel.showComments(null)} onImage={images.openInsert} daily={daily ?? null} onNavigate={onNavigate} />}
      <ImageInsertUi ins={images} />
      {picker && (
        <AmbiguousPicker source={path} state={picker} titles={linkData?.titles ?? {}} onClose={() => setPicker(null)}
          onOpen={(target) => openCandidate(picker.link, target)}
          onPinned={(target, raw) => { setPicker(null); setPinned({ raw, target }) }} />
      )}
      {pinned && (
        <div className="toast">
          <span className="toast-icon">{Icon.check}</span>
          <span className="toast-text" role="status">{t('pin.pinned', { raw: pinned.raw, target: noteName(pinned.target) })}</span>
          <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={() => setPinned(null)}>{Icon.close}</Button>
        </div>
      )}
      {reverted && <RevertToast key={reverted.seq} report={reverted.report} onDismiss={() => setReverted(null)} />}
    </>
  )
}
