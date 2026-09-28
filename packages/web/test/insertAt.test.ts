import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { vihkoSyntax } from '@vihko/core/syntax'
import { insertionRange, outsideInline } from '../src/editor/insertAt.ts'

const state = (doc: string) => EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: vihkoSyntax }) })

// The literals are the case: each kind of inline syntax an insertion must not split.
const CASES = [
  '![](Tareas%20pendientes-2026-09-28-1951.png)',
  '[the plan](../launch/Plan.md)',
  '[[Plan#Budget|the plan]]',
  '![[diagram.png]]',
  '<!-- @someone 2026-09-28T10:00Z · a comment -->',
  '`inline code`',
  '<https://example.org/x>',
]

test('an insertion point inside a link, an image, a wikilink, a comment or inline code goes to its end', () => {
  for (const node of CASES) {
    const doc = `Before ${node} after.\n`
    const from = doc.indexOf(node)
    const to = from + node.length
    const s = state(doc)
    for (let pos = from + 1; pos < to; pos++) assert.equal(outsideInline(s, pos), to, `${node} at ${pos - from}`)
    // At its edges, or outside it: where it was.
    for (const pos of [0, from, to, doc.length - 1]) assert.equal(outsideInline(s, pos), pos, `${node}: ${pos}`)
  }
})

test('a range with an end inside one: nothing is replaced, the insertion goes after it; a range outside any stays', () => {
  const doc = 'Some words [a link](x.md) and more words.\n'
  const s = state(doc)
  const link = { from: doc.indexOf('['), to: doc.indexOf(')') + 1 }
  assert.deepEqual(insertionRange(s, 0, 4), { from: 0, to: 4 })
  assert.deepEqual(insertionRange(s, link.from, link.to), link, 'the whole link, selected: replaced')
  assert.deepEqual(insertionRange(s, 5, link.from + 3), { from: link.to, to: link.to })
  assert.deepEqual(insertionRange(s, link.to - 3, doc.length - 1), { from: link.to, to: link.to })
})
