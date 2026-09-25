// Sesión de coedición de una nota (D-012): documento Yjs sincronizado con el hub
// por /collab. El archivo sigue siendo la verdad; el hub avisa cada vez que el
// texto llega al disco (`thoth:saved`) y si la nota se borra fuera (D-022).
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import * as Y from 'yjs'

export const TEXT = 'md'
const SAVED = 'thoth:saved'
const ORPHANED = 'thoth:deleted-externally'
const ORPHAN_RESOLVED = 'thoth:orphan-resolved'

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
}

/** `sha256:<hex>`, igual que `contentHash` del servidor. */
async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useCollab(path: string): CollabState {
  const [state, setState] = useState<CollabState>({ session: null, connection: 'connecting', save: 'saved', orphaned: false })

  useEffect(() => {
    const doc = new Y.Doc()
    const text = doc.getText(TEXT)
    const provider = new HocuspocusProvider({ websocketProvider: sharedSocket(), name: path, document: doc })
    provider.attach()
    const set = (patch: Partial<CollabState>) => setState((s) => ({ ...s, ...patch }))
    set({ session: { doc, text, provider }, connection: 'connecting', save: 'saved', orphaned: false })

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
    provider.on('stateless', ({ payload }: { payload: string }) => {
      let msg: { type?: string; etag?: string }
      try { msg = JSON.parse(payload) } catch { return }
      if (msg.type === SAVED && msg.etag) { savedHash = msg.etag; void recheck() }
      else if (msg.type === ORPHANED) set({ orphaned: true })
      else if (msg.type === ORPHAN_RESOLVED) set({ orphaned: false })
    })

    return () => {
      doc.off('update', onUpdate)
      provider.destroy()
      doc.destroy()
    }
  }, [path])

  return state
}
