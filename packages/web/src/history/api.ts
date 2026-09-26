// History API client (D-016, D-033): a note's versions, one version with its
// diff, restoring it, and «Recent changes». Authors come with their current
// name; reasons as codes with their data, which the UI words (D-025).
import { request } from '../api.ts'

export type HistoryMode = 'managed' | 'unmanaged' | 'off'

export interface HistoryStatus {
  mode: HistoryMode
  /** Whether versions can be read (and, managed, recorded) now. */
  available: boolean
  /** Why not: a code (`history_unavailable`, `history_no_repository`…) and a hint for developers. */
  error: { code: string; message: string } | null
}

/** Who made a version. `name` is the current one; `key` is its value for the `author` filter of «Recent changes». */
export interface HistoryAuthor {
  kind: 'user' | 'agent' | 'system' | 'external' | 'git'
  id?: string
  name: string
  onBehalfOf?: { id: string; name: string }
  key: string
}

/**
 * Why the system made a change (or, for `restored`, `trash_restored` and
 * `reverted`, why a person did). `by` is who asked for the operation; unknown codes are shown
 * as a plain system change.
 */
export interface Reason {
  code: string
  from?: string
  to?: string
  by?: HistoryAuthor | null
  moves?: { from: string; to: string }[]
  alias?: string
  id?: string
  at?: string
}

export type ChangeKind = 'created' | 'modified' | 'moved' | 'deleted' | 'restored'

export interface Version {
  /** The commit. */
  id: string
  /** ISO, the author time. */
  at: string
  authors: HistoryAuthor[]
  reason: Reason | null
  /** An external change found when thoth started («while thoth was stopped»). */
  foundAtStartup: boolean
  /** The note's path in this version. */
  path: string
  change: ChangeKind
  /** For `moved`: where it was. */
  from?: string
  /** Words and marks added and removed against the previous version. */
  added: number
  removed: number
}

/** What is still being written into the note and isn't a version yet. */
export interface Pending { authors: HistoryAuthor[]; since: string }

/** `excluded`: thoth.yaml keeps the file out of the history (`history.exclude`); what is listed is from before. */
export interface VersionPage { versions: Version[]; next: string | null; pending: Pending | null; excluded: boolean }

export type DiffOp = [-1 | 0 | 1, string]
/** `ops` turn the compared text into the version: what the version adds is an insertion. */
export interface Diff { ops: DiffOp[]; added: number; removed: number }
export type Against = 'previous' | 'current'

export interface RestoreReport {
  etag: string
  /** The images the version linked that no longer existed: brought back, or why not. */
  images: { restored: string[]; missing: { path: string; reason: 'not_in_history' | 'exists' }[] }
}

/** A piece that is undone: `removed` (what the version wrote) goes and `restored` comes back, with a bit of the note around it. */
export interface RevertedPiece { before: string; removed: string; restored: string; after: string }
/** A piece left as it is because it was changed after the version: what the version wrote, what was there before, what is there now. */
export interface SkippedPiece { before: string; version: string; previous: string; current: string; after: string }
/** What reverting a version's change does (`dryRun`) or did. The lists hold the first pieces; `counts`, all of them. */
export interface RevertReport {
  dryRun: boolean
  changed: boolean
  etag: string
  reverted: RevertedPiece[]
  skipped: SkippedPiece[]
  /** `already`: pieces the note already has as they were before the version. */
  counts: { reverted: number; skipped: number; already: number }
}

export interface ChangeFile { path: string; change: ChangeKind; from?: string; added: number; removed: number }
export interface Change {
  id: string
  at: string
  authors: HistoryAuthor[]
  reason: Reason | null
  foundAtStartup: boolean
  files: ChangeFile[]
}
export interface ChangesPage { changes: Change[]; next: string | null; authors: HistoryAuthor[] }

/** Requests made on their own (polling, a refresh on focus) give up after this; they are asked again. */
const POLL_TIMEOUT = 15_000

const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  return q.toString()
}

export const historyApi = {
  status: () => request<HistoryStatus>('GET', '/api/history/status', undefined, {}, AbortSignal.timeout(POLL_TIMEOUT)),
  versions: (path: string, opts: { cursor?: string | null; limit?: number } = {}) =>
    request<VersionPage>('GET', `/api/history/versions?${query({ path, cursor: opts.cursor, limit: opts.limit })}`, undefined, {}, AbortSignal.timeout(POLL_TIMEOUT)),
  diff: (path: string, id: string, against: Against) =>
    request<Diff>('GET', `/api/history/diff?${query({ path, id, against })}`),
  version: (path: string, id: string) =>
    request<{ path: string; id: string; at: string; text: string | null }>('GET', `/api/history/version?${query({ path, id })}`),
  restore: (path: string, id: string) => request<RestoreReport>('POST', '/api/history/restore', { path, id }),
  revert: (path: string, id: string, opts: { dryRun?: boolean } = {}) =>
    request<RevertReport>('POST', '/api/history/revert', { path, id, dryRun: opts.dryRun === true }),
  changes: (opts: { cursor?: string | null; author?: string | null } = {}) =>
    request<ChangesPage>('GET', `/api/history/changes?${query({ cursor: opts.cursor, author: opts.author })}`, undefined, {}, AbortSignal.timeout(POLL_TIMEOUT)),
}
