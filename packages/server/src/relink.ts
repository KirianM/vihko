// Link rewriting when moving or renaming a note. Rule: a rename never changes
// the destination of an existing link. For each link that resolved to a note,
// we check where it resolves after the change; if it differs, it's rewritten
// with the shortest form that still points to its destination.
import { posix } from 'node:path'
import { extract, markdownDest, resolveImageRef, shortestTarget, type ImageLink, type LinkIndex, type LinkRef, type Resolution } from '@vihko/core'

export interface Replacement {
  from: number
  to: number
  text: string
}

/**
 * Replacements so a note's links keep their destination.
 * `srcBefore`/`srcAfter`: the note's path before and after (they differ if it's the moved note).
 * `map`: destination before → destination after (the moved note changes path; the rest don't).
 */
export function planRelinks(
  text: string,
  srcBefore: string,
  srcAfter: string,
  before: LinkIndex,
  after: LinkIndex,
  map: (path: string) => string,
): Replacement[] {
  return planLinks(text, srcBefore, srcAfter, before, after, map).reps
}

/** A link's resolution as a report shows it: where it leads, among which notes it is ambiguous, or broken. */
export type LinkState =
  | { status: 'resolved'; path: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'missing' }

/**
 * How a move changes a link it doesn't rewrite (D-019: an ambiguous link is
 * never resolved silently). Stable codes, the UI words them:
 * - `resolves`: it was ambiguous or broken and will lead to a note.
 * - `ambiguous`: it will be ambiguous (it was broken, or led to a note it can't keep).
 * - `retargets`: it led to a note and will lead to another one.
 * - `breaks`: it will lead nowhere.
 * An ambiguous link that stays ambiguous (among other candidates) is not a shift.
 */
export type ShiftCode = 'resolves' | 'ambiguous' | 'retargets' | 'breaks'

/** `before` in the paths before the move, `after` in the paths after it. */
export interface Shift {
  raw: string
  code: ShiftCode
  before: LinkState
  after: LinkState
}

const stateOf = (r: Resolution): LinkState =>
  r.status === 'resolved' ? { status: 'resolved', path: r.path } : r.status === 'ambiguous' ? { status: 'ambiguous', candidates: r.candidates } : { status: 'missing' }

/**
 * The replacements that keep a note's links on their destination, and the
 * links whose resolution the move changes all the same (`shifts`): those that
 * weren't resolved before (ambiguous or broken) and are now, or are broken
 * now, and the rare resolved one no rewrite can keep. Those links are not
 * rewritten: the preview lists them so whoever moves decides.
 */
export function planLinks(
  text: string,
  srcBefore: string,
  srcAfter: string,
  before: LinkIndex,
  after: LinkIndex,
  map: (path: string) => string,
): { reps: Replacement[]; shifts: Shift[] } {
  const reps: Replacement[] = []
  const shifts: Shift[] = []
  for (const link of extract(text).links) {
    const rb = before.resolve(srcBefore, link)
    const ra = after.resolve(srcAfter, link)
    if (rb.status === 'resolved') {
      const want = map(rb.path)
      if (ra.status === 'resolved' && ra.path === want) continue
      const raw = rewriteLink(link, srcAfter, want, after)
      if (raw !== null) {
        if (raw !== link.raw) reps.push({ from: link.from, to: link.to, text: raw })
        continue
      }
      // No form of the link reaches its destination any more: it is left as it is, and said.
      const code: ShiftCode = ra.status === 'resolved' ? 'retargets' : ra.status === 'ambiguous' ? 'ambiguous' : 'breaks'
      shifts.push({ raw: link.raw, code, before: stateOf(rb), after: stateOf(ra) })
      continue
    }
    if (ra.status === rb.status) continue // still broken, or still ambiguous (maybe among other candidates)
    const code: ShiftCode = ra.status === 'resolved' ? 'resolves' : ra.status === 'ambiguous' ? 'ambiguous' : 'breaks'
    shifts.push({ raw: link.raw, code, before: stateOf(rb), after: stateOf(ra) })
  }
  return { reps, shifts }
}

/**
 * Links in a note to `from` that still reach `to` without being touched (through
 * an alias, or because the name does not change). For the preview: what is not
 * rewritten.
 */
export function keptLinks(text: string, src: string, before: LinkIndex, after: LinkIndex, from: string, to: string): { raw: string; via: 'path' | 'alias' }[] {
  const out: { raw: string; via: 'path' | 'alias' }[] = []
  for (const link of extract(text).links) {
    const rb = before.resolve(src, link)
    if (rb.status !== 'resolved' || rb.path !== from) continue
    const ra = after.resolve(src, link)
    if (ra.status === 'resolved' && ra.path === to) out.push({ raw: link.raw, via: ra.via === 'alias' ? 'alias' : 'path' })
  }
  return out
}

