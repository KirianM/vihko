// Edits by operation: applied to the current text atomically, without
// requiring that the rest of the note hasn't changed. This is what lets an
// agent write to a note while someone else is editing it (the ETag changes
// on every keystroke, so a full replacement with If-Match would never match).
import { FrontmatterError, extract, normKey, setFrontmatterKey, type ScalarValue } from '@vihko/core'
import { NoteError } from './notes.ts'

export type EditOp =
  /** Replaces `find` (exact text) with `replace`. Fails if it doesn't appear exactly `expectedCount` times (1 by default). */
  | { op: 'find_replace'; find: string; replace: string; expectedCount?: number }
  /** Appends text to the end of the note (with a newline if needed). */
  | { op: 'append'; text: string }
  /**
   * Adds text at the end of a section: after its last non-blank line, before
   * the next heading of the same level or above. `heading`: its text, or with
   * its level (`## Tasks`) when the same text appears at several levels.
   */
  | { op: 'append_under_heading'; heading: string; text: string }
  /** Replaces what is under a heading (its section, subsections included), keeping the heading line. */
  | { op: 'replace_section'; heading: string; text: string }
  /**
   * Sets a top-level frontmatter key to a scalar or a list of them, touching
   * only that value's bytes (the block is created if the note has none).
   */
  | { op: 'set_frontmatter'; key: string; value: ScalarValue | ScalarValue[] }

/**
 * A change at an exact place: `remove` characters at `at`, then `insert`.
 * On an open note it's applied as it is, not recomputed as a diff of the
 * whole text: a diff may take characters someone is typing next to it as
 * part of the change, and the two texts end up interleaved.
 */
export interface Splice {
  at: number
  remove: number
  insert: string
}

/**
 * Replacing `text[from, to)` with `insert`, leaving out of the splice the
 * characters the replacement keeps at either end (they keep their identity
 * for anyone editing next to them).
 */
export function spliceOf(text: string, from: number, to: number, insert: string): Splice {
  const old = text.slice(from, to)
  let p = 0
  while (p < old.length && p < insert.length && old[p] === insert[p]) p++
  let q = 0
  while (q < old.length - p && q < insert.length - p && old[old.length - 1 - q] === insert[insert.length - 1 - q]) q++
  return { at: from + p, remove: old.length - p - q, insert: insert.slice(p, insert.length - q) }
}

/** Applies splices in order: each one to the text left by the previous ones. */
export function applySplices(text: string, splices: readonly Splice[]): string {
  let out = text
  for (const s of splices) out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove)
  return out
}

