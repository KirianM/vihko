// A write planned on a text the note had a moment ago, applied to the text
// it has now. Someone typing in an open note changes its ETag on every
// keystroke, so a change planned on what an agent read rarely finds the same
// text when it arrives. When nothing changed since where the change goes,
// it's the same change in the text as it is now; when something did (in what
// it replaces, or right next to it), it isn't, and it's refused.
import diff from 'fast-diff'
import type { Splice } from './edits.ts'

/** `base[from, to)` replaced with `insert`, in the base text's positions. */
interface Replacement { from: number; to: number; insert: string }

/** What sequential splices (edits.ts) change in `base`: its ranges replaced, in order, none overlapping. */
export function replacementsOf(base: string, splices: readonly Splice[]): Replacement[] {
  // The text as it goes: runs of the base (by position) and inserted text.
  type Piece = { from: number; to: number } | { text: string }
  const pieces: Piece[] = base.length ? [{ from: 0, to: base.length }] : []
  const len = (p: Piece) => ('text' in p ? p.text.length : p.to - p.from)
  /** The index of the piece that starts at `at`, splitting one if needed (the end: the number of pieces). */
  const cut = (at: number): number => {
    let pos = 0
    for (let i = 0; i < pieces.length; i++) {
      if (pos === at) return i
      const p = pieces[i]!
      const l = len(p)
      if (at < pos + l) {
        const k = at - pos
        const parts: Piece[] = 'text' in p ? [{ text: p.text.slice(0, k) }, { text: p.text.slice(k) }] : [{ from: p.from, to: p.from + k }, { from: p.from + k, to: p.to }]
        pieces.splice(i, 1, ...parts)
        return i + 1
      }
      pos += l
    }
    return pieces.length
  }
  for (const s of splices) {
    const i = cut(s.at)
    const j = cut(s.at + s.remove)
    pieces.splice(i, j - i, ...(s.insert ? [{ text: s.insert }] : []))
  }
  const out: Replacement[] = []
  let pos = 0
  let inserted = ''
  for (const p of pieces) {
    if ('text' in p) { inserted += p.text; continue }
    if (p.from > pos || inserted) out.push({ from: pos, to: p.from, insert: inserted })
    inserted = ''
    pos = p.to
  }
  if (pos < base.length || inserted) out.push({ from: pos, to: base.length, insert: inserted })
  return out
}

/** What changes from `a` to `b`, as replacements of `a`'s ranges. */
function changesBetween(a: string, b: string): Replacement[] {
  const out: Replacement[] = []
  let pos = 0
  let open: Replacement | null = null
  for (const [op, chunk] of diff(a, b)) {
    if (op === diff.EQUAL) {
      if (open) { out.push(open); open = null }
      pos += chunk.length
      continue
    }
    open ??= { from: pos, to: pos, insert: '' }
    if (op === diff.DELETE) { pos += chunk.length; open.to = pos } else open.insert += chunk
  }
  if (open) out.push(open)
  return out
}

/**
 * `planned` (a change made on `base`: the new text, or splices) applied to
 * `current` instead, as splices; null when someone changed `base` where the
 * change goes since (a range it replaces, or one that touches it). A new
 * text is taken as one change, from its first difference with `base` to its last.
 */
export function rebase(base: string, planned: string | readonly Splice[], current: string): Splice[] | null {
  const mine = typeof planned === 'string' ? hull(base, planned) : replacementsOf(base, planned)
  const theirs = changesBetween(base, current)
  for (const a of mine) for (const o of theirs) if (o.from <= a.to && a.from <= o.to) return null
  const out: Splice[] = []
  // From the last one: the positions of those before it stay valid.
  for (const a of [...mine].reverse()) {
    let shift = 0
    for (const o of theirs) if (o.to < a.from) shift += o.insert.length - (o.to - o.from)
    out.push({ at: a.from + shift, remove: a.to - a.from, insert: a.insert })
  }
  return out
}

/** A new text as one replacement of `base`: from their first difference to their last (none if equal). */
function hull(base: string, next: string): Replacement[] {
  if (base === next) return []
  let p = 0
  while (p < base.length && p < next.length && base[p] === next[p]) p++
  let q = 0
  while (q < base.length - p && q < next.length - p && base[base.length - 1 - q] === next[next.length - 1 - q]) q++
  return [{ from: p, to: base.length - q, insert: next.slice(p, next.length - q) }]
}
