// Stable codes the server returns instead of text: the UI translates them.
// Renaming a code breaks clients; adding a new one doesn't.
import type { ConfigError } from './workspace.ts'

export type { ConfigError, ConfigErrorCode } from './workspace.ts'

/**
 * The `error` field of every API error response. The accompanying `message`
 * is just a hint for developers: the UI never shows it.
 */
export type ErrorCode =
  | 'unauthorized' // no session, or expired
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'invalid' // malformed body or parameters
  | 'internal'
  | 'precondition_required' // missing If-Match
  | 'precondition_failed' // If-Match doesn't match
  | 'exists'
  | 'invalid_path'
  | 'edit_mismatch'
  | 'invalid_username'
  | 'weak_password'
  | 'user_exists'
  | 'already_setup'
  | 'invalid_token'
  | 'too_large' // an image over the size limit
  | 'unsupported_type' // not an image type thoth stores
  | 'fetch_failed' // an image URL could not be downloaded
  | 'not_configured' // a feature that thoth.yaml doesn't turn on (daily notes with no series)
  | 'not_empty' // a folder that still holds files can't be deleted
  | 'history_off' // thoth.yaml turns the history off
  | 'history_unavailable' // the history can't be read right now (see /api/history/status)
  | 'not_revertible' // a version that creates or deletes the note has no change of its text to revert

/**
 * Space-level alerts: what thoth has detected in the notes folder that needs
 * a decision. Each one carries the data to word it and the actions available
 * to whoever's asking (admin-only ones aren't shown to anyone else).
 */
export type Alert =
  /** A scan was about to remove too many notes from the index at once and stopped. */
  | { code: 'scan_aborted_mass_delete'; removing: number; total: number; actions: ('rescan' | 'confirm_removal')[] }
  /** The notes folder doesn't exist or can't be read. */
  | { code: 'scan_aborted_root_unavailable'; actions: 'rescan'[] }
  /** A note deleted from outside, with a copy pending a decision. */
  | { code: 'orphaned_note'; path: string; actions: ('keep_copy' | 'discard_copy')[] }
  /** Several notes share the same `uid`. Fixed by editing the frontmatter, never automatically. */
  | { code: 'uid_conflict'; uid: string; paths: string[]; actions: never[] }
  /**
   * Notes moved outside thoth (same `uid`, or the same content without one),
   * detected together: `links` written for their old paths no longer reach
   * them. `update_links` rewrites them as a thoth move would have; nothing is
   * rewritten on its own. Goes away when no such link is left.
   */
  | { code: 'external_move'; id: string; moves: { from: string; to: string }[]; links: number; actions: 'update_links'[] }
  /** A sync tool's conflict copy; `note` is the original note if it exists. */
  | { code: 'sync_conflict'; path: string; note: string | null; actions: never[] }
  /**
   * The workspace configuration file can't be used. thoth goes on with the
   * last valid one it read (`fallback: 'last_good'`) or with none (`'none'`).
   */
  | { code: 'config_invalid'; file: string; errors: ConfigError[]; fallback: 'last_good' | 'none'; actions: never[] }
  /**
   * The workspace configuration applies, but without some parts: unknown keys,
   * a newer `version`, a rejected strict section (D-031.9).
   */
  | { code: 'config_warnings'; file: string; warnings: ConfigError[]; actions: never[] }
  /** A daily-note series names a template note that doesn't exist: its notes are created empty. */
  | { code: 'config_template_missing'; series: string; template: string; actions: never[] }
  /**
   * The history can't record right now (git missing, disk full, a broken
   * repository). Notes are still written; what is pending waits in the state
   * volume and is retried. `detail` is for developers, never shown.
   */
  | { code: 'history_unavailable'; detail: string; actions: never[] }
  /**
   * Files larger than the history's limit (thoth.yaml `history.maxFileSize`,
   * `limitMb`): they don't enter the history, and restoring can't bring them back.
   */
  | { code: 'history_files_too_large'; paths: string[]; limitMb: number; actions: never[] }
  /**
   * git has failed for so long that the commits waiting for it reached their
   * cap: since `since`, `versions` of them were merged into later ones. Their
   * contents and authors are kept; the history has fewer, coarser versions.
   * Goes away once everything waiting is in git.
   */
  | { code: 'history_versions_merged'; versions: number; since: string; actions: never[] }
  /** `history.mode: unmanaged`, but the notes folder isn't inside a git repository: there is no history to show. */
  | { code: 'history_no_repository'; actions: never[] }

export type AlertCode = Alert['code']
export type AlertAction = Alert['actions'][number]