/** The operations as splices, in order (see `applySplices`). */
export function planEdits(text: string, ops: EditOp[]): Splice[] {
  let out = text
  const splices: Splice[] = []
  const push = (s: Splice) => {
    splices.push(s)
    out = applySplices(out, [s])
  }
  for (const [i, e] of ops.entries()) {
    if (e.op === 'find_replace') {
      if (!e.find) throw new NoteError('edit_mismatch', `operation ${i}: empty find`)
      const expected = e.expectedCount ?? 1
      const at: number[] = []
      for (let k = out.indexOf(e.find); k !== -1; k = out.indexOf(e.find, k + e.find.length)) at.push(k)
      if (at.length !== expected) {
        throw new NoteError('edit_mismatch', `operation ${i}: expected ${expected} occurrences, found ${at.length}`)
      }
      // From the last one: the earlier positions stay valid.
      for (const k of at.reverse()) push(spliceOf(out, k, k + e.find.length, e.replace))
    } else if (e.op === 'append') {
      push({ at: out.length, remove: 0, insert: (out === '' || out.endsWith('\n') ? '' : '\n') + e.text })
    } else if ((e.op === 'append_under_heading' || e.op === 'replace_section') && typeof e.text !== 'string') {
      throw new NoteError('edit_mismatch', `operation ${i}: text must be text`)
    } else if (e.op === 'append_under_heading') {
      const s = section(out, e.heading, i)
      // After the last line with something on it before any subheading: blank lines stay between it and what follows.
      let at = s.ownEnd
      while (at > s.bodyStart) {
        const prev = out.lastIndexOf('\n', at - 2) + 1
        if (out.slice(prev, at).trim() !== '') break
        at = prev
      }
      const lead = at > 0 && out[at - 1] !== '\n' ? '\n' : ''
      push({ at, remove: 0, insert: lead + e.text + (e.text.endsWith('\n') ? '' : '\n') })
    } else if (e.op === 'replace_section') {
      const s = section(out, e.heading, i)
      let body = e.text === '' || e.text.endsWith('\n') ? e.text : e.text + '\n'
      // A blank line before the heading that follows, as the section had it.
      if (s.end < out.length && body !== '' && !body.endsWith('\n\n')) body += '\n'
      const lead = s.bodyStart > 0 && out[s.bodyStart - 1] !== '\n' ? '\n' : ''
      push(spliceOf(out, s.bodyStart, s.end, lead + body))
    } else if (e.op === 'set_frontmatter') {
      if (typeof e.key !== 'string' || !e.key.trim()) throw new NoteError('edit_mismatch', `operation ${i}: empty key`)
      const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      if (!(scalar(e.value) || (Array.isArray(e.value) && e.value.every(scalar)))) {
        throw new NoteError('edit_mismatch', `operation ${i}: the value must be text, a number, true/false or a list of them`)
      }
      let next: string
      try {
        next = setFrontmatterKey(out, e.key, e.value)
      } catch (err) {
        if (err instanceof FrontmatterError) throw new NoteError('edit_mismatch', `operation ${i}: ${err.message}`)
        throw err
      }
      push(spliceOf(out, 0, out.length, next))
    } else {
      throw new NoteError('edit_mismatch', `operation ${i}: unknown type`)
    }
  }
  return splices
}

/**
 * The section under a heading: `bodyStart` right after the heading's line
 * (both lines of a setext heading), `end` where the next heading of the same
 * level or above starts, or the end of the note; `ownEnd`, where its own text
 * ends (the first subheading, or `end`). The heading is found by its text
 * (case and spacing aside); `## Text` also asks for its level. None or
 * several: `edit_mismatch`.
 */
function section(text: string, heading: string, i: number): { bodyStart: number; end: number; ownEnd: number } {
  if (typeof heading !== 'string' || !heading.trim()) throw new NoteError('edit_mismatch', `operation ${i}: empty heading`)
  const m = /^\s*(#{1,6})\s+(.*)$/.exec(heading)
  const level = m ? m[1]!.length : null
  const want = normKey((m ? m[2]! : heading).replace(/\s+#+\s*$/, ''))
  const headings = extract(text).headings
  const found = headings.filter((h) => normKey(h.text) === want && (level === null || h.level === level))
  if (found.length !== 1) {
    throw new NoteError('edit_mismatch', `operation ${i}: expected 1 heading "${heading}", found ${found.length}`)
  }
  const h = found[0]!
  let bodyStart = lineEnd(text, h.from)
  // A setext heading is underlined on the next line.
  if (!/^\s{0,3}#/.test(text.slice(h.from, bodyStart)) && /^\s{0,3}(=+|-+)\s*$/.test(text.slice(bodyStart, lineEnd(text, bodyStart)).replace(/\n$/, ''))) {
    bodyStart = lineEnd(text, bodyStart)
  }
  const next = headings.find((x) => x.from > h.from && x.level <= h.level)
  const end = next ? next.from : text.length
  const sub = headings.find((x) => x.from > h.from)
  return { bodyStart, end, ownEnd: sub && sub.from < end ? sub.from : end }
}

/** Offset right after the line that holds `at` (its `\n` included), or the end of the text. */
function lineEnd(text: string, at: number): number {
  const nl = text.indexOf('\n', at)
  return nl === -1 ? text.length : nl + 1
}

export function applyEdits(text: string, ops: EditOp[]): string {
  return applySplices(text, planEdits(text, ops))
}
