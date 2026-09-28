// A note, a template or a path is anyone's text, and vihko reads it on the
// server's only thread: every reading of it takes time in proportion to its
// length. Each input here is one that a backtracking pattern (or a scan
// repeated from every position) turned quadratic, so that a note of a few
// hundred kilobytes kept the server busy for seconds or minutes. The values
// are the attack itself, hence literal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extract, globProblem, markdownParser, parseSearchQuery,
  pathMatcher, trimSlashes, trimTrailingSlashes, withoutClosingHashes,
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

test('paths: a long run of slashes that doesn\'t end them', () => {
  const path = 'a' + '/'.repeat(N) + 'b'
  assert.equal(fast('trim', () => trimSlashes('//' + path + '//')), path)
  assert.equal(trimTrailingSlashes('a//'), 'a')
  assert.equal(trimSlashes('///'), '')
  fast('search filter', () => parseSearchQuery(`path:${path} tag:${path}`))
  fast('glob', () => [globProblem(path), pathMatcher([path])('a/b')])
})
