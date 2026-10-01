// Link resolution. An in-memory key index: each note contributes all the
// suffixes of its path without the extension, plus its aliases, normalized.
// It's the model for the indexer's `link_keys` table and also serves the editor.
// Browser-safe entry point (@vihko/core/resolve): no Node modules here.
//
// With spaces, what a link means depends only on the file and the space it
// is in, never on who reads it, and a link never leaves its note's space:
// 1. an empty target (`[[#Heading]]`) is the note itself;
// 2. a relative Markdown link, or `[[/path]]`, is an exact path, which
//    leads to a note only when that note is in the source's space;
// 3. a wikilink whose first segment is `people` or `spaces` (and has more
//    after it) is an exact path from the notes root, also only within the
//    source's space: `[[spaces/…]]` into another space is broken;
// 4. any other wikilink (a name or a path suffix) resolves only among the
//    notes of the source's space, by proximity, then by their
//    aliases, also of that space and without proximity (an alias several
//    notes share is ambiguous). An alias never beats a name or a path.
// A link that would reach another space is broken: exactly what a link to a
// note that doesn't exist looks like, so links can't probe what exists
// elsewhere. Notes in no space (the
// layout before spaces) form one group of their own, so there everything
// resolves as it always did.
import { caseFold } from './casefold.ts'
import type { LinkRef } from './markdown.ts'
import { PEOPLE, SPACES, spaceRootOf } from './spaces.ts'

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

/** Key normalization: NFC, full Unicode case folding, no extra whitespace. */
export const normKey = (s: string) => caseFold(s).trim().replace(/\s+/g, ' ')

const stripMd = (p: string) => (/\.md$/i.test(p) ? p.slice(0, -3) : p)
const dirOf = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const segments = (dir: string) => (dir === '' ? [] : dir.split('/'))

/** `posix.join(dir, rel)` for relative note paths: `.` and `..` folded, empty segments dropped. */
export function joinPath(dir: string, rel: string): string {
  const out: string[] = []
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/') || '.'
}

/** Path keys for a note: all its suffixes (`plan`, `vihko/plan`, `projects/vihko/plan`). */
export function pathKeys(path: string): string[] {
  const parts = normKey(stripMd(path)).split('/')
  return parts.map((_, i) => parts.slice(i).join('/'))
}

/**
 * The group a note's names resolve in (rule 4): the root of its space
 * (`people/ana`, `spaces/Home`), or `''` for a note in no space.
 */
export function linkSpace(path: string): string {
  return spaceRootOf(path) ?? ''
}

const ROOT_SEGMENTS = new Set([normKey(PEOPLE), normKey(SPACES)])

/**
 * Whether a wikilink target is written from the notes root (rule 3): its
 * first segment is `people` or `spaces` (in any case, as links are compared)
 * and something follows it. `[[people]]` alone is a note's name.
 */
export function isRootTarget(target: string): boolean {
  const t = target.replace(/^\/+/, '')
  const slash = t.indexOf('/')
  return slash > 0 && ROOT_SEGMENTS.has(normKey(t.slice(0, slash)))
}

export interface LinkIndexOptions {
  /** Whether aliases resolve links (vihko.yaml `links.aliases`, on by default). They're kept either way. */
  aliases?: boolean
}

export class LinkIndex {
  private byPath = new Map<string, Set<string>>()
  private byAlias = new Map<string, Set<string>>()
  private notes = new Map<string, NoteKeys>()
  /** Each note's space (linkSpace), worked out once. */
  private spaces = new Map<string, string>()
  /** Whether aliases resolve links, as a last resort after names and paths. */
  aliases: boolean

  constructor(opts: LinkIndexOptions = {}) {
    this.aliases = opts.aliases ?? true
  }

  has(path: string) {
    return this.notes.has(path)
  }

  get(path: string): NoteKeys | undefined {
    return this.notes.get(path)
  }

  /** An independent copy, to simulate a change (e.g. a rename) without touching the original. */
  clone(): LinkIndex {
    const c = new LinkIndex({ aliases: this.aliases })
    for (const n of this.notes.values()) c.set(n)
    return c
  }

  /** Adds or replaces a note. Returns the affected keys (to re-resolve links). */
  set(note: NoteKeys): Set<string> {
    const affected = this.delete(note.path)
    this.notes.set(note.path, note)
    this.spaces.set(note.path, linkSpace(note.path))
    for (const k of pathKeys(note.path)) add(this.byPath, k, note.path, affected)
    for (const a of note.aliases ?? []) add(this.byAlias, normKey(a), note.path, affected)
    return affected
  }

  delete(path: string): Set<string> {
    const affected = new Set<string>()
    const old = this.notes.get(path)
    if (!old) return affected
    this.notes.delete(path)
    this.spaces.delete(path)
    for (const k of pathKeys(path)) remove(this.byPath, k, path, affected)
    for (const a of old.aliases ?? []) remove(this.byAlias, normKey(a), path, affected)
    return affected
  }

  /** A link's lookup key, to tell whether a key change affects it. */
  static keyOf(source: string, link: Pick<LinkRef, 'kind' | 'target'>): string | null {
    if (link.target === '') return null
    if (link.kind === 'markdown') return normKey(stripMd(joinPath(dirOf(source), link.target)))
    return normKey(stripMd(link.target.replace(/^\/+/, '')))
  }

