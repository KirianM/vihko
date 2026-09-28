import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type StateCommand } from '@codemirror/state'
import { vihkoSyntax } from '@vihko/core/syntax'
import { continuedMarker, insertNewlineContinueTask, toggleAt, toggleTask } from '../src/editor/tasks.ts'

test('toggleAt: one character between the brackets, and nothing else', () => {
  assert.deepEqual(toggleAt('- [ ] tea', 2), { from: 3, to: 4, insert: 'x' })
  assert.deepEqual(toggleAt('- [x] tea', 2), { from: 3, to: 4, insert: ' ' })
  assert.deepEqual(toggleAt('- [X] tea', 2), { from: 3, to: 4, insert: ' ' })
  assert.equal(toggleAt('- [-] tea', 2), null)
  assert.equal(toggleAt('- tea', 2), null)
})

test('continuedMarker: a list marker and nothing else before the cursor', () => {
  assert.equal(continuedMarker('- '), true)
  assert.equal(continuedMarker('  * '), true)
  assert.equal(continuedMarker('> 12. '), true)
  assert.equal(continuedMarker('- tea'), false)
  assert.equal(continuedMarker(''), false)
})

/** Runs a command on `doc` with the cursor at `|` and returns the result with the cursor marked. */
function run(cmd: StateCommand, doc: string): string | null {
  const at = doc.indexOf('|')
  let state = EditorState.create({
    doc: doc.slice(0, at) + doc.slice(at + 1),
    selection: { anchor: at },
    extensions: markdown({ base: markdownLanguage, extensions: vihkoSyntax }),
  })
  let done = false
  cmd({ state, dispatch: (tr) => { state = tr.state; done = true } })
  if (!done) return null
  const head = state.selection.main.head
  const text = state.doc.toString()
  return text.slice(0, head) + '|' + text.slice(head)
}

test('Enter on a task continues with an unchecked task', () => {
  assert.equal(run(insertNewlineContinueTask, '- [ ] tea|'), '- [ ] tea\n- [ ] |')
  assert.equal(run(insertNewlineContinueTask, '- [x] tea|'), '- [x] tea\n- [ ] |')
  assert.equal(run(insertNewlineContinueTask, '* [ ] te|a'), '* [ ] te\n* [ ] |a')
  assert.equal(run(insertNewlineContinueTask, '1. [ ] one|'), '1. [ ] one\n2. [ ] |')
  assert.equal(run(insertNewlineContinueTask, '- a\n  - [ ] nested|'), '- a\n  - [ ] nested\n  - [ ] |')
})

test('Enter on an empty task ends the list like an empty item', () => {
  assert.equal(run(insertNewlineContinueTask, '- [ ] a\n- [ ] b\n- [ ] |'), '- [ ] a\n- [ ] b\n|')
  // Same as lang-markdown with plain items, whatever it does (here: a loose second item).
  const plain = run(insertNewlineContinueTask, '- a\n- |')!.replace('- a', '- [ ] a')
  assert.equal(run(insertNewlineContinueTask, '- [ ] a\n- [ ] |'), plain)
})

test('Enter outside tasks is plain markup continuation', () => {
  assert.equal(run(insertNewlineContinueTask, '- tea|'), '- tea\n- |')
  assert.equal(run(insertNewlineContinueTask, '```\n- [ ] code|\n```'), null)
})

test('toggleTask: the task on the cursor line, one character', () => {
  assert.equal(run(toggleTask, '- [ ] t|ea'), '- [x] t|ea')
  assert.equal(run(toggleTask, '  1. [x] tea|'), '  1. [ ] tea|')
  assert.equal(run(toggleTask, '- tea|'), null)
  assert.equal(run(toggleTask, '```\n- [ ] code|\n```'), null)
})
