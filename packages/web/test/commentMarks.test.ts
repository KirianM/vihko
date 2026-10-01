import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorSelection, EditorState } from '@codemirror/state'
import { commentMarks } from '../src/editor/commentMarks.ts'
import { livePreview } from '../src/editor/livePreview.ts'
import { formatComment, parseThreads } from '../src/editor/comments.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A line with a comment at its end, as the editor keeps it. */
function aLine() {
  const text = `${m.aParagraph()} ${formatComment(m.aUsername(), new Date(Date.UTC(2026, 8, 1)), m.aSentence())}\n`
  const t = parseThreads(text)[0]!
  return { text, t }
}

test('comments: the keyboard never leaves the cursor inside a comment\'s syntax; a click may', () => {
  const { text, t } = aLine()
  const s = EditorState.create({ doc: text, selection: EditorSelection.cursor(0), extensions: [livePreview, commentMarks] })
  const inside = t.from + Math.floor((t.to - t.from) / 2)
  // «End» or → into it: to its end; ← into it from after: to its start.
  assert.equal(s.update({ selection: EditorSelection.cursor(inside), userEvent: 'select' }).state.selection.main.head, t.to)
  const after = EditorState.create({ doc: text, selection: EditorSelection.cursor(t.to), extensions: [livePreview, commentMarks] })
  assert.equal(after.update({ selection: EditorSelection.cursor(inside), userEvent: 'select' }).state.selection.main.head, t.from)
  // Shift+End: the selection reaches past it, never into it.
  const sel = s.update({ selection: EditorSelection.range(0, inside), userEvent: 'select' }).state.selection.main
  assert.deepEqual([sel.anchor, sel.head], [0, t.to])
  // A click where it shows: left there, to edit it.
  assert.equal(s.update({ selection: EditorSelection.cursor(inside), userEvent: 'select.pointer' }).state.selection.main.head, inside)
  // Anywhere else, as asked.
  assert.equal(s.update({ selection: EditorSelection.cursor(t.from - 1), userEvent: 'select' }).state.selection.main.head, t.from - 1)
})
