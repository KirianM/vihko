// Comparing a thread's commented text with the one it had, and the
// threads that left a note and go back into it. The parsing itself is
// tested with the editor (packages/web/test/comments.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorChanged, goneThreads, normalizeAnchor, parseThreads, removedThread, reopener, resolveThread, type Change } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

// Who wrote the comments (their usernames).
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()

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
// A thread (a comment and its reply) and another comment; what they say doesn't matter.
const K_TEXT = m.aComment()
const R_TEXT = m.aComment()
const K = `<!-- @${AUTHOR} 2026-09-24T08:12Z · ${K_TEXT} -->`
const R = `<!-- @${REPLIER} 2026-09-24T08:15Z · ↳ ${R_TEXT} -->`
const OTHER = `<!-- @${REPLIER} 2026-09-26T10:00Z · ${m.aComment()} -->`
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
  const [ONE, TWO] = [m.aSentence(), m.aSentence()]
  const doc = `${ONE}${K}\n${R}\n\n${TWO}${OTHER}`
  assert.deepEqual(goneThreads(doc, doc), [])
  // A reply more or less: the thread is still there.
  assert.deepEqual(goneThreads(doc, doc.replace(R, `${R}\n<!-- @${AUTHOR} 2026-09-24T09:00Z · ↳ ${m.aComment()} -->`)), [])
  assert.deepEqual(goneThreads(doc, doc.replace(`\n${R}`, '')), [])
  // Resolved: the whole thread, replies included, as it was.
  const gone = goneThreads(doc, resolve(doc).after)
  assert.equal(gone.length, 1)
  assert.equal(gone[0]!.id, `${AUTHOR}|2026-09-24T08:12Z|${K_TEXT}`)
  assert.deepEqual(gone[0]!.comments.map((c) => [c.author, c.text, c.reply]), [[AUTHOR, K_TEXT, false], [REPLIER, R_TEXT, true]])
  assert.equal(gone[0]!.anchor, ONE)
  // Two threads that became one because the text between them went away: nothing resolved.
  const two = `${ONE}${K} ${TWO}${OTHER}`
  assert.equal(parseThreads(two.replace(` ${TWO}`, '')).length, 1)
  assert.deepEqual(goneThreads(two, two.replace(` ${TWO}`, '')), [])
  // Its first comment's text edited: another thread (the identity is author, date and text).
  assert.deepEqual(goneThreads(doc, doc.replace(K_TEXT, `${K_TEXT} ${m.aWord()}`)).map((t) => t.anchor), [ONE])
})

test('reopening: where its text still is, nearest to where it was; never inside code or merged into another thread', () => {
  const same = m.aSentence()
  const doc = `${same}\n\n${same}${K}\n\n${same}`
  const { after, removed } = resolve(doc)
  assert.equal(apply(after, reopener(after)(removed)!), doc, 'the second one, where it was')
  assert.equal(reopener(after.replaceAll(same, m.aSentence()))(removed), null, 'its text is gone')
  assert.equal(reopener(`\`\`\`\n${same}\n\`\`\`\n`)(removed), null, 'only inside a code block')
  // Reflowed: runs of whitespace inside the text may differ.
  const reflowed = 'Una frase\nbastante  larga.'
  const long = resolve(`Una frase bastante larga.${K}`)
  assert.equal(apply(reflowed, reopener(reflowed)(long.removed)!), `${reflowed}${K}`)
  // Whole words only (a word run on into another one).
  assert.equal(reopener('Usa SQLiteX')(resolve(`Usa SQLite${K}`).removed), null)
  // Someone commented the same sentence meanwhile: it would become part of that thread.
  const [one, two] = [m.aSentence(), m.aSentence()]
  const single = resolve(`${one}${K}\n\n${two}`)
  assert.equal(reopener(single.after.replace(one, `${one}${OTHER}`))(single.removed), null)
})
