// Co-editing session for a note (D-012): a Yjs document synced with the hub over
// /collab. The file is still the source of truth; the hub says whenever the text
// reaches the disk (`thoth:saved`), when the note is deleted outside thoth
// (D-022) and when anyone moves or trashes it from thoth.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import * as Y from 'yjs'

export const TEXT = 'md'
const SAVED = 'thoth:saved'
const ORPHANED = 'thoth:deleted-externally'
const ORPHAN_RESOLVED = 'thoth:orphan-resolved'
const MOVED = 'thoth:moved'
const TRASHED = 'thoth:trashed'

/** Un único WebSocket para toda la aplicación; cada nota abierta es un documento sobre él. */
let socket: HocuspocusProviderWebsocket | null = null
function sharedSocket() {
  socket ??= new HocuspocusProviderWebsocket({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
  })
  return socket
}

export type Connection = 'connecting' | 'online' | 'offline'
/** `saved`: lo que ves es lo que hay en el archivo. `saving`: hay cambios aún no volcados. */
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

/** `sha256:<hex>`, igual que `contentHash` del servidor. */
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

    // Estado de guardado: al abrir, lo que llega del hub es lo del disco. Tras cualquier
    // cambio (tuyo o de otro), "guardado" solo cuando el hub anuncia el hash del texto actual.
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
