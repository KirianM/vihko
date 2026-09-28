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
  | 'control_characters' // a note or folder name vihko would give with a control character (a tab, a line break…)
  | 'edit_mismatch'
  | 'invalid_username'
  | 'weak_password'
  | 'user_exists'
  | 'already_setup'
  | 'invalid_token'
  | 'too_large' // an image over the size limit
  | 'unsupported_type' // not an image type vihko stores
  | 'fetch_failed' // an image URL could not be downloaded
  | 'busy' // too many images being received at once (uploads and copies from a URL): try again in a moment (Retry-After)
  | 'not_configured' // a feature that vihko.yaml doesn't turn on (daily notes with no series)
  | 'not_empty' // a folder that still holds files can't be deleted
  | 'history_off' // vihko.yaml turns the history off
  | 'history_unavailable' // the history can't be read right now (see /api/history/status)
  | 'integrations_locked' // VIHKO_INTEGRATIONS=off: the API and MCP switches can't be turned on
  | 'not_revertible' // a version that creates or deletes the note has no change of its text to revert
  | 'agent_denied' // an agent named a note that exists but isn't for agents (`ai: false`, or outside its key's folders)
  | 'audience_widens' // an agent's move would open the note to people, groups or keys who can't see it now: it needs the audience confirmed (D-040 3.2)
  | 'invalid_client' // an OAuth authorization request from a client this vihko doesn't know
  | 'invalid_redirect_uri' // an OAuth authorization request whose redirect URI the client didn't register
  | 'too_many_attempts' // too many failed sign-ins (or first-boot tokens): wait `retryAfter` seconds (also Retry-After)
  | 'config_invalid' // vihko.yaml can't be changed by vihko as it is (not valid YAML, or its permissions are rejected): it's fixed by hand first
  | 'invalid_link' // a one-time link (invitation or reset) that doesn't work: unknown, used or expired, alike
  | 'wrong_password' // a password asked for with a session (changing it, confirming a key or an OAuth client) isn't right
  | 'last_admin' // the last active admin can't be demoted, disabled or deleted
  | 'not_disabled' // only a disabled user can be deleted
  | 'user_disabled' // a disabled user gets no link: enable them first
  | 'group_exists'
  | 'invalid_group_name'
  | 'private_address' // «Save a copy»: a member may only download from public addresses (D-038.6)
  | 'history_unmanaged' // purging: the history is the notes folder's own git repository, which vihko never rewrites
  | 'history_no_repository' // purging: there is no managed history yet
  | 'invalid_version' // purging: not a version id
  | 'not_a_version' // purging: that version doesn't write that note
  | 'history_moved' // purging: the history changed while it was being rewritten; nothing changed
  | 'login_expired' // the second step of a sign-in came too late (or its pending sign-in is unknown): the password again
  | 'invalid_code' // a second-factor code (or recovery code) that isn't right
  | 'code_used' // a TOTP code already accepted once: wait for the next one
  | 'confirmation_required' // creating a key, approving an OAuth client or one of the admin's changes to an account: the current code (or the password) is missing
  | 'two_factor_disabled' // the admin turned the second factor off: it can't be set up
  | 'two_factor_required' // the admin requires a second factor: one's own can't be turned off
  | 'two_factor_off' // no second factor in force to change

