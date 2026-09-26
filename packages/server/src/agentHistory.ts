// The history as an agent sees it (D-014, D-035): the same reader, through
// the access filter. A user's reader is returned as it is.
//
// For an agent, a version exists only if the note was in the key's folders
// then and its text then wasn't hidden (`ai: false`, unreadable frontmatter);
// a deletion, if the text it deleted wasn't. The text right before a version,
// when hidden, is left out: the version reads as the note's creation, with
// its words counted as such, so no count of what it can't see gets out. In
// «Recent changes», each note is checked the same way at that commit. A
// reason names only paths the agent can read (a link rewritten because a note
// it can't see was moved says so, without saying which).
import { classifyPath } from '@thoth/core'
import type { Access } from './access.ts'
import { wordStats } from './history/diff.ts'
import type { HistoryReader, RawChange, RawVersion, VersionText } from './history/reader.ts'

/** The reader `access` may use: filtered for an agent, the reader itself for a user. */
export function historyFor(access: Access, reader: HistoryReader): HistoryReader {
  return access.isAgent ? new AgentHistory(access, reader) : reader
}

class AgentHistory implements HistoryReader {
  private access: Access
  private inner: HistoryReader

  constructor(access: Access, inner: HistoryReader) {
    this.access = access
    this.inner = inner
  }

  async versions(path: string, page: { cursor?: string | null; limit: number }) {
    const r = await this.inner.versions(path, page)
    const versions: RawVersion[] = []
    for (const v of r.versions) {
      const t = await this.inner.version(path, v.id)
      const shown = this.shown(t)
      if (!shown) continue
      versions.push({ ...masked(v, t!, shown, this.access), reason: maskedReason(v.reason, this.access) })
    }
    return { versions, next: r.next }
  }

  async version(path: string, id: string): Promise<VersionText | null> {
    return this.shown(await this.inner.version(path, id))
  }

  async file(id: string, path: string): Promise<Uint8Array | null> {
    if (!this.access.inScope(path)) return null
    const bytes = await this.inner.file(id, path)
    if (bytes && classifyPath(path) === 'note' && this.access.hides(Buffer.from(bytes).toString('utf8'))) return null
    return bytes
  }

  async changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string) => boolean }) {
    const r = await this.inner.changes({ ...page, canRead: (p) => page.canRead(p) && this.access.canRead(p) })
    const changes: RawChange[] = []
    for (const c of r.changes) {
      const files: RawChange['files'] = []
      for (const f of c.files) {
        if (classifyPath(f.path) !== 'note') { files.push(f); continue }
        const t = await this.inner.version(f.path, c.id)
        const shown = this.shown(t)
        if (!shown) continue
        files.push(masked(f, t!, shown, this.access))
      }
      if (files.length) changes.push({ ...c, files, reason: maskedReason(c.reason, this.access) })
    }
    return { changes, next: r.next }
  }

  /** Everyone in the history is more than an agent may know: the API lists the authors of what it shows. */
  async authors() {
    return []
  }

  /** The version as the agent may see it, or null if it may not. */
  private shown(t: VersionText | null): VersionText | null {
    if (!t || !this.access.inScope(t.path)) return null
    if (t.text === null) return t.before === null || this.access.hides(t.before) ? null : t
    if (this.access.hides(t.text)) return null
    return t.before !== null && this.access.hides(t.before) ? { ...t, before: null } : t
  }
}

/**
 * A version or changed file as listed: with the text before it left out,
 * it becomes the note's creation; where it came from is only said if that
 * path is in the key's folders.
 */
function masked<T extends { change: RawVersion['change']; from?: string; added: number; removed: number }>(v: T, t: VersionText, shown: VersionText, access: Access): T {
  if (t.before !== null && shown.before === null) {
    const { from: _from, ...rest } = v
    return { ...rest, change: 'created', ...wordStats('', t.text ?? '') } as T
  }
  if (v.from !== undefined && !access.inScope(v.from)) {
    const { from: _from, ...rest } = v
    return rest as T
  }
  return v
}

/**
 * A reason with only the paths the agent can read: `from`/`to` of a move it
 * can't see become null, and the moves of `links_after_external_move` are
 * those it can see whole.
 */
function maskedReason(r: Record<string, unknown> | null, access: Access): Record<string, unknown> | null {
  if (!r) return r
  const sees = (p: unknown) => typeof p === 'string' && access.canRead(p)
  const out: Record<string, unknown> = { ...r }
  for (const k of ['from', 'to']) if (k in out && !sees(out[k])) out[k] = null
  if (Array.isArray(out.moves)) out.moves = (out.moves as { from?: unknown; to?: unknown }[]).filter((m) => sees(m.from) && sees(m.to))
  return out
}
