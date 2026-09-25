// Co-editing session for a note: a Yjs document synced with the hub over
// /collab. The file is still the source of truth; the hub says whenever the text
// reaches the disk (`thoth:saved`), when the note is deleted outside thoth
// and when anyone moves or trashes it from thoth. If the hub refuses the tab's
// copy on a reconnection (another document generation, see lineage.ts), the
// session moves to the hub's document and what hadn't been sent is set aside.
import { HocuspocusProviderWebsocket, type HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { NoteLink, TEXT, type Lineage, type SetAside } from './lineage.ts'

export { TEXT, type SetAside }
const SAVED = 'thoth:saved'
const ORPHANED = 'thoth:deleted-externally'
const ORPHAN_RESOLVED = 'thoth:orphan-resolved'
const MOVED = 'thoth:moved'
const TRASHED = 'thoth:trashed'

/** A single WebSocket for the whole application; each open note is a document over it. */
let socket: HocuspocusProviderWebsocket | null = null
function sharedSocket() {
  socket ??= new HocuspocusProviderWebsocket({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
  })
  return socket
}

export type Connection = 'connecting' | 'online' | 'offline'
/** `saved`: what you see is what's in the file. `saving`: there are changes not yet flushed. */
export type SaveState = 'saved' | 'saving'

export interface Session {
  doc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
}

export interface CollabState {
  session: Session | null
  connection: Connection
  save: SaveState
  orphaned: boolean
  /** The note was moved to this path: reopen it there. */
  moved: string | null
  /** The note was moved to the trash: the entry and who did it. */
  trashed: { id: string; by: string } | null
  /** The hub refused this tab's copy and it had changes that never arrived: the text to keep aside. */
  setAside: SetAside | null
  /** Forgets the text set aside (kept as a copy, or discarded). */
  clearSetAside: () => void
}

/** `sha256:<hex>`, same as the server's `contentHash`. */
async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useCollab(path: string): CollabState {
  const [state, setState] = useState<CollabState>(() => ({
    session: null, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null, setAside: null,
    clearSetAside: () => setState((s) => ({ ...s, setAside: null })),
  }))

  useEffect(() => {
    const set = (patch: Partial<CollabState>) => setState((s) => ({ ...s, ...patch }))
    set({ session: null, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null, setAside: null })
    // The hub closed the document on its side (moved, trashed, copy discarded).
    let closedByHub = false

    const wire = ({ doc, text, provider }: Lineage) => {
      set({ session: { doc, text, provider }, connection: 'connecting', save: 'saved' })
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

      provider.on('synced', () => { synced = true; set({ connection: 'online' }) })
      provider.on('status', ({ status }: { status: string }) => {
        if (status === 'disconnected') set({ connection: 'offline' })
        else if (status === 'connected' && provider.isSynced) set({ connection: 'online' })
      })
      provider.on('stateless', ({ payload }: { payload: string }) => {
        let msg: { type?: string; etag?: string; to?: string; id?: string; by?: string; action?: string }
        try { msg = JSON.parse(payload) } catch { return }
        if (msg.type === SAVED && msg.etag) { savedHash = msg.etag; void recheck() }
        else if (msg.type === ORPHANED) set({ orphaned: true })
        else if (msg.type === ORPHAN_RESOLVED) { if (msg.action === 'discard') closedByHub = true; set({ orphaned: false }) }
        else if (msg.type === MOVED && msg.to) { closedByHub = true; set({ moved: msg.to }) }
        else if (msg.type === TRASHED && msg.id) { closedByHub = true; set({ trashed: { id: msg.id, by: msg.by ?? '' } }) }
      })
    }

    const link = new NoteLink(sharedSocket(), path, { onLineage: wire, onSetAside: (s) => set({ setAside: s }) })

    // After a move, a trash or a discarded orphan copy, the hub closes the
    // document on its side: the provider leaves the shared socket without
    // sending a close, which Hocuspocus would queue and apply to a later opening.
    return () => link.destroy(closedByHub)
  }, [path])

  return state
}
