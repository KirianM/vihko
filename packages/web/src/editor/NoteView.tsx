// The open note: header (path, save state, presence, panel toggle, more
// actions), the banner for a note deleted outside thoth, the editor and
// the side panel.
import type { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useState } from 'react'
import { Button } from 'react-aria-components'
import { api, type MoveReport, type User } from '../api.ts'
import { useTheme } from '../theme.ts'
import { userColor } from '../userColor.ts'
import { errorText, useT } from '../i18n.tsx'
import { Crumbs, Icon, ThemeToggle } from '../ui.tsx'
import { SearchButton } from '../Palette.tsx'
import { useCollab, type CollabState } from './collab.ts'
import type { Trashed } from '../TrashToast.tsx'
import { Editor } from './Editor.tsx'
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

interface Props {
  path: string
  user: User
  onNavigate: (p: string) => void
  /** The note changed path (renamed by you or someone else): reopen it there. With the report when you did it. */
  onMoved: (to: string, report?: MoveReport) => void
  onTrashed: (t: Trashed) => void
}

export function NoteView({ path, user, onNavigate, onMoved, onTrashed }: Props) {
  const c = useCollab(path)
  const [linkData, setLinkData] = useState<LinksData | null>(null)
  const links = useMemo(
    () => new Map<string, LinkInfo>((linkData?.outgoing ?? []).map((l) => [l.raw, { status: l.status, path: l.dst_path, candidates: l.candidates }])),
    [linkData],
  )
  const panel = usePanel()
  const [view, setView] = useState<EditorView | null>(null)

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
        <Crumbs path={path} />
        <span className="spacer" />
        <SaveStatus c={c} />
        <Presence c={c} />
        <SearchButton />
        <ThemeToggle />
        <PanelToggle panel={panel} />
        <NoteActions path={path} onMoved={onMoved} onTrashed={(id) => onTrashed({ id, path, by: null })} />
      </header>
      {c.orphaned && <OrphanBanner path={path} />}
      <div className="note-body">
        <div className="note">
          {c.session && c.connection !== 'connecting' && (
            <Editor session={c.session} user={user} links={links} onNavigate={onNavigate} onView={setView} onComments={panel.showComments} />
          )}
        </div>
        <NotePanel panel={panel} view={view} session={c.session} user={user} links={linkData} onNavigate={onNavigate} />
      </div>
    </>
  )
}
