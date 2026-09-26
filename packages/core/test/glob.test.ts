import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globProblem, pathMatcher } from '@thoth/core'

const matches = (pattern: string, path: string) => pathMatcher([pattern])(path)

test('glob: a pattern names a path from the notes root, and covers everything under it', () => {
  for (const p of ['biblioteca', 'biblioteca/', 'biblioteca/**']) {
    assert.ok(matches(p, 'biblioteca/libro.pdf'), p)
    assert.ok(matches(p, 'biblioteca/a/b/c.md'), p)
    assert.ok(!matches(p, 'bibliotecas/libro.pdf'), `${p}: only that folder`)
    assert.ok(!matches(p, 'otros/biblioteca/libro.pdf'), `${p}: from the root`)
  }
  assert.ok(matches('borradores/secreto.md', 'borradores/secreto.md'))
  assert.ok(!matches('borradores/secreto.md', 'borradores/secreto.md.bak'))
  assert.ok(!matches('borradores/secreto.md', 'borradores/otro.md'))
})

test('glob: * and ? stay within one name; ** spans folders', () => {
  assert.ok(matches('*.pdf', 'libro.pdf'))
  assert.ok(!matches('*.pdf', 'biblioteca/libro.pdf'), '* never crosses /')
  assert.ok(matches('**/*.pdf', 'libro.pdf'), '** can be no folder at all')
  assert.ok(matches('**/*.pdf', 'a/b/libro.pdf'))
  assert.ok(!matches('**/*.pdf', 'a/libro.pdf.md'))
  assert.ok(matches('a/**/b.md', 'a/b.md'))
  assert.ok(matches('a/**/b.md', 'a/x/y/b.md'))
  assert.ok(!matches('a/**/b.md', 'ax/b.md'))
  assert.ok(matches('diario/202?-*.md', 'diario/2026-09-26.md'))
  assert.ok(!matches('diario/202?-*.md', 'diario/20266-09-26.md'))
  assert.ok(!matches('diario/202?-*.md', 'diario/202/-x.md'), '? never matches /')
  assert.ok(matches('**', 'anything/at/all.md'))
})

test('glob: other characters are literal, and names compare in NFC', () => {
  assert.ok(matches('notas (viejas)/a+b.md', 'notas (viejas)/a+b.md'))
  assert.ok(!matches('a.md', 'aXmd'), 'a dot is a dot')
  assert.ok(matches('Café/**', 'Café/menu.md'), 'a name stored decomposed')
  assert.ok(matches('Café/**', 'Café/menu.md'), 'a pattern typed decomposed')
  assert.ok(!matches('cafe/**', 'Cafe/menu.md'), 'case matters')
})

test('glob: invalid patterns', () => {
  assert.equal(globProblem('biblioteca/**'), null)
  assert.equal(globProblem('Archivo/'), null)
  assert.equal(globProblem(''), 'empty')
  assert.equal(globProblem('  '), 'empty')
  assert.equal(globProblem('/'), 'empty')
  assert.equal(globProblem('/etc/**'), 'absolute')
  assert.equal(globProblem('a/../b'), 'segment')
  assert.equal(globProblem('./a'), 'segment')
  assert.equal(globProblem('a//b'), 'segment')
  assert.equal(globProblem('a/**b'), 'double_star')
  assert.equal(globProblem('***'), 'double_star')
  for (const p of ['*.{pdf,epub}', '[ab].md', '!keep.md', 'a\\b', 'a\tb']) assert.equal(globProblem(p), 'unsupported', p)
  // An invalid pattern in a list never matches (the configuration reports it).
  assert.ok(!pathMatcher(['/etc/**'])('etc/passwd'))
  assert.ok(!pathMatcher([])('a.md'))
})
