// Main structure: folder tree and the note open in the editor.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Modal, ModalOverlay, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components'
import { seriesNeighbors } from '@vihko/core/series'
import { ApiError, SESSION_ENDED_EVENT, api, atLeast, type FolderLock, type FolderMoveReport, type MoveJob, type MoveReport, type Profile, type SpaceEntry, type SpacesInfo, type TreeNote, type User, type WorkspaceInfo } from './api.ts'
import { SpacesContext, notePathOf, rootOf, usePathLabels, useSpacesValue } from './spaces.tsx'
import { addressOf } from '@vihko/core/spaces'
import { SpaceSections, type Section, type SectionAction } from './Sidebar.tsx'
import { DeleteSpaceDialog, LeaveSpaceDialog, NewSpaceDialog, RenameSpaceDialog, spaceError } from './SpaceDialogs.tsx'
import { SpacesPage } from './SpacesAdmin.tsx'
import { audienceChanges } from './Audience.tsx'
import { MembersDialog, PermissionsDialog } from './Permissions.tsx'
import { AlertsPage, NoticeToast, isPersonalNotice, type PersonalNotice } from './Alerts.tsx'
import { AgentsPage } from './Agents.tsx'
import { PrivacyPage } from './Privacy.tsx'
import { UsersPage } from './Users.tsx'
import { AccountPage } from './Account.tsx'
import { useChooseLanguage } from './language.ts'
import { useTheme } from './theme.ts'
import { baseHue, userColor } from './userColor.ts'
import { errorText, useT } from './i18n.tsx'
import { Brand, Crumbs, FolderPermissionsContext, Icon, MenuButton, OpenNavContext, ThemeToggle } from './ui.tsx'
import { TrashToast, type Trashed } from './TrashToast.tsx'
import { PinOfferToast, type PinOffer } from './PinOffer.tsx'
import { MoveToast, moveNotice } from './MoveToast.tsx'
import { MoveProgress, type JobEnd } from './MoveProgress.tsx'
import { shiftedNotice } from './Shifts.tsx'
import { OpenPaletteContext, Palette, SearchButton, type PaletteMode } from './Palette.tsx'
import { rememberNote } from './recent.ts'
import { WINDOWS, modKTaken } from './keys.ts'
import { useBackClose, useMobile, useVisualViewport } from './mobile.ts'
import { PreferencesDialog, browserTimeZone } from './Preferences.tsx'
import { ancestors, buildTree, type FolderInfoOf, type Node, type TreeAction } from './FolderTree.tsx'
import { DeleteFolderDialog, FolderMoveDialog, MoveToNewSpaceDialog, NewFolderDialog } from './FolderDialogs.tsx'
import { RenameDialog, TrashDialog } from './editor/NoteActions.tsx'
import { TagsView } from './TagsView.tsx'
import type { RestoreReport } from './history/api.ts'
import { ChangesPage } from './history/Changes.tsx'
import { HistoryIcon, RestoreToast, TimeZoneContext, useHistoryStatus, useVersions } from './history/ui.tsx'
import { VersionView } from './history/VersionView.tsx'

/** A dialog opened from the tree: its context menu or a drop. */
type TreeDialog =
  | { kind: 'newFolder'; parent: string }
  | { kind: 'moveFolder'; path: string; parent?: string }
  | { kind: 'toNewSpace'; path: string }
  | { kind: 'deleteFolder'; path: string }
  | { kind: 'permissions'; path: string }
  | { kind: 'members'; path: string }
  | { kind: 'moveNote'; path: string; folder?: string }
  | { kind: 'trashNote'; path: string }
  | { kind: 'newSpace' }
  | { kind: 'renameSpace'; section: Section }
  | { kind: 'leaveSpace'; section: Section }
  | { kind: 'deleteSpace'; space: SpaceEntry }

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** Views that aren't a note, in the URL as `?view=` (no router). */
const VIEWS = ['alerts', 'changes', 'agents', 'privacy', 'users', 'account', 'spaces'] as const
type View = (typeof VIEWS)[number]
/** Earlier names of a view, still opened (bookmarks, links already sent); the URL then says the current one. */
const VIEW_ALIASES: Record<string, View> = { avisos: 'alerts' }
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + '/')

