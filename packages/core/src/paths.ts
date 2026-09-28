// What each file in the notes folder is, as far as vihko is concerned.

export type PathKind = 'note' | 'conflict' | 'ignored' | 'other'

const SYNC_CONFLICT = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(?:\.[^/]*)?$/

/**
 * Classifies a path relative to the notes root (with `/`):
 * - `ignored`: any hidden segment (`.obsidian/`, `.trash/`, `.git/`, `.nfsXXXX`,
 *   editor and vihko temp files) or backup copies ending in `~`.
 * - `conflict`: a Syncthing conflict copy of a note. Flagged, not indexed.
 * - `note`: a `.md` file.
 * - `other`: any other file (attachments).
 */
export function classifyPath(rel: string): PathKind {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]!
  if (parts.some((p) => p.startsWith('.')) || name.endsWith('~')) return 'ignored'
  const isMd = /\.md$/i.test(name)
  if (SYNC_CONFLICT.test(name)) return isMd ? 'conflict' : 'ignored'
  return isMd ? 'note' : 'other'
}

/** Path of the note a conflict copy came from (`Plan.sync-conflict-….md` → `Plan.md`). */
export function conflictOriginal(rel: string): string {
  return rel.replace(/\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(?=\.[^/.]*$|$)/, '')
}

/** true if a directory shouldn't be traversed (saves descending into `.git/` and similar). */
export const isIgnoredDir = (name: string) => name.startsWith('.')
