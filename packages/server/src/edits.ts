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

export function applyEdits(text: string, ops: EditOp[]): string {
  let out = text
  for (const [i, e] of ops.entries()) {
    if (e.op === 'find_replace') {
      if (!e.find) throw new NoteError('edit_mismatch', `operation ${i}: empty find`)
      const expected = e.expectedCount ?? 1
      const count = out.split(e.find).length - 1
      if (count !== expected) {
        throw new NoteError('edit_mismatch', `operation ${i}: expected ${expected} occurrences, found ${count}`)
      }
      out = out.split(e.find).join(e.replace)
    } else if (e.op === 'append') {
      out += (out === '' || out.endsWith('\n') ? '' : '\n') + e.text
    } else {
      throw new NoteError('edit_mismatch', `operation ${i}: unknown type`)
    }
  }
  return out
}