// The editor (CodeMirror, Yjs) is downloaded separately, when the first note is opened.
const NoteView = lazy(() => import('./editor/NoteView.tsx').then((m) => ({ default: m.NoteView })))

export function Shell({ user, onLogout, onUnauthorized }: { user: User; onLogout: () => void; onUnauthorized: () => void }) {
  const t = useT()
  const { effective } = useTheme()
  const chooseLanguage = useChooseLanguage()
  const [notes, setNotes] = useState<TreeNote[] | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  /** Folders shown only as the way to what the person sees (D-038). */
  const [pathOnly, setPathOnly] = useState<Set<string>>(() => new Set())
  /** The person's level in each folder they see, and the folders' locks (the admin: every folder). Null until loaded. */
  const [locks, setLocks] = useState<Map<string, FolderLock> | null>(null)
  /** What the person reaches, space by space (D-056); null until loaded. */
  const [spaces, setSpaces] = useState<SpacesInfo | null>(null)
  const spacesValue = useSpacesValue(user.username, spaces)
  /** Paths as the person sees them, for what the shell itself shows (the context is provided below). */
  const shellLabels = usePathLabels(spacesValue)
  /** Something went wrong with a space's action (pinning, from the sidebar). */
  const [spaceIssue, setSpaceIssue] = useState<string | null>(null)
  /** The open note can't be read: it doesn't exist or isn't the person's to see (the same message for both). */
  const [noAccess, setNoAccess] = useState<string | null>(null)
  /** Sidebar: the folder tree or the tags; a picked tag lists its notes. */
  const [sideTab, setSideTab] = useState<'folders' | 'tags'>('folders')
  const [tag, setTag] = useState<string | null>(null)
  const [treeDialog, setTreeDialog] = useState<TreeDialog | null>(null)
  /** Where «New note here» creates the note; null = the open note's folder. */
  const [createIn, setCreateIn] = useState<string | null>(null)
  /** Your last folder move, if some link could not be rewritten. */
  const [folderIssue, setFolderIssue] = useState<FolderMoveReport | null>(null)
  const [alerts, setAlerts] = useState(0)
  /** Notices addressed to this person when they came in (M4.1): said at once, kept in «Alerts» until dismissed there. */
  const [arrived, setArrived] = useState<PersonalNotice[] | null>(null)
  // `?note=` is the note's address (D-056.29); one from before it is read too, and written back as an address below.
  const [openPath, setOpenPathState] = useState<string | null>(() => notePathOf(location.search))
  const [view, setView] = useState<View | null>(() => {
    const v = new URLSearchParams(location.search).get('view')
    return VIEWS.find((x) => x === v) ?? (v !== null && Object.hasOwn(VIEW_ALIASES, v) ? VIEW_ALIASES[v]! : null)
  })
  /** A version of the open note shown instead of the editor (`?version=`, from the history). */
  const [version, setVersion] = useState<string | null>(() => new URLSearchParams(location.search).get('version'))
  const versionRef = useRef(version)
  versionRef.current = version
  const setOpenPath = (path: string | null) => { setView(null); setVersion(null); setOpenPathState(path) }
  const openVersion = (path: string, id: string) => { setView(null); setOpenPathState(path); setVersion(id) }
  const showAlerts = () => { setOpenPathState(null); setVersion(null); setView('alerts') }
  const showChanges = () => { setOpenPathState(null); setVersion(null); setView('changes') }
  const showAgents = () => { setPrefsOpen(false); setOpenPathState(null); setVersion(null); setView('agents') }
  const showPrivacy = () => { setPrefsOpen(false); setOpenPathState(null); setVersion(null); setView('privacy') }
  const showUsers = () => { setPrefsOpen(false); setOpenPathState(null); setVersion(null); setView('users') }
  const showAccount = () => { setPrefsOpen(false); setOpenPathState(null); setVersion(null); setView('account') }
  const showSpaces = () => { setPrefsOpen(false); setOpenPathState(null); setVersion(null); setView('spaces') }
  const historyStatus = useHistoryStatus()
  const historyOn = historyStatus !== null && historyStatus.mode !== 'off'
  /** The note at `?note=` doesn't exist, but its version was asked for: shown on its own (restoring creates it again). */
  const [missing, setMissing] = useState<string | null>(null)
  const missingVersions = useVersions(missing, false)
  const [restored, setRestored] = useState<{ seq: number; report: RestoreReport } | null>(null)
  const restoredDone = (report: RestoreReport) => { setVersion(null); setRestored((r) => ({ seq: (r?.seq ?? 0) + 1, report })) }
  const [ready, setReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<Trashed | null>(null)
  /** You opened one of an ambiguous link's candidates: pin the link there? */
  const [pinOffer, setPinOffer] = useState<PinOffer | null>(null)
  /** Your last rename or move, if some link could not be rewritten. */
  const [moveIssue, setMoveIssue] = useState<MoveReport | null>(null)
  /** The open note was moved by another tool and followed its file; `links`: left behind (null until known). */
  const [outsideMove, setOutsideMove] = useState<{ from: string; to: string; links: number | null } | null>(null)
  /** Your move whose links are still being rewritten, and what went wrong following it. */
  const [moveJob, setMoveJob] = useState<MoveJob | null>(null)
  const [jobIssue, setJobIssue] = useState<string | null>(null)
  const [palette, setPalette] = useState<PaletteMode | null>(null)
  const mobile = useMobile()
  // On a phone with nothing open, start at the tree: it's the only way in.
  const [navOpen, setNavOpen] = useState(() => mobile && !openPath && !view)
  const [expanded, setExpanded] = useState<Set<Key>>(() => new Set(openPath ? ancestors(openPath) : []))
  useBackClose(mobile && navOpen, () => setNavOpen(false))
  useVisualViewport(mobile)
  /** vihko.yaml as the server has it now: daily-note series and the templates folder. */
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }

  const loadTree = () => Promise.all([
    api.tree().then((r) => { setNotes(r.notes); setFolders(r.folders); setPathOnly(new Set(r.pathOnly ?? [])) }).catch(fail),
    // Without it the tree offers every action and the server answers: never a reason to fail the page.
    api.permissionFolders().then((r) => setLocks(new Map(r.folders.map((f) => [f.path, f])))).catch(() => {}),
    api.spaces().then(setSpaces).catch(fail),
  ])
  const loadWorkspace = () => api.workspace().then(setWorkspace).catch(() => {})
  const loadAlerts = () => api.alerts().then((a) => setAlerts(a.length)).catch(() => {})

  useEffect(() => {
    void loadTree()
    api.alerts().then((a) => {
      setAlerts(a.length)
      const mine = a.filter(isPersonalNotice)
      if (!mine.length) return
      setArrived(mine)
      // On a phone the tree starts open over everything: the notice goes first.
      setNavOpen(false)
    }).catch(() => {})
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
    // vihko.yaml can change at any time (another editor, git pull): read again on coming back.
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

  // The hub says this session ended (disabled, sessions closed, a new password elsewhere): sign in again.
  useEffect(() => {
    const ended = () => onUnauthorized()
    window.addEventListener(SESSION_ENDED_EVENT, ended)
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended)
  }, [onUnauthorized])

  // ⌘K / Ctrl+K opens the palette from anywhere, including from the editor,
  // except over text selected in a note the person can edit: there it's a link (keys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        // Captured and not propagated: the editor never sees the key (on macOS, Ctrl+K deletes to end of line).
        e.preventDefault()
        e.stopPropagation()
        if (!modKTaken(e)) setPalette('search')
      }
      // ⌘⌥D / Ctrl+Alt+D: today's note. By physical key too (Option changes e.key on a Mac, and so does
      // a non-Latin layout), except for Ctrl+Alt on Windows: that's AltGr, which types «đ» with D on some layouts.
      const d = e.key.toLowerCase() === 'd' || (e.code === 'KeyD' && !(WINDOWS && e.ctrlKey && e.altKey))
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && d && todayRef.current) {
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
    for (const [k, v] of [['note', openPath && (addressOf(openPath) ?? openPath)], ['version', openPath && version], ['view', view]] as const) v ? url.searchParams.set(k, v) : url.searchParams.delete(k)
    history.replaceState(null, '', url)
  }, [openPath, version, view])
  // A version is a screen over its note: the back button goes back to the note.
  useBackClose(openPath !== null && version !== null, () => setVersion(null))

  useEffect(() => {
    setReady(null)
    if (!openPath) return
    // The tree shows where the note is (it may have been opened by a link or the palette).
    setExpanded((e) => { const add = ancestors(openPath).filter((k) => !e.has(k)); return add.length ? new Set([...e, ...add]) : e })
    setTrashed(null)
    setPinOffer((o) => (o?.target === openPath ? o : null))
    setMoveIssue((m) => (m?.to === openPath ? m : null))
    setOutsideMove((m) => (m?.to === openPath ? m : null))
    setError(null)
    setMissing(null)
    setNoAccess(null)
    // Check that it exists before opening co-editing: the hub rejects notes that don't exist.
    api.note(openPath).then(() => { setReady(openPath); rememberNote(openPath) }).catch((err) => {
      if (versionRef.current && err instanceof ApiError && err.code === 'not_found') setMissing(openPath)
      // Neither missing nor someone else's is told apart (D-024, D-038).
      else if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) setNoAccess(openPath)
      else fail(err)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath])

  const tree = useMemo(() => (notes ? buildTree(notes, folders) : []), [notes, folders])
  const admin = user.role === 'admin'
  /** The person's level and a folder's marks, for the tree's actions and locks. */
  const folderInfo = useMemo<FolderInfoOf>(() => (path) => {
    if (!locks) return undefined
    const l = locks.get(path)
    return { level: l?.level ?? null, canEdit: l?.canEdit ?? false, own: l?.ownGrants ?? false, ai: l?.aiClosed ?? false, pathOnly: pathOnly.has(path) }
  }, [locks, pathOnly])
  /** Whether this person may open who a folder is shared with: where they manage it (the admin role counts for nothing, D-056). */
  const canManageFolder = (folder: string) => !!locks?.get(folder)?.canEdit
  /** Nowhere to write: no «New note» (read-only mode signals, D-038.5). Their own space always is. */
  const editsSomewhere = !locks || !!spaces?.personal || [...locks.values()].some((l) => atLeast(l.level, 'edit'))
  // The header's way to share a note's folder (only once the levels are known), never the root of one's own space.
  const folderPermissions = useMemo(() => (locks ? {
    can: (folder: string) => !!locks.get(folder)?.canEdit && folder !== spaces?.personal?.path,
    open: (folder: string) => setTreeDialog({ kind: 'permissions', path: folder }),
  } : null), [locks, spaces])
  // Template notes: those in the templates folders of vihko.yaml, subfolders included.
  const templates = useMemo(() => {
    const dirs = workspace?.templates ?? []
    if (!dirs.length || !notes) return []
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    return notes.map((n) => n.path).filter((p) => dirs.some((dir) => p.startsWith(`${dir}/`))).sort(collator.compare)
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
  /** Where things are created: the open note's folder, else the root of the person's own space (never the notes root, D-056). */
  const mine = spaces?.personal?.path ?? `people/${user.username}`
  const folder = openPath?.includes('/') && rootOf(openPath) ? openPath.slice(0, openPath.lastIndexOf('/')) : mine
  /** Where the palette's «new folder» creates: the open note's folder, else their own space, where this person may (as the tree: `edit`). */
  const mayCreateIn = (path: string) => !locks || atLeast(locks.get(path)?.level, 'edit')
  const newFolderIn = mayCreateIn(folder) ? folder : mine
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
    else if (action === 'toNewSpace') setTreeDialog({ kind: 'toNewSpace', path: node.path })
    // To one's own space: the move of always, its destination there (D-056.28).
    else if (action === 'toMine') setTreeDialog({ kind: 'moveFolder', path: node.path, parent: mine })
    else if (action === 'deleteFolder') setTreeDialog({ kind: 'deleteFolder', path: node.path })
    else if (action === 'permissions') setTreeDialog({ kind: 'permissions', path: node.path })
    else if (action === 'moveNote') setTreeDialog({ kind: 'moveNote', path: node.path })
    else setTreeDialog({ kind: 'trashNote', path: node.path })
  }
  /** A note is in place; the report comes now or, for a move in the background, when it ends. */
  const noteMoved = (from: string, to: string, report: MoveReport | null) => {
    setTreeDialog(null)
    setExpanded((e) => new Set([...e, ...ancestors(to)]))
    if (openPath === from) setOpenPath(to)
    if (report && moveNotice(report)) setMoveIssue(report)
    void loadTree()
  }
  /** Another tool moved the open note and it followed its file: the alert may offer «Update links». */
  const movedOutside = (from: string, to: string) => {
    setExpanded((e) => new Set([...e, ...ancestors(to)]))
    setOpenPath(to)
    setOutsideMove({ from, to, links: null })
    void loadTree()
    api.alerts().then((list) => {
      setAlerts(list.length)
      const a = list.find((x) => x.code === 'external_move' && x.moves.some((m) => m.from === from && m.to === to))
      const links = a?.code === 'external_move' ? a.links : 0
      setOutsideMove((m) => (m?.to === to ? { ...m, links } : m))
    }).catch(() => {})
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
  const moveStarted = (job: MoveJob) => {
    if (job.kind === 'note') noteMoved(job.from, job.to, null)
    else folderPlaced(job.from, job.to)
    setJobIssue(null)
    setMoveJob(job)
  }
  const moveEnded = (job: MoveJob, end: JobEnd) => {
    setMoveJob(null)
    if (end.kind === 'done') {
      const r = end.report
      if ('kept' in r) { if (moveNotice(r)) setMoveIssue(r) }
      else if ('notes' in r) setFolderIssue(r.failed.length || r.shifted.length ? r : null)
    } else {
      setJobIssue(end.kind === 'lost' ? t('job.lost', { name: baseName(job.to).replace(/\.md$/i, '') }) : end.message)
    }
    void loadTree()
  }
  // A drop moves at once when nothing else changes; if links would be rewritten
  // (or images go along), it goes through the same dialog and preview as the menu.
  const onDrop = async (key: string, folder: string) => {
    const path = key.slice(2)
    const to = folder ? `${folder}/${baseName(path)}` : baseName(path)
    try {
      // Between sections of the sidebar is between spaces: always through the dialog (spec §5.4).
      if (rootOf(path) !== rootOf(to)) return setTreeDialog(key.startsWith('n:') ? { kind: 'moveNote', path, folder } : { kind: 'moveFolder', path, parent: folder })
      if (key.startsWith('n:')) {
        const preview = await api.move(path, to, true)
        if (preview.relinked.length || preview.shifted.length || preview.images.moved.length || preview.images.stayed.length || preview.images.copied?.length || preview.images.folder || preview.images.failed.length || audienceChanges(preview.audience)) return setTreeDialog({ kind: 'moveNote', path, folder })
        noteMoved(path, to, await api.move(path, to))
      } else {
        const preview = await api.moveFolder(path, to, true)
        // Who sees it changes: never in silence (D-038), the dialog asks.
        if (preview.relinked.length || preview.shifted.length || audienceChanges(preview.audience)) return setTreeDialog({ kind: 'moveFolder', path, parent: folder })
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
  /** A section's menu (a space, or a folder shared with the person). */
  const onSection = (action: SectionAction, s: Section) => {
    // Pinning happens in place (the drawer stays open on a phone); the rest opens something over it.
    if (action !== 'pin' && action !== 'unpin') setNavOpen(false)
    setSpaceIssue(null)
    if (action === 'newNote') { setCreateIn(s.root); setPalette('create') }
    else if (action === 'newFolder') setTreeDialog({ kind: 'newFolder', parent: s.root })
    // Managers change who's in; every other member only sees it (D-056.27).
    else if ((action === 'members' && s.level === 'manage') || action === 'share' || action === 'agents') setTreeDialog({ kind: 'permissions', path: s.root })
    else if (action === 'members' || action === 'access') setTreeDialog({ kind: 'members', path: s.root })
    else if (action === 'rename') setTreeDialog({ kind: 'renameSpace', section: s })
    else if (action === 'leave') setTreeDialog({ kind: 'leaveSpace', section: s })
    else if (action === 'delete') {
      const space = spaces?.spaces.find((x) => x.path === s.root)
      if (space) setTreeDialog({ kind: 'deleteSpace', space })
    } else {
      api.pinShared(s.root, action === 'pin').then(() => loadTree()).catch((err) => {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized()
        setSpaceIssue(spaceError(t, err))
      })
    }
  }
  /** Notes of a folder (and everything under it), as the tree has them. */
  const notesUnder = (folder: string) => (notes ?? []).filter((n) => n.path.startsWith(`${folder}/`)).length
  const treeView = (
    <Tabs className="side-tabs" selectedKey={sideTab} onSelectionChange={(k) => setSideTab(k === 'tags' ? 'tags' : 'folders')}>
      <div className="side-tabs-head">
        <TabList className="side-tablist" aria-label={t('sidebar.views')}>
          <Tab id="folders" className="side-tab">{t('shell.folders')}</Tab>
          <Tab id="tags" className="side-tab">{t('sidebar.tags')}</Tab>
        </TabList>
      </div>
      <TabPanel id="folders" className="sidebar-tree">
        {notes === null || spaces === null
          ? <div className="empty">{t('common.loading')}</div>
          : (
            <SpaceSections
              info={spaces}
              tree={tree}
              selected={openPath}
              expanded={expanded}
              onExpanded={setExpanded}
              onOpen={mobile ? pick(setOpenPath) : setOpenPath}
              onAction={onTreeAction}
              onDrop={(key, folder) => void onDrop(key, folder)}
              draggable={!mobile}
              folderInfo={folderInfo}
              onSection={onSection}
              onNewSpace={pick(() => setTreeDialog({ kind: 'newSpace' }))}
              onFirstNote={pick(() => { setCreateIn(mine); setPalette('create') })}
            />
          )}
        {spaceIssue && <p className="error-text space-issue" role="alert">{spaceIssue}</p>}
      </TabPanel>
      <TabPanel id="tags" className="sidebar-tree">
        <TagsView selected={tag} onSelect={setTag} openPath={openPath} onOpen={mobile ? pick(setOpenPath) : setOpenPath} refresh={notes} />
      </TabPanel>
    </Tabs>
  )
  const changesLink = historyOn && (
    <a className="sidebar-link" href="?view=changes" aria-current={view === 'changes' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setNavOpen(false); showChanges() }}>
      {HistoryIcon.history}<span>{t('changes.link')}</span>
    </a>
  )
  const alertsLink = alerts > 0 && (
    <a className="sidebar-alerts" href="?view=alerts" aria-current={view === 'alerts' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setNavOpen(false); showAlerts() }}>
      {Icon.alert}<span>{t(alerts === 1 ? 'shell.alertsOne' : 'shell.alerts', { n: alerts })}</span>
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
    <SpacesContext.Provider value={spacesValue}>
    <TimeZoneContext.Provider value={profile?.timezone ?? browserTimeZone()}>
    <OpenPaletteContext.Provider value={() => setPalette('search')}>
    <OpenNavContext.Provider value={mobile ? () => setNavOpen(true) : null}>
    <FolderPermissionsContext.Provider value={folderPermissions}>
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
                {editsSomewhere && <Button className="btn btn-primary btn-xl" onPress={pick(() => setPalette('create'))}>{t('shell.newNote')}</Button>}
                {dailyOn && <Button className="btn btn-xl" onPress={pick(() => void openToday())}>{Icon.calendar}{t('shell.today')}</Button>}
                {changesLink}
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
            {editsSomewhere && <Button className="btn btn-icon" aria-label={t('shell.newNote')} onPress={() => setPalette('create')}>{Icon.plus}</Button>}
          </div>
          <Button className="btn sidebar-search" onPress={() => setPalette('search')}>
            {Icon.search}<span>{t('shell.search')}</span><kbd>⌘K</kbd>
          </Button>
          {treeView}
          {changesLink}
          {alertsLink}
          {userRow}
        </nav>
      )}
      <main className="main">
        {view === 'alerts' ? (
          <AlertsPage
            onOpen={setOpenPath}
            onSpaces={showSpaces}
            onChanged={(n) => { setAlerts(n); void loadTree() }}
            onUnauthorized={onUnauthorized}
          />
        ) : view === 'agents' ? (
          <AgentsPage user={user} onUnauthorized={onUnauthorized} onPrivacy={showPrivacy} />
        ) : view === 'privacy' ? (
          <PrivacyPage user={user} onUnauthorized={onUnauthorized} onAgents={showAgents} />
        ) : view === 'users' && user.role === 'admin' ? (
          <UsersPage user={user} onUnauthorized={onUnauthorized} />
        ) : view === 'spaces' && user.role === 'admin' ? (
          <SpacesPage user={user} onUnauthorized={onUnauthorized} onChanged={() => void loadTree()} />
        ) : view === 'account' ? (
          <AccountPage user={user} onUnauthorized={onUnauthorized} />
        ) : view === 'changes' ? (
          <ChangesPage status={historyStatus} notes={notes} admin={admin} onOpenVersion={openVersion} onUnauthorized={onUnauthorized} />
        ) : openPath && version && missing === openPath ? (
          <>
            <header className="main-head">
              <MenuButton />
              <Crumbs path={openPath} />
              <span className="spacer" />
              <SearchButton />
              <ThemeToggle />
            </header>
            <VersionView key={version} path={openPath} id={version} store={missingVersions} exists={false} closeLabel={t('version.close')}
              onClose={showChanges}
              onRestored={(report) => { restoredDone(report); setMissing(null); setReady(openPath); rememberNote(openPath); void loadTree() }} />
          </>
        ) : openPath && ready === openPath ? (
          <Suspense fallback={<div className="empty">{t('common.loading')}</div>}>
            <NoteView
              key={openPath}
              path={openPath}
              user={user}
              daily={dailyNav}
              onNavigate={setOpenPath}
              onMoved={(to, report) => { setOpenPath(to); if (report && moveNotice(report)) setMoveIssue(report); void loadTree() }}
              onMovedOutside={movedOutside}
              onMoveStarted={moveStarted}
              onTrashed={(t) => { setOpenPath(null); setTrashed(t); void loadTree() }}
              templates={templates}
              onCreated={created}
              onPickCandidate={(offer) => { setPinOffer(offer); setOpenPath(offer.target) }}
              history={historyStatus}
              version={version}
              onVersion={setVersion}
              onRestored={restoredDone}
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
              {openPath && noAccess === openPath && !error && (
                <div className="no-access" role="alert">
                  <p className="no-access-title">{Icon.lock}{t('note.noAccess')}</p>
                  <p>{t('note.noAccessHint')}</p>
                </div>
              )}
              {!openPath && !error && <p className="empty">{t('shell.empty')}</p>}
            </div>
          </>
        )}
        {arrived && view !== 'alerts' && (
          <NoticeToast notices={arrived} onSee={() => { setArrived(null); setNavOpen(false); showAlerts() }} onDismiss={() => setArrived(null)} />
        )}
        {moveIssue && <MoveToast report={moveIssue} onDismiss={() => setMoveIssue(null)} />}
        {outsideMove && outsideMove.to === openPath && (
          <div className="toast">
            <span className="toast-icon">{Icon.rename}</span>
            <span className="toast-text" role="status">
              {t('movedOutside.done', { name: baseName(outsideMove.from).replace(/\.md$/i, ''), to: shellLabels.label(outsideMove.to) })}
              {outsideMove.links ? ` ${t(outsideMove.links === 1 ? 'movedOutside.linksOne' : 'movedOutside.links', { n: outsideMove.links })}` : ''}
            </span>
            {!!outsideMove.links && <Button className="btn" onPress={() => { setOutsideMove(null); showAlerts() }}>{t('movedOutside.review')}</Button>}
            <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={() => setOutsideMove(null)}>{Icon.close}</Button>
          </div>
        )}
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
        {jobIssue && (
          <div className="toast toast-warn">
            <span className="toast-icon">{Icon.alert}</span>
            <span className="toast-text" role="alert">{jobIssue}</span>
            <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={() => setJobIssue(null)}>{Icon.close}</Button>
          </div>
        )}
        {moveJob && <MoveProgress key={moveJob.id} job={moveJob} onFinished={(end) => moveEnded(moveJob, end)} />}
        {pinOffer && pinOffer.target === openPath && (
          <PinOfferToast key={`${pinOffer.source}#${pinOffer.raw}#${pinOffer.target}`} offer={pinOffer} onDismiss={() => setPinOffer(null)} />
        )}
        {restored && <RestoreToast key={restored.seq} report={restored.report} onDismiss={() => setRestored(null)} />}
        {trashed && (
          <TrashToast
            key={trashed.id}
            trashed={trashed}
            onRestored={(path) => {
              if (trashed.folder) setExpanded((e) => new Set([...e, ...ancestors(path), path]))
              else setOpenPath(path)
              setTrashed(null)
              void loadTree()
            }}
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
          {treeDialog?.kind === 'moveFolder' && <FolderMoveDialog path={treeDialog.path} initialParent={treeDialog.parent} onClose={closeTreeDialog} onMoved={folderMoved} onStarted={moveStarted} />}
          {treeDialog?.kind === 'toNewSpace' && (
            <MoveToNewSpaceDialog path={treeDialog.path} onClose={closeTreeDialog} onMoved={(root) => {
              const from = treeDialog.path
              folderPlaced(from, root)
            }} />
          )}
          {treeDialog?.kind === 'deleteFolder' && (
            <DeleteFolderDialog path={treeDialog.path} onClose={closeTreeDialog} onDeleted={(entries) => {
              const path = treeDialog.path
              closeTreeDialog()
              // What it held went to the trash: the notice offers it all back.
              if (entries.length) {
                if (openPath !== null && openPath.startsWith(`${path}/`)) setOpenPath(null)
                setTrashed({ id: entries[0]!.id, path, by: null, folder: entries.map((e) => e.id) })
              }
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'members' && <MembersDialog path={treeDialog.path} me={user} onClose={closeTreeDialog} onUnauthorized={onUnauthorized} />}
          {treeDialog?.kind === 'permissions' && (
            <PermissionsDialog folder={treeDialog.path} me={user} canOpen={canManageFolder} onClose={closeTreeDialog}
              onMoveTo={(target) => setTreeDialog(target === 'mine' ? { kind: 'moveFolder', path: treeDialog.path, parent: mine } : { kind: 'toNewSpace', path: treeDialog.path })}
              onChanged={() => void loadTree()} onAccessLost={closeTreeDialog} onUnauthorized={onUnauthorized} />
          )}
          {treeDialog?.kind === 'moveNote' && (
            <RenameDialog path={treeDialog.path} initialFolder={treeDialog.folder} onClose={closeTreeDialog} onMoved={(to, r) => noteMoved(treeDialog.path, to, r)} onStarted={moveStarted} />
          )}
          {treeDialog?.kind === 'newSpace' && (
            <NewSpaceDialog me={user.username} onClose={closeTreeDialog} onCreated={() => {
              closeTreeDialog()
              setSideTab('folders')
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'renameSpace' && (
            <RenameSpaceDialog path={treeDialog.section.root} name={treeDialog.section.name} onClose={closeTreeDialog} onRenamed={() => { closeTreeDialog(); void loadTree() }} />
          )}
          {treeDialog?.kind === 'leaveSpace' && (
            <LeaveSpaceDialog path={treeDialog.section.root} name={treeDialog.section.name} kind={treeDialog.section.kind === 'shared' ? 'shared' : 'received'} onClose={closeTreeDialog} onLeft={() => {
              const root = treeDialog.section.root
              closeTreeDialog()
              if (openPath?.startsWith(`${root}/`)) setOpenPath(null)
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'deleteSpace' && (
            <DeleteSpaceDialog space={treeDialog.space} notes={notesUnder(treeDialog.space.path)} onClose={closeTreeDialog} onDeleted={() => {
              const root = treeDialog.space.path
              closeTreeDialog()
              if (openPath?.startsWith(`${root}/`)) setOpenPath(null)
              void loadTree()
            }} />
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
          onNewFolder={newFolderIn === null ? null : () => setTreeDialog({ kind: 'newFolder', parent: newFolderIn })}
          onLanguage={(choice) => { setError(null); chooseLanguage(choice).catch(fail) }}
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
          onAgents={showAgents}
          onPrivacy={showPrivacy}
          onAccount={showAccount}
          onUsers={user.role === 'admin' ? showUsers : null}
          onSpaces={user.role === 'admin' ? showSpaces : null}
        />
      )}
    </div>
    </FolderPermissionsContext.Provider>
    </OpenNavContext.Provider>
    </OpenPaletteContext.Provider>
    </TimeZoneContext.Provider>
    </SpacesContext.Provider>
  )
}
