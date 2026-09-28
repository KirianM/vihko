import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FrontmatterError, readFrontmatter, setFrontmatterKey } from '@vihko/core'

const vault = (p: string) => readFileSync(new URL(`../../../testdata/vault/${p}`, import.meta.url), 'utf8')

test('reads exotic frontmatter without implicit conversions', () => {
  const fm = readFrontmatter(vault('frontmatter/exotico.md'))
  assert.equal(fm.error, null)
  assert.equal(fm.data.title, 'Título con: dos puntos')
  assert.deepEqual(fm.data.tags, ['a', 'b', 'c'])
  assert.equal(fm.data.fecha, '2026-09-24', 'dates stay as text')
  assert.deepEqual(fm.data.copia, { x: 1 }, 'YAML anchors are resolved')
  assert.equal(fm.data.multilinea, 'línea uno\nlínea dos\n')
})

test('invalid frontmatter: error, and body starting after the closing delimiter', () => {
  const fm = readFrontmatter(vault('frontmatter/invalido.md'))
  assert.ok(fm.error)
  assert.deepEqual(fm.data, {})
  assert.throws(() => setFrontmatterKey(vault('frontmatter/invalido.md'), 'uid', 'X'), FrontmatterError)
})

test('no closing delimiter means no frontmatter', () => {
  const fm = readFrontmatter('---\ntitle: x\nsin cierre\n')
  assert.equal(fm.block, null)
  assert.equal(fm.bodyStart, 0)
})

test('adding a key to exotic frontmatter only adds a line', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'uid', '01J9ABC')
  assert.equal(after, before.replace('desconocida_de_otra_herramienta: true\n---\n', 'desconocida_de_otra_herramienta: true\nuid: 01J9ABC\n---\n'))
})

test('changing a quoted value only changes that value', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'title', 'Nuevo')
  assert.equal(after, before.replace('title: "Título con: dos puntos"', 'title: Nuevo'))
})

test('replacing a flow list keeps the line comment', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'tags', 'uno')
  assert.equal(after, before.replace(`tags: [a, 'b', "c"]   # lista en flujo con comentario`, 'tags: uno   # lista en flujo con comentario'))
})

test('replacing a block list collapses it to one line', () => {
  const before = '---\naliases:\n  - plan\n  - otro\ntitle: x\n---\ncuerpo\n'
  assert.equal(setFrontmatterKey(before, 'aliases', 'uno'), '---\naliases: uno\ntitle: x\n---\ncuerpo\n')
})

test('filling in a key with no value', () => {
  assert.equal(setFrontmatterKey('---\nuid:\ntitle: x\n---\n', 'uid', 'A1'), '---\nuid: A1\ntitle: x\n---\n')
})

test('creates the block when it does not exist, without touching the body', () => {
  const before = vault('frontmatter/sin-frontmatter.md')
  assert.equal(setFrontmatterKey(before, 'uid', 'A1'), '---\nuid: A1\n---\n' + before)
  assert.equal(setFrontmatterKey('', 'uid', 'A1'), '---\nuid: A1\n---\n')
})

test('BOM and CRLF are preserved', () => {
  const before = vault('frontmatter/bom-crlf.md')
  const after = setFrontmatterKey(before, 'uid', 'A1')
  assert.equal(after, before.replace('title: BOM y CRLF\r\n---\r\n', 'title: BOM y CRLF\r\nuid: A1\r\n---\r\n'))
  assert.ok(after.startsWith('﻿'))
  const created = setFrontmatterKey('﻿línea\r\notra\r\n', 'uid', 'A1')
  assert.equal(created, '﻿---\r\nuid: A1\r\n---\r\nlínea\r\notra\r\n')
})

test('values that need it get quoted and read back the same', () => {
  const after = setFrontmatterKey('---\ntitle: x\n---\n', 'title', 'a: b # c')
  assert.equal(readFrontmatter(after).data.title, 'a: b # c')
  const num = setFrontmatterKey('---\ntitle: x\n---\n', 'title', '123')
  assert.equal(readFrontmatter(num).data.title, '123', 'a numeric-looking string stays text')
})

test('a list is written as a one-line flow list, quoted where a flow list needs it', () => {
  const after = setFrontmatterKey('---\ntags: [a] # mine\ntitle: x\n---\ncuerpo\n', 'tags', ['uno', 'dos, tres', 'a: b', 4, true])
  assert.equal(after, '---\ntags: [uno, "dos, tres", "a: b", 4, true] # mine\ntitle: x\n---\ncuerpo\n')
  assert.deepEqual(readFrontmatter(after).data.tags, ['uno', 'dos, tres', 'a: b', 4, true])
  assert.equal(setFrontmatterKey('---\ntitle: x\n---\n', 'tags', []), '---\ntitle: x\ntags: []\n---\n')
  assert.throws(() => setFrontmatterKey('---\na: 1\n---\n', 'a', ['x\ny']), FrontmatterError)
})

test('multiline values are rejected', () => {
  assert.throws(() => setFrontmatterKey('---\na: 1\n---\n', 'a', 'x\ny'), FrontmatterError)
})

test('adding to a list: flow, block, from a scalar, and creating it', async () => {
  const { addToFrontmatterList } = await import('@vihko/core')
  assert.equal(addToFrontmatterList('---\naliases: [a, b]  # c\n---\nx\n', 'aliases', 'Viejo'), '---\naliases: [a, b, Viejo]  # c\n---\nx\n')
  assert.equal(addToFrontmatterList('---\naliases: []\n---\n', 'aliases', 'V'), '---\naliases: [V]\n---\n')
  assert.equal(addToFrontmatterList('---\naliases:\n  - a\ntitle: t\n---\n', 'aliases', 'V'), '---\naliases:\n  - a\n  - V\ntitle: t\n---\n')
  assert.equal(addToFrontmatterList('---\naliases: a\n---\n', 'aliases', 'V'), '---\naliases: [a, V]\n---\n')
  assert.equal(addToFrontmatterList('---\ntitle: t\n---\n', 'aliases', 'V'), '---\ntitle: t\naliases: [V]\n---\n')
  assert.equal(addToFrontmatterList('# sin frontmatter\n', 'aliases', 'Plan: viejo'), '---\naliases: ["Plan: viejo"]\n---\n# sin frontmatter\n')
  assert.equal(addToFrontmatterList('---\naliases: [a]\n---\n', 'aliases', 'a'), '---\naliases: [a]\n---\n', 'no duplicates')
  const crlf = addToFrontmatterList('---\r\naliases:\r\n  - a\r\n---\r\n', 'aliases', 'V')
  assert.equal(crlf, '---\r\naliases:\r\n  - a\r\n  - V\r\n---\r\n')
})
