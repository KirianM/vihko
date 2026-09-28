// A note, a template or a path is anyone's text, and vihko reads it on the
// server's only thread: every reading of it takes time in proportion to its
// length. Each input here is one that a backtracking pattern (or a scan
// repeated from every position) turned quadratic, so that a note of a few
// hundred kilobytes kept the server busy for seconds or minutes. The values
// are the attack itself, hence literal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globProblem, parseSearchQuery, pathMatcher, trimSlashes, trimTrailingSlashes } from '@vihko/core'

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

test('paths: a long run of slashes that doesn\'t end them', () => {
  const path = 'a' + '/'.repeat(N) + 'b'
  assert.equal(fast('trim', () => trimSlashes('//' + path + '//')), path)
  assert.equal(trimTrailingSlashes('a//'), 'a')
  assert.equal(trimSlashes('///'), '')
  fast('search filter', () => parseSearchQuery(`path:${path} tag:${path}`))
  fast('glob', () => [globProblem(path), pathMatcher([path])('a/b')])
})
