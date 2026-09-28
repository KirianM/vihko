import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addComment, cleanText, commentPosition, displayDate, formatComment, formatDate, parseComments, parseDate, parseThreads, replyTo, resolveThread, type Change } from '../src/editor/comments.ts'
import { mother } from '../../../test/mother.ts'

// Comments' authors (usernames).
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()
const AGENT = m.aUsername()

const apply = (doc: string, c: Change) => doc.slice(0, c.from) + c.insert + doc.slice(c.to)
const anchor = (doc: string, i = 0) => {
  const t = parseThreads(doc)[i]!
  return doc.slice(t.anchorFrom, t.anchorTo)
}
const WHEN = new Date(Date.UTC(2026, 8, 24, 8, 12))

// A sentence with a thread on it (a comment and a reply); what they say doesn't matter.
const SENTENCE = m.aSentence()
const ROOT = m.aComment()
const REPLY = m.aComment()
const D023 = `${SENTENCE}<!-- @${AUTHOR} 2026-09-24T08:12Z · ${ROOT} -->
<!-- @${AGENT} 2026-09-24T08:15Z · ↳ ${REPLY} -->
`

test('reads the example: a thread with a reply, anchored to the sentence', () => {
  const threads = parseThreads(D023)
  assert.equal(threads.length, 1)
  const [root, reply] = threads[0]!.comments
  assert.deepEqual([root!.author, root!.date, root!.text, root!.reply], [AUTHOR, '2026-09-24T08:12Z', ROOT, false])
  assert.deepEqual([reply!.author, reply!.text, reply!.reply], [AGENT, REPLY, true])
  assert.equal(anchor(D023), SENTENCE)
})

test('the anchor starts at the sentence, without list or heading marks', () => {
  assert.equal(anchor(`Primera frase. La segunda va aquí<!-- @${REPLIER} 2026-09-24T08:12Z · ojo -->`), 'La segunda va aquí')
  assert.equal(anchor(`- [ ] tarea pendiente<!-- @${REPLIER} 2026-09-24T08:12Z · ojo -->`), 'tarea pendiente')
  assert.equal(anchor(`## Título<!-- @${REPLIER} 2026-09-24T08:12Z · ojo -->`), 'Título')
  assert.equal(anchor(`> cita larga<!-- @${REPLIER} 2026-09-24T08:12Z · ojo -->`), 'cita larga')
  // After another thread on the same line, the anchor starts where that thread ends.
  const two = `uno<!-- @${REPLIER} 2026-09-24T08:12Z · a --> dos<!-- @${REPLIER} 2026-09-24 10:13 · b -->`
  assert.equal(parseThreads(two).length, 2)
  assert.equal(anchor(two, 1), 'dos')
  // Alone on its line: no anchor.
  assert.equal(anchor(`texto\n\n<!-- @${REPLIER} 2026-09-24T08:12Z · nota general -->`), '')
})

test('threads: consecutive ones merge; with text or a blank line in between, they do not', () => {
  const c = (n: number) => `<!-- @${REPLIER} 2026-09-24 10:1${n} · c${n} -->`
  assert.equal(parseThreads(`a${c(1)}${c(2)}\n${c(3)}`).length, 1)
  assert.equal(parseThreads(`a${c(1)} b${c(2)}`).length, 2)
  assert.equal(parseThreads(`a${c(1)}\n\n${c(2)}`).length, 2)
})

test('ignores HTML comments without the format, and ones inside code', () => {
  assert.equal(parseComments(`<!-- nota suelta --> y <!-- @${REPLIER} sin fecha · x -->`).length, 0)
  assert.equal(parseComments(`\`\`\`\nx<!-- @${REPLIER} 2026-09-24T08:12Z · no -->\n\`\`\`\ny<!-- @${REPLIER} 2026-09-24T08:12Z · sí -->`).length, 1)
})

test('ids tell identical comments apart and stay stable', () => {
  const c = `<!-- @${REPLIER} 2026-09-24T08:12Z · igual -->`
  const doc = `uno${c}\n\ndos${c}`
  const ids = parseThreads(doc).map((t) => t.id)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(parseThreads('antes\n\n' + doc).map((t) => t.id), ids)
})

test('format: UTC date, one line, and nothing that closes the comment early', () => {
  assert.equal(formatDate(WHEN), '2026-09-24T08:12Z')
  assert.equal(formatComment(AUTHOR, WHEN, 'esto no,\nusa SQLite'), `<!-- @${AUTHOR} 2026-09-24T08:12Z · esto no, usa SQLite -->`)
  assert.equal(formatComment(REPLIER, WHEN, 'vale', true), `<!-- @${REPLIER} 2026-09-24T08:12Z · ↳ vale -->`)
  assert.equal(cleanText('a --> b'), 'a -- > b')
  const doc = 'x' + formatComment(REPLIER, WHEN, 'raro --> y <!-- más')
  assert.equal(parseComments(doc)[0]!.text, 'raro -- > y <!-- más')
})

