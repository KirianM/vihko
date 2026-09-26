// Reading a history. The HTTP API (http/history.ts) only talks to this
// interface, so each mode brings its own: the managed repository in the state
// volume (managed.ts), or the notes folder's own git (unmanaged.ts).
//
// Implementing one: pages are always bounded (never walk the whole history to
// answer one page), cursors are opaque strings, and `canRead` is asked for
// every file a change lists (the permission filter, D-014, D-016).
import type { Author } from '../actor.ts'

/**
 * An author as a reader gives it: one of thoth's (users by id, their name is
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
  /** An external change found when thoth started («with thoth stopped»). */
  foundAtStartup: boolean
  /** The note's path in this version. */
  path: string
  change: ChangeKind
  /** For `moved`: where it was. */
  from?: string
  /** Words (and marks) added and removed against the note's previous version. */
  added: number
  removed: number
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
   * (`authorFilter`).
   */
  changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string) => boolean }): Promise<{ changes: RawChange[]; next: string | null }>
  /** Everyone who appears in the history (for the author filter). */
  authors(): Promise<AuthorRef[]>
}

/** Why a history can't be read: a code the API returns (and the UI words). */
export class HistoryError extends Error {
  readonly code: 'history_off' | 'history_unavailable' | 'not_found' | 'invalid'
  constructor(code: HistoryError['code'], message: string) {
    super(message)
    this.code = code
  }
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

/** Cursors: opaque to clients, JSON inside. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeCursor<T>(cursor: string | null | undefined, check: (v: unknown) => v is T): T | null {
  if (!cursor) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (check(v)) return v
  } catch { /* falls through */ }
  throw new HistoryError('invalid', 'invalid cursor')
}
