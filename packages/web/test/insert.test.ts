import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tag, wikilink, type Edit } from '../src/editor/insert.ts'

/** Applies the edit and marks the cursor with `|`, to compare against the expected text. */
const run = (doc: string, e: Edit) => {
  const out = doc.slice(0, e.from) + e.insert + doc.slice(e.to)
  return out.slice(0, e.cursor) + '|' + out.slice(e.cursor)
}

test('wikilink: empty brackets with the cursor inside, or around the selection with the cursor after', () => {
  assert.equal(run('see ', wikilink('see ', 4, 4)), 'see [[|]]')
  assert.equal(run('see Plan now', wikilink('see Plan now', 4, 8)), 'see [[Plan]]| now')
})

test('tag: a word boundary before the #, never glued to the previous word', () => {
  assert.equal(run('', tag('', 0, 0)), '#|')
  assert.equal(run('note ', tag('note ', 5, 5)), 'note #|')
  assert.equal(run('note', tag('note', 4, 4)), 'note #|')
  assert.equal(run('a\n', tag('a\n', 2, 2)), 'a\n#|')
  assert.equal(run('mark m1 here', tag('mark m1 here', 5, 7)), 'mark #m1| here')
})
