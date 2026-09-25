// Main structure: folder tree and the note open in the editor.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Collection, Dialog, Modal, ModalOverlay, Tree, TreeItem, TreeItemContent, type Key } from 'react-aria-components'
import { seriesNeighbors } from '@thoth/core/series'
import { ApiError, api, type MoveReport, type Profile, type TreeNote, type User, type WorkspaceInfo } from './api.ts'
import { AlertsPage } from './Alerts.tsx'
import { useTheme } from './theme.ts'
import { baseHue, userColor } from './userColor.ts'
import { errorText, useT } from './i18n.tsx'
import { Brand, Crumbs, Icon, MenuButton, OpenNavContext, ThemeToggle } from './ui.tsx'
import { TrashToast, type Trashed } from './TrashToast.tsx'
import { MoveToast } from './MoveToast.tsx'
import { OpenPaletteContext, Palette, SearchButton, type PaletteMode } from './Palette.tsx'
import { rememberNote } from './recent.ts'
import { useBackClose, useMobile, useVisualViewport } from './mobile.ts'
import { PreferencesDialog, browserTimeZone } from './Preferences.tsx'

// The editor (CodeMirror, Yjs) is downloaded separately, when the first note is opened.
const NoteView = lazy(() => import('./editor/NoteView.tsx').then((m) => ({ default: m.NoteView })))

interface Node { id: string; name: string; path: string; children: Node[] | null }

/** Converts the flat list of paths into a tree: folders first, then notes, alphabetically. */
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

/** Folder keys that contain a note, so it shows in the tree. */
const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, a) => `d:${a.slice(0, i + 1).join('/')}`)

