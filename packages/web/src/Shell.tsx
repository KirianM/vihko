// Main structure: folder tree and the note open in the editor.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Modal, ModalOverlay, Tab, TabList, TabPanel, Tabs, Tooltip, TooltipTrigger, type Key } from 'react-aria-components'
import { seriesNeighbors } from '@vihko/core/series'
import { ApiError, SESSION_ENDED_EVENT, api, atLeast, keysMadeHere, type FolderLock, type FolderMoveReport, type Level, type MoveJob, type MoveReport, type Note, type Profile, type SpaceEntry, type SpacesInfo, type TreeNote, type User, type WorkspaceInfo } from './api.ts'
import { TooLargeNote } from './TooLargeNote.tsx'
import { SpacesContext, notePathOf, rootOf, usePathLabels, useSpacesValue } from './spaces.tsx'
import { renamedPath } from './legacyAddress.ts'
import { openingNote } from './onOpen.ts'
import { HomePage } from './Home.tsx'
import { NoteSettingsDialog } from './NoteSettings.tsx'
import { ChooseSeriesDialog } from './ChooseSeries.tsx'
import { addressOf } from '@vihko/core/spaces'
import { SpaceSections, type Section, type SectionAction } from './Sidebar.tsx'
import { DeleteSpaceDialog, LeaveSpaceDialog, NewSpaceDialog, RenameSpaceDialog, SpaceDeletedToast, spaceError } from './SpaceDialogs.tsx'
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
import { BackContext, Brand, Crumbs, DismissGuardContext, FolderPermissionsContext, GoHomeContext, Icon, MenuButton, OpenNavContext, ThemeToggle } from './ui.tsx'
import { TrashToast, type Trashed } from './TrashToast.tsx'
import { RescueBanner } from './RescueBanner.tsx'
import { setRescueUser } from './editor/rescue.ts'
import { managesFolder, noteFolder } from './levels.ts'
import { PinOfferToast, type PinOffer } from './PinOffer.tsx'
import { TimeZoneToast, timeZoneOffer } from './TimeZoneOffer.tsx'
import { MoveToast, moveNotice } from './MoveToast.tsx'
import { MoveProgress, type JobEnd } from './MoveProgress.tsx'
import { shiftedNotice } from './Shifts.tsx'
import { OpenPaletteContext, Palette, SearchButton, type PaletteMode } from './Palette.tsx'
import { rememberNote } from './recent.ts'
import { MAC, WINDOWS, keys, modKTaken } from './keys.ts'
import { useBackClose, useMobile, useVisualViewport } from './mobile.ts'
import { PreferencesDialog, browserTimeZone } from './Preferences.tsx'
import { ancestors, buildTree, type FolderInfoOf, type Node, type TreeAction } from './FolderTree.tsx'
import { DeleteFolderDialog, FolderMoveDialog, MarkTemplatesDialog, MoveToNewSpaceDialog, NewFolderDialog } from './FolderDialogs.tsx'
import { RenameDialog, TrashDialog } from './editor/NoteActions.tsx'
import { TagsView } from './TagsView.tsx'
import type { RestoreReport } from './history/api.ts'
import { ChangesPage } from './history/Changes.tsx'
import { TrashPage } from './Trash.tsx'
import { HistoryIcon, RestoreToast, TimeZoneContext, useHistoryStatus, useVersions } from './history/ui.tsx'
import { VersionView } from './history/VersionView.tsx'

