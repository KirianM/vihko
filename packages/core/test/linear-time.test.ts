// A note, a template or a path is anyone's text, and vihko reads it on the
// server's only thread: every reading of it takes time in proportion to its
// length. Each input here is one that a backtracking pattern (or a scan
// repeated from every position) turned quadratic, so that a note of a few
// hundred kilobytes kept the server busy for seconds or minutes. The values
// are the attack itself, hence literal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanText, extract, formatDate, globProblem, goneThreads, markdownParser, parseComments, parseSearchQuery,
  parseThreads, pathMatcher, renderTemplate, reopener, trimSlashes, trimTrailingSlashes, withoutClosingHashes, type RemovedThread,
} from '@vihko/core'

/** Far more than linear work needs, far less than the quadratic took at these sizes (seconds). */
const BUDGET_MS = 1000
const N = 100_000

function fast<T>(what: string, fn: () => T): T {
  const start = performance.now()
  const out = fn()
  const ms = performance.now() - start
  assert.ok(ms < BUDGET_MS, `${what}: ${Math.round(ms)} ms`)
  return out
}

const NOW = { year: 2026, month: 9, day: 28, hour: 10, minute: 12 }

test('Markdown: a long run of spaces inside a paragraph or a heading', () => {
  fast('paragraph', () => markdownParser.parse('a' + ' '.repeat(N) + 'x\n'))
  const x = fast('heading', () => extract('# a' + ' '.repeat(N) + 'x ##\n'))
  assert.equal(x.headings[0]!.text, 'a' + ' '.repeat(N) + 'x')
  // Still a hard break where there is one.
  const tree = markdownParser.parse('a   \nb\\\nc\n')
  const breaks: number[] = []
  tree.iterate({ enter: (n) => { if (n.name === 'HardBreak') breaks.push(n.from) } })
  assert.deepEqual(breaks, [1, 6])
})

test('Markdown: a tag with a long run of slashes inside it', () => {
  const x = fast('tag', () => extract('#a' + '/'.repeat(N) + 'b\n'))
  assert.equal(x.tags[0]!.name, 'a' + '/'.repeat(N) + 'b')
  assert.equal(extract('#a/b///\n').tags[0]!.name, 'a/b')
})

test('a heading closing sequence, removed as the pattern did', () => {
  const cases: [string, string][] = [['a ##', 'a'], ['a ## ', 'a'], ['a ## ##', 'a ##'], ['a##', 'a##'], ['##', '##'], ['a \t#\t', 'a'], ['a', 'a']]
  for (const [heading, text] of cases) {
    assert.equal(withoutClosingHashes(heading), text, heading)
  }
  assert.equal(withoutClosingHashes('a\n#\n', /\s/), 'a')
  fast('closing sequence', () => withoutClosingHashes('a' + ' '.repeat(N) + 'x ##'))
})

test('comments: never closed, or with a long run of spaces', () => {
  fast('long run', () => parseComments('<!-- @a 2026-09-28 · x' + ' '.repeat(N)))
  fast('many openings', () => parseComments('<!-- @a 2026-09-28 · '.repeat(N / 10)))
  fast('many on one line', () => parseThreads('a. <!-- @a 2026-09-28 · x -->'.repeat(N / 10)))
  // What they read is what they read.
  const doc = 'Uno.<!-- @a 2026-09-28T10:12Z · primero   -->\n<!-- @b 2026-09-28 · ↳ segundo -->\n```\n<!-- @c 2026-09-28 · código -->\n```\n<!-- @d 2026-09-28 · sin cerrar'
  assert.deepEqual(parseComments(doc).map((c) => [c.author, c.date, c.text, c.reply]), [['a', '2026-09-28T10:12Z', 'primero', false], ['b', '2026-09-28', 'segundo', true]])
  assert.deepEqual(parseThreads(doc).map((t) => doc.slice(t.anchorFrom, t.anchorTo)), ['Uno.'])
})

test('comments: many resolved on one long line, and reopened among many', () => {
  const line = 'a. <!-- @a 2026-09-28 · x -->'.repeat(N / 4)
  const gone = fast('gone threads', () => goneThreads(line, ''))
  assert.equal(gone.length, N / 4, 'every thread, identical ones included')
  const doc = 'a <!-- @b 2026-09-28 · c -->\n'.repeat(N / 4)
  const removed: RemovedThread = { id: 'x', comments: [], anchor: 'a', place: { removed: '<!-- @x 2026-09-28 · y -->', context: 'a', at: 0 } }
  // Every place right after an `a` would join the thread that follows it: none is found, after looking at each.
  assert.equal(fast('reopen', () => reopener(doc)(removed)), null)
  fast('context with a long run of spaces', () => reopener(doc)({ ...removed, place: { ...removed.place, context: 'a' + ' '.repeat(N) + 'b' } }))
})

test('a comment\'s text: a long run of dashes', () => {
  assert.equal(fast('dashes', () => cleanText('-'.repeat(N))), '-'.repeat(N))
  assert.equal(cleanText('a --> b ---> c ->'), 'a -- > b --- > c ->')
})

test('templates: an unclosed variable, and a date format with unclosed brackets', () => {
  const text = '{{date:' + ' '.repeat(N)
  assert.equal(fast('template', () => renderTemplate(text, { now: NOW, user: 'u', title: 't' })), text)
  assert.equal(fast('date format', () => formatDate('['.repeat(N), NOW)), '['.repeat(N))
  assert.equal(renderTemplate('{{date:[Week] W, YYYY }} {{ title }} {{date:}}', { now: NOW, user: 'u', title: 't' }), 'Week 40, 2026 t ')
  assert.equal(formatDate('[a] YYYY [b', NOW), 'a 2026 [b')
})

test('paths: a long run of slashes that doesn\'t end them', () => {
  const path = 'a' + '/'.repeat(N) + 'b'
  assert.equal(fast('trim', () => trimSlashes('//' + path + '//')), path)
  assert.equal(trimTrailingSlashes('a//'), 'a')
  assert.equal(trimSlashes('///'), '')
  fast('search filter', () => parseSearchQuery(`path:${path} tag:${path}`))
  fast('glob', () => [globProblem(path), pathMatcher([path])('a/b')])
})
