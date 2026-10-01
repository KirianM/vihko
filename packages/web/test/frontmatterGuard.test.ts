import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorSelection, EditorState } from '@codemirror/state'
import { frontmatterGuard, frontmatterRange, selectBody } from '../src/editor/frontmatterGuard.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A note with frontmatter (a uid and `ai: false`, the case D-056.34 is for) and a body. */
function aNote() {
  const fm = `---\nuid: ${m.anId()}\nai: false\ntags: [${m.aTag()}]\n---\n`
  const body = `# ${m.aHeading()}\n\n${m.aParagraph()}\n`
  return { fm, body, text: fm + body }
}

const stateOf = (text: string, selection?: EditorSelection) => EditorState.create({ doc: text, selection, extensions: [frontmatterGuard] })

test('frontmatter: found as core finds it, with where the body starts', () => {
  const n = aNote()
  const r = frontmatterRange(stateOf(n.text).doc)!
  assert.equal(r.end, n.fm.length)
  assert.equal(n.text.slice(r.yamlFrom, r.yamlTo), n.fm.slice(4, -4))
  // Literals: the delimiters are the case.
  assert.ok(frontmatterRange(stateOf('---\na: 1\n...\nbody').doc))
  assert.equal(frontmatterRange(stateOf('---\na: 1\nbody').doc), null, 'no closing line: all body')
  assert.equal(frontmatterRange(stateOf(`${m.aParagraph()}\n---\na: 1\n---\n`).doc), null, 'only at the start')
  assert.equal(frontmatterRange(stateOf('--- \na: 1\n---\n').doc), null)
})

test('frontmatter: select all, then delete, type or paste, never reaches it', () => {
  const n = aNote()
  for (const [event, insert] of [['delete.backward', ''], ['delete.cut', ''], ['input.type', m.aWord()], ['input.paste', m.aParagraph()], ['input.drop', m.aSentence()]] as const) {
    const all = stateOf(n.text, EditorSelection.single(0, n.text.length))
    const tr = all.update({ changes: { from: 0, to: n.text.length, insert }, userEvent: event })
    assert.equal(tr.state.doc.toString(), n.fm + insert, event)
    assert.equal(tr.state.selection.main.head, n.fm.length + insert.length, event)
  }
})

test('frontmatter: a selection from the body into it is clipped at the body; a deletion wholly in it is dropped', () => {
  const n = aNote()
  const half = n.fm.length + Math.floor(n.body.length / 2)
  const s = stateOf(n.text, EditorSelection.single(half, 2))
  const tr = s.update({ changes: { from: 2, to: half }, userEvent: 'delete.backward' })
  assert.equal(tr.state.doc.toString(), n.fm + n.body.slice(half - n.fm.length))
  // Backspace at the start of the body: the line break of the closing line stays.
  const start = stateOf(n.text, EditorSelection.cursor(n.fm.length))
  assert.equal(start.update({ changes: { from: n.fm.length - 1, to: n.fm.length }, userEvent: 'delete.backward' }).state.doc.toString(), n.text)
})

test('frontmatter: inside its open block it is edited as any text, and what isn\'t a person\'s passes as it is', () => {
  const n = aNote()
  const at = n.fm.indexOf('ai: false')
  const open = stateOf(n.text, EditorSelection.single(at, at + 'ai: false'.length))
  assert.equal(open.update({ changes: { from: at, to: at + 'ai: false'.length }, userEvent: 'delete.backward' }).state.doc.toString(), n.text.replace('ai: false', ''))
  // Another person's or an agent's change (the shared document, no user event), anywhere.
  const body = stateOf(n.text, EditorSelection.cursor(n.text.length))
  assert.equal(body.update({ changes: { from: 0, to: n.fm.length } }).state.doc.toString(), n.body)
  // A note without frontmatter: nothing to protect.
  const plain = stateOf(n.body, EditorSelection.single(0, n.body.length))
  assert.equal(plain.update({ changes: { from: 0, to: n.body.length }, userEvent: 'delete.backward' }).state.doc.toString(), '')
})

test('frontmatter: select all takes the body, or inside the open block its YAML', () => {
  const n = aNote()
  assert.deepEqual(selectBody(stateOf(n.text, EditorSelection.cursor(n.text.length))), { anchor: n.fm.length, head: n.text.length })
  const inside = stateOf(n.text, EditorSelection.cursor(5))
  const r = selectBody(inside)!
  assert.equal(n.text.slice(r.anchor, r.head), n.fm.slice(4, -5))
  assert.equal(selectBody(stateOf(n.body)), null)
})
