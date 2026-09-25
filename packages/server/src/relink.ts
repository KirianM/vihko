// Link rewriting when moving or renaming a note. Rule: a rename never changes
// the destination of an existing link. For each link that resolved to a note,
// we check where it resolves after the change; if it differs, it's rewritten
// with the shortest form that still points to its destination.
import { posix } from 'node:path'
import { extract, type LinkIndex, type LinkRef } from '@thoth/core'

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
  const out: Replacement[] = []
  for (const link of extract(text).links) {
    const rb = before.resolve(srcBefore, link)
    if (rb.status !== 'resolved') continue
    const want = map(rb.path)
    const ra = after.resolve(srcAfter, link)
    if (ra.status === 'resolved' && ra.path === want) continue
    const raw = rewrite(link, srcAfter, want, after)
    if (raw !== null && raw !== link.raw) out.push({ from: link.from, to: link.to, text: raw })
  }
  return out
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

export function applyReplacements(text: string, reps: Replacement[]): string {
  let out = text
  for (const r of [...reps].sort((a, b) => b.from - a.from)) out = out.slice(0, r.from) + r.text + out.slice(r.to)
  return out
}

const stripMd = (p: string) => p.replace(/\.md$/i, '')

function rewrite(link: LinkRef, src: string, want: string, index: LinkIndex): string | null {
  if (link.kind === 'markdown') {
    const open = link.raw.indexOf('](')
    const url = link.raw.slice(open + 2, -1)
    const hash = url.indexOf('#')
    const rel = posix.relative(posix.dirname(src), want)
    return link.raw.slice(0, open + 2) + rel.replace(/ /g, '%20') + (hash === -1 ? '' : url.slice(hash)) + ')'
  }
  // Wikilink: name, progressively longer path suffixes, and finally the absolute path.
  const parts = stripMd(want).split('/')
  const candidates = [...parts.map((_, i) => parts.slice(parts.length - 1 - i).join('/')), '/' + parts.join('/')]
  const target = candidates.find((c) => {
    const r = index.resolve(src, { kind: 'wiki', target: c, anchor: null })
    return r.status === 'resolved' && r.path === want
  })
  if (!target) return null
  const start = link.raw.indexOf(link.target, link.kind === 'embed' ? 3 : 2)
  return link.raw.slice(0, start) + target + link.raw.slice(start + link.target.length)
}