  resolve(source: string, link: Pick<LinkRef, 'kind' | 'target' | 'anchor'>): Resolution {
    if (link.target === '') return this.withAnchor(source, link.anchor, 'self')
    const key = LinkIndex.keyOf(source, link)!

    if (link.kind === 'markdown' || link.target.startsWith('/') || isRootTarget(link.target)) {
      // Relative path (Markdown), absolute from the root (`[[/folder/Note]]`)
      // or from the notes root (`[[spaces/Home/Note]]`): exact
      // full-path match, no heuristics, and only in the source's own space.
      const space = linkSpace(source)
      const hits = this.inSpace(this.byPath.get(key), space).filter((p) => normKey(stripMd(p)) === key)
      return hits.length === 1 ? this.withAnchor(hits[0]!, link.anchor, 'path') : { status: 'missing' }
    }

    // A name or a path suffix: only among the notes of the source's space.
    const space = linkSpace(source)
    const byPath = this.pick(source, this.inSpace(this.byPath.get(key), space))
    if (byPath) return byPath.status === 'resolved' ? this.withAnchor(byPath.path, link.anchor, 'path') : byPath
    // Then aliases, without proximity: one note's alias leads to it; one shared by several notes is
    // ambiguous, however near one of them is. So a note that takes an alias never captures a link
    // another note's alias resolves (whoever writes it may not even see that note); the
    // link shows its candidates, and a name or a path (which beat aliases) fixes it.
    const byAlias = this.aliases ? this.inSpace(this.byAlias.get(key), space) : []
    if (byAlias.length === 1) return this.withAnchor(byAlias[0]!, link.anchor, 'alias')
    if (byAlias.length > 1) return { status: 'ambiguous', candidates: byAlias.sort() }
    return { status: 'missing' }
  }

  /** The paths of `set` in the space whose root is `space` (linkSpace). */
  private inSpace(set: Set<string> | undefined, space: string): string[] {
    if (!set) return []
    const out: string[] = []
    for (const p of set) if ((this.spaces.get(p) ?? linkSpace(p)) === space) out.push(p)
    return out
  }

  /** Tie-break: the deepest common ancestor wins; then the shallowest one below it. */
  private pick(source: string, candidates: string[]): { status: 'resolved'; path: string } | { status: 'ambiguous'; candidates: string[] } | null {
    if (candidates.length === 0) return null
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

/**
 * The shortest wikilink target that, written in `source`, resolves to `path`:
 * the name, then progressively longer path suffixes, which ends at the path
 * from the notes root (never with a leading `/`: Obsidian doesn't read
 * that). The absolute `/folder/Note` only as a last resort, for a
 * note in no space. Without the `.md` extension. A note of another space
 * has no such target (links never cross spaces): what this returns then resolves nowhere,
 * and callers check (`sameSpace`).
 *
 * `opts.whole`: whether `index` holds every note under a folder (all of
 * them by default: the server's index does). A reader who sees only part of
 * a space (a folder shared from someone's) has an index without the notes
 * they can't see, which a name might reach: a shorter form is only safe when
 * `source` and `path` share a folder the index holds whole (then the
 * nearest note wins, and every note that near is in it). Otherwise the path
 * from the root, which means the same for everyone.
 */
export function shortestTarget(index: LinkIndex, source: string, path: string, opts: { whole?: (folder: string) => boolean } = {}): string {
  const parts = stripMd(path).split('/')
  const partial = opts.whole !== undefined && linkSpace(path) === linkSpace(source) && linkSpace(path) !== '' && !opts.whole(commonFolder(source, path))
  for (let i = partial ? 0 : parts.length - 1; i >= 0; i--) {
    const target = parts.slice(i).join('/')
    const r = index.resolve(source, { kind: 'wiki', target, anchor: null })
    if (r.status === 'resolved' && r.path === path) return target
  }
  return '/' + parts.join('/')
}

/** The deepest folder two paths share (`''` for the root). */
function commonFolder(a: string, b: string): string {
  const x = segments(dirOf(a))
  const y = segments(dirOf(b))
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return x.slice(0, n).join('/')
}

/** Whether a link in `source` may lead to `path` at all: both in the same space. */
export function sameSpace(source: string, path: string): boolean {
  return linkSpace(source) === linkSpace(path)
}

/**
 * How vihko writes a wikilink to `path` in `source`, a note of the same
 * space (never across spaces): the shortest target
 * (`shortestTarget`, with its `opts`) and, when that target had to be the
 * path from the notes root (a reader who sees only part of the space, a
 * folder shared from someone's), the visible text: the note's name, so that
 * vihko, Obsidian and other editors show `trip`, not `people/ana/trips/trip`.
 * Null otherwise, where the name is already what shows.
 */
export function wikiLink(index: LinkIndex, source: string, path: string, opts: { whole?: (folder: string) => boolean } = {}): { target: string; display: string | null } {
  const target = shortestTarget(index, source, path, opts)
  return { target, display: isRootTarget(target) ? noteName(path) : null }
}

/** A note's name: the last segment of its path, without `.md`. */
export function noteName(path: string): string {
  return stripMd(path.slice(path.lastIndexOf('/') + 1))
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