/** A dialog opened from the tree: its context menu or a drop. */
type TreeDialog =
  | { kind: 'newFolder'; parent: string }
  | { kind: 'moveFolder'; path: string; parent?: string }
  | { kind: 'toNewSpace'; path: string }
  | { kind: 'deleteFolder'; path: string }
  | { kind: 'markTemplates'; path: string }
  | { kind: 'permissions'; path: string }
  | { kind: 'members'; path: string }
  | { kind: 'moveNote'; path: string; folder?: string }
  | { kind: 'trashNote'; path: string }
  | { kind: 'newSpace' }
  | { kind: 'renameSpace'; section: Section }
  | { kind: 'leaveSpace'; section: Section }
  | { kind: 'deleteSpace'; space: SpaceEntry }
  | { kind: 'settings'; space: string | null; name: string | null }

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** Views that aren't a note, in the URL as `?view=` (no router). */
const VIEWS = ['alerts', 'changes', 'trash', 'agents', 'privacy', 'users', 'account', 'spaces'] as const
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
  /** Folders shown only as the way to what the person sees. */
  const [pathOnly, setPathOnly] = useState<Set<string>>(() => new Set())
  /** The person's level in each folder they see, and the folders' locks (the admin: every folder). Null until loaded. */
  const [locks, setLocks] = useState<Map<string, FolderLock> | null>(null)
  /** What the person reaches, space by space; null until loaded. */
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
  /** A tree dialog with unsaved changes asks before Escape or a press outside closes it (ui.tsx useDismissGuard). */
  const dismissGuard = useRef<(() => boolean) | null>(null)
  /** Where «New note here» creates the note; null = the open note's folder. */
  const [createIn, setCreateIn] = useState<string | null>(null)
  /** Your last folder move, if some link could not be rewritten. */
  const [folderIssue, setFolderIssue] = useState<FolderMoveReport | null>(null)
  const [alerts, setAlerts] = useState(0)
  /** Notices addressed to this person when they came in (M4.1): said at once, kept in «Alerts» until dismissed there. */
  const [arrived, setArrived] = useState<PersonalNotice[] | null>(null)
  // `?note=` is the note's address (never `people/` nor `spaces/`); one from before it is read too, and written back as an address below.
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
  /**
   * Where «Back» on a page (Account, Agents, Alerts…) goes: where
   * the person was when they left a note or Home for the pages; going from
   * one page to another keeps it. Null: Home.
   */
  const [returnTo, setReturnTo] = useState<{ path: string; version: string | null } | null>(null)
  /** Coming in with nothing asked for: «On opening» is being decided (Home isn't shown until it is). */
  const [opening, setOpening] = useState(() => openPath === null && view === null)
  const viewRef = useRef(view)
  viewRef.current = view
  const openPathRef = useRef(openPath)
  openPathRef.current = openPath
  const show = (v: View) => {
    setPrefsOpen(false)
    if (viewRef.current === null) setReturnTo(openPathRef.current ? { path: openPathRef.current, version: versionRef.current } : null)
    setOpenPathState(null)
    setVersion(null)
    setView(v)
  }
  const showAlerts = () => show('alerts')
  const showChanges = () => show('changes')
  const showTrash = () => show('trash')
  const showAgents = () => show('agents')
  const showPrivacy = () => show('privacy')
  const showUsers = () => show('users')
  const showAccount = () => show('account')
  const showSpaces = () => show('spaces')
  /** «Home»: nothing open, no page. The logo leads here. */
  const goHome = () => { setPrefsOpen(false); setNavOpen(false); setReturnTo(null); setOpenPath(null) }
  const goBack = () => {
    const to = returnTo
    setReturnTo(null)
    if (to) { setView(null); setOpenPathState(to.path); setVersion(to.version) } else setOpenPath(null)
  }
  const historyStatus = useHistoryStatus()
  const historyOn = historyStatus !== null && historyStatus.mode !== 'off'
  /** The note at `?note=` doesn't exist, but its version was asked for: shown on its own (restoring creates it again). */
  const [missing, setMissing] = useState<string | null>(null)
  const missingVersions = useVersions(missing, false)
  const [restored, setRestored] = useState<{ seq: number; report: RestoreReport } | null>(null)
  const restoredDone = (report: RestoreReport) => { setVersion(null); setRestored((r) => ({ seq: (r?.seq ?? 0) + 1, report })) }
  const [ready, setReady] = useState<string | null>(null)
  /** What the person may do in the note that's ready, as the server said when it was checked: its editor starts at that. */
  const [readyLevel, setReadyLevel] = useState<Level | null>(null)
  /** The open note went where the person can't follow (moved where they can't open it, or gone on reconnecting). */
  const [goneAway, setGoneAway] = useState<{ path: string; why: 'movedAway' | 'gone' } | null>(null)
  // What the person typed that didn't reach a note is theirs only (rescue.ts).
  setRescueUser(user.id)
  /** The open note, when it's too large to edit live: shown as plain text, with a download. */
  const [large, setLarge] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<Trashed | null>(null)
  /**
   * Someone else put the open note in the trash: «Restore» only when this
   * person may (its entry is in their trash), and the space it was in, when
   * it was deleted with it: never a «Restore» that fails.
   */
  const othersTrash = async (t: Trashed) => {
    const [entries, now] = await Promise.all([api.trashEntries().catch(() => null), api.spaces().catch(() => null)])
    if (entries === null) return
    const root = rootOf(t.path)
    // Deleted with its space: it comes back with the space, whole («Restore space» in the notice), never on its own here.
    const spaceGone = now !== null && root !== null && root.startsWith('spaces/') && !now.spaces.some((s) => s.path === root) && !now.shared.some((s) => t.path.startsWith(`${s.path}/`))
    const restorable = !spaceGone && entries.some((e) => e.id === t.id)
    setTrashed((cur) => (cur?.id === t.id ? { ...cur, restorable, spaceGone } : cur))
  }
  /** A shared space this person just deleted: «Undo» brings it back whole. */
  const [spaceDeleted, setSpaceDeleted] = useState<{ deleted: string; name: string } | null>(null)
  /** You opened one of an ambiguous link's candidates: pin the link there? */
  const [pinOffer, setPinOffer] = useState<PinOffer | null>(null)
  /** The browser's timezone, offered once instead of the profile's (someone travelling). */
  const [zoneOffer, setZoneOffer] = useState<{ saved: string; browser: string } | null>(null)
  /** Your last rename or move, if some link could not be rewritten. */
  const [moveIssue, setMoveIssue] = useState<MoveReport | null>(null)
  /** The open note was moved by another tool and followed its file; `links`: left behind (null until known). */
  const [outsideMove, setOutsideMove] = useState<{ from: string; to: string; links: number | null } | null>(null)
  /** Your move whose links are still being rewritten, and what went wrong following it. */
  const [moveJob, setMoveJob] = useState<MoveJob | null>(null)
  const [jobIssue, setJobIssue] = useState<string | null>(null)
  const [palette, setPalette] = useState<PaletteMode | null>(null)
  const mobile = useMobile()
  // On a phone too, vihko opens at Home: the tree is behind the menu button.
  const [navOpen, setNavOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<Key>>(() => new Set(openPath ? ancestors(openPath) : []))
  useBackClose(mobile && navOpen, () => setNavOpen(false))
  useVisualViewport(mobile)
  /** vihko.yaml as the server has it now: daily-note series. */
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  /** «Today's note» asks which series to use: the one chosen is gone. */
  const [choosingSeries, setChoosingSeries] = useState(false)

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

  /** The notices already said (the toast): one that arrives later, live, is said once. */
  const seenNotices = useRef<Set<string>>(new Set())
  const loadNotices = () => api.alerts().then((a) => {
    setAlerts(a.length)
    const fresh = a.filter(isPersonalNotice).filter((n) => !seenNotices.current.has(n.id))
    for (const n of fresh) seenNotices.current.add(n.id)
    // What this person just did themselves stays in the notices, without a toast over it
    // (deleting a space has its own «Undo»; a key made here was just shown to them).
    const own = (n: (typeof fresh)[number]) => (n.code === 'space_deleted' && n.by === user.username)
      || (n.code === 'account_key_added' && n.kind === 'key' && keysMadeHere.has(n.name))
    const mine = fresh.filter((n) => !own(n))
    if (!mine.length) return
    setArrived(mine)
    // On a phone the tree starts open over everything: the notice goes first.
    setNavOpen(false)
  }).catch(() => {})

  useEffect(() => {
    void loadTree()
    void loadNotices()
    void loadWorkspace()
    const startedEmpty = !openPath && !view
    api.profile().then(async (p) => {
      // First sign-in: the browser's timezone becomes the person's (editable in Preferences).
      if (!p.timezone) p = await api.updateProfile({ timezone: browserTimeZone() }).catch(() => p)
      setProfile(p)
      // Afterwards, a browser somewhere else is offered once (TimeZoneOffer.tsx); never changed by itself.
      const browser = timeZoneOffer(p.timezone)
      if (browser && p.timezone) setZoneOffer({ saved: p.timezone, browser })
      // «On opening», when nothing else was asked for: a note only if it exists and they
      // read it (today's is never created on coming in: no empty notes); otherwise Home stays.
      if (!startedEmpty) return
      const target = await openingNote(p).catch(() => null)
      if (target) setOpenPathState((current) => current ?? target)
      setOpening(false)
    }).catch(() => {}).finally(() => setOpening(false))
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
      // The series they chose is gone: they choose again, never another one by itself.
      if (err instanceof ApiError && err.code === 'series_gone') {
        void loadWorkspace()
        setChoosingSeries(true)
        return
      }
      fail(err)
    }
  }
  const todayRef = useRef<(() => void) | null>(null)
  todayRef.current = dailyOn ? () => void openToday() : null

  // The tree and the sidebar, live: the server says «read your tree again» when someone
  // else's change concerns what this person sees (GET /api/live). The browser reconnects by itself.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const events = new EventSource('/api/live')
    let timer: ReturnType<typeof setTimeout> | null = null
    events.addEventListener('tree', () => {
      if (timer) return
      timer = setTimeout(() => { timer = null; void loadTree() }, 150)
    })
    // A notice arrived for this person (what someone did to their account or their spaces): said at once.
    events.addEventListener('notices', () => { void loadNotices() })
    return () => { if (timer) clearTimeout(timer); events.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    setLarge(null)
    // Check that it exists before opening co-editing: the hub rejects notes that don't exist.
    setGoneAway(null)
    // One too large to edit live (vihko.yaml `notes.maxSize`) shows as plain text instead.
    api.note(openPath).then((n) => { setReadyLevel(n.level ?? null); if (n.tooLarge) setLarge(n); else setReady(openPath); rememberNote(openPath) }).catch((err) => {
      // Moved again a moment ago, while its editor reopened it at the last place it heard of: follow it.
      if (err instanceof ApiError && err.code === 'not_found' && typeof err.data?.movedTo === 'string') return setOpenPathState(err.data.movedTo)
      if (versionRef.current && err instanceof ApiError && err.code === 'not_found') setMissing(openPath)
      // Neither missing nor someone else's is told apart: nobody learns what exists by asking.
      else if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) setNoAccess(openPath)
      else fail(err)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath])

  // An address of a shared space from 0.1.0-rc.1 or rc.2 (`casa-7k2q9x/…`): the space it was renamed to when spaces lost their ids.
  useEffect(() => {
    if (!noAccess || noAccess !== openPath || !spaces) return
    const to = renamedPath(noAccess, spaces)
    if (to) setOpenPathState(to)
  }, [noAccess, openPath, spaces])

  /** Shows a folder or space in the sidebar (Home's «Shared with you»): its folders open; on a phone, the drawer. */
  const reveal = (path: string) => {
    setSideTab('folders')
    setExpanded((e) => new Set([...e, ...ancestors(`${path}/_`)]))
    if (mobile) setNavOpen(true)
  }

  const tree = useMemo(() => (notes ? buildTree(notes, folders) : []), [notes, folders])
  const admin = user.role === 'admin'
  /** The main area holds the open note (and the rescue banner goes under its header), as the render below decides. */
  const pageShown = view === 'alerts' || view === 'agents' || view === 'privacy' || view === 'account' || view === 'changes' || view === 'trash' || ((view === 'users' || view === 'spaces') && admin)
  const noteShown = !pageShown && !!openPath && ready === openPath && !(version && missing === openPath)
  /** The person's level and a folder's marks, for the tree's actions and locks. */
  const folderInfo = useMemo<FolderInfoOf>(() => (path) => {
    if (!locks) return undefined
    const l = locks.get(path)
    return { level: l?.level ?? null, canEdit: l?.canEdit ?? false, own: l?.ownGrants ?? false, ai: l?.aiClosed ?? false, pathOnly: pathOnly.has(path) }
  }, [locks, pathOnly])
  /** Whether this person may open who a folder is shared with: where they manage it (the admin role counts for nothing: the admin manages, not reads). */
  const canManageFolder = (folder: string) => !!locks?.get(folder)?.canEdit
  /** Nowhere to write: no «New note» (read-only mode signals). Their own space always is. */
  const editsSomewhere = !locks || !!spaces?.personal || [...locks.values()].some((l) => atLeast(l.level, 'edit'))
  // The header's way to share a note's folder (only once the levels are known), never the root of one's own space.
  const folderPermissions = useMemo(() => (locks ? {
    can: (folder: string) => !!locks.get(folder)?.canEdit && folder !== spaces?.personal?.path,
    open: (folder: string) => setTreeDialog({ kind: 'permissions', path: folder }),
  } : null), [locks, spaces])
  // Template notes: those marked `template: true` that the person reads, wherever they are (the tree marks them).
  const templates = useMemo(() => {
    if (!notes) return []
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    return notes.filter((n) => n.template).map((n) => n.path).sort(collator.compare)
  }, [notes])
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
  /** Where things are created: the open note's folder, else the root of the person's own space (never the notes root). */
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
    // To one's own space: the move of always, its destination there.
    else if (action === 'toMine') setTreeDialog({ kind: 'moveFolder', path: node.path, parent: mine })
    else if (action === 'deleteFolder') setTreeDialog({ kind: 'deleteFolder', path: node.path })
    else if (action === 'permissions') setTreeDialog({ kind: 'permissions', path: node.path })
    else if (action === 'markTemplates') setTreeDialog({ kind: 'markTemplates', path: node.path })
    else if (action === 'moveNote') setTreeDialog({ kind: 'moveNote', path: node.path })
    // A template or not: only its `template: true` changes; the tree marks it.
    else if (action === 'makeTemplate' || action === 'stopTemplate') {
      setSpaceIssue(null)
      api.markTemplate(node.path, action === 'makeTemplate').then(() => loadTree(), (err) => setSpaceIssue(errorText(t, err)))
    }
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
      // Between sections of the sidebar is between spaces: always through the dialog.
      if (rootOf(path) !== rootOf(to)) return setTreeDialog(key.startsWith('n:') ? { kind: 'moveNote', path, folder } : { kind: 'moveFolder', path, parent: folder })
      if (key.startsWith('n:')) {
        const preview = await api.move(path, to, true)
        if (preview.relinked.length || preview.shifted.length || preview.images.moved.length || preview.images.stayed.length || preview.images.copied?.length || preview.images.folder || preview.images.failed.length || audienceChanges(preview.audience)) return setTreeDialog({ kind: 'moveNote', path, folder })
        noteMoved(path, to, await api.move(path, to))
      } else {
        const preview = await api.moveFolder(path, to, true)
        // Who sees it changes: never in silence, the dialog asks.
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
    // Managers change who's in; every other member only sees it.
    else if ((action === 'members' && s.level === 'manage') || action === 'share' || action === 'agents') setTreeDialog({ kind: 'permissions', path: s.root })
    else if (action === 'members' || action === 'access') setTreeDialog({ kind: 'members', path: s.root })
    else if (action === 'rename') setTreeDialog({ kind: 'renameSpace', section: s })
    else if (action === 'settings') setTreeDialog({ kind: 'settings', space: s.kind === 'shared' ? s.root : null, name: s.kind === 'shared' ? s.name : null })
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
  const trashLink = (
    <a className="sidebar-link" href="?view=trash" aria-current={view === 'trash' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setNavOpen(false); showTrash() }}>
      {Icon.trash}<span>{t('trash.link')}</span>
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
    <GoHomeContext.Provider value={goHome}>
    <BackContext.Provider value={view !== null ? goBack : null}>
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
                {trashLink}
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
            {/* Icons only: each says what it is on hover and focus, with its shortcut, under the name it has everywhere else. */}
            {dailyOn && (
              <TooltipTrigger delay={400} closeDelay={0}>
                <Button className="btn btn-icon" aria-label={t('shell.today')} aria-keyshortcuts={MAC ? 'Meta+Alt+D' : 'Control+Alt+D'} onPress={() => void openToday()}>{Icon.calendar}</Button>
                <Tooltip className="tip" placement="bottom" offset={6}>{t('format.withKeys', { label: t('shell.today'), keys: keys('Mod-Alt-d') })}</Tooltip>
              </TooltipTrigger>
            )}
            {editsSomewhere && (
              <TooltipTrigger delay={400} closeDelay={0}>
                <Button className="btn btn-icon" aria-label={t('shell.newNote')} onPress={() => setPalette('create')}>{Icon.plus}</Button>
                <Tooltip className="tip" placement="bottom" offset={6}>{t('shell.newNote')}</Tooltip>
              </TooltipTrigger>
            )}
          </div>
          <Button className="btn sidebar-search" onPress={() => setPalette('search')}>
            {Icon.search}<span>{t('shell.search')}</span><kbd>⌘K</kbd>
          </Button>
          {treeView}
          {changesLink}
          {trashLink}
          {alertsLink}
          {userRow}
        </nav>
      )}
      <main className="main">
        {/* Over the note, under its header (NoteView); anywhere else, first. */}
        {!noteShown && <RescueBanner user={user} onCreated={created} />}
        {view === 'alerts' ? (
          <AlertsPage
            onOpen={setOpenPath}
            onSpaces={showSpaces}
            onSettings={(space) => setTreeDialog({ kind: 'settings', space: space?.path ?? null, name: space?.name ?? null })}
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
        ) : view === 'trash' ? (
          <TrashPage onOpen={setOpenPath} onChanged={() => void loadTree()} onUnauthorized={onUnauthorized} />
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
              onRestored={(report) => { restoredDone(report); setMissing(null); setReady(openPath); rememberNote(openPath); void loadTree() }}
              onOpen={(p) => { setVersion(null); setOpenPath(p); void loadTree() }} />
          </>
        ) : openPath && large?.path === openPath ? (
          <>
            <header className="main-head">
              <MenuButton />
              <Crumbs path={openPath} />
              <span className="spacer" />
              <SearchButton />
              <ThemeToggle />
            </header>
            <TooLargeNote note={large} />
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
              onTrashed={(t) => { setOpenPath(null); setTrashed(t); void loadTree(); if (t.by !== null) void othersTrash(t) }}
              onGone={(why) => { const from = openPath; setOpenPath(null); setGoneAway({ path: from, why }); void loadTree() }}
              initialLevel={readyLevel}
              rescue={<RescueBanner user={user} onCreated={created} />}
              templates={templates}
              onCreated={created}
              onPickCandidate={(offer) => { setPinOffer(offer); setOpenPath(offer.target) }}
              history={historyStatus}
              version={version}
              onVersion={setVersion}
              onRestored={restoredDone}
            />
          </Suspense>
        ) : !openPath && !opening ? (
          <HomePage
            user={user}
            refresh={notes}
            onOpen={setOpenPath}
            onReveal={reveal}
            onNewNote={editsSomewhere ? () => { setCreateIn(mine); setPalette('create') } : null}
            onToday={dailyOn ? () => void openToday() : null}
            onSearch={() => setPalette('search')}
            onNewSpace={spaces?.canCreate ? () => setTreeDialog({ kind: 'newSpace' }) : null}
            onUnauthorized={onUnauthorized}
          />
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
              {!openPath && !error && <p className="empty">{t('common.loading')}</p>}
            </div>
          </>
        )}
        {/* The toasts, one above the other: a notice that comes in live never covers another. */}
        <div className="toasts">
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
          {zoneOffer && (
            <TimeZoneToast saved={zoneOffer.saved} browser={zoneOffer.browser} onChanged={(p) => { setProfile(p); setZoneOffer(null) }} onDismiss={() => setZoneOffer(null)} />
          )}
          {pinOffer && pinOffer.target === openPath && (
            <PinOfferToast key={`${pinOffer.source}#${pinOffer.raw}#${pinOffer.target}`} offer={pinOffer} onDismiss={() => setPinOffer(null)} />
          )}
          {restored && <RestoreToast key={restored.seq} report={restored.report} onDismiss={() => setRestored(null)} />}
          {spaceDeleted && (
            <SpaceDeletedToast key={spaceDeleted.deleted} deleted={spaceDeleted.deleted} name={spaceDeleted.name}
              onRestored={(root) => { setSpaceDeleted(null); setSideTab('folders'); setExpanded((e) => new Set([...e, root])); void loadTree() }}
              onDismiss={() => setSpaceDeleted(null)} />
          )}
          {goneAway && !openPath && (
            <div className="toast toast-warn">
              <span className="toast-icon">{Icon.alert}</span>
              <span className="toast-text" role="alert">{t(goneAway.why === 'movedAway' ? 'note.movedAway' : 'note.goneAway', { name: baseName(goneAway.path).replace(/\.md$/i, '') })}</span>
              <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={() => setGoneAway(null)}>{Icon.close}</Button>
            </div>
          )}
          {trashed && (
            <TrashToast
              key={trashed.id}
              trashed={trashed}
              canPurge={historyStatus?.mode === 'managed' && (admin || managesFolder((f) => locks?.get(f)?.level, noteFolder(trashed.path)))}
              onRestored={(path) => {
                if (trashed.folder) setExpanded((e) => new Set([...e, ...ancestors(path), path]))
                else setOpenPath(path)
                setTrashed(null)
                void loadTree()
              }}
              onDismiss={() => setTrashed(null)}
            />
          )}
        </div>
      </main>
      <DismissGuardContext.Provider value={dismissGuard}>
      <ModalOverlay className="modal-overlay" isOpen={treeDialog !== null} onOpenChange={(o) => { if (!o && !dismissGuard.current?.()) closeTreeDialog() }} isDismissable>
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
          {treeDialog?.kind === 'markTemplates' && (
            <MarkTemplatesDialog path={treeDialog.path} onClose={closeTreeDialog} onDone={() => {
              closeTreeDialog()
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'members' && <MembersDialog path={treeDialog.path} me={user} onClose={closeTreeDialog} onUnauthorized={onUnauthorized} />}
          {treeDialog?.kind === 'permissions' && (
            <PermissionsDialog folder={treeDialog.path} me={user} canOpen={canManageFolder} onClose={closeTreeDialog}
              onMoveTo={(target) => setTreeDialog(target === 'mine' ? { kind: 'moveFolder', path: treeDialog.path, parent: mine } : { kind: 'toNewSpace', path: treeDialog.path })}
              onLeave={(kind, name) => setTreeDialog({ kind: 'leaveSpace', section: { root: treeDialog.path, kind, name, detail: null, level: 'manage' } })}
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
            <RenameSpaceDialog path={treeDialog.section.root} name={treeDialog.section.name} onClose={closeTreeDialog} onRenamed={(space) => folderPlaced(treeDialog.section.root, space.path)} />
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
            <DeleteSpaceDialog space={treeDialog.space} notes={notesUnder(treeDialog.space.path)} onClose={closeTreeDialog} onDeleted={(deleted) => {
              const root = treeDialog.space.path
              closeTreeDialog()
              if (openPath?.startsWith(`${root}/`)) setOpenPath(null)
              // «Undo», right away: the space back whole.
              setSpaceDeleted({ deleted, name: treeDialog.space.name })
              void loadTree()
            }} />
          )}
          {treeDialog?.kind === 'settings' && (
            <NoteSettingsDialog space={treeDialog.space} name={treeDialog.name} onClose={closeTreeDialog} onSaved={() => { closeTreeDialog(); void loadWorkspace() }} />
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
      </DismissGuardContext.Provider>
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
      {choosingSeries && workspace && (
        <ChooseSeriesDialog
          series={workspace.daily}
          first={profile?.dailySeries == null}
          onClose={() => setChoosingSeries(false)}
          onChosen={(p) => { setProfile(p); setChoosingSeries(false); void openToday() }}
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
          onNoteSettings={() => { setPrefsOpen(false); setTreeDialog({ kind: 'settings', space: null, name: null }) }}
        />
      )}
    </div>
    </FolderPermissionsContext.Provider>
    </BackContext.Provider>
    </GoHomeContext.Provider>
    </OpenNavContext.Provider>
    </OpenPaletteContext.Provider>
    </TimeZoneContext.Provider>
    </SpacesContext.Provider>
  )
}