test('commenting a selection: right after the end of it, without splitting words', () => {
  const doc = 'La propuesta era usar Postgres con una tabla. Otra frase.'
  const sel = doc.indexOf('usar Postgres')
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postg'.length), sel + 'usar Postgres'.length)
  assert.equal(commentPosition(doc, sel, sel + 'usar Postgres '.length), sel + 'usar Postgres'.length)
  const out = apply(doc, addComment(doc, commentPosition(doc, sel, sel + 13), AUTHOR, WHEN, 'no'))
  assert.equal(out, `La propuesta era usar Postgres<!-- @${AUTHOR} 2026-09-24T08:12Z · no --> con una tabla. Otra frase.`)
  assert.equal(anchor(out), 'La propuesta era usar Postgres')
})

test('commenting with no selection: at the end of the cursor\'s sentence or line', () => {
  const doc = 'Una frase. Otra sin punto  \nsiguiente'
  assert.equal(commentPosition(doc, 2, 2), 'Una frase.'.length)
  assert.equal(commentPosition(doc, 13, 13), 'Una frase. Otra sin punto'.length)
})

test('commenting inside a thread adds it after the thread', () => {
  const doc = D023.trimEnd()
  const inside = doc.indexOf(ROOT)
  assert.equal(commentPosition(doc, inside, inside), doc.length)
})

test('replying: on its own line after a thread that closes a paragraph; attached if the paragraph continues', () => {
  const alone = `Frase.<!-- @${AUTHOR} 2026-09-24T08:12Z · a -->\n\nOtro párrafo.`
  const r1 = apply(alone, replyTo(alone, parseThreads(alone)[0]!, REPLIER, WHEN, 'b'))
  assert.equal(r1, `Frase.<!-- @${AUTHOR} 2026-09-24T08:12Z · a -->\n<!-- @${REPLIER} 2026-09-24T08:12Z · ↳ b -->\n\nOtro párrafo.`)
  assert.equal(parseThreads(r1)[0]!.comments.length, 2)
  const inline = `Frase.<!-- @${AUTHOR} 2026-09-24T08:12Z · a --> sigue\nel párrafo`
  const r2 = apply(inline, replyTo(inline, parseThreads(inline)[0]!, REPLIER, WHEN, 'b'))
  assert.equal(r2, `Frase.<!-- @${AUTHOR} 2026-09-24T08:12Z · a --><!-- @${REPLIER} 2026-09-24T08:12Z · ↳ b --> sigue\nel párrafo`)
  const lazy = `Frase.<!-- @${AUTHOR} 2026-09-24T08:12Z · a -->\nsigue el párrafo`
  assert.ok(!apply(lazy, replyTo(lazy, parseThreads(lazy)[0]!, REPLIER, WHEN, 'b')).includes('-->\n<!--'))
})

test('resolving deletes the whole thread and nothing else', () => {
  const doc = `---\nuid: X\n---\n${D023}\nFin.`
  const out = apply(doc, resolveThread(doc, parseThreads(doc)[0]!))
  assert.equal(out, `---\nuid: X\n---\n${SENTENCE}\n\nFin.`)
  const own = `a\n<!-- @${REPLIER} 2026-09-24T08:12Z · suelta -->\nb`
  assert.equal(apply(own, resolveThread(own, parseThreads(own)[0]!)), 'a\nb')
  const last = `a\n<!-- @${REPLIER} 2026-09-24T08:12Z · suelta -->`
  assert.equal(apply(last, resolveThread(last, parseThreads(last)[0]!)), 'a')
})

test('dates: written in UTC, shown in the reader\'s timezone, legacy dates kept as written', () => {
  const tz = process.env.TZ
  try {
    process.env.TZ = 'Europe/Madrid'
    const now = new Date(Date.UTC(2026, 8, 24, 20, 0))
    assert.equal(displayDate('2026-09-24T08:12Z', now), '10:12', 'today: only the local time')
    assert.equal(displayDate('2026-09-23T22:30Z', now), '00:30', 'yesterday in UTC, today locally')
    assert.equal(displayDate('2026-09-23T21:30Z', now), '2026-09-23 23:30', 'another day: date and time')
    process.env.TZ = 'America/Mexico_City'
    assert.equal(displayDate('2026-09-24T08:12Z', now), '02:12', 'another reader, another local time')
    assert.equal(displayDate('2026-09-24 10:12 +02:00', now), '02:12', 'an offset written by hand is read too')
    assert.equal(displayDate('2026-09-24 10:12', now), '2026-09-24 10:12', 'no zone: shown as written')
    assert.equal(parseDate('2026-09-24 10:12'), null)
    assert.equal(parseDate('2026-09-24T10:12+0200')!.toISOString(), '2026-09-24T08:12:00.000Z')
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
  const doc = `Texto.<!-- @${REPLIER} 2026-09-24 10:12 +02:00 · con desfase -->`
  assert.equal(parseComments(doc)[0]!.date, '2026-09-24 10:12 +02:00')
})

