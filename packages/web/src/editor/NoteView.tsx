// The open note: header (path, save state, presence, panel toggle, more
// actions), the banner for a note deleted outside vihko, the editor (or one
// of its versions, from the history) and the side panel.
import type { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, DialogTrigger, Popover, Tooltip, TooltipTrigger } from 'react-aria-components'
import { ApiError, api, canEdit, type CommentOriginal, type Level, type MoveJob, type MoveReport, type ServerConfig, type User } from '../api.ts'
import { INSERT_IMAGE } from '../commands.ts'
import { useTheme } from '../theme.ts'
import { userColor } from '../userColor.ts'
import { errorText, useT } from '../i18n.tsx'
import { Crumbs, Diamond, Icon, MenuButton, ThemeToggle, noteName } from '../ui.tsx'
import { useMobile } from '../mobile.ts'
import { FormatBar } from './FormatBar.tsx'
import { SearchButton } from '../Palette.tsx'
import { useCollab, type ClaimedLevel, type CollabState } from './collab.ts'
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

/**
 * The save state. `compact` (the phone's bar): while all is well (saved,
 * saving) only its icon, with the text for screen readers and as a tooltip,
 * so the formatting buttons get the room; what needs the person's attention
 * keeps its text.
 */
function SaveStatus({ c, compact = false }: { c: CollabState; compact?: boolean }) {
  const t = useT()
  if (c.orphaned) return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.orphanStatus')}</span></span>
  // What's true while offline: nothing is saved, and only this tab has it.
  if (c.connection === 'offline') return <span className="status status-warn" title={t('editor.offlineHint')}>{Icon.alert}<span className="status-label">{t('editor.offline')}</span></span>
  if (c.cantSave) return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.cantSaveStatus')}</span></span>
  if (c.connection === 'connecting') return <span className="status"><span className="status-label">{t('editor.connecting')}</span></span>
  const calm = (cls: string, icon: ReactNode, text: string) => (
    <span className={`status ${cls}${compact ? ' status-calm' : ''}`} title={compact ? text : undefined}>{icon}<span className="status-label">{text}</span></span>
  )
  // Saving has had no icon where its text shows; alone, it needs one.
  if (c.save === 'saving') return calm('status-saving', compact ? Icon.saving : null, t('editor.saving'))
  return calm('status-ok', Icon.check, t('editor.saved'))
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
 * What the person may do in the note, from the server: asked on
 * opening, and again when the hub says it changed while open (then the
 * session is opened again: collab.ts). Null until known, and `none` when
 * they can't read it any more.
 */
function useLevel(path: string, c: CollabState, initial: Level | null, onMovedAway?: (to: string) => void): Level | 'none' | null {
  const [level, setLevel] = useState<{ path: string; value: Level | 'none' } | null>(initial ? { path, value: initial } : null)
  useEffect(() => {
    if (c.access === 'none') return setLevel({ path, value: 'none' })
    // What the hub just said, until the server answers (`manage` writes as `edit` for the hub).
    if (c.access) {
      const access = c.access
      setLevel((l) => ({ path, value: access === 'edit' && l?.path === path && l.value === 'manage' ? 'manage' : access }))
    }
    let live = true
    api.note(path).then((n) => { if (live) setLevel({ path, value: n.level ?? 'edit' }) }, (e) => {
      if (!live || !(e instanceof ApiError) || e.code !== 'not_found') return
      // Moved again by vihko a moment ago, while this editor reopened it here: follow it.
      if (typeof e.data?.movedTo === 'string' && onMovedAway) return onMovedAway(e.data.movedTo)
      setLevel({ path, value: 'none' })
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

/** vihko can't save the note: why, and that it's read-only for everyone until it can. */
function CantSaveBanner({ reason }: { reason: NonNullable<CollabState['cantSave']> }) {
  const t = useT()
  return (
    <div className="banner" role="alert">
      <div className="banner-text">
        <b>{t('editor.cantSaveTitle')}</b>
        <span>{t(`editor.cantSave.${reason}`)} {t('editor.cantSaveBody')}</span>
      </div>
    </div>
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

/** On a phone, after the formatting bar's buttons: the daily-note arrows and the save state (or «Read only»). */
function BarEnd({ c, level, daily, onNavigate }: { c: CollabState; level: Level; daily: { prev: string | null; next: string | null } | null; onNavigate: (p: string) => void }) {
  return (
    <>
      {daily && <DailyNav daily={daily} onNavigate={onNavigate} bar />}
      {canEdit(level) || c.cantSave ? <SaveStatus c={c} compact /> : <span className={daily ? 'status-compact' : undefined}><ReadOnlyBadge level={level} /></span>}
    </>
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
  /**
   * The note isn't where this tab had it, and the hub won't say where:
   * moved somewhere the person can't open (`movedAway`), or found gone on
   * reconnecting (`gone`). What wasn't sent is kept apart (rescue.ts).
   */
  onGone: (why: 'movedAway' | 'gone') => void
  /** What the server said the person may do in the note when the shell checked it, if it did. */
  initialLevel?: Level | null
  /** Shown under the header: what the person typed that didn't reach a note (RescueBanner). */
  rescue?: ReactNode
  /** Template notes (marked `template: true`), offered when creating a note from a broken link. */
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

export function NoteView({ path, user, daily, onNavigate, onMoved, onMovedOutside, onMoveStarted, onTrashed, onGone, initialLevel = null, rescue, templates, onCreated, onPickCandidate, history, version, onVersion, onRestored }: Props) {
  const t = useT()
  // The level the editor shows the note at, told to the hub on every connection.
  const claim = useRef<ClaimedLevel | null>(initialLevel ? (canEdit(initialLevel) ? 'edit' : initialLevel as ClaimedLevel) : null)
  const c = useCollab(path, claim)
  const hiding = useAgentHiding(path, c)
  const level = useLevel(path, c, initialLevel, (to) => onMoved(to))
  claim.current = level === null || level === 'none' ? null : canEdit(level) ? 'edit' : level as ClaimedLevel
  const gone = level === 'none'
  /** While vihko can't save it, nobody edits it: shown as if they could only read it. */
  const known: Level | null = level === 'none' ? null : c.cantSave && canEdit(level) ? 'read' : level
  const editable = canEdit(known)
  const [linkData, setLinkData] = useState<LinksData | null>(null)
  const links = useMemo(
    () => new Map<string, LinkInfo>((linkData?.outgoing ?? []).map((l) => [l.raw, { status: l.status, path: l.dstPath, candidates: l.candidates }])),
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
  // Gone where the person can't follow: closed, as when it goes to the trash.
  useEffect(() => {
    if (c.gone) onGone(c.gone)
  }, [c.gone]) // eslint-disable-line react-hooks/exhaustive-deps

  // History: the note's versions, kept fresh while the tab or a version is on screen. Only with `edit`: sharing a note to read doesn't give its past.
  const historyOn = history !== null && history.mode !== 'off' && level !== null && level !== 'none' && canEdit(level)
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
        {!mobile && known && (editable || c.orphaned || c.cantSave || c.connection === 'offline' ? <SaveStatus c={c} /> : <ReadOnlyBadge level={known} />)}
        {!gone && <Presence c={c} />}
        <SearchButton />
        <ThemeToggle />
        {!gone && <PanelToggle panel={panel} />}
        {editable && <NoteActions path={path} onMoved={onMoved} onMoveStarted={onMoveStarted} onTrashed={(id) => onTrashed({ id, path, by: null })} onInsertImage={images.openInsert} />}
      </header>
      {c.orphaned && !gone && <OrphanBanner path={path} />}
      {c.cantSave && !gone && <CantSaveBanner reason={c.cantSave} />}
      {rescue}
      <CreateLinkUi state={createLink} />
      <div className="note-body">
        <div className="note" hidden={version !== null}>
          {gone && <p className="empty" role="alert">{t('note.gone')}</p>}
          {!mobile && view && known && <FormatBar view={view} level={known} onComment={() => panel.showComments(null)} onImage={images.openInsert} />}
          {c.session && c.connection !== 'connecting' && config && known && (
            <Editor path={path} session={c.session} user={user} links={links} onNavigate={onNavigate} onView={setView} onComments={panel.showComments}
              commentReach={{ notices: !panel.open, click: !panel.open && !panel.narrow }}
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
      {mobile && !panel.open && version === null && known && (
        <FormatBar mobile view={view} level={known} onComment={() => panel.showComments(null)} onImage={images.openInsert}
          end={<BarEnd c={c} level={known} daily={daily ?? null} onNavigate={onNavigate} />} />
      )}
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
