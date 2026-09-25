// Stable codes the server returns instead of text: the UI translates them.
// Renaming a code breaks clients; adding a new one doesn't.

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
  /** A sync tool's conflict copy; `note` is the original note if it exists. */
  | { code: 'sync_conflict'; path: string; note: string | null; actions: never[] }

export type AlertCode = Alert['code']
export type AlertAction = Alert['actions'][number]
