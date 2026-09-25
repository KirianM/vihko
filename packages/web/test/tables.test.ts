import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownParser } from '@thoth/core/syntax'
import { alignments, tableModel, type Cell, type TableModel } from '../src/editor/tables.ts'

/** The model of the first table in `doc`, or null if the parser finds none. */
function model(doc: string): TableModel | null {
  const cursor = markdownParser.parse(doc).cursor()
  do {
    if (cursor.name === 'Table') {
      const base = doc.lastIndexOf('\n', cursor.from - 1) + 1
      return tableModel(cursor.node, (from, to) => doc.slice(from, to), base)
    }
  } while (cursor.next())
  return null
}

/** A cell as `text` with its styles: `strong:b`, and `|` between runs. */
const show = (c: Cell) => c.content.map((s) => (s.marks.length ? `${s.marks.join('+')}:${s.text}` : s.text)).join('|')

test('alignments: from the colons of the delimiter row', () => {
  assert.deepEqual(alignments('|:--|:-:|--:|---|'), ['left', 'center', 'right', null])
  assert.deepEqual(alignments(':--- | ---: '), ['left', 'right'])
  assert.deepEqual(alignments('| :-: |'), ['center'])
})

test('a table: header, rows and alignment per column', () => {
  const m = model('| Name | Qty | Note |\n|:-----|----:|:----:|\n| tea | 2 | green |\n| coffee | 10 | |\n')!
  assert.deepEqual(m.align, ['left', 'right', 'center'])
  assert.deepEqual(m.head.map(show), ['Name', 'Qty', 'Note'])
  assert.deepEqual(m.body.map((r) => r.map(show)), [['tea', '2', 'green'], ['coffee', '10', '']])
})

test('cell positions point at the cell text in the source, relative to the table', () => {
  const doc = 'Intro\n\n| a | b |\n|---|---|\n| one |  |\n'
  const m = model(doc)!
  const base = doc.indexOf('| a')
  assert.equal(doc.slice(base + m.head[1]!.pos, base + m.head[1]!.pos + 1), 'b')
  assert.equal(doc.slice(base + m.body[0]![0]!.pos).startsWith('one'), true)
  // An empty cell: just inside its pipes.
  const empty = base + m.body[0]![1]!.pos
  assert.equal(doc.slice(empty - 2, empty + 2), '|  |')
})

test('rows are padded or cut to the header, as GFM says', () => {
  const doc = '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n'
  const m = model(doc)!
  assert.deepEqual(m.body.map((r) => r.map(show)), [['1', ''], ['1', '2']])
  // A missing cell goes to the end of its row.
  assert.equal(m.body[0]![1]!.pos, doc.indexOf('| 1 |\n') + '| 1 |'.length)
})

test('no outer pipes', () => {
  const m = model('a | b\n--|--\n1 | 2\n')!
  assert.deepEqual(m.head.map(show), ['a', 'b'])
  assert.deepEqual(m.body.map((r) => r.map(show)), [['1', '2']])
})

test('inline Markdown in cells: emphasis, code, links and wikilinks as text, escaped pipes', () => {
  const m = model('| x |\n|---|\n| **bold** and *it* |\n| `a \\| b` |\n| [site](https://example.com) |\n| [[Note#Part\\|alias]] [[Other.md]] |\n| ~~no~~ #tag |\n')!
  assert.deepEqual(m.body.map((r) => show(r[0]!)), [
    'strong:bold| and |em:it',
    'code:a | b',
    'link:site',
    'link:alias| |link:Other',
    'strike:no| |tag:#tag',
  ])
})

test('a table inside a code block is not a table', () => {
  assert.equal(model('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n'), null)
})

test('a table in a blockquote: positions relative to the quoted line', () => {
  const doc = '> | a |\n> |---|\n> | b |\n'
  const m = model(doc)!
  assert.deepEqual(m.body.map((r) => r.map(show)), [['b']])
  assert.equal(doc[m.body[0]![0]!.pos], 'b')
})
