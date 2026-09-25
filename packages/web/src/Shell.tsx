// Main structure: folder tree and the note open in the editor.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Modal, ModalOverlay, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components'
import { seriesNeighbors } from '@thoth/core/series'
import { ApiError, api, type FolderMoveReport, type MoveReport, type Profile, type TreeNote, type User, type WorkspaceInfo } from './api.ts'
import { AlertsPage } from './Alerts.tsx'
import { useTheme } from './theme.ts'
import { baseHue, userColor } from './userColor.ts'
import { errorText, useT } from './i18n.tsx'
import { Brand, Crumbs, Icon, MenuButton, OpenNavContext, ThemeToggle } from './ui.tsx'
import { TrashToast, type Trashed } from './TrashToast.tsx'
import { MoveToast, moveNotice } from './MoveToast.tsx'
import { shiftedNotice } from './Shifts.tsx'
import { OpenPaletteContext, Palette, SearchButton, type PaletteMode } from './Palette.tsx'
import { rememberNote } from './recent.ts'
import { useBackClose, useMobile, useVisualViewport } from './mobile.ts'
import { PreferencesDialog, browserTimeZone } from './Preferences.tsx'
import { FolderTree, ancestors, buildTree, type Node, type TreeAction } from './FolderTree.tsx'
import { DeleteFolderDialog, FolderMoveDialog, NewFolderDialog } from './FolderDialogs.tsx'
import { RenameDialog, TrashDialog } from './editor/NoteActions.tsx'
import { TagsView } from './TagsView.tsx'

/** A dialog opened from the tree: its context menu or a drop. */
type TreeDialog =
  | { kind: 'newFolder'; parent: string }
  | { kind: 'moveFolder'; path: string; parent?: string }
  | { kind: 'deleteFolder'; path: string }
  | { kind: 'moveNote'; path: string; folder?: string }
  | { kind: 'trashNote'; path: string }

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + '/')

// The editor (CodeMirror, Yjs) is downloaded separately, when the first note is opened.
const NoteView = lazy(() => import('./editor/NoteView.tsx').then((m) => ({ default: m.NoteView })))

