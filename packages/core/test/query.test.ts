// The search box's filters (query.ts): frontmatter fields, `prop:` and the
// reserved names, next to `tag:` and `path:` (whose own cases are in the
// server's search tests).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESERVED_FILTERS, hasSearchFilter, parseSearchQuery } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('search filters: any key whose name is not reserved is a frontmatter field, key and value case-folded', () => {
  const [key, value, word] = [m.aWord(), m.aWord(), m.aUniqueWord()]
  assert.deepEqual(parseSearchQuery(`${word} ${key.toUpperCase()}:${value.toUpperCase()}`), {
    text: word,
    filters: [{ kind: 'field', key, value, negate: false }],
  })
  // Literals: the folding (ß → ss) and NFC are the case.
  assert.deepEqual(parseSearchQuery('Straße:Größe').filters, [{ kind: 'field', key: 'strasse', value: 'grösse', negate: false }])
  assert.deepEqual(parseSearchQuery('estado:café').filters, [{ kind: 'field', key: 'estado', value: 'café', negate: false }])
})

test('search filters: prop:key=value for any key at all, a built-in filter\'s name included; quotes for spaces', () => {
  const [key, value] = [m.aWord(), m.aWord()]
  assert.deepEqual(parseSearchQuery(`prop:${key}=${value}`).filters, [{ kind: 'field', key, value, negate: false }])
  assert.deepEqual(parseSearchQuery(`prop:tag=${value} prop:Path=x`).filters, [
    { kind: 'field', key: 'tag', value, negate: false },
    { kind: 'field', key: 'path', value: 'x', negate: false },
  ])
  assert.deepEqual(parseSearchQuery('prop:"due date"="next week" status:"in progress"').filters, [
    { kind: 'field', key: 'due date', value: 'next week', negate: false },
    { kind: 'field', key: 'status', value: 'in progress', negate: false },
  ])
  // A value still being typed asks nothing yet.
  assert.deepEqual(parseSearchQuery(`prop:${key}=`).filters, [])
})

test('search filters: prop:key with no value, a key that is there; - in front excludes any of them', () => {
  const [key, value] = [m.aWord(), m.aWord()]
  assert.deepEqual(parseSearchQuery(`prop:${key} -prop:"${key} x" -${key}:${value} -prop:${key}=${value}`).filters, [
    { kind: 'exists', key, negate: false },
    { kind: 'exists', key: `${key} x`, negate: true },
    { kind: 'field', key, value, negate: true },
    { kind: 'field', key, value, negate: true },
  ])
  assert.deepEqual(parseSearchQuery('prop:').filters, [])
})

test('search filters: the reserved names are never a frontmatter field; those with no meaning yet are kept apart', () => {
  const value = m.aWord()
  // Literals: the reserved names are the case under test.
  for (const name of ['is', 'has', 'in', 'before', 'after'] as const) {
    assert.deepEqual(parseSearchQuery(`${name}:${value}`).filters, [{ kind: 'reserved', name, value, negate: false }], name)
    assert.deepEqual(parseSearchQuery(`-${name.toUpperCase()}:"${value} x"`).filters, [{ kind: 'reserved', name, value: `${value} x`, negate: true }], name)
    assert.deepEqual(parseSearchQuery(`prop:${name}=${value}`).filters, [{ kind: 'field', key: name, value, negate: false }], name)
  }
  assert.deepEqual(RESERVED_FILTERS, ['tag', 'path', 'is', 'has', 'in', 'prop', 'before', 'after'])
  // Close to a reserved name is not one: a field.
  assert.deepEqual(parseSearchQuery(`isn:${value} hash:${value} created:${value}`).filters.map((f) => f.kind === 'field' && f.key), ['isn', 'hash', 'created'])
})

test('search filters: what only looks like one stays text (a time, a URL, a colon before a space, part of a word)', () => {
  // Literals: each is the case under test.
  for (const text of ['10:30', 'https://example.org/x', 'note: something', 'a:', '"quoted:x"']) {
    assert.deepEqual(parseSearchQuery(text).filters, [], text)
  }
  assert.equal(parseSearchQuery('meet at 10:30').text, 'meet at 10:30')
  assert.equal(parseSearchQuery('see https://example.org/x').text, 'see https://example.org/x')
  // A word with a colon, quoted: searched as text, never a filter.
  assert.deepEqual(parseSearchQuery('budget "re:budget"'), { text: 'budget "re:budget"', filters: [] })
  assert.ok(!hasSearchFilter('"re:budget"'))
})

test('search filters: combined with text, tags and paths, in the order written', () => {
  const [word, tag, folder, key, value] = [m.aUniqueWord(), m.aTag(), m.aFolder(), m.aWord(), m.aWord()]
  const r = parseSearchQuery(`${word} tag:${tag} path:"${folder}" ${key}:${value} prop:${key}`)
  assert.equal(r.text, word)
  assert.deepEqual(r.filters.map((f) => f.kind), ['tag', 'path', 'field', 'exists'])
})

test('search filters: a query with one is a search, never a new note\'s name', () => {
  const key = m.aWord()
  for (const q of [`tag:`, `has:`, `prop:`, `is:`, `-prop:${key}`, `${key}:x`, `prop:${key}=x`]) assert.ok(hasSearchFilter(q), q)
  for (const q of [m.aTitle(), `${key}:`, '10:30']) assert.ok(!hasSearchFilter(q), q)
})
