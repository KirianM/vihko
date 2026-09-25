// Estructura principal: árbol de carpetas y la nota abierta en el editor.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Button, Collection, Tree, TreeItem, TreeItemContent, type Key } from 'react-aria-components'
import { ApiError, alertCount, api, type TreeNote, type User } from './api.ts'
import { useTheme } from './theme.ts'
import { baseHue, userColor } from './userColor.ts'
import { errorText, useT } from './i18n.tsx'
import { Brand, Crumbs, Icon, ThemeToggle } from './ui.tsx'
import { OpenPaletteContext, Palette, SearchButton, type PaletteMode } from './Palette.tsx'
import { rememberNote } from './recent.ts'

// El editor (CodeMirror, Yjs) se descarga aparte, al abrir la primera nota.
const NoteView = lazy(() => import('./editor/NoteView.tsx').then((m) => ({ default: m.NoteView })))

interface Node { id: string; name: string; path: string; children: Node[] | null }

/** Convierte la lista plana de rutas en un árbol: carpetas primero, luego notas, en orden alfabético. */
export function buildTree(notes: TreeNote[]): Node[] {
  const root: Node = { id: 'd:', name: '', path: '', children: [] }
  const folders = new Map<string, Node>([['', root]])
  const folder = (path: string): Node => {
    let f = folders.get(path)
    if (f) return f
    const i = path.lastIndexOf('/')
    const parent = folder(i === -1 ? '' : path.slice(0, i))
    f = { id: `d:${path}`, name: path.slice(i + 1), path, children: [] }
    parent.children!.push(f)
    folders.set(path, f)
    return f
  }
  for (const n of notes) {
    const i = n.path.lastIndexOf('/')
    const parent = folder(i === -1 ? '' : n.path.slice(0, i))
    parent.children!.push({ id: `n:${n.path}`, name: n.path.slice(i + 1).replace(/\.md$/i, ''), path: n.path, children: null })
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const sort = (list: Node[]) => {
    list.sort((a, b) => (a.children === null) === (b.children === null) ? collator.compare(a.name, b.name) : a.children === null ? 1 : -1)
    for (const x of list) if (x.children) sort(x.children)
  }
  sort(root.children!)
  return root.children!
}

function NoteTree({ nodes, selected, onOpen }: { nodes: Node[]; selected: string | null; onOpen: (path: string) => void }) {
  const t = useT()
  return (
    <Tree
      className="tree"
      aria-label={t('shell.folders')}
      items={nodes}
      selectionMode="single"
      selectedKeys={selected ? [`n:${selected}`] : []}
      onAction={(key: Key) => { const k = String(key); if (k.startsWith('n:')) onOpen(k.slice(2)) }}
      renderEmptyState={() => <div className="empty">{t('shell.noNotes')}</div>}
    >
      {function render(node: Node) {
        return (
          <TreeItem id={node.id} textValue={node.name} className="tree-item">
            <TreeItemContent>
              {({ level, hasChildItems }) => (
                <div className="tree-row" style={{ paddingLeft: 8 + (level - 1) * 18 }}>
                  {hasChildItems
                    ? <Button slot="chevron" className="tree-chevron">{Icon.chevron}</Button>
                    : <span style={{ width: 20, flexShrink: 0 }} />}
                  <span className="tree-label">{node.name}</span>
                </div>
              )}
            </TreeItemContent>
            {node.children && <Collection items={node.children}>{render}</Collection>}
          </TreeItem>
        )
      }}
    </Tree>
  )
}

export function Shell({ user, onLogout, onUnauthorized }: { user: User; onLogout: () => void; onUnauthorized: () => void }) {
  const t = useT()
  const { effective } = useTheme()
  const [notes, setNotes] = useState<TreeNote[] | null>(null)
  const [alerts, setAlerts] = useState(0)
  const [openPath, setOpenPath] = useState<string | null>(() => new URLSearchParams(location.search).get('note'))
  const [ready, setReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [palette, setPalette] = useState<PaletteMode | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }

  useEffect(() => {
    api.tree().then((r) => setNotes(r.notes)).catch(fail)
    api.alerts().then((a) => setAlerts(alertCount(a))).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ⌘K / Ctrl+K abre la paleta desde cualquier sitio, también desde el editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        // En captura y sin propagar: el editor no llega a ver la tecla (en macOS, Ctrl+K borra hasta fin de línea).
        e.preventDefault()
        e.stopPropagation()
        setPalette('search')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    setReady(null)
    if (!openPath) return
    const url = new URL(location.href)
    url.searchParams.set('note', openPath)
    history.replaceState(null, '', url)
    setError(null)
    // Se comprueba que existe antes de abrir la coedición: el hub rechaza notas inexistentes.
    api.note(openPath).then(() => { setReady(openPath); rememberNote(openPath) }).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath])

  const tree = useMemo(() => (notes ? buildTree(notes) : []), [notes])
  const folder = openPath?.includes('/') ? openPath.slice(0, openPath.lastIndexOf('/')) : ''
  const created = (path: string) => {
    setPalette(null)
    api.tree().then((r) => setNotes(r.notes)).catch(fail)
    setOpenPath(path)
  }

  return (
    <OpenPaletteContext.Provider value={() => setPalette('search')}>
    <div className="shell">
      <nav className="sidebar" aria-label={t('shell.folders')}>
        <div className="sidebar-head">
          <Brand />
          <span className="spacer" />
          <Button className="btn btn-icon" aria-label={t('shell.newNote')} onPress={() => setPalette('create')}>{Icon.plus}</Button>
        </div>
        <Button className="btn sidebar-search" onPress={() => setPalette('search')}>
          {Icon.search}<span>{t('shell.search')}</span><kbd>⌘K</kbd>
        </Button>
        <div className="sidebar-tree">
          {notes === null ? <div className="empty">{t('common.loading')}</div> : <NoteTree nodes={tree} selected={openPath} onOpen={setOpenPath} />}
        </div>
        {alerts > 0 && <a className="sidebar-alerts" href="#avisos">{Icon.alert}<span>{t('shell.alerts', { n: alerts })}</span></a>}
        <div className="sidebar-user">
          <span className="avatar" aria-hidden="true" style={{ background: userColor(baseHue(user.id), effective) }}>{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="name">{user.username}</span>
          <span className="role">{t(user.role === 'admin' ? 'role.admin' : 'role.member')}</span>
          <Button className="btn btn-icon" aria-label={t('shell.logout')} onPress={onLogout}>{Icon.logout}</Button>
        </div>
      </nav>
      <main className="main">
        {openPath && ready === openPath ? (
          <Suspense fallback={<div className="empty">{t('common.loading')}</div>}>
            <NoteView key={openPath} path={openPath} user={user} onNavigate={setOpenPath} />
          </Suspense>
        ) : (
          <>
            <header className="main-head">
              <Crumbs path={openPath} />
              <span className="spacer" />
              <SearchButton />
              <ThemeToggle />
            </header>
            <div className="note">
              {error && <p className="error-text" role="alert">{error}</p>}
              {!openPath && !error && <p className="empty">{t('shell.empty')}</p>}
            </div>
          </>
        )}
      </main>
      {palette && (
        <Palette
          key={palette}
          mode={palette}
          folder={folder}
          openPath={openPath}
          notes={notes}
          onClose={() => setPalette(null)}
          onMode={setPalette}
          onOpen={setOpenPath}
          onCreated={created}
        />
      )}
    </div>
    </OpenPaletteContext.Provider>
  )
}
