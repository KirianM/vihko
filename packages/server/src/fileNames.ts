// Files that aren't notes, named the way Obsidian writes them: `![[photo.png]]`
// or `[[invoice.pdf]]`, a bare name (or a path suffix) with no folder. Such a
// reference resolves as a note's name does (core resolve.ts): first relative
// to the note, as Markdown does; then by name among the files of the note's
// space (index.db `files`), the nearest winning with the same tie rules, and
// never in another space. Who reads it is the caller's to judge.
import { LinkIndex, classifyPath, linkSpace, normKey, resolveImageRef, sameSpace } from '@vihko/core'
import type { Db } from './db.ts'

/**
 * A file's extension: up to 8 letters or digits, with a letter, so that a
 * note named `v1.2` or `Report 2026.10` is still a note's name.
 */
const FILE_EXTENSION = /\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,8}$/i

/** The target up to its `#anchor`. Sliced, not a `/#.*$/` replace: that one is quadratic on many `#` before a line break. */
const withoutAnchor = (target: string) => {
  const hash = target.indexOf('#')
  return hash === -1 ? target : target.slice(0, hash)
}

/** Whether a link's target names a file that isn't a note: it has an extension (FILE_EXTENSION), and it isn't `.md`. */
export function isFileTarget(target: string): boolean {
  const t = withoutAnchor(target).trim()
  const name = t.slice(t.lastIndexOf('/') + 1)
  return FILE_EXTENSION.test(name) && !name.startsWith('.') && classifyPath(t.replace(/^\/+/, '')) === 'other'
}

/**
 * The file `target` names, written in the note at `source` (a path from the
 * notes root), or null when it names none, or more than one equally near
 * (ambiguous: as for a note, nothing is guessed).
 */
export function fileByName(index: Db, source: string, target: string): string | null {
  const t = withoutAnchor(target).trim()
  if (!t || !isFileTarget(t)) return null
  const has = index.prepare('select 1 from files where path = ?')
  // Relative to the note first, as `![[…]]` always resolved.
  const relative = resolveImageRef(source, t, { embed: true })
  if (relative !== null && sameSpace(source, relative) && has.get(relative)) return relative
  // Then by name, among the files of the note's space only.
  const name = normKey(t.slice(t.lastIndexOf('/') + 1))
  const space = linkSpace(source)
  const candidates = (index.prepare('select path from files where name = ?').all(name) as { path: string }[])
    .map((r) => r.path).filter((p) => linkSpace(p) === space)
  if (candidates.length === 0) return null
  const files = new LinkIndex({ aliases: false })
  for (const p of candidates) files.set({ path: p })
  const r = files.resolve(source, { kind: 'wiki', target: t, anchor: null })
  return r.status === 'resolved' ? r.path : null
}
