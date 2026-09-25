// The open note: header (path, save state, presence, panel toggle, more
// actions), the banner for a note deleted outside thoth, the editor and
// the side panel.
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import { api, type MoveReport, type ServerConfig, type User } from '../api.ts'
import { INSERT_IMAGE } from '../commands.ts'
import { useTheme } from '../theme.ts'
import { userColor } from '../userColor.ts'
import { errorText, useT } from '../i18n.tsx'
import { Crumbs, Icon, MenuButton, ThemeToggle } from '../ui.tsx'
import { useMobile } from '../mobile.ts'
import { listItem, tag, wikilink, type Edit } from './insert.ts'
import { SearchButton } from '../Palette.tsx'
import { useCollab, type CollabState } from './collab.ts'
import type { Trashed } from '../TrashToast.tsx'
import { Editor } from './Editor.tsx'
import { ImageInsertUi, useImageInsert } from './ImageInsert.tsx'
import { NoteActions } from './NoteActions.tsx'
import type { LinkInfo } from './livePreview.ts'
import { NotePanel, PanelToggle, usePanel, type LinksData } from './NotePanel.tsx'
import { usePresence } from './presence.ts'

function SaveStatus({ c }: { c: CollabState }) {
  const t = useT()
  if (c.orphaned) return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.orphanStatus')}</span></span>
  if (c.connection === 'offline') return <span className="status status-warn">{Icon.alert}<span className="status-label">{t('editor.offline')}</span></span>
  if (c.connection === 'connecting') return <span className="status"><span className="status-label">{t('editor.connecting')}</span></span>
  if (c.save === 'saving') return <span className="status"><span className="status-label">{t('editor.saving')}</span></span>
  return <span className="status status-ok">{Icon.check}<span className="status-label">{t('editor.saved')}</span></span>
}

function Presence({ c }: { c: CollabState }) {
  const peers = usePresence(c.session?.provider)
  const { effective } = useTheme()
  if (peers.length === 0) return null
  return (
    <span className="presence">
      {peers.map((p) => (
        <span key={p.name} className="avatar avatar-stack" title={p.name} style={{ background: userColor(p.hue, effective) }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
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

function EditorBar({ view, c, onComment, onImage, daily, onNavigate }: {
  view: EditorView | null
  c: CollabState
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
  const edit = (make: (doc: string, from: number, to: number) => Edit) => {
    if (!view) return
    const { from, to } = view.state.selection.main
    const e = make(view.state.doc.toString(), from, to)
    view.dispatch({ changes: { from: e.from, to: e.to, insert: e.insert }, selection: { anchor: e.cursor }, scrollIntoView: true, userEvent: 'input' })
    view.focus()
  }
  return (
    <div className="editor-bar" role="toolbar" aria-label={t('editor.bar')}>
      <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.insertLink')} onPress={() => edit(wikilink)}>[[</Button>
      <Button className="btn btn-icon bar-btn bar-hash" preventFocusOnPress aria-label={t('editor.insertTag')} onPress={() => edit(tag)}>#</Button>
      <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.insertList')} onPress={() => edit((doc, from) => listItem(doc, from))}>{Icon.list}</Button>
      <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('image.insertTitle')} onPress={onImage}>{Icon.image}</Button>
      <Button className="btn btn-icon bar-btn" preventFocusOnPress aria-label={t('editor.comment')} onPress={onComment}>{Icon.comment}</Button>
      <span className="spacer" />
      {daily && <DailyNav daily={daily} onNavigate={onNavigate} bar />}
      <span className={daily ? 'status-compact' : undefined}><SaveStatus c={c} /></span>
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
  onTrashed: (t: Trashed) => void
}

export function NoteView({ path, user, daily, onNavigate, onMoved, onTrashed }: Props) {
  const c = useCollab(path)
  const [linkData, setLinkData] = useState<LinksData | null>(null)
  const links = useMemo(
    () => new Map<string, LinkInfo>((linkData?.outgoing ?? []).map((l) => [l.raw, { status: l.status, path: l.dst_path, candidates: l.candidates }])),
    [linkData],
  )
  const panel = usePanel()
  const [view, setView] = useState<EditorView | null>(null)
  const mobile = useMobile()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const images = useImageInsert(path, c.session, view, config?.maxImageBytes ?? 0)

  // Without the settings the editor can't know whether external images are
  // blocked; if they can't be read, the server's CSP still enforces it.
  useEffect(() => {
    let live = true
    api.config().then((r) => { if (live) setConfig(r) }, () => { if (live) setConfig({ externalImages: 'allow', maxImageBytes: 0 }) })
    return () => { live = false }
  }, [])

  // «Insert image» from the palette.
  const openInsert = useRef(images.openInsert)
  openInsert.current = images.openInsert
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

  // Moved or trashed from thoth, by you or someone else: the hub tells all its editors.
  useEffect(() => { if (c.moved) onMoved(c.moved) }, [c.moved]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (c.trashed) onTrashed({ id: c.trashed.id, path, by: c.trashed.by === user.username ? null : c.trashed.by })
  }, [c.trashed]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <Crumbs path={path} />
        {daily && !mobile && <DailyNav daily={daily} onNavigate={onNavigate} />}
        <span className="spacer" />
        {!mobile && <SaveStatus c={c} />}
        <Presence c={c} />
        <SearchButton />
        <ThemeToggle />
        <PanelToggle panel={panel} />
        <NoteActions path={path} onMoved={onMoved} onTrashed={(id) => onTrashed({ id, path, by: null })} onInsertImage={images.openInsert} />
      </header>
      {c.orphaned && <OrphanBanner path={path} />}
      <div className="note-body">
        <div className="note">
          {c.session && c.connection !== 'connecting' && config && (
            <Editor path={path} session={c.session} user={user} links={links} onNavigate={onNavigate} onView={setView} onComments={panel.showComments}
              externalImages={config.externalImages} onImageFiles={images.onFiles} onImageUrl={images.onUrl} />
          )}
        </div>
        <NotePanel panel={panel} view={view} session={c.session} user={user} links={linkData} onNavigate={onNavigate} />
      </div>
      {mobile && !panel.open && <EditorBar view={view} c={c} onComment={() => panel.showComments(null)} onImage={images.openInsert} daily={daily ?? null} onNavigate={onNavigate} />}
      <ImageInsertUi ins={images} />
    </>
  )
}
