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
  | 'integrations_locked' // THOTH_INTEGRATIONS=off: the API and MCP switches can't be turned on
  | 'not_revertible' // a version that creates or deletes the note has no change of its text to revert
  | 'agent_denied' // an agent named a note that exists but isn't for agents (`ai: false`, or outside its key's folders)
  | 'audience_widens' // an agent's move would open the note to people, groups or keys who can't see it now: it needs the audience confirmed (D-040 3.2)
  | 'invalid_client' // an OAuth authorization request from a client this thoth doesn't know
  | 'invalid_redirect_uri' // an OAuth authorization request whose redirect URI the client didn't register
  | 'too_many_attempts' // too many failed sign-ins (or first-boot tokens): wait `retryAfter` seconds (also Retry-After)
  | 'config_invalid' // thoth.yaml can't be changed by thoth as it is (not valid YAML, or its permissions are rejected): it's fixed by hand first
  | 'invalid_link' // a one-time link (invitation or reset) that doesn't work: unknown, used or expired, alike
  | 'wrong_password' // a password asked for with a session (changing it, confirming a key or an OAuth client) isn't right
  | 'last_admin' // the last active admin can't be demoted, disabled or deleted
  | 'not_disabled' // only a disabled user can be deleted
  | 'user_disabled' // a disabled user gets no link: enable them first
  | 'group_exists'
  | 'invalid_group_name'
  | 'private_address' // «Save a copy»: a member may only download from public addresses (D-038.6)
  | 'history_unmanaged' // purging: the history is the notes folder's own git repository, which thoth never rewrites
  | 'history_no_repository' // purging: there is no managed history yet
  | 'invalid_version' // purging: not a version id
  | 'not_a_version' // purging: that version doesn't write that note
  | 'history_moved' // purging: the history changed while it was being rewritten; nothing changed
  | 'login_expired' // the second step of a sign-in came too late (or its pending sign-in is unknown): the password again
  | 'invalid_code' // a second-factor code (or recovery code) that isn't right
  | 'code_used' // a TOTP code already accepted once: wait for the next one
  | 'confirmation_required' // creating a key or approving an OAuth client: the current code (or the password) is missing
  | 'two_factor_disabled' // the admin turned the second factor off: it can't be set up
  | 'two_factor_required' // the admin requires a second factor: one's own can't be turned off
  | 'two_factor_off' // no second factor in force to change

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
  /**
   * Someone purged a path (a note, or a folder with everything in it) or one
   * version of a note from the history while thoth ran (D-038.9): which,
   * who (`by`, their name) and when (`at`, ISO). Never anything of the
   * content. Only admins see it, until they dismiss it.
   */
  | { code: 'history_purged'; id: string; path: string; version: string | null; by: string; at: string; actions: 'dismiss'[] }
  /** `history.mode: unmanaged`, but the notes folder isn't inside a git repository: there is no history to show. */
  | { code: 'history_no_repository'; actions: never[] }
  /**
   * The API or the MCP server is on (`api`, `mcp`) while thoth.yaml keeps
   * the history unmanaged or off (`mode`): what an agent writes gets no
   * version of its own to undo it by (D-034 3.8).
   */
  | { code: 'integrations_unversioned'; mode: 'unmanaged' | 'off'; api: boolean; mcp: boolean; actions: never[] }
  /**
   * Many failed or refused sign-ins (`attempts`) since `since` (ISO), the
   * last of them in the past day: someone may be guessing passwords. The
   * login limits are holding them back; only admins see it. Kept in memory:
   * a restart forgets it.
   */
  | { code: 'login_attempts_blocked'; attempts: number; since: string; actions: never[] }
  /**
   * The `permissions` of thoth.yaml can't be used (the file, or the section,
   * with a mistake: `config_warnings` or `config_invalid` say where). With
   * `last_good`, the last valid ones stay in force; with `closed` (it was
   * so when thoth started), nobody reads any note until it's fixed. Only
   * admins see it.
   */
  | { code: 'permissions_rejected'; fallback: 'last_good' | 'closed'; actions: never[] }
  /**
   * Notes moved outside thoth out of `folder`, which has permissions of its
   * own, into a folder where others apply: nobody reads them until someone
   * decides. `move_permissions` moves the folder's rules to `to` (where the
   * notes went); `release` accepts what they get where they are. `notes`:
   * how many. For the admin and whoever manages `folder`.
   */
  | { code: 'permissions_held'; id: string; folder: string; to: string | null; notes: number; actions: ('move_permissions' | 'release')[] }
  /**
   * New images go to one folder for everyone (`attachments.mode: folder`),
   * with more than one person: the image of a private note lands where
   * others may read it (an image has its folder's permissions). `per-note`
   * or `next-to-note` keep each image with its note. Only admins see it.
   */
  | { code: 'attachments_shared_folder'; folder: string; actions: never[] }

export type AlertCode = Alert['code']
export type AlertAction = Alert['actions'][number]
