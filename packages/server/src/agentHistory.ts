// The history as a principal may see it:
// the same reader, through the access filter, for people and agents alike.
//
// - A note's history (versions, their texts and diffs, «Recent changes») is
//   for whoever has `edit` where the note is (`Access.canHistory`): sharing
//   a note to read doesn't share its past. Each version is judged where the
//   note was then, by the rules in force now: a version from when it was in
//   a folder the principal can't edit doesn't exist for it, and the version
//   that brought it from there doesn't say where it came from.
// - For an agent, also: a version exists only if the note was in the key's
//   folders then (and out of folders closed to agents) and its text then
//   wasn't hidden (`ai: false`, unreadable frontmatter); a deletion, if the
//   text it deleted wasn't. The text right before a version, when hidden, is
//   left out the same way, so no count of what it can't see gets out.
// - In «Recent changes», each file is checked the same way at that commit.
// - A reason names only paths the principal can read (a link rewritten
//   because a note it can't see was moved says so, without saying which).
// - A file's bytes (the images a restore brings back) only from folders it
//   can read now.
import { classifyPath, folderOf } from '@vihko/core'
import type { Access } from './access.ts'
import { wordStats } from './history/diff.ts'
import type { HistoryReader, RawChange, RawVersion, VersionText } from './history/reader.ts'

/** The reader `access` may use. */
export function historyFor(access: Access, reader: HistoryReader): HistoryReader {
  return new PrincipalHistory(access, reader)
}

class PrincipalHistory implements HistoryReader {
  private access: Access
  private inner: HistoryReader

  constructor(access: Access, inner: HistoryReader) {
    this.access = access
    this.inner = inner
  }

  /**
   * Whether the history of what is at `path` (where it was then) is for it:
   * `edit` there; a file that isn't a note, only if it may read it too (for
   * an agent, one a note it can read uses).
   */
  private reaches(path: string): boolean {
    return this.access.canHistory(path) && (classifyPath(path) === 'note' || this.access.canRead(path))
  }

  async versions(path: string, page: { cursor?: string | null; limit: number }) {
    const r = await this.inner.versions(path, page)
    const versions: RawVersion[] = []
    for (const v of r.versions) {
      if (!this.reaches(v.path)) continue
      // A person's history is judged by paths alone; an agent's, by each version's text too.
      if (!this.access.isAgent) { versions.push({ ...this.masked(v, null, null), reason: maskedReason(v.reason, this.access) }); continue }
      const t = await this.inner.version(path, v.id)
      const shown = this.shown(t)
      if (!shown) continue
      versions.push({ ...this.masked(v, t, shown), reason: maskedReason(v.reason, this.access) })
    }
    return { versions, next: r.next }
  }

  async version(path: string, id: string): Promise<VersionText | null> {
    return this.shown(await this.inner.version(path, id))
  }

  async file(id: string, path: string): Promise<Uint8Array | null> {
    // Its folder's permission now (for an agent, its user's, in the key's reach): never what it can't read.
    // Nor, for an agent, a file a note hidden from agents uses now (`ai: false`): restoring it under another name would open it.
    if (!this.access.viewer.can(path, 'read') || !this.access.inScope(path) || this.access.closedToAgent(folderOf(path)) || this.access.fileHidden(path)) return null
    const bytes = await this.inner.file(id, path)
    if (bytes && classifyPath(path) === 'note' && this.access.hides(Buffer.from(bytes).toString('utf8'))) return null
    return bytes
  }

  async changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string) => boolean }) {
    const r = await this.inner.changes({ ...page, canRead: (p) => page.canRead(p) && this.reaches(p) })
    const changes: RawChange[] = []
    for (const c of r.changes) {
      const files: RawChange['files'] = []
      for (const f of c.files) {
        if (classifyPath(f.path) !== 'note' || !this.access.isAgent) { files.push(this.masked(f, null, null)); continue }
        const t = await this.inner.version(f.path, c.id)
        const shown = this.shown(t)
        if (!shown) continue
        files.push(this.masked(f, t, shown))
      }
      if (files.length) changes.push({ ...c, files, reason: maskedReason(c.reason, this.access) })
    }
    return { changes, next: r.next }
  }

  /**
   * Everyone who appears in the history: more than a principal may know.
   * A person gets the people (every name is visible to everyone, to share),
   * vihko and outside changes, and their own agents; an agent, nobody (the
   * API lists the authors of what it shows).
   */
  async authors() {
    if (this.access.isAgent) return []
    const me = this.access.user.id
    return (await this.inner.authors()).filter((a) => a.kind === 'user' || a.kind === 'system' || a.kind === 'external' || (a.kind === 'agent' && a.onBehalfOf === me))
  }

  /** The version as the principal may see it, or null if it may not. */
  private shown(t: VersionText | null): VersionText | null {
    if (!t || !this.reaches(t.path)) return null
    if (t.text === null) return t.before === null || this.access.hides(t.before) ? null : t
    if (this.access.hides(t.text)) return null
    return t.before !== null && this.access.hides(t.before) ? { ...t, before: null } : t
  }

  /**
   * A version or changed file as listed: with the text before it left out
   * (an agent's), it becomes the note's creation; where it came from is only
   * said if that's within reach.
   */
  private masked<T extends { change: RawVersion['change']; from?: string; added: number; removed: number }>(v: T, t: VersionText | null, shown: VersionText | null): T {
    if (t && shown && t.before !== null && shown.before === null) {
      const { from: _from, ...rest } = v
      return { ...rest, change: 'created', ...wordStats('', t.text ?? '') } as T
    }
    if (v.from !== undefined && !this.reaches(v.from)) {
      const { from: _from, ...rest } = v
      return rest as T
    }
    return v
  }
}

/**
 * A reason with only the paths the principal can read: `from`/`to` of a
 * move it can't see become null, and the moves of `links_after_external_move`
 * are those it can see whole.
 */
function maskedReason(r: Record<string, unknown> | null, access: Access): Record<string, unknown> | null {
  if (!r) return r
  const sees = (p: unknown) => typeof p === 'string' && access.canRead(p)
  const out: Record<string, unknown> = { ...r }
  for (const k of ['from', 'to']) if (k in out && !sees(out[k])) out[k] = null
  if (Array.isArray(out.moves)) out.moves = (out.moves as { from?: unknown; to?: unknown }[]).filter((m) => sees(m.from) && sees(m.to))
  return out
}
