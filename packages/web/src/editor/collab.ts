// Co-editing session for a note: a Yjs document synced with the hub over
// /collab. The file is still the source of truth; the hub says whenever the text
// reaches the disk (`vihko:saved`), when the note is deleted outside vihko,
// when anyone moves or trashes it from vihko and when it was moved outside
// vihko and the hub followed it, when it can't be saved (and when it can
// again), and when this session ended (then the application signs out).
// When the person's access to the note changes while it's open, the hub says
// what they have now and closes it: it's opened again at once with that
// (read-only below `edit`), or, with no access left, not at all. If the hub
// refuses the tab's copy on a reconnection (another document generation, see
// lineage.ts), the session moves to the hub's document.
//
// What the tab typed and the hub never got is never dropped in silence
// (rescue.ts): written where the note went when that can be done safely,
// otherwise kept for the person to save as a copy. A copy with changes still
// unsent when the note is closed stays open until they're sent.
import { HocuspocusProviderWebsocket, type HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type * as Y from 'yjs'
import { NoteLink, TEXT, type Lineage, type SetAside } from './lineage.ts'
import { ApiError, SESSION_ENDED_EVENT, api } from '../api.ts'
import { addRescue, carryTo, settleCarry, takeCarry, trackUnsent, type RescueWhy } from './rescue.ts'

export { TEXT, type SetAside }
const SAVED = 'vihko:saved'
const ORPHANED = 'vihko:deleted-externally'
const ORPHAN_RESOLVED = 'vihko:orphan-resolved'
const MOVED = 'vihko:moved'
const TRASHED = 'vihko:trashed'
const SESSION_ENDED = 'vihko:session-ended'
const ACCESS = 'vihko:access'
const STALE = 'vihko:stale-generation'
const SAVE_FAILED = 'vihko:save-failed'
const SAVE_RESUMED = 'vihko:save-resumed'
const NAME_REFUSED = 'vihko:name-refused'

/** What the hub says a person may do in the note now: `none` means it's gone for them. */
export type HubAccess = 'none' | 'read' | 'comment' | 'edit'
/** The level an editor shows the note at, as its token claims it (lineage.ts `Claim`). */
export type ClaimedLevel = 'edit' | 'comment' | 'read'
/** Why vihko can't save the note right now. */
export type SaveFailure = 'disk_full' | 'write_denied' | 'write_failed'

interface HubMessage {
  type?: string; etag?: string; to?: string | null; text?: string; external?: boolean; id?: string; by?: string; action?: string; access?: string; reason?: string; aliases?: unknown
}

/** A single WebSocket for the whole application; each open note is a document over it. */
let socket: HocuspocusProviderWebsocket | null = null
function sharedSocket() {
  if (socket) return socket
  socket = new HocuspocusProviderWebsocket({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
  })
  // A connection that keeps failing may be a session that ended meanwhile (the hub turns it away
  // before any message could say so): asked over HTTP, which says it.
  socket.on('disconnect', () => void probeSession())
  return socket
}

/** Each copy of a note open in this tab (or still sending), to keep what it hasn't sent when the session ends. */
const sessionEnders = new Set<(why: RescueWhy) => void>()
let ending = false
/** The session ended: what every copy hadn't sent is kept for the person to decide once they're back, and the application signs out. */
function sessionEnded() {
  if (ending) return
  ending = true
  for (const end of [...sessionEnders]) end('session')
  window.dispatchEvent(new Event(SESSION_ENDED_EVENT))
  setTimeout(() => { ending = false }, 1000)
}

let probing = 0
async function probeSession() {
  const now = Date.now()
  if (now - probing < 3000 || sessionEnders.size === 0) return
  probing = now
  try {
    await api.me()
  } catch (err) {
    // Offline: nothing to learn yet. A 401: the session is over.
    if (err instanceof ApiError && err.status === 401) sessionEnded()
  }
}

export type Connection = 'connecting' | 'online' | 'offline'
/** `saved`: what you see is what's in the file. `saving`: there are changes not yet flushed. */
export type SaveState = 'saved' | 'saving'

export interface Session {
  doc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
  /** The note it edits. */
  path: string
}

export interface CollabState {
  session: Session | null
  connection: Connection
  save: SaveState
  orphaned: boolean
  /** The note was moved to this path: reopen it there. `outside`: by another tool, and the hub followed it. */
  moved: { to: string; outside: boolean } | null
  /** The note was moved to the trash: the entry and who did it. */
  trashed: { id: string; by: string } | null
  /**
   * The note is no longer where this tab had it, and the hub won't say
   * where: moved somewhere the person can't open (`movedAway`), or found
   * gone on reconnecting (`gone`: deleted, moved, or no longer theirs).
   */
  gone: 'movedAway' | 'gone' | null
  /** What the hub last said this person may do in the note, when it changed while open (null: nothing said). */
  access: HubAccess | null
  /** vihko can't save the note right now: read-only for everyone, until it can. */
  cantSave: SaveFailure | null
  /** Aliases this person typed that aren't available here: vihko took them out of the note (null: none). */
  nameRefused: string[] | null
}

/** `sha256:<hex>`, same as the server's `contentHash`. */
async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** How many times in a row a note the server says is there may be refused by the hub before it's taken as gone. */
const MAX_REFUSALS = 3

/**
 * The note's co-editing session. `claim`: the level the editor shows it at
 * (null while unknown), told to the hub on every (re)connection.
 */
export function useCollab(path: string, claim: RefObject<ClaimedLevel | null>): CollabState {
  const [state, setState] = useState<CollabState>(() => ({
    session: null, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null, gone: null, access: null, cantSave: null, nameRefused: null,
  }))
  // Each reopening after an access change is a new session.
  const [opening, setOpening] = useState(0)
  /** What the hub said last about the person's level here: it's what the editor shows until the server is asked again. */
  const heard = useRef<ClaimedLevel | null>(null)
  const refusals = useRef(0)

  // Another note: nothing said about it yet.
  useEffect(() => {
    heard.current = null
    refusals.current = 0
    setState((s) => ({ ...s, access: null }))
  }, [path])

  useEffect(() => {
    const set = (patch: Partial<CollabState>) => setState((s) => ({ ...s, ...patch }))
    set({ session: null, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null, gone: null, cantSave: null, nameRefused: null })
    // The hub closed the document on its side (moved, trashed, copy discarded, refused).
    let closedByHub = false
    let live = true
    /** What the current copy hadn't sent is kept as a rescue (once). */
    let rescued = false
    const keep = (l: Lineage, why: RescueWhy) => {
      if (rescued || !l.unsent()) return
      rescued = true
      addRescue({ path, text: l.text.toString(), why })
    }

    const wire = (l: Lineage) => {
      const { doc, text, provider } = l
      set({ session: { doc, text, provider, path }, connection: 'connecting', save: 'saved' })
      // Save state: on open, what arrives from the hub is what's on disk. After any
      // change (yours or someone else's), "saved" only once the hub announces the hash of the current text.
      let savedHash: string | null = null
      let synced = false
      let dirty = false
      let check = 0
      const recheck = async () => {
        const n = ++check
        if (!dirty) return set({ save: 'saved' })
        const h = await contentHash(text.toString())
        if (n === check) set({ save: h === savedHash ? 'saved' : 'saving' })
      }
      doc.on('update', () => {
        if (synced) dirty = true
        void recheck()
      })

      provider.on('synced', () => {
        if (!synced) {
          refusals.current = 0
          // What a copy of this note typed before it moved here or reopened: written now if it can be.
          const carried = takeCarry(path)
          if (carried) settleCarry(carried, text, provider.authorizedScope === 'read-write')
        }
        synced = true
        set({ connection: 'online' })
      })
      provider.on('status', ({ status }: { status: string }) => {
        if (status === 'disconnected') set({ connection: 'offline' })
        else if (status === 'connected' && provider.isSynced) set({ connection: 'online' })
      })
      provider.on('authenticationFailed', () => { if (l === link.lineage) void refused(l) })
      provider.on('stateless', ({ payload }: { payload: string }) => {
        let msg: HubMessage
        try { msg = JSON.parse(payload) } catch { return }
        if (msg.type === SAVED && msg.etag) { savedHash = msg.etag; void recheck() }
        else if (msg.type === ORPHANED) set({ orphaned: true })
        else if (msg.type === ORPHAN_RESOLVED) { if (msg.action === 'discard') closedByHub = true; set({ orphaned: false }) }
        else if (msg.type === MOVED) {
          closedByHub = true
          const mine = text.toString()
          if (msg.to) {
            // What it typed that the hub didn't have when it closed the note here goes with it.
            if (l.unsent() && msg.text !== mine) carryTo(msg.to, { from: path, mine, base: typeof msg.text === 'string' ? msg.text : null, why: 'moved' })
            set({ moved: { to: msg.to, outside: msg.external === true } })
          } else {
            keep(l, 'movedAway')
            set({ gone: 'movedAway' })
          }
        } else if (msg.type === TRASHED && msg.id) {
          closedByHub = true
          keep(l, 'trashed')
          set({ trashed: { id: msg.id, by: msg.by ?? '' } })
        } else if (msg.type === SESSION_ENDED) sessionEnded()
        else if (msg.type === ACCESS && typeof msg.access === 'string') {
          // The hub closes it right after: opened again with what the person has now, unless that's nothing.
          const access = msg.access as HubAccess
          closedByHub = true
          heard.current = access === 'none' ? null : access
          if (access === 'none') keep(l, 'gone')
          // Read-only now: what it hadn't sent can't go in; whether it's missing is seen once reopened.
          else if (l.unsent()) carryTo(path, { from: path, mine: text.toString(), base: null, why: access === 'edit' ? 'refused' : 'readOnly' })
          set({ access })
          if (access !== 'none') setOpening((n) => n + 1)
        } else if (msg.type === SAVE_FAILED) set({ cantSave: (msg.reason as SaveFailure | undefined) ?? 'write_failed' })
        else if (msg.type === NAME_REFUSED && Array.isArray(msg.aliases)) set({ nameRefused: msg.aliases.filter((a): a is string => typeof a === 'string') })
        else if (msg.type === SAVE_RESUMED) {
          set({ cantSave: null })
          // Something typed as it turned read-only was dropped: sent again.
          if (l.unsent()) provider.forceSync()
        }
      })
    }

    /**
     * The hub turned this copy away on reconnecting (the note isn't there
     * any more, or not for this person): the server says where it is, if
     * vihko moved it a moment ago; what the copy hadn't sent goes along to be
     * written there, or is kept.
     */
    const refused = async (l: Lineage) => {
      if (closedByHub) return
      closedByHub = true
      const mine = l.text.toString()
      const unsent = l.unsent()
      let to: string | null = null
      let there = false
      try {
        await api.note(path)
        there = true
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return sessionEnded()
        if (err instanceof ApiError && err.code === 'not_found' && typeof err.data?.movedTo === 'string') to = err.data.movedTo
        else if (!(err instanceof ApiError && err.code === 'not_found')) there = true // can't tell yet: tried again
      }
      if (!live) {
        if (unsent && !rescued) addRescue({ path, text: mine, why: 'gone' })
        return
      }
      if (to !== null) {
        if (unsent) carryTo(to, { from: path, mine, base: null, why: 'moved' })
        return set({ moved: { to, outside: false } })
      }
      if (there && ++refusals.current <= MAX_REFUSALS) {
        if (unsent) carryTo(path, { from: path, mine, base: null, why: 'refused' })
        // Once the hub is done with whatever kept it (a document being closed), it opens again.
        setTimeout(() => { if (live) setOpening((n) => n + 1) }, 1000 * refusals.current)
        return
      }
      keep(l, 'gone')
      set({ gone: 'gone' })
    }

    const link = new NoteLink(sharedSocket(), path, {
      onLineage: wire,
      onSetAside: (s) => addRescue({ path, text: s.text, why: 'refused' }),
    }, () => heard.current ?? claim.current)
    const untrack = trackUnsent(() => !rescued && link.lineage.unsent())
    const onSessionEnd = (why: RescueWhy) => { closedByHub = true; keep(link.lineage, why) }
    sessionEnders.add(onSessionEnd)

    return () => {
      live = false
      untrack()
      sessionEnders.delete(onSessionEnd)
      // After a move, a trash or a discarded orphan copy, the hub closes the
      // document on its side: the provider leaves the shared socket without
      // sending a close, which Hocuspocus would queue and apply to a later opening.
      if (closedByHub || rescued || !link.lineage.unsent()) return link.destroy(closedByHub)
      // Closed with changes the hub hasn't acknowledged: they go on being sent.
      drain(link, path)
    }
  }, [path, opening]) // eslint-disable-line react-hooks/exhaustive-deps

  return state
}

/**
 * A copy closed (another note opened, a reopening) while it had changes the
 * hub hadn't acknowledged: it stays connected until they are, and is
 * destroyed then. If the hub turns it away first, what it hadn't sent is
 * kept for the person to decide (`addRescue`).
 */
function drain(link: NoteLink, path: string) {
  const l = link.hold()
  let done = false
  const finish = (why: RescueWhy | null, quiet: boolean) => {
    if (done) return
    done = true
    if (why && l.unsent()) addRescue({ path, text: l.text.toString(), why })
    untrack()
    sessionEnders.delete(onSessionEnd)
    l.destroy(quiet)
  }
  const onSessionEnd = (why: RescueWhy) => finish(why, true)
  const untrack = trackUnsent(() => !done && l.unsent())
  sessionEnders.add(onSessionEnd)
  l.provider.on('unsyncedChanges', () => { if (!l.unsent()) finish(null, false) })
  l.provider.on('authenticationFailed', () => finish('gone', true))
  l.provider.on('stateless', ({ payload }: { payload: string }) => {
    let msg: HubMessage
    try { msg = JSON.parse(payload) } catch { return }
    if (msg.type === MOVED) finish(typeof msg.text === 'string' && msg.text === l.text.toString() ? null : msg.to ? 'moved' : 'movedAway', true)
    else if (msg.type === TRASHED) finish('trashed', true)
    else if (msg.type === ACCESS) finish(msg.access === 'none' ? 'gone' : 'readOnly', true)
    else if (msg.type === STALE) finish('refused', true)
    else if (msg.type === SESSION_ENDED) sessionEnded()
  })
}
