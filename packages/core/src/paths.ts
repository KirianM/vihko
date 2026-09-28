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

/**
 * true if `path` has a C0 control character (newline, tab, NUL…) or DEL.
 * vihko never gives a note or folder such a name: they are invisible, and
 * the history can't keep a file named with them. One that already has it
 * (named by another program) is still indexed, read and written.
 */
export const hasControlCharacter = (path: string) => /[\u0000-\u001f\u007f]/.test(path)

/** true if a directory shouldn't be traversed (saves descending into `.git/` and similar). */
export const isIgnoredDir = (name: string) => name.startsWith('.')

const SLASH = 47 // /

/**
 * `s` without the `/` it ends with, however many. A loop, not `/\/+$/`:
 * that pattern tries every `/` of a long run that doesn't end the text,
 * in quadratic time, and these are names anyone can write.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--
  return end === s.length ? s : s.slice(0, end)
}

/** `s` without the `/` it starts or ends with (`/^\/+|\/+$/g`, in linear time). */
export function trimSlashes(s: string): string {
  let start = 0
  while (start < s.length && s.charCodeAt(start) === SLASH) start++
  return trimTrailingSlashes(start === 0 ? s : s.slice(start))
}
