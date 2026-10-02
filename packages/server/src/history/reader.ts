// Reading a history. The HTTP API (http/history.ts) only talks to this
// interface, so each mode brings its own: the managed repository in the state
// volume (managed.ts), or the notes folder's own git (unmanaged.ts).
//
// Implementing one: pages are always bounded (never walk the whole history to
// answer one page), cursors are opaque strings, and `canRead` is asked for
// every file a change lists (the permission filter).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Author } from '../actor.ts'

/**
 * An author as a reader gives it: one of vihko's (users by id, their name is
 * resolved from state.db by the API), or a git author (unmanaged mode).
 */
export type AuthorRef = Author | { kind: 'git'; name: string; email: string }

export type ChangeKind = 'created' | 'modified' | 'moved' | 'deleted' | 'restored'

/** One version of a note, newest first in a list. */
export interface RawVersion {
  /** The commit. */
  id: string
  /** When it happened (ISO): the author time. */
  at: string
  authors: AuthorRef[]
  /** Why (code and data, `by` as an author key such as `user <id>`); null for a plain edit. */
  reason: Record<string, unknown> | null
  /** An external change found when vihko started («with vihko stopped»). */
  foundAtStartup: boolean
  /** The note's path in this version. */
  path: string
  change: ChangeKind
  /** For `moved`: where it was. */
  from?: string
  /** Words (and marks) added and removed against the note's previous version. */
  added: number
  removed: number
  /**
   * Where who may see this version is judged, when not at `path`: the note's
   * path now, for a version from before its folder was renamed within its
   * space or its shared space was renamed (managed.ts). Never sent to a client.
   */
  judgedPath?: string
  /** The same, for `from`. */
  fromJudgedPath?: string
}

/** One change of «Recent changes»: a commit, with the files the reader may show. */
export interface RawChange {
  id: string
  at: string
  authors: AuthorRef[]
  reason: Record<string, unknown> | null
  foundAtStartup: boolean
  files: { path: string; change: ChangeKind; from?: string; added: number; removed: number }[]
}

/** A version's text, and the note's text right before it. */
export interface VersionText {
  path: string
  id: string
  at: string
  /** null: this version deletes the note. */
  text: string | null
  /** null: the note didn't exist before this version. */
  before: string | null
  /** Where who may see it is judged, when not at `path` (see RawVersion). */
  judgedPath?: string
}

export interface HistoryReader {
  /** A page of the note's versions, newest first, following its moves. */
  versions(path: string, page: { cursor?: string | null; limit: number }): Promise<{ versions: RawVersion[]; next: string | null }>
  /** Version `id` of the note now at `path` (following its moves); null if it isn't one of its versions. */
  version(path: string, id: string): Promise<VersionText | null>
  /** A file's bytes in commit `id` (the images a restore brings back); null if it isn't there. */
  file(id: string, path: string): Promise<Uint8Array | null>
  /**
   * A page of changes, newest first: only files `canRead` allows, and no
   * change left without any; `author` keeps those with a matching author
   * (`authorFilter`). `canRead` is asked with where the file is judged (see
   * RawVersion `judgedPath`) and when the change was made (ISO).
   */
  changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string, at: string) => boolean }): Promise<{ changes: RawChange[]; next: string | null }>
  /** Everyone who appears in the history (for the author filter). */
  authors(): Promise<AuthorRef[]>
}

/** Why a history can't be read: a code the API returns (and the UI words). */
export class HistoryError extends Error {
  /** `not_revertible`: a version that creates or deletes the note has no change of its text to revert. */
  readonly code: 'history_off' | 'history_unavailable' | 'not_found' | 'invalid' | 'not_revertible'
  constructor(code: HistoryError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/**
 * What a client is told when the history can't be read. What git said (its
 * errors can name the server's folders) stays on the server: in the log and
 * the admin's alerts.
 */
export const UNAVAILABLE_MESSAGE = 'the history can\'t be read right now: the admin\'s alerts say why'

/** The message a client gets with a history error: its own, except when it may carry git's words. */
export function clientMessage(e: HistoryError): string {
  return e.code === 'history_unavailable' ? UNAVAILABLE_MESSAGE : e.message
}

/**
 * The value of the author filter for an author: `user:<id>`, `agent:<keyId>`,
 * `system`, `external`, `git:<email>`. A bare kind (`user`, `agent`, `git`)
 * matches every author of that kind.
 */
export function authorFilter(a: AuthorRef): string {
  if (a.kind === 'user' || a.kind === 'agent') return `${a.kind}:${a.id}`
  if (a.kind === 'git') return `git:${a.email || a.name}`
  return a.kind
}

export function matchesAuthor(authors: readonly AuthorRef[], filter: string | null | undefined): boolean {
  if (!filter) return true
  return authors.some((a) => a.kind === filter || authorFilter(a) === filter)
}

/**
 * Cursors: opaque to clients, JSON inside, encrypted and authenticated
 * (AES-256-GCM) with a key of this process. A cursor carries where a walk
 * goes on (a commit, a path, maybe a path the note had in a place the client
 * can't read): only the server makes one and only the server reads it, so a
 * client can't point a page at another note's history, nor learn where the
 * note was. A restart makes them stale (`invalid`): the list is
 * loaded again.
 */
const CURSOR_KEY = randomBytes(32)

export function encodeCursor(value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', CURSOR_KEY, iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')
}

export function decodeCursor<T>(cursor: string | null | undefined, check: (v: unknown) => v is T): T | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url')
    if (raw.length > 28 && raw.toString('base64url') === cursor) {
      const decipher = createDecipheriv('aes-256-gcm', CURSOR_KEY, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(raw.length - 16))
      const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
      const v = JSON.parse(plain.toString('utf8')) as unknown
      if (check(v)) return v
    }
  } catch { /* falls through */ }
  throw new HistoryError('invalid', 'invalid cursor')
}