function NoteTree({ nodes, selected, expanded, onExpanded, onOpen }: {
  nodes: Node[]
  selected: string | null
  expanded: Set<Key>
  onExpanded: (keys: Set<Key>) => void
  onOpen: (path: string) => void
}) {
  const t = useT()
  return (
    <Tree
      className="tree"
      aria-label={t('shell.folders')}
      items={nodes}
      selectionMode="single"
      selectedKeys={selected ? [`n:${selected}`] : []}
      expandedKeys={expanded}
      onExpandedChange={onExpanded}
      onAction={(key: Key) => {
        const k = String(key)
        if (k.startsWith('n:')) return onOpen(k.slice(2))
        // A folder row opens or closes (on a phone the chevron alone is too small a target).
        const next = new Set(expanded)
        if (!next.delete(key)) next.add(key)
        onExpanded(next)
      }}
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
  const [openPath, setOpenPathState] = useState<string | null>(() => new URLSearchParams(location.search).get('note'))
  // Views that aren't a note, in the URL as `?view=` (no router: this is the only one).
  const [view, setView] = useState<'avisos' | null>(() => (new URLSearchParams(location.search).get('view') === 'avisos' ? 'avisos' : null))
  const setOpenPath = (path: string | null) => { setView(null); setOpenPathState(path) }
  const showAlerts = () => { setOpenPathState(null); setView('avisos') }
  const [ready, setReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<Trashed | null>(null)
  /** Your last rename or move, if some link could not be rewritten. */
  const [moveIssue, setMoveIssue] = useState<MoveReport | null>(null)
  const [palette, setPalette] = useState<PaletteMode | null>(null)
  const mobile = useMobile()
  // On a phone with nothing open, start at the tree: it's the only way in.
  const [navOpen, setNavOpen] = useState(() => mobile && !openPath && !view)
  const [expanded, setExpanded] = useState<Set<Key>>(() => new Set(openPath ? ancestors(openPath) : []))
  useBackClose(mobile && navOpen, () => setNavOpen(false))
  useVisualViewport(mobile)
  /** thoth.yaml as the server has it now: daily-note series and the templates folder. */
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }

  const loadTree = () => api.tree().then((r) => setNotes(r.notes)).catch(fail)
  const loadWorkspace = () => api.workspace().then(setWorkspace).catch(() => {})
  const loadAlerts = () => api.alerts().then((a) => setAlerts(a.length)).catch(() => {})

  useEffect(() => {
    void loadTree()
    void loadAlerts()
    void loadWorkspace()
    const startedEmpty = !openPath && !view
    api.profile().then(async (p) => {
      // First sign-in: the browser's timezone becomes the person's (editable in Preferences).
      if (!p.timezone) p = await api.updateProfile({ timezone: browserTimeZone() }).catch(() => p)
      setProfile(p)
      // «Open on start» only opens today's note if it exists: it never creates one (D-030).
      if (!p.openDailyOnStart || !startedEmpty) return
      const today = await api.today().catch(() => null)
      if (!today?.exists) return
      setOpenPathState((current) => current ?? today.path)
      setNavOpen(false)
    }).catch(() => {})
    // thoth.yaml can change at any time (another editor, git pull): read again on coming back.
    const refresh = () => { if (document.visibilityState === 'visible') { void loadWorkspace(); void loadAlerts() } }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dailyOn = (workspace?.daily.length ?? 0) > 0
  /** Opens today's note, creating it from its template if needed; never overwrites. */
  const openToday = async () => {
    setError(null)
    try {
      const r = await api.openToday()
      if (r.created) void loadTree()
      setOpenPath(r.path)
    } catch (err) {
      fail(err)
    }
  }
  const todayRef = useRef<(() => void) | null>(null)
  todayRef.current = dailyOn ? () => void openToday() : null

  // ⌘K / Ctrl+K opens the palette from anywhere, including from the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        // Captured and not propagated: the editor never sees the key (on macOS, Ctrl+K deletes to end of line).
        e.preventDefault()
        e.stopPropagation()
        setPalette('search')
      }
      // ⌘⌥D / Ctrl+Alt+D: today's note. By physical key: Option changes e.key on a Mac.
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyD' && todayRef.current) {
        e.preventDefault()
        e.stopPropagation()
        todayRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const url = new URL(location.href)
    for (const [k, v] of [['note', openPath], ['view', view]] as const) v ? url.searchParams.set(k, v) : url.searchParams.delete(k)
    history.replaceState(null, '', url)
  }, [openPath, view])

  useEffect(() => {
    setReady(null)
    if (!openPath) return
    // The tree shows where the note is (it may have been opened by a link or the palette).
    setExpanded((e) => { const add = ancestors(openPath).filter((k) => !e.has(k)); return add.length ? new Set([...e, ...add]) : e })
    setTrashed(null)
    setMoveIssue((m) => (m?.to === openPath ? m : null))
    setError(null)
    // Check that it exists before opening co-editing: the hub rejects notes that don't exist.
    api.note(openPath).then(() => { setReady(openPath); rememberNote(openPath) }).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath])

  const tree = useMemo(() => (notes ? buildTree(notes) : []), [notes])
  // Template notes: those in the templates folder of thoth.yaml, subfolders included.
  const templates = useMemo(() => {
    const dir = workspace?.templates
    if (!dir || !notes) return []
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    return notes.map((n) => n.path).filter((p) => p.startsWith(`${dir}/`)).sort(collator.compare)
  }, [workspace, notes])
  // Previous and next in the header when the open note belongs to a daily-note series.
  const dailyNav = useMemo(() => {
    if (!openPath || !notes || !workspace) return null
    const paths = notes.map((n) => n.path)
    for (const s of workspace.daily) {
      const n = seriesNeighbors(s, paths, openPath)
      if (n) return n
    }
    return null
  }, [openPath, notes, workspace])
  const folder = openPath?.includes('/') ? openPath.slice(0, openPath.lastIndexOf('/')) : ''
  const created = (path: string) => {
    setPalette(null)
    api.tree().then((r) => setNotes(r.notes)).catch(fail)
    setOpenPath(path)
  }

  // In the drawer, whatever you pick closes it.
  const pick = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { setNavOpen(false); fn(...a) }
  const treeView = (
    <div className="sidebar-tree">
      {notes === null
        ? <div className="empty">{t('common.loading')}</div>
        : <NoteTree nodes={tree} selected={openPath} expanded={expanded} onExpanded={setExpanded} onOpen={mobile ? pick(setOpenPath) : setOpenPath} />}
    </div>
  )
  const alertsLink = alerts > 0 && (
    <a className="sidebar-alerts" href="?view=avisos" aria-current={view === 'avisos' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setNavOpen(false); showAlerts() }}>
      {Icon.alert}<span>{t('shell.alerts', { n: alerts })}</span>
    </a>
  )
  const userRow = (
    <div className="sidebar-user">
      <Button className="sidebar-user-btn" aria-label={t('shell.preferences')} isDisabled={!profile} onPress={pick(() => setPrefsOpen(true))}>
        <span className="avatar" aria-hidden="true" style={{ background: userColor(baseHue(user.id), effective) }}>{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="name">{user.username}</span>
        <span className="role">{t(user.role === 'admin' ? 'role.admin' : 'role.member')}</span>
      </Button>
      <Button className="btn btn-icon" aria-label={t('shell.logout')} onPress={onLogout}>{Icon.logout}</Button>
    </div>
  )

  return (
    <OpenPaletteContext.Provider value={() => setPalette('search')}>
    <OpenNavContext.Provider value={mobile ? () => setNavOpen(true) : null}>
    <div className="shell">
      {mobile ? (
        <ModalOverlay className="drawer-overlay" isOpen={navOpen} onOpenChange={setNavOpen} isDismissable>
          <Modal className="drawer">
            <Dialog className="drawer-dialog" aria-label={t('shell.folders')}>
              <div className="sidebar-head">
                <Brand />
                <span className="spacer" />
                <ThemeToggle />
                <Button className="btn btn-icon" aria-label={t('shell.closeFolders')} onPress={() => setNavOpen(false)}>{Icon.close}</Button>
              </div>
              {treeView}
              <div className="drawer-foot">
                <Button className="btn btn-primary btn-xl" onPress={pick(() => setPalette('create'))}>{t('shell.newNote')}</Button>
                {dailyOn && <Button className="btn btn-xl" onPress={pick(() => void openToday())}>{Icon.calendar}{t('shell.today')}</Button>}
                {alertsLink}
              </div>
              {userRow}
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : (
        <nav className="sidebar" aria-label={t('shell.folders')}>
          <div className="sidebar-head">
            <Brand />
            <span className="spacer" />
            {dailyOn && <Button className="btn btn-icon" aria-label={t('shell.today')} onPress={() => void openToday()}>{Icon.calendar}</Button>}
            <Button className="btn btn-icon" aria-label={t('shell.newNote')} onPress={() => setPalette('create')}>{Icon.plus}</Button>
          </div>
          <Button className="btn sidebar-search" onPress={() => setPalette('search')}>
            {Icon.search}<span>{t('shell.search')}</span><kbd>⌘K</kbd>
          </Button>
          {treeView}
          {alertsLink}
          {userRow}
        </nav>
      )}
      <main className="main">
        {view === 'avisos' ? (
          <AlertsPage
            onOpen={setOpenPath}
            onChanged={(n) => { setAlerts(n); void loadTree() }}
            onUnauthorized={onUnauthorized}
          />
        ) : openPath && ready === openPath ? (
          <Suspense fallback={<div className="empty">{t('common.loading')}</div>}>
            <NoteView
              key={openPath}
              path={openPath}
              user={user}
              daily={dailyNav}
              onNavigate={setOpenPath}
              onMoved={(to, report) => { setOpenPath(to); if (report && (report.failed.length || report.images.failed.length)) setMoveIssue(report); void loadTree() }}
              onTrashed={(t) => { setOpenPath(null); setTrashed(t); void loadTree() }}
              templates={templates}
              onCreated={created}
            />
          </Suspense>
        ) : (
          <>
            <header className="main-head">
              <MenuButton />
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
        {moveIssue && <MoveToast report={moveIssue} onDismiss={() => setMoveIssue(null)} />}
        {trashed && (
          <TrashToast
            key={trashed.id}
            trashed={trashed}
            onRestored={(path) => { setOpenPath(path); void loadTree() }}
            onDismiss={() => setTrashed(null)}
          />
        )}
      </main>
      {palette && (
        <Palette
          key={palette}
          mode={palette}
          folder={folder}
          openPath={openPath}
          notes={notes}
          templates={templates}
          onToday={dailyOn ? () => void openToday() : null}
          onClose={() => setPalette(null)}
          onMode={setPalette}
          onOpen={setOpenPath}
          onCreated={created}
        />
      )}
      {prefsOpen && profile && (
        <PreferencesDialog
          profile={profile}
          workspace={workspace}
          onClose={() => setPrefsOpen(false)}
          onSaved={(p) => { setProfile(p); setPrefsOpen(false) }}
        />
      )}
    </div>
    </OpenNavContext.Provider>
    </OpenPaletteContext.Provider>
  )
}
