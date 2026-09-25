import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkIndex, caseFold, extract, normKey, parseSearchQuery } from '@thoth/core'

test('caseFold: full Unicode case folding, not just lowercase', () => {
  assert.equal(caseFold('Straße'), caseFold('STRASSE'), 'ß folds to ss')
  assert.equal(caseFold('ẞ'), 'ss', 'capital sharp s')
  assert.equal(caseFold('ΟΔΟΣ'), caseFold('οδος'), 'final sigma and capital sigma fold alike')
  assert.equal(caseFold('οδος'), 'οδοσ')
  assert.equal(caseFold('ﬁle'), 'file', 'ligatures unfold')
  assert.equal(caseFold('ſ'), 's', 'long s')
  assert.equal(caseFold('µ'), 'μ', 'micro sign is Greek mu')
  assert.equal(caseFold('ᏸ'), 'Ᏸ', 'Cherokee folds to the uppercase letters')
  assert.equal(caseFold('ꭰ'), caseFold('Ꭰ'))
})

test('caseFold: dotless and dotted i follow the default (non-Turkic) folding', () => {
  assert.equal(caseFold('I'), 'i')
  assert.equal(caseFold('ı'), 'ı', 'dotless i stays itself')
  assert.notEqual(caseFold('ı'), caseFold('i'))
  assert.equal(caseFold('İ'), 'i̇', 'capital dotted I is i plus a combining dot')
  assert.equal(caseFold('İ'), caseFold('i̇'))
})

test('caseFold: NFC in and out, so composed and decomposed forms match', () => {
  assert.equal(caseFold('Reunión'), 'reunión')
  assert.equal(caseFold('RÉSUMÉ'), caseFold('résumé'))
  // ǰ has no uppercase: its folding decomposes and NFC composes it again.
  assert.equal(caseFold('J̌'), 'ǰ')
  for (const s of ['Straße', 'ΟΔΟΣ', 'İstanbul', 'ᾈ', 'ﬃ']) assert.equal(caseFold(caseFold(s)), caseFold(s), `idempotent: ${s}`)
})

test('links resolve across full case folding', () => {
  const index = new LinkIndex()
  index.set({ path: 'viajes/Straße.md', aliases: ['ΟΔΟΣ'], headings: ['Größe'] })
  index.set({ path: 'ı.md' })
  const r = (target: string, anchor: string | null = null) => index.resolve('a.md', { kind: 'wiki', target, anchor })
  assert.deepEqual(r('STRASSE'), { status: 'resolved', path: 'viajes/Straße.md', anchor: null, via: 'path' })
  assert.deepEqual(r('viajes/strasse'), { status: 'resolved', path: 'viajes/Straße.md', anchor: null, via: 'path' })
  assert.deepEqual(r('οδος'), { status: 'resolved', path: 'viajes/Straße.md', anchor: null, via: 'alias' }, 'final sigma matches the capital')
  assert.deepEqual(r('Strasse', 'GRÖSSE'), { status: 'resolved', path: 'viajes/Straße.md', anchor: 'ok', via: 'path' })
  assert.deepEqual(r('I'), { status: 'missing' }, 'I is not ı')
  assert.equal(normKey('  Straße   Nueva '), 'strasse nueva')
})

test('tags and the tag: filter fold alike', () => {
  const tags = extract('#Straße #ΟΔΟΣ\n').tags.map((t) => t.name)
  assert.deepEqual(tags, ['strasse', 'οδοσ'])
  assert.deepEqual(parseSearchQuery('tag:STRASSE tag:#οδος').filters.map((f) => f.value), ['strasse', 'οδοσ'])
})
