// The tree and the sidebar, live: when someone creates, renames,
// moves or deletes notes or folders, or a folder is shared or a space's
// members change, each person whose view that changes is told to read their
// tree again, over a server-sent event stream (GET /api/events). An event
// says nothing but «read your tree again»: no path, no name, no count. And
// it only reaches someone the change concerns, judged by their access at
// that moment, so nobody learns that something they can't read changed:
//
// - a path that changed (indexer.ts `onTreeChange`: a note added, removed,
//   moved or retitled, a folder made or gone) reaches whoever reads it, a
//   note as a note, a folder as a folder; a move, whoever read where it was
//   or reads where it is;
// - a change of who reaches what (vihko.yaml's permissions, a group's
//   members, a person deleted, a pin) reaches whoever's spaces, shared
//   folders or levels in the folders they see differ from what they were
//   (compared as a fingerprint of their view, kept per connection).
//
// Why a server-sent stream and not the hub's WebSocket: the hub's connection
// lives with an open note (one Hocuspocus document per note), and Home or a
// settings page has none; an event stream needs nothing new (Hono's own
// `streamSSE`), goes through the same session cookie and reconnects by
// itself.
import { createHash } from 'node:crypto'
import { classifyPath } from '@vihko/core'
import type { Access, AccessPolicy } from './access.ts'
import type { User } from './auth.ts'

/** How long changes are gathered before one event goes out (a folder moved is many paths at once). */
export const LIVE_DEBOUNCE_MS = 250

interface Subscriber {
  user: User
  send: () => void
  /** «Read your notices again»: one arrived for this person (notices.ts). */
  notice?: () => void
  /** The fingerprint of what the person reached when last told. */
  view: string
  timer: ReturnType<typeof setTimeout> | null
}

export interface LiveTreeOptions {
  policy: AccessPolicy
  /** The fingerprint of what someone reaches (their spaces, shared folders and levels): see the header. */
  viewOf: (user: User) => unknown
  debounceMs?: number
}

export class LiveTree {
  private subs = new Set<Subscriber>()
  private opts: LiveTreeOptions

  constructor(opts: LiveTreeOptions) {
    this.opts = opts
  }

  /** How many are listening (tests). */
  get size(): number {
    return this.subs.size
  }

  private fingerprint(user: User): string {
    try {
      return createHash('sha256').update(JSON.stringify(this.opts.viewOf(user))).digest('hex')
    } catch {
      return ''
    }
  }

  /**
   * Listens for one person; `send` is called (debounced) when their tree
   * should be read again, `notice` when a notice arrived for them. Returns
   * how to stop.
   */
  subscribe(user: User, send: () => void, notice?: () => void): () => void {
    const sub: Subscriber = { user, send, notice, view: this.fingerprint(user), timer: null }
    this.subs.add(sub)
    return () => {
      if (sub.timer) clearTimeout(sub.timer)
      this.subs.delete(sub)
    }
  }

  private tell(sub: Subscriber) {
    if (sub.timer) return
    sub.timer = setTimeout(() => {
      sub.timer = null
      if (!this.subs.has(sub)) return
      sub.view = this.fingerprint(sub.user)
      try { sub.send() } catch { /* the connection is gone: it unsubscribes itself */ }
    }, this.opts.debounceMs ?? LIVE_DEBOUNCE_MS)
  }

  /** Whether `access` sees a path: a note as a note, anything else as a folder (an image's folder, a folder). */
  private static sees(access: Access, path: string): boolean {
    if (classifyPath(path) === 'note') return access.canRead(path)
    return access.level(path) !== null
  }

  /** Paths changed (indexer.ts `onTreeChange`): tells whoever reads any of them. */
  pathsChanged(paths: readonly string[]): void {
    if (paths.length === 0) return
    for (const sub of this.subs) {
      if (sub.timer) continue
      const access = this.opts.policy.for({ kind: 'user', user: sub.user })
      if (paths.some((p) => LiveTree.sees(access, p))) this.tell(sub)
    }
  }

  /** Who reaches what may have changed: tells whoever's view differs from when they were last told. */
  viewChanged(): void {
    for (const sub of this.subs) {
      if (sub.timer) continue
      if (this.fingerprint(sub.user) !== sub.view) this.tell(sub)
    }
  }

  /** Tells one person's every connection (something only they did: a pin, from another tab). */
  userChanged(userId: string): void {
    for (const sub of this.subs) if (sub.user.id === userId) this.tell(sub)
  }

  /** A notice arrived for one person: each of their connections reads its notices again, at once. Nothing of it is sent. */
  noticeFor(userId: string): void {
    for (const sub of this.subs) {
      if (sub.user.id !== userId || !sub.notice) continue
      try { sub.notice() } catch { /* the connection is gone: it unsubscribes itself */ }
    }
  }
}