/** A rewrite of an image reference: the span of its destination, and the whole reference before and after (for the preview). */
export interface ImageReplacement extends Replacement {
  before: string
  after: string
}

const isWiki = (img: ImageLink) => img.kind === 'embed' || img.kind === 'wiki'

/**
 * Replacements so a moved note's image references keep reaching their image.
 * `place`: where each image is after the move (its own path if it stays).
 * External URLs and references that leave the notes folder are not touched.
 */
export function planImageRelinks(
  text: string,
  srcBefore: string,
  srcAfter: string,
  place: (path: string) => string,
  /** Rewrites only the references for which it says yes: where the image is wanted and where the reference leads now. */
  onlyIf?: (want: string, now: string | null) => boolean,
): ImageReplacement[] {
  const out: ImageReplacement[] = []
  for (const img of extract(text).images) {
    const was = resolveImageRef(srcBefore, img.dest, { embed: isWiki(img) })
    if (was === null) continue
    const want = place(was)
    const now = resolveImageRef(srcAfter, img.dest, { embed: isWiki(img) })
    if (now === want || (onlyIf && !onlyIf(want, now))) continue
    const dest = imageDest(img, srcAfter, want)
    const after = img.raw.slice(0, img.destFrom - img.from) + dest + img.raw.slice(img.destTo - img.from)
    out.push({ from: img.destFrom, to: img.destTo, text: dest, before: img.raw, after })
  }
  return out
}

/**
 * How a note at `src` writes a reference to the image at `path`, in the style
 * of `img`: from the root if it was written from the root; otherwise relative
 * (Markdown, encoded), or for embeds relative only while it doesn't climb out
 * of the note's folder (`/path` from the root if it would). The `?query` or
 * `#anchor` of a Markdown destination is kept.
 */
function imageDest(img: ImageLink, src: string, path: string): string {
  const bare = img.dest.replace(/^<|>$/g, '')
  const fromRoot = bare.startsWith('/')
  const rel = posix.relative(posix.dirname(src), path)
  if (isWiki(img)) return fromRoot || rel.startsWith('../') ? '/' + path : rel
  const suffix = /[?#].*$/.exec(bare)?.[0] ?? ''
  const dest = markdownDest(fromRoot ? '/' + path : rel) + suffix
  return img.dest.startsWith('<') ? `<${dest}>` : dest
}

/**
 * Link resolution as it was before notes moved outside vihko (D-031.4): a
 * copy of `now` with each moved note back at its old path, its aliases and
 * headings as they are now.
 */
export function beforeMoves(now: LinkIndex, moves: readonly { from: string; to: string }[]): LinkIndex {
  const before = now.clone()
  for (const m of moves) before.delete(m.to)
  for (const m of moves) {
    const keys = now.get(m.to)
    if (keys) before.set({ ...keys, path: m.from })
  }
  return before
}

export function applyReplacements(text: string, reps: Replacement[]): string {
  let out = text
  for (const r of [...reps].sort((a, b) => b.from - a.from)) out = out.slice(0, r.from) + r.text + out.slice(r.to)
  return out
}

/**
 * The link written so that, in `src`, it reaches `want`: a Markdown link by
 * its relative path, a wikilink by the shortest target that resolves there
 * (`shortestTarget`), keeping its anchor (`#…`) and visible text (`|…`).
 * Null if no form of it reaches `want`.
 */
export function rewriteLink(link: LinkRef, src: string, want: string, index: LinkIndex): string | null {
  if (link.kind === 'markdown') {
    const open = link.raw.indexOf('](')
    const url = link.raw.slice(open + 2, -1)
    const hash = url.indexOf('#')
    const rel = posix.relative(posix.dirname(src), want)
    return link.raw.slice(0, open + 2) + rel.replace(/ /g, '%20') + (hash === -1 ? '' : url.slice(hash)) + ')'
  }
  // Wikilink: name, progressively longer path suffixes, and finally the absolute path.
  const target = shortestTarget(index, src, want)
  const r = index.resolve(src, { kind: 'wiki', target, anchor: null })
  if (r.status !== 'resolved' || r.path !== want) return null
  const start = link.raw.indexOf(link.target, link.kind === 'embed' ? 3 : 2)
  return link.raw.slice(0, start) + target + link.raw.slice(start + link.target.length)
}
