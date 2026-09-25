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

test('lee el ejemplo de D-023: un hilo con respuesta, anclado a la frase', () => {
  const threads = parseThreads(D023)
  assert.equal(threads.length, 1)
  const [root, reply] = threads[0]!.comments
  assert.deepEqual([root!.author, root!.date, root!.text, root!.reply], ['noa', '2026-09-24 10:12', 'esto no, usa SQLite', false])
  assert.deepEqual([reply!.author, reply!.text, reply!.reply], ['claude', 'de acuerdo, lo cambio', true])
  assert.equal(anchor(D023), 'Usaremos Postgres para el índice.')
})

test('el ancla empieza en la frase, sin marcas de lista ni de encabezado', () => {
  assert.equal(anchor('Primera frase. La segunda va aquí<!-- @ana 2026-09-24 10:12 · ojo -->'), 'La segunda va aquí')
  assert.equal(anchor('- [ ] tarea pendiente<!-- @ana 2026-09-24 10:12 · ojo -->'), 'tarea pendiente')
  assert.equal(anchor('## Título<!-- @ana 2026-09-24 10:12 · ojo -->'), 'Título')
  assert.equal(anchor('> cita larga<!-- @ana 2026-09-24 10:12 · ojo -->'), 'cita larga')
  // Tras otro hilo en la misma línea, el ancla empieza donde acaba ese hilo.
  const two = 'uno<!-- @ana 2026-09-24 10:12 · a --> dos<!-- @ana 2026-09-24 10:13 · b -->'
  assert.equal(parseThreads(two).length, 2)
  assert.equal(anchor(two, 1), 'dos')
  // Solo en su línea: sin ancla.
  assert.equal(anchor('texto\n\n<!-- @ana 2026-09-24 10:12 · nota general -->'), '')
})

test('hilos: consecutivos se unen; con texto o una línea en blanco entre medias, no', () => {
  const c = (n: number) => `<!-- @ana 2026-09-24 10:1${n} · c${n} -->`
  assert.equal(parseThreads(`a${c(1)}${c(2)}\n${c(3)}`).length, 1)
  assert.equal(parseThreads(`a${c(1)} b${c(2)}`).length, 2)
  assert.equal(parseThreads(`a${c(1)}\n\n${c(2)}`).length, 2)
})

test('ignora comentarios HTML sin el formato y los que están en código', () => {
  assert.equal(parseComments('<!-- nota suelta --> y <!-- @ana sin fecha · x -->').length, 0)
  assert.equal(parseComments('```\nx<!-- @ana 2026-09-24 10:12 · no -->\n```\ny<!-- @ana 2026-09-24 10:12 · sí -->').length, 1)
})

test('los ids distinguen comentarios idénticos y son estables', () => {
  const c = '<!-- @ana 2026-09-24 10:12 · igual -->'
  const doc = `uno${c}\n\ndos${c}`
  const ids = parseThreads(doc).map((t) => t.id)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(parseThreads('antes\n\n' + doc).map((t) => t.id), ids)
})

test('formato: fecha local, una línea y nada que cierre el comentario antes de tiempo', () => {
  assert.equal(formatDate(WHEN), '2026-09-24 10:12')
  assert.equal(formatComment('noa', WHEN, 'esto no,\nusa SQLite'), '<!-- @noa 2026-09-24 10:12 · esto no, usa SQLite -->')
  assert.equal(formatComment('ana', WHEN, 'vale', true), '<!-- @ana 2026-09-24 10:12 · ↳ vale -->')
  assert.equal(cleanText('a --> b'), 'a -- > b')
  const doc = 'x' + formatComment('ana', WHEN, 'raro --> y <!-- más')
  assert.equal(parseComments(doc)[0]!.text, 'raro -- > y <!-- más')
})

test('comentar una selección: al final de lo seleccionado, sin partir palabras', () => {
  const doc = 'La propuesta era usar Postgres con una tabla. Otra frase.'
  const sel = doc.indexOf('usar Postgres')
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postg'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres '.length), sel + 'usar Postgres'.length)
  const out = apply(doc, addComment(doc, commentPosition(doc, sel, sel + 13), 'noa', WHEN, 'no'))
  assert.equal(out, 'La propuesta era usar Postgres<!-- @noa 2026-09-24 10:12 · no --> con una tabla. Otra frase.')
  assert.equal(anchor(out), 'La propuesta era usar Postgres')
})

test('comentar sin selección: al final de la frase del cursor o de la línea', () => {
  const doc = 'Una frase. Otra sin punto  \nsiguiente'
  assert.equal(commentPosition(doc, 2, 2), 'Una frase.'.length)
  assert.equal(commentPosition(doc, 13, 13), 'Una frase. Otra sin punto'.length)
})

test('comentar dentro de un hilo lo añade tras el hilo', () => {
  const doc = D023.trimEnd()
  const inside = doc.indexOf('esto no')
  assert.equal(commentPosition(doc, inside, inside), doc.length)
})

test('responder: en su línea tras un hilo que cierra párrafo; pegado si el párrafo sigue', () => {
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

test('resolver borra el hilo entero y nada más', () => {
  const doc = `---\nuid: X\n---\n${D023}\nFin.`
  const out = apply(doc, resolveThread(doc, parseThreads(doc)[0]!))
  assert.equal(out, '---\nuid: X\n---\nUsaremos Postgres para el índice.\n\nFin.')
  const own = 'a\n<!-- @ana 2026-09-24 10:12 · suelta -->\nb'
  assert.equal(apply(own, resolveThread(own, parseThreads(own)[0]!)), 'a\nb')
  const last = 'a\n<!-- @ana 2026-09-24 10:12 · suelta -->'
  assert.equal(apply(last, resolveThread(last, parseThreads(last)[0]!)), 'a')
})