export function Shell({ user, onLogout, onUnauthorized }: { user: User; onLogout: () => void; onUnauthorized: () => void }) {
  const t = useT()
  const { effective } = useTheme()
  const [notes, setNotes] = useState<TreeNote[] | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  /** Sidebar: the folder tree or the tags; a picked tag lists its notes. */
  const [sideTab, setSideTab] = useState<'folders' | 'tags'>('folders')
  const [tag, setTag] = useState<string | null>(null)
  const [treeDialog, setTreeDialog] = useState<TreeDialog | null>(null)
  /** Where «New note here» creates the note; null = the open note's folder. */
  const [createIn, setCreateIn] = useState<string | null>(null)
  /** Your last folder move, if some link could not be rewritten. */
  const [folderIssue, setFolderIssue] = useState<FolderMoveReport | null>(null)
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

  const loadTree = () => api.tree().then((r) => { setNotes(r.notes); setFolders(r.folders) }).catch(fail)
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

  const tree = useMemo(() => (notes ? buildTree(notes, folders) : []), [notes, folders])
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
    void loadTree()
    setOpenPath(path)
  }

  // --- The tree's context menu, drops and dialogs ---------------------------
  const closeTreeDialog = () => setTreeDialog(null)
  const onTreeAction = (action: TreeAction, node: Node) => {
    setNavOpen(false)
    if (action === 'newNote') { setCreateIn(node.path); setPalette('create') }
    else if (action === 'newFolder') setTreeDialog({ kind: 'newFolder', parent: node.path })
    else if (action === 'moveFolder') setTreeDialog({ kind: 'moveFolder', path: node.path })
    else if (action === 'deleteFolder') setTreeDialog({ kind: 'deleteFolder', path: node.path })
    else if (action === 'moveNote') setTreeDialog({ kind: 'moveNote', path: node.path })
    else setTreeDialog({ kind: 'trashNote', path: node.path })
  }
  const noteMoved = (from: string, to: string, report: MoveReport) => {
    setTreeDialog(null)
    setExpanded((e) => new Set([...e, ...ancestors(to)]))
    if (openPath === from) setOpenPath(to)
    if (moveNotice(report)) setMoveIssue(report)
    void loadTree()
  }
  const folderPlaced = (from: string, to: string) => {
    setTreeDialog(null)
    const map = (p: string) => (inside(p, from) ? to + p.slice(from.length) : p)
    // Open folders stay open at their new place, and the tree shows where the folder went.
    setExpanded((e) => new Set([...[...e].map((k) => (String(k).startsWith('d:') ? `d:${map(String(k).slice(2))}` : k)), ...ancestors(to)]))
    if (openPath && map(openPath) !== openPath) setOpenPath(map(openPath))
    void loadTree()
  }
  const folderMoved = (r: FolderMoveReport) => {
    folderPlaced(r.from, r.to)
    setFolderIssue(r.failed.length || r.shifted.length ? r : null)
  }
  // A drop moves at once when nothing else changes; if links would be rewritten
  // (or images go along), it goes through the same dialog and preview as the menu.
  const onDrop = async (key: string, folder: string) => {
    const path = key.slice(2)
    const to = folder ? `${folder}/${baseName(path)}` : baseName(path)
    try {
      if (key.startsWith('n:')) {
        const preview = await api.move(path, to, true)
        if (preview.relinked.length || preview.shifted.length || preview.images.moved.length || preview.images.stayed.length) return setTreeDialog({ kind: 'moveNote', path, folder })
        noteMoved(path, to, await api.move(path, to))
      } else {
        const preview = await api.moveFolder(path, to, true)
        if (preview.relinked.length || preview.shifted.length) return setTreeDialog({ kind: 'moveFolder', path, parent: folder })
        folderMoved(await api.moveFolder(path, to))
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      // The dialog shows why (a name already taken…) and lets it be changed.
      setTreeDialog(key.startsWith('n:') ? { kind: 'moveNote', path, folder } : { kind: 'moveFolder', path, parent: folder })
    }
  }

  // In the drawer, whatever you pick closes it.
  const pick = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { setNavOpen(false); fn(...a) }
  const treeView = (
    <Tabs className="side-tabs" selectedKey={sideTab} onSelectionChange={(k) => setSideTab(k === 'tags' ? 'tags' : 'folders')}>
      <div className="side-tabs-head">
        <TabList className="side-tablist" aria-label={t('sidebar.views')}>
          <Tab id="folders" className="side-tab">{t('shell.folders')}</Tab>
          <Tab id="tags" className="side-tab">{t('sidebar.tags')}</Tab>
        </TabList>
        <span className="spacer" />
        {sideTab === 'folders' && (
          <Button className="btn btn-icon btn-quiet" aria-label={t('folder.new')} onPress={pick(() => setTreeDialog({ kind: 'newFolder', parent: '' }))}>{Icon.folderPlus}</Button>
        )}
      </div>
      <TabPanel id="folders" className="sidebar-tree">
        {notes === null
          ? <div className="empty">{t('common.loading')}</div>
          : (
            <FolderTree
              nodes={tree}
              selected={openPath}
              expanded={expanded}
              onExpanded={setExpanded}
              onOpen={mobile ? pick(setOpenPath) : setOpenPath}
              onAction={onTreeAction}
              onDrop={(key, folder) => void onDrop(key, folder)}
              draggable={!mobile}
              emptyText={t('shell.noNotes')}
            />
          )}
      </TabPanel>
      <TabPanel id="tags" className="sidebar-tree">
        <TagsView selected={tag} onSelect={setTag} openPath={openPath} onOpen={mobile ? pick(setOpenPath) : setOpenPath} refresh={notes} />
      </TabPanel>
    </Tabs>
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
              onMoved={(to, report) => { setOpenPath(to); if (report && moveNotice(report)) setMoveIssue(report); void loadTree() }}
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
        {folderIssue && (
          <div className="toast toast-warn">
            <span className="toast-icon">{Icon.alert}</span>
            <span className="toast-text" role="alert">{[
              folderIssue.failed.length > 0 && t('folder.partial', { name: baseName(folderIssue.to), notes: folderIssue.failed.map((f) => baseName(f.path).replace(/\.md$/i, '')).join(', ') }),
              shiftedNotice(t, baseName(folderIssue.to), folderIssue.shifted),
            ].filter(Boolean).join(' ')}</span>
            <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={() => setFolderIssue(null)}>{Icon.close}</Button>
          </div>
        )}
        {trashed && (
          <TrashToast
            key={trashed.id}
            trashed={trashed}
            onRestored={(path) => { setOpenPath(path); void loadTree() }}
            onDismiss={() => setTrashed(null)}
          />
        )}
      </main>
      <ModalOverlay className="modal-overlay" isOpen={treeDialog !== null} onOpenChange={(o) => { if (!o) closeTreeDialog() }} isDismissable>
        <Modal className="modal">
          {treeDialog?.kind === 'newFolder' && (
            <NewFolderDialog parent={treeDialog.parent} onClose={closeTreeDialog} onCreated={(p) => {
              closeTreeDialog()
              setSideTab('folders')
              setExpanded((e) => new Set([...e, ...ancestors(p)]))
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'moveFolder' && <FolderMoveDialog path={treeDialog.path} initialParent={treeDialog.parent} onClose={closeTreeDialog} onMoved={folderMoved} />}
          {treeDialog?.kind === 'deleteFolder' && <DeleteFolderDialog path={treeDialog.path} onClose={closeTreeDialog} onDeleted={() => { closeTreeDialog(); void loadTree() }} />}
          {treeDialog?.kind === 'moveNote' && (
            <RenameDialog path={treeDialog.path} initialFolder={treeDialog.folder} onClose={closeTreeDialog} onMoved={(to, r) => noteMoved(treeDialog.path, to, r)} />
          )}
          {treeDialog?.kind === 'trashNote' && (
            <TrashDialog path={treeDialog.path} onClose={closeTreeDialog} onTrashed={(id) => {
              const path = treeDialog.path
              closeTreeDialog()
              if (openPath === path) setOpenPath(null)
              setTrashed({ id, path, by: null })
              void loadTree()
            }} />
          )}
        </Modal>
      </ModalOverlay>
      {palette && (
        <Palette
          key={palette}
          mode={palette}
          folder={createIn ?? folder}
          openPath={openPath}
          notes={notes}
          templates={templates}
          onToday={dailyOn ? () => void openToday() : null}
          onClose={() => { setPalette(null); setCreateIn(null) }}
          onMode={setPalette}
          onOpen={setOpenPath}
          onCreated={(p) => { setCreateIn(null); created(p) }}
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