/**
 * Space-level alerts: what vihko has detected in the notes folder that needs
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
   * Notes moved outside vihko (same `uid`, or the same content without one),
   * detected together: `links` written for their old paths no longer reach
   * them. `update_links` rewrites them as a vihko move would have; nothing is
   * rewritten on its own. Goes away when no such link is left.
   */
  | { code: 'external_move'; id: string; moves: { from: string; to: string }[]; links: number; actions: 'update_links'[] }
  /** A sync tool's conflict copy; `note` is the original note if it exists. */
  | { code: 'sync_conflict'; path: string; note: string | null; actions: never[] }
  /**
   * The workspace configuration file can't be used. vihko goes on with the
   * last valid one it read (`fallback: 'last_good'`) or with none (`'none'`).
   */
  | { code: 'config_invalid'; file: string; errors: ConfigError[]; fallback: 'last_good' | 'none'; actions: never[] }
  /**
   * The workspace configuration applies, but without some parts: unknown keys,
   * a newer `version`, a rejected strict section (D-031.9).
   */
  | { code: 'config_warnings'; file: string; warnings: ConfigError[]; actions: never[] }
  /**
   * vihko rewrote the workspace configuration file to the current format when
   * it started (D-042.6), at `at` (ISO): which `migrations` (their id and a
   * one-line description, in English), and where the file as it was is kept
   * (`backup`, a path in the state volume). Only admins see it, until one of
   * them dismisses it.
   */
  | { code: 'config_migrated'; id: string; file: string; migrations: ConfigMigrationRef[]; backup: string; at: string; actions: 'dismiss'[] }
  /**
   * The workspace configuration file is in an older format and couldn't be
   * rewritten when vihko started: `migration` failed (null: writing the file
   * did). It was left as it was, and it's tried again at the next start.
   * `detail` is for developers. Only admins see it.
   */
  | { code: 'config_migration_failed'; file: string; migration: ConfigMigrationRef | null; detail: string; actions: never[] }
  /** A daily-note series names a template note that doesn't exist: its notes are created empty. */
  | { code: 'config_template_missing'; series: string; template: string; actions: never[] }
  /**
   * The history can't record right now (git missing, disk full, a broken
   * repository). Notes are still written; what is pending waits in the state
   * volume and is retried. `detail` is for developers, never shown.
   */
  | { code: 'history_unavailable'; detail: string; actions: never[] }
  /**
   * Files larger than the history's limit (vihko.yaml `history.maxFileSize`,
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
   * version of a note from the history while vihko ran (D-038.9): which,
   * who (`by`, their name) and when (`at`, ISO). Never anything of the
   * content. Only admins see it, until they dismiss it.
   */
  | { code: 'history_purged'; id: string; path: string; version: string | null; by: string; at: string; actions: 'dismiss'[] }
  /** `history.mode: unmanaged`, but the notes folder isn't inside a git repository: there is no history to show. */
  | { code: 'history_no_repository'; actions: never[] }
  /**
   * The API or the MCP server is on (`api`, `mcp`) while vihko.yaml keeps
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
   * The `permissions` of vihko.yaml can't be used (the file, or the section,
   * with a mistake: `config_warnings` or `config_invalid` say where). With
   * `last_good`, the last valid ones stay in force; with `closed` (it was
   * so when vihko started), nobody reads any note until it's fixed. Only
   * admins see it.
   */
  | { code: 'permissions_rejected'; fallback: 'last_good' | 'closed'; actions: never[] }
  /**
   * Notes moved outside vihko out of `folder`, which has permissions of its
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
  /**
   * Addressed to one person (M4.1): the vihko admin `by` (their name) gave
   * them a password reset link, took their second factor away or changed
   * their role (to `role`) at `at` (ISO). Until they dismiss it.
   */
  | { code: 'account_changed'; id: string; change: AccountChange; role: 'admin' | 'member' | null; by: string; at: string; actions: 'dismiss'[] }
  /** The same, told to every other admin: `by` did it to `user` (names). Until each dismisses theirs. */
  | { code: 'user_account_changed'; id: string; change: AccountChange; role: 'admin' | 'member' | null; by: string; user: string; at: string; actions: 'dismiss'[] }
  /**
   * Addressed to one person (M4.1): `by` (their name) purged from the
   * history a note they wrote in (`version`: one version of it) at `at`.
   * `path` only while they can still read it; null otherwise. Never anything
   * of the content.
   */
  | { code: 'history_purged_authored'; id: string; path: string | null; version: boolean; by: string; at: string; actions: 'dismiss'[] }
  /**
   * Second factors stored encrypted with a VIHKO_SECRET_KEY that isn't the
   * one in force (or with none set): their codes can't be checked, so those
   * people (`users`, names) sign in with a recovery code, or the admin takes
   * theirs away (`vihko user reset-2fa`). Only admins see it.
   */
  | { code: 'two_factor_unreadable'; users: string[]; actions: never[] }

/** One of vihko.yaml's format migrations, as the log and the admin see it (server configMigrations.ts). */
export interface ConfigMigrationRef {
  id: string
  /** One line, in English. */
  description: string
}

/** What the vihko admin did to someone's account. */
export type AccountChange = 'reset_link' | 'two_factor_reset' | 'role_changed'

export type AlertCode = Alert['code']
export type AlertAction = Alert['actions'][number]
