import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FrontmatterError, readFrontmatter, setFrontmatterKey } from '@thoth/core'

const vault = (p: string) => readFileSync(new URL(`../../../testdata/vault/${p}`, import.meta.url), 'utf8')

test('lee el frontmatter exótico sin conversiones implícitas', () => {
  const fm = readFrontmatter(vault('frontmatter/exotico.md'))
  assert.equal(fm.error, null)
  assert.equal(fm.data.title, 'Título con: dos puntos')
  assert.deepEqual(fm.data.tags, ['a', 'b', 'c'])
  assert.equal(fm.data.fecha, '2026-09-24', 'las fechas quedan como texto')
  assert.deepEqual(fm.data.copia, { x: 1 }, 'las anclas YAML se resuelven')
  assert.equal(fm.data.multilinea, 'línea uno\nlínea dos\n')
})

test('frontmatter inválido: error y cuerpo a partir del cierre', () => {
  const fm = readFrontmatter(vault('frontmatter/invalido.md'))
  assert.ok(fm.error)
  assert.deepEqual(fm.data, {})
  assert.throws(() => setFrontmatterKey(vault('frontmatter/invalido.md'), 'uid', 'X'), FrontmatterError)
})

test('sin delimitador de cierre no hay frontmatter', () => {
  const fm = readFrontmatter('---\ntitle: x\nsin cierre\n')
  assert.equal(fm.block, null)
  assert.equal(fm.bodyStart, 0)
})

test('añadir una clave al frontmatter exótico solo añade una línea', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'uid', '01J9ABC')
  assert.equal(after, before.replace('desconocida_de_otra_herramienta: true\n---\n', 'desconocida_de_otra_herramienta: true\nuid: 01J9ABC\n---\n'))
})

test('cambiar un valor entre comillas solo cambia ese valor', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'title', 'Nuevo')
  assert.equal(after, before.replace('title: "Título con: dos puntos"', 'title: Nuevo'))
})

test('sustituir una lista en flujo conserva el comentario de la línea', () => {
  const before = vault('frontmatter/exotico.md')
  const after = setFrontmatterKey(before, 'tags', 'uno')
  assert.equal(after, before.replace(`tags: [a, 'b', "c"]   # lista en flujo con comentario`, 'tags: uno   # lista en flujo con comentario'))
})

test('sustituir una lista en bloque la deja en una línea', () => {
  const before = '---\naliases:\n  - plan\n  - otro\ntitle: x\n---\ncuerpo\n'
  assert.equal(setFrontmatterKey(before, 'aliases', 'uno'), '---\naliases: uno\ntitle: x\n---\ncuerpo\n')
})

test('rellenar una clave sin valor', () => {
  assert.equal(setFrontmatterKey('---\nuid:\ntitle: x\n---\n', 'uid', 'A1'), '---\nuid: A1\ntitle: x\n---\n')
})

test('crear el bloque cuando no existe, sin tocar el cuerpo', () => {
  const before = vault('frontmatter/sin-frontmatter.md')
  assert.equal(setFrontmatterKey(before, 'uid', 'A1'), '---\nuid: A1\n---\n' + before)
  assert.equal(setFrontmatterKey('', 'uid', 'A1'), '---\nuid: A1\n---\n')
})

test('BOM y CRLF se conservan', () => {
  const before = vault('frontmatter/bom-crlf.md')
  const after = setFrontmatterKey(before, 'uid', 'A1')
  assert.equal(after, before.replace('title: BOM y CRLF\r\n---\r\n', 'title: BOM y CRLF\r\nuid: A1\r\n---\r\n'))
  assert.ok(after.startsWith('﻿'))
  const created = setFrontmatterKey('﻿línea\r\notra\r\n', 'uid', 'A1')
  assert.equal(created, '﻿---\r\nuid: A1\r\n---\r\nlínea\r\notra\r\n')
})

test('los valores que lo necesitan se entrecomillan y releen igual', () => {
  const after = setFrontmatterKey('---\ntitle: x\n---\n', 'title', 'a: b # c')
  assert.equal(readFrontmatter(after).data.title, 'a: b # c')
  const num = setFrontmatterKey('---\ntitle: x\n---\n', 'title', '123')
  assert.equal(readFrontmatter(num).data.title, '123', 'un texto numérico sigue siendo texto')
})

test('valores multilínea se rechazan', () => {
  assert.throws(() => setFrontmatterKey('---\na: 1\n---\n', 'a', 'x\ny'), FrontmatterError)
})
