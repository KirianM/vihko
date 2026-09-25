// Link resolution. An in-memory key index: each note contributes all the
// suffixes of its path without the extension, plus its aliases, normalized.
// It's the model for the indexer's `link_keys` table and also serves the editor.
import { posix } from 'node:path'
import type { LinkRef } from './markdown.ts'

export interface NoteKeys {
  /** Path relative to the notes root, with `/`, including the `.md` extension. */
  path: string
  aliases?: readonly string[]
  /** Heading texts, to check anchors. */
  headings?: readonly string[]
}

export type Resolution =
  | { status: 'resolved'; path: string; anchor: 'ok' | 'missing' | null; via: 'path' | 'alias' | 'self' }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'missing' }

/** Key normalization: NFC, lowercase, no extra whitespace. */
export const normKey = (s: string) => s.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')

const stripMd = (p: string) => (/\.md$/i.test(p) ? p.slice(0, -3) : p)
const dirOf = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const segments = (dir: string) => (dir === '' ? [] : dir.split('/'))

/** Path keys for a note: all its suffixes (`plan`, `thoth/plan`, `projects/thoth/plan`). */
export function pathKeys(path: string): string[] {
  const parts = normKey(stripMd(path)).split('/')
  return parts.map((_, i) => parts.slice(i).join('/'))
}

export class LinkIndex {
  private byPath = new Map<string, Set<string>>()
  private byAlias = new Map<string, Set<string>>()
  private notes = new Map<string, NoteKeys>()

  has(path: string) {
    return this.notes.has(path)
  }

  get(path: string): NoteKeys | undefined {
    return this.notes.get(path)
  }

  /** An independent copy, to simulate a change (e.g. a rename) without touching the original. */
  clone(): LinkIndex {
    const c = new LinkIndex()
    for (const n of this.notes.values()) c.set(n)
    return c
  }

  /** Adds or replaces a note. Returns the affected keys (to re-resolve links). */
  set(note: NoteKeys): Set<string> {
    const affected = this.delete(note.path)
    this.notes.set(note.path, note)
    for (const k of pathKeys(note.path)) add(this.byPath, k, note.path, affected)
    for (const a of note.aliases ?? []) add(this.byAlias, normKey(a), note.path, affected)
    return affected
  }

  delete(path: string): Set<string> {
    const affected = new Set<string>()
    const old = this.notes.get(path)
    if (!old) return affected
    this.notes.delete(path)
    for (const k of pathKeys(path)) remove(this.byPath, k, path, affected)
    for (const a of old.aliases ?? []) remove(this.byAlias, normKey(a), path, affected)
    return affected
  }

  /** A link's lookup key, to tell whether a key change affects it. */
  static keyOf(source: string, link: Pick<LinkRef, 'kind' | 'target'>): string | null {
    if (link.target === '') return null
    if (link.kind === 'markdown') return normKey(stripMd(posix.join(dirOf(source), link.target)))
    return normKey(stripMd(link.target.replace(/^\/+/, '')))
  }

  resolve(source: string, link: Pick<LinkRef, 'kind' | 'target' | 'anchor'>): Resolution {
    if (link.target === '') return this.withAnchor(source, link.anchor, 'self')
    const key = LinkIndex.keyOf(source, link)!

    if (link.kind === 'markdown' || link.target.startsWith('/')) {
      // Relative path (Markdown) or absolute from the root (`[[/folder/Note]]`):
      // exact full-path match, no heuristics.
      const hits = [...(this.byPath.get(key) ?? [])].filter((p) => normKey(stripMd(p)) === key)
      return hits.length === 1 ? this.withAnchor(hits[0]!, link.anchor, 'path') : { status: 'missing' }
    }

    const byPath = this.pick(source, this.byPath.get(key))
    if (byPath) return byPath.status === 'resolved' ? this.withAnchor(byPath.path, link.anchor, 'path') : byPath
    const byAlias = this.pick(source, this.byAlias.get(key))
    if (byAlias) return byAlias.status === 'resolved' ? this.withAnchor(byAlias.path, link.anchor, 'alias') : byAlias
    return { status: 'missing' }
  }

  /** Tie-break: the deepest common ancestor wins; then the shallowest one below it. */
  private pick(source: string, set: Set<string> | undefined): { status: 'resolved'; path: string } | { status: 'ambiguous'; candidates: string[] } | null {
    if (!set || set.size === 0) return null
    const candidates = [...set]
    if (candidates.length === 1) return { status: 'resolved', path: candidates[0]! }
    const src = segments(dirOf(source))
    const score = (p: string) => {
      const dst = segments(dirOf(p))
      let common = 0
      while (common < src.length && common < dst.length && src[common] === dst[common]) common++
      return { common, below: dst.length - common }
    }
    const scored = candidates.map((p) => ({ p, ...score(p) }))
    const maxCommon = Math.max(...scored.map((s) => s.common))
    const deepest = scored.filter((s) => s.common === maxCommon)
    const minBelow = Math.min(...deepest.map((s) => s.below))
    const best = deepest.filter((s) => s.below === minBelow)
    if (best.length === 1) return { status: 'resolved', path: best[0]!.p }
    return { status: 'ambiguous', candidates: best.map((s) => s.p).sort() }
  }

  private withAnchor(path: string, anchor: string | null, via: 'path' | 'alias' | 'self'): Resolution {
    if (anchor === null) return { status: 'resolved', path, anchor: null, via }
    const headings = this.notes.get(path)?.headings ?? []
    const ok = headings.some((h) => normKey(h) === normKey(anchor))
    return { status: 'resolved', path, anchor: ok ? 'ok' : 'missing', via }
  }
}

function add(map: Map<string, Set<string>>, key: string, path: string, affected: Set<string>) {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(path)
  affected.add(key)
}

function remove(map: Map<string, Set<string>>, key: string, path: string, affected: Set<string>) {
  const set = map.get(key)
  if (!set) return
  set.delete(path)
  if (set.size === 0) map.delete(key)
  affected.add(key)
}
