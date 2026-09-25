// Edits by operation: applied to the current text atomically, without
// requiring that the rest of the note hasn't changed. This is what lets an
// agent write to a note while someone else is editing it (the ETag changes
// on every keystroke, so a full replacement with If-Match would never match).
import { NoteError } from './notes.ts'

export type EditOp =
  /** Replaces `find` (exact text) with `replace`. Fails if it doesn't appear exactly `expectedCount` times (1 by default). */
  | { op: 'find_replace'; find: string; replace: string; expectedCount?: number }
  /** Appends text to the end of the note (with a newline if needed). */
  | { op: 'append'; text: string }

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
    } else {
      throw new NoteError('edit_mismatch', `operation ${i}: unknown type`)
    }
  }
  return splices
}

export function applyEdits(text: string, ops: EditOp[]): string {
  return applySplices(text, planEdits(text, ops))
}
