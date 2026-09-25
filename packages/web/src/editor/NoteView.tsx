// Nota abierta: cabecera (ruta, estado de guardado, presencia), aviso de nota
// borrada fuera (D-022) y el editor.
import { useEffect, useState } from 'react'
import { Button } from 'react-aria-components'
import { api, type User } from '../api.ts'
import { useTheme } from '../theme.ts'
import { userColor } from '../userColor.ts'
import { errorText, useT } from '../i18n.tsx'
import { Crumbs, Icon, ThemeToggle } from '../ui.tsx'
import { SearchButton } from '../Palette.tsx'
import { useCollab, type CollabState } from './collab.ts'
import { Editor } from './Editor.tsx'
import type { LinkInfo } from './livePreview.ts'
import { usePresence } from './presence.ts'

function SaveStatus({ c }: { c: CollabState }) {
  const t = useT()
  if (c.orphaned) return <span className="status status-warn">{Icon.alert}{t('editor.orphanStatus')}</span>
  if (c.connection === 'offline') return <span className="status status-warn">{Icon.alert}{t('editor.offline')}</span>
  if (c.connection === 'connecting') return <span className="status">{t('editor.connecting')}</span>
  if (c.save === 'saving') return <span className="status">{t('editor.saving')}</span>
  return <span className="status status-ok">{Icon.check}{t('editor.saved')}</span>
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

export function NoteView({ path, user, onNavigate }: { path: string; user: User; onNavigate: (p: string) => void }) {
  const c = useCollab(path)
  const [links, setLinks] = useState<Map<string, LinkInfo>>(new Map())

  // Los estados de los enlaces salen del índice: se piden al abrir y tras cada guardado.
  useEffect(() => {
    if (c.save !== 'saved') return
    let live = true
    api.links(path).then((r) => {
      if (!live) return
      setLinks(new Map(r.outgoing.map((l) => [l.raw, { status: l.status, path: l.dst_path, candidates: l.candidates }])))
    }).catch(() => {})
    return () => { live = false }
  }, [path, c.save])

  return (
    <>
      <header className="main-head">
        <Crumbs path={path} />
        <span className="spacer" />
        <SaveStatus c={c} />
        <Presence c={c} />
        <SearchButton />
        <ThemeToggle />
      </header>
      {c.orphaned && <OrphanBanner path={path} />}
      <div className="note">
        {c.session && c.connection !== 'connecting' && <Editor session={c.session} user={user} links={links} onNavigate={onNavigate} />}
      </div>
    </>
  )
}
