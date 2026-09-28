// A note's Yjs document on the client, tied to the hub's document generation.
//
// The hub starts a new generation whenever it builds a note's document without
// a saved state that continues the last one (the state was lost, or the file
// no longer matches it). A copy from another generation must never be merged:
// its text would be added a second time. The provider tells the hub, on every
// (re)connection, which generation its copy belongs to; the hub refuses a
// different one before syncing anything (`vihko:stale-generation`). The copy is
// then dropped and the note is opened again from the hub, and whatever it had
// not got acknowledged is handed over to be kept aside.
//
// Framework-free: the editor's hook uses it, and so do the hub tests.
import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'

export const TEXT = 'md'
/** Map in the document with the hub's metadata; `generation` is the generation id. */
export const META = 'vihko'
export const STALE_GENERATION = 'vihko:stale-generation'

export function generationOf(doc: Y.Doc): string | null {
  const g = doc.getMap(META).get('generation')
  return typeof g === 'string' ? g : null
}

export interface Lineage {
  doc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
  /** There are local changes the hub hasn't acknowledged. */
  unsent(): boolean
  /**
   * Closes it for good. With `quiet`, without telling the hub: after the hub
   * closed it (or refused it), a close sent now would be queued and applied to
   * a later opening on the same socket.
   */
  destroy(quiet?: boolean): void
}

/** Opens a document on the shared socket. */
export function openLineage(websocketProvider: HocuspocusProviderWebsocket, name: string): Lineage {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    websocketProvider,
    name,
    document: doc,
    // Sent on every (re)connection, before any sync: an empty copy claims nothing.
    token: () => JSON.stringify({ generation: generationOf(doc) }),
    // Each opening has its own address on the socket: what an old one still had
    // in flight when the hub refused it can't reach the next opening of the note.
    sessionAwareness: true,
  })
  // Unsent: a local change since the provider last had every change acknowledged.
  // The provider counts sent changes until the hub confirms them; a new sync
  // also counts as one until the hub confirms it has the document's state.
  let pending = false
  const onUpdate = (_u: Uint8Array, origin: unknown) => { if (origin !== provider) pending = true }
  doc.on('update', onUpdate)
  provider.on('unsyncedChanges', ({ number }: { number: number }) => { if (number === 0 && provider.isAuthenticated) pending = false })
  provider.attach()
  return {
    doc,
    text: doc.getText(TEXT),
    provider,
    unsent: () => pending,
    destroy(quiet = false) {
      doc.off('update', onUpdate)
      if (quiet) websocketProvider.configuration.providerMap.delete(provider.effectiveName)
      provider.destroy()
      doc.destroy()
    },
  }
}

/** What a refused copy had not got acknowledged: its whole text, to keep as a copy. */
export interface SetAside { text: string }

/**
 * A note kept open across generations. `onLineage` is called with each document
 * (the first one, and a new one after a refused reconnection); `onSetAside`
 * when a refused copy had unsent changes that the current document lacks.
 */
export class NoteLink {
  lineage: Lineage
  private closed = false
  private websocketProvider: HocuspocusProviderWebsocket
  private name: string
  private events: { onLineage: (l: Lineage) => void; onSetAside: (s: SetAside) => void }

  constructor(websocketProvider: HocuspocusProviderWebsocket, name: string, events: NoteLink['events']) {
    this.websocketProvider = websocketProvider
    this.name = name
    this.events = events
    this.lineage = this.open()
  }

  private open(): Lineage {
    const l = openLineage(this.websocketProvider, this.name)
    l.provider.on('stateless', ({ payload }: { payload: string }) => {
      let msg: { type?: string }
      try { msg = JSON.parse(payload) } catch { return }
      if (msg.type === STALE_GENERATION && l === this.lineage) this.replace()
    })
    this.events.onLineage(l)
    return l
  }

  /** The hub refused this copy: drop it, open the current one and hand over what wasn't sent. */
  private replace() {
    if (this.closed) return
    const old = this.lineage
    const aside = old.unsent() ? old.text.toString() : null
    old.destroy(true) // the hub already closed it
    const next = this.lineage = this.open()
    if (aside === null) return
    const check = () => {
      if (next !== this.lineage || this.closed) return
      next.provider.off('synced', check)
      if (next.text.toString() !== aside) this.events.onSetAside({ text: aside })
    }
    next.provider.on('synced', check)
  }

  destroy(quiet = false) {
    this.closed = true
    this.lineage.destroy(quiet)
  }
}
