// Paths people type (D-056.29, rc.2): in a field that takes a note or a folder
// (purging, where something is moved, a new note's folders), a person types
// the path as they see it, «My notes / diary / day» or «Home/recipes/Bread»,
// in any case, and it is found as a link is: case doesn't matter, and the
// display form names the space. One match is used; several that differ only
// in case are offered to choose from; none is said. Only what the person can
// see is ever matched or offered (whatever they can't read never answers).
// The API stays exact: this is the interface's, before it asks the server.
// A real path (`people/<me>/…`), typed out of habit, is understood too, but
// nothing shows it.
import { normKey } from '@vihko/core/resolve'
import { PEOPLE, SPACES } from '@vihko/core/spaces'

/** What was typed, as path segments: split at `/` (spaces around it or not), each trimmed, empty ones dropped. */
export function typedSegments(text: string): string[] {
  return text.normalize('NFC').split('/').map((s) => s.trim()).filter((s) => s !== '')
}

const stripMd = (s: string) => s.replace(/\.md$/i, '')
/** A segment as compared: case folded, whitespace collapsed; the last one without `.md`. */
const key = (s: string, last: boolean) => normKey(last ? stripMd(s) : s)

/** The ways one space's root may be typed: `root` is the real one (`people/ana`), `names` what a person may write for it. */
export interface RootNames { root: string; names: string[] }

/** What the person typed, found: one path, several (that differ only in case: choose), or none. */
export type TypedMatch =
  | { status: 'one'; path: string }
  | { status: 'several'; paths: string[] }
  | { status: 'none' }

/**
 * The real paths `typed` names among `known` (real paths the person can
 * see: notes, files, folders), compared segment by segment in any case, the
 * first segments by any name of a space's root in `roots` (or the real
 * root). `.md` may be left out of a note's name.
 */
export function resolveTyped(typed: string, known: Iterable<string>, roots: readonly RootNames[]): TypedMatch {
  const segs = typedSegments(typed)
  if (segs.length === 0) return { status: 'none' }
  const found = new Set<string>()
  const list = [...known]
  for (const { root, inner } of splitRoots(segs, roots)) {
    const want = inner.map((s, i) => key(s, i === inner.length - 1))
    for (const p of list) {
      if (inner.length === 0 ? p !== root : !p.startsWith(root + '/')) continue
      const rest = inner.length === 0 ? [] : p.slice(root.length + 1).split('/')
      if (rest.length !== want.length) continue
      if (rest.every((s, i) => key(s, i === rest.length - 1) === want[i])) found.add(p)
    }
  }
  const paths = [...found].sort()
  return paths.length === 0 ? { status: 'none' } : paths.length === 1 ? { status: 'one', path: paths[0]! } : { status: 'several', paths }
}

/**
 * The real path `typed` would be if nothing matched: its first segments read
 * as a space's root (when they name exactly one root) and the rest as typed
 * (`.md` added when the last segment has none and `note`). For purging, by
 * the admin, what they can't read by its name. Null when no root is named, or
 * several are.
 */
export function guessTyped(typed: string, roots: readonly RootNames[], opts: { note?: boolean } = {}): string | null {
  const segs = typedSegments(typed)
  const hits = splitRoots(segs, roots)
  const rootsHit = new Set(hits.map((h) => h.root))
  if (rootsHit.size !== 1) return null
  // The longest name wins: «Home» and «Home/old» as two spaces' names.
  const { root, inner } = hits.reduce((a, b) => (a.inner.length <= b.inner.length ? a : b))
  if (inner.length === 0) return root
  if (inner.some((s) => s === '.' || s === '..')) return null
  const last = inner.at(-1)!
  const rest = opts.note && !/\.md$/i.test(last) ? [...inner.slice(0, -1), `${last}.md`] : inner
  return `${root}/${rest.join('/')}`
}

/** Each way the first segments name a root: the root, and what's left. */
function splitRoots(segs: string[], roots: readonly RootNames[]): { root: string; inner: string[] }[] {
  const out: { root: string; inner: string[] }[] = []
  const seen = new Set<string>()
  const add = (root: string, inner: string[]) => {
    const k = `${root}\0${inner.length}`
    if (!seen.has(k)) { seen.add(k); out.push({ root, inner }) }
  }
  for (const r of roots) {
    for (const name of [...r.names, r.root]) {
      const n = typedSegments(name)
      if (n.length === 0 || n.length > segs.length) continue
      if (n.every((s, i) => normKey(s) === normKey(segs[i]!))) add(r.root, segs.slice(n.length))
    }
  }
  return out
}

/** The folder a real path names in display segments: whether it names a root of the real layout (`people/…`, `spaces/…`). */
export const isRealRoot = (segment: string) => normKey(segment) === normKey(PEOPLE) || normKey(segment) === normKey(SPACES)

/**
 * A folder typed inside a place (where something is moved), matched against
 * the folders that are there (`known`, relative to the place), segment by
 * segment, as `resolveTyped`: each typed segment takes the spelling of the
 * one folder it names in any case; one that names none starts the new
 * folders, as typed. `several`: a segment names more than one folder (they
 * differ only in case): each choice, whole.
 */
export function alignFolder(typed: string, known: readonly string[]): { inner: string } | { several: string[] } {
  const segs = typedSegments(typed)
  const out: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const prefix = out.join('/')
    const here = new Set<string>()
    for (const f of known) {
      const parts = f.split('/')
      if (parts.length <= i || parts.slice(0, i).join('/') !== prefix) continue
      if (normKey(parts[i]!) === normKey(segs[i]!)) here.add(parts[i]!)
    }
    if (here.size === 0) return { inner: [...out, ...segs.slice(i)].join('/') }
    if (here.size > 1) {
      const rest = segs.slice(i + 1)
      return { several: [...here].sort().map((name) => [...out, name, ...rest].join('/')) }
    }
    out.push([...here][0]!)
  }
  return { inner: out.join('/') }
}
