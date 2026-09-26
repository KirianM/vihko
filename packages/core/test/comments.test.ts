// Comparing a thread's commented text with the one it had (D-031.6), and the
// threads that left a note and go back into it (D-032.5). The parsing itself is
// tested with the editor (packages/web/test/comments.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorChanged, goneThreads, normalizeAnchor, parseThreads, removedThread, reopener, resolveThread, type Change } from '@thoth/core'

test('whitespace and Unicode normalization are not changes', () => {
  assert.equal(normalizeAnchor('  We’ll\tuse\n Postgres  '), 'We’ll use Postgres')
  assert.equal(anchorChanged('Usaremos el índice.', 'Usaremos  el índice.'), false, 'a no-break space is whitespace')
  assert.equal(anchorChanged('índice', 'índice'), false, 'composed and decomposed accents')
})

test('any other difference is a change, however small', () => {
  assert.equal(anchorChanged('We will use Postgres.', 'We will not use Postgres.'), true)
  assert.equal(anchorChanged('Budget: 1000 €.', 'Budget: 100 €.'), true)
  assert.equal(anchorChanged('Case matters.', 'case matters.'), true)
  assert.equal(anchorChanged('Some text.', ''), true, 'the text is gone')
})

test('a thread that had no text to anchor to never changes', () => {
  assert.equal(anchorChanged('', 'Now there is text.'), false)
  assert.equal(anchorChanged('  ', ''), false)
})

const apply = (doc: string, c: Change) => doc.slice(0, c.from) + c.insert + doc.slice(c.to)
const K = '<!-- @noa 2026-09-24T08:12Z · esto no, usa SQLite -->'
const R = '<!-- @ana 2026-09-24T08:15Z · ↳ de acuerdo -->'
const OTHER = '<!-- @ana 2026-09-26T10:00Z · otro -->'
/** Resolves thread `i` of `doc`: the text left, and the thread as it went. */
const resolve = (doc: string, i = 0) => {
  const t = parseThreads(doc)[i]!
  return { after: apply(doc, resolveThread(doc, t)), removed: removedThread(doc, t) }
}

test('resolving and then reopening gives the note back exactly as it was', () => {
  const cases = [
    `Usaremos Postgres para el índice.${K}\n${R}\n\nFin.`, // after its sentence, a reply on its own line
    `Una frase. Otra frase ${K} y sigue el párrafo.`, // a space before it, the paragraph goes on
    `---\nuid: X\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n${K}\n\nFin.`, // alone on its line under a table
    `Párrafo.\n\n${K}\n\nOtro párrafo.`, // alone, blank lines around it
    `Párrafo.\n${K}`, // alone on the last line
    `${K}\nPrimera línea.`, // alone on the first line
    `Párrafo.\n${K} texto detrás`, // at the start of a line that goes on
    `- uno\n- ${K}\n- tres`, // a list item with nothing else
  ]
  for (const doc of cases) {
    const { after, removed } = resolve(doc)
    assert.ok(!after.includes('<!--'), doc)
    const change = reopener(after)(removed)
    assert.ok(change, `reopenable: ${doc}`)
    assert.equal(apply(after, change), doc)
  }
})

test('the threads that left a note: known by their first comment, wherever it is now', () => {
  const doc = `Uno.${K}\n${R}\n\nDos.${OTHER}`
  assert.deepEqual(goneThreads(doc, doc), [])
  // A reply more or less: the thread is still there.
  assert.deepEqual(goneThreads(doc, doc.replace(R, `${R}\n<!-- @noa 2026-09-24T09:00Z · ↳ hecho -->`)), [])
  assert.deepEqual(goneThreads(doc, doc.replace(`\n${R}`, '')), [])
  // Resolved: the whole thread, replies included, as it was.
  const gone = goneThreads(doc, resolve(doc).after)
  assert.equal(gone.length, 1)
  assert.equal(gone[0]!.id, 'noa|2026-09-24T08:12Z|esto no, usa SQLite')
  assert.deepEqual(gone[0]!.comments.map((c) => [c.author, c.text, c.reply]), [['noa', 'esto no, usa SQLite', false], ['ana', 'de acuerdo', true]])
  assert.equal(gone[0]!.anchor, 'Uno.')
  // Two threads that became one because the text between them went away: nothing resolved.
  const two = `Uno.${K} Dos.${OTHER}`
  assert.equal(parseThreads(two.replace(' Dos.', '')).length, 1)
  assert.deepEqual(goneThreads(two, two.replace(' Dos.', '')), [])
  // Its first comment's text edited: another thread (the identity is author, date and text).
  assert.deepEqual(goneThreads(doc, doc.replace('usa SQLite', 'usa SQLite ya')).map((t) => t.anchor), ['Uno.'])
})

test('reopening: where its text still is, nearest to where it was; never inside code or merged into another thread', () => {
  const doc = `Repetida.\n\nRepetida.${K}\n\nRepetida.`
  const { after, removed } = resolve(doc)
  assert.equal(apply(after, reopener(after)(removed)!), doc, 'the second one, where it was')
  assert.equal(reopener(after.replaceAll('Repetida.', 'Cambiada.'))(removed), null, 'its text is gone')
  assert.equal(reopener('```\nRepetida.\n```\n')(removed), null, 'only inside a code block')
  // Reflowed: runs of whitespace inside the text may differ.
  const reflowed = 'Una frase\nbastante  larga.'
  const long = resolve(`Una frase bastante larga.${K}`)
  assert.equal(apply(reflowed, reopener(reflowed)(long.removed)!), `${reflowed}${K}`)
  // Whole words only.
  assert.equal(reopener('Usa SQLiteX')(resolve(`Usa SQLite${K}`).removed), null)
  // Someone commented the same sentence meanwhile: it would become part of that thread.
  const single = resolve(`Uno.${K}\n\nDos.`)
  assert.equal(reopener(single.after.replace('Uno.', `Uno.${OTHER}`))(single.removed), null)
})
