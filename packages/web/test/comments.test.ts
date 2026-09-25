import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addComment, cleanText, commentPosition, formatComment, formatDate, parseComments, parseThreads, replyTo, resolveThread, type Change } from '../src/editor/comments.ts'

const apply = (doc: string, c: Change) => doc.slice(0, c.from) + c.insert + doc.slice(c.to)
const anchor = (doc: string, i = 0) => {
  const t = parseThreads(doc)[i]!
  return doc.slice(t.anchorFrom, t.anchorTo)
}
const WHEN = new Date(2026, 8, 24, 10, 12)

const D023 = `Usaremos Postgres para el índice.<!-- @noa 2026-09-24 10:12 · esto no, usa SQLite -->
<!-- @claude 2026-09-24 10:15 · ↳ de acuerdo, lo cambio -->
`

test('reads the example: a thread with a reply, anchored to the sentence', () => {
  const threads = parseThreads(D023)
  assert.equal(threads.length, 1)
  const [root, reply] = threads[0]!.comments
  assert.deepEqual([root!.author, root!.date, root!.text, root!.reply], ['noa', '2026-09-24 10:12', 'esto no, usa SQLite', false])
  assert.deepEqual([reply!.author, reply!.text, reply!.reply], ['claude', 'de acuerdo, lo cambio', true])
  assert.equal(anchor(D023), 'Usaremos Postgres para el índice.')
})

test('the anchor starts at the sentence, without list or heading marks', () => {
  assert.equal(anchor('Primera frase. La segunda va aquí<!-- @ana 2026-09-24 10:12 · ojo -->'), 'La segunda va aquí')
  assert.equal(anchor('- [ ] tarea pendiente<!-- @ana 2026-09-24 10:12 · ojo -->'), 'tarea pendiente')
  assert.equal(anchor('## Título<!-- @ana 2026-09-24 10:12 · ojo -->'), 'Título')
  assert.equal(anchor('> cita larga<!-- @ana 2026-09-24 10:12 · ojo -->'), 'cita larga')
  // After another thread on the same line, the anchor starts where that thread ends.
  const two = 'uno<!-- @ana 2026-09-24 10:12 · a --> dos<!-- @ana 2026-09-24 10:13 · b -->'
  assert.equal(parseThreads(two).length, 2)
  assert.equal(anchor(two, 1), 'dos')
  // Alone on its line: no anchor.
  assert.equal(anchor('texto\n\n<!-- @ana 2026-09-24 10:12 · nota general -->'), '')
})

test('threads: consecutive ones merge; with text or a blank line in between, they do not', () => {
  const c = (n: number) => `<!-- @ana 2026-09-24 10:1${n} · c${n} -->`
  assert.equal(parseThreads(`a${c(1)}${c(2)}\n${c(3)}`).length, 1)
  assert.equal(parseThreads(`a${c(1)} b${c(2)}`).length, 2)
  assert.equal(parseThreads(`a${c(1)}\n\n${c(2)}`).length, 2)
})

test('ignores HTML comments without the format, and ones inside code', () => {
  assert.equal(parseComments('<!-- nota suelta --> y <!-- @ana sin fecha · x -->').length, 0)
  assert.equal(parseComments('```\nx<!-- @ana 2026-09-24 10:12 · no -->\n```\ny<!-- @ana 2026-09-24 10:12 · sí -->').length, 1)
})

test('ids tell identical comments apart and stay stable', () => {
  const c = '<!-- @ana 2026-09-24 10:12 · igual -->'
  const doc = `uno${c}\n\ndos${c}`
  const ids = parseThreads(doc).map((t) => t.id)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(parseThreads('antes\n\n' + doc).map((t) => t.id), ids)
})

test('format: local date, one line, and nothing that closes the comment early', () => {
  assert.equal(formatDate(WHEN), '2026-09-24 10:12')
  assert.equal(formatComment('noa', WHEN, 'esto no,\nusa SQLite'), '<!-- @noa 2026-09-24 10:12 · esto no, usa SQLite -->')
  assert.equal(formatComment('ana', WHEN, 'vale', true), '<!-- @ana 2026-09-24 10:12 · ↳ vale -->')
  assert.equal(cleanText('a --> b'), 'a -- > b')
  const doc = 'x' + formatComment('ana', WHEN, 'raro --> y <!-- más')
  assert.equal(parseComments(doc)[0]!.text, 'raro -- > y <!-- más')
})

test('commenting a selection: right after the end of it, without splitting words', () => {
  const doc = 'La propuesta era usar Postgres con una tabla. Otra frase.'
  const sel = doc.indexOf('usar Postgres')
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postg'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres '.length), sel + 'usar Postgres'.length)
  const out = apply(doc, addComment(doc, commentPosition(doc, sel, sel + 13), 'noa', WHEN, 'no'))
  assert.equal(out, 'La propuesta era usar Postgres<!-- @noa 2026-09-24 10:12 · no --> con una tabla. Otra frase.')
  assert.equal(anchor(out), 'La propuesta era usar Postgres')
})

test('commenting with no selection: at the end of the cursor\'s sentence or line', () => {
  const doc = 'Una frase. Otra sin punto  \nsiguiente'
  assert.equal(commentPosition(doc, 2, 2), 'Una frase.'.length)
  assert.equal(commentPosition(doc, 13, 13), 'Una frase. Otra sin punto'.length)
})

test('commenting inside a thread adds it after the thread', () => {
  const doc = D023.trimEnd()
  const inside = doc.indexOf('esto no')
  assert.equal(commentPosition(doc, inside, inside), doc.length)
})

test('replying: on its own line after a thread that closes a paragraph; attached if the paragraph continues', () => {
  const alone = 'Frase.<!-- @noa 2026-09-24 10:12 · a -->\n\nOtro párrafo.'
  const r1 = apply(alone, replyTo(alone, parseThreads(alone)[0]!, 'ana', WHEN, 'b'))
  assert.equal(r1, 'Frase.<!-- @noa 2026-09-24 10:12 · a -->\n<!-- @ana 2026-09-24 10:12 · ↳ b -->\n\nOtro párrafo.')
  assert.equal(parseThreads(r1)[0]!.comments.length, 2)
  const inline = 'Frase.<!-- @noa 2026-09-24 10:12 · a --> sigue\nel párrafo'
  const r2 = apply(inline, replyTo(inline, parseThreads(inline)[0]!, 'ana', WHEN, 'b'))
  assert.equal(r2, 'Frase.<!-- @noa 2026-09-24 10:12 · a --><!-- @ana 2026-09-24 10:12 · ↳ b --> sigue\nel párrafo')
  const lazy = 'Frase.<!-- @noa 2026-09-24 10:12 · a -->\nsigue el párrafo'
  assert.ok(!apply(lazy, replyTo(lazy, parseThreads(lazy)[0]!, 'ana', WHEN, 'b')).includes('-->\n<!--'))
})

test('resolving deletes the whole thread and nothing else', () => {
  const doc = `---\nuid: X\n---\n${D023}\nFin.`
  const out = apply(doc, resolveThread(doc, parseThreads(doc)[0]!))
  assert.equal(out, '---\nuid: X\n---\nUsaremos Postgres para el índice.\n\nFin.')
  const own = 'a\n<!-- @ana 2026-09-24 10:12 · suelta -->\nb'
  assert.equal(apply(own, resolveThread(own, parseThreads(own)[0]!)), 'a\nb')
  const last = 'a\n<!-- @ana 2026-09-24 10:12 · suelta -->'
  assert.equal(apply(last, resolveThread(last, parseThreads(last)[0]!)), 'a')
})
