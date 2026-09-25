// Co-editing session for a note: a Yjs document synced with the hub over
// /collab. The file is still the source of truth; the hub says whenever the text
// reaches the disk (`thoth:saved`), when the note is deleted outside thoth
// and when anyone moves or trashes it from thoth.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import * as Y from 'yjs'

export const TEXT = 'md'
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
}

/** `sha256:<hex>`, same as the server's `contentHash`. */
async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useCollab(path: string): CollabState {
  const [state, setState] = useState<CollabState>({ session: null, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null })

  useEffect(() => {
    const doc = new Y.Doc()
    const text = doc.getText(TEXT)
    const provider = new HocuspocusProvider({ websocketProvider: sharedSocket(), name: path, document: doc })
    provider.attach()
    const set = (patch: Partial<CollabState>) => setState((s) => ({ ...s, ...patch }))
    set({ session: { doc, text, provider }, connection: 'connecting', save: 'saved', orphaned: false, moved: null, trashed: null })

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
    const onUpdate = () => {
      if (synced) dirty = true
      void recheck()
    }
    doc.on('update', onUpdate)

    provider.on('synced', () => { synced = true; set({ connection: 'online' }) })
    provider.on('status', ({ status }: { status: string }) => {
      if (status === 'disconnected') set({ connection: 'offline' })
      else if (status === 'connected' && provider.isSynced) set({ connection: 'online' })
    })
    // After a move or trash, the hub closes the document on its side. Drop the
    // provider from the shared socket: otherwise destroying it sends a close that
    // Hocuspocus queues and applies to the next opening of the same path on this
    // socket (restoring it), which would be left disconnected without a word.
    const forget = () => { sharedSocket().configuration.providerMap.delete(provider.effectiveName) }
    provider.on('stateless', ({ payload }: { payload: string }) => {
      let msg: { type?: string; etag?: string; to?: string; id?: string; by?: string }
      try { msg = JSON.parse(payload) } catch { return }
      if (msg.type === SAVED && msg.etag) { savedHash = msg.etag; void recheck() }
      else if (msg.type === ORPHANED) set({ orphaned: true })
      else if (msg.type === ORPHAN_RESOLVED) set({ orphaned: false })
      else if (msg.type === MOVED && msg.to) { forget(); set({ moved: msg.to }) }
      else if (msg.type === TRASHED && msg.id) { forget(); set({ trashed: { id: msg.id, by: msg.by ?? '' } }) }
    })

    return () => {
      doc.off('update', onUpdate)
      provider.destroy()
      doc.destroy()
    }
  }, [path])

  return state
}
