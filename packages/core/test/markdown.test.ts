import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extract } from '@thoth/core'

const vault = (p: string) => readFileSync(new URL(`../../../testdata/vault/${p}`, import.meta.url), 'utf8')
const targets = (text: string) => extract(text).links.map((l) => l.target)
const tagNames = (text: string) => [...new Set(extract(text).tags.map((t) => t.name))].sort()

test('nada de lo que está en código es enlace ni tag', () => {
  const x = extract(vault('codigo.md'))
  assert.deepEqual(x.links.map((l) => l.raw), ['[[Plan]]'])
  assert.deepEqual(x.tags.map((t) => t.name), ['hogar'])
})

test('tags: mayúsculas, anidados, frontmatter, numéricos y encabezados', () => {
  assert.deepEqual(tagNames(vault('tags.md')), ['hogar', 'hogar/red', 'proyectos'])
  const x = extract(vault('tags.md'))
  assert.equal(x.tags.filter((t) => t.source === 'frontmatter').length, 2)
  assert.ok(x.headings.some((h) => h.text === 'Título' && h.level === 1))
})

test('wikilinks: texto visible, embed, ancla y referencia a sí misma', () => {
  const links = extract(vault('proyectos/thoth/notas.md')).links
  assert.deepEqual(links.map((l) => [l.kind, l.target, l.display]), [
    ['wiki', 'Plan', null],
    ['wiki', 'plan', null],
    ['wiki', 'Plan', 'el plan'],
    ['embed', 'Plan', null],
    ['wiki', 'notas', null],
  ])
})

test('enlaces del hogar: alias, anclas, rotos, Markdown relativo y externos', () => {
  const links = extract(vault('hogar/enlaces.md')).links
  assert.deepEqual(links.map((l) => [l.kind, l.target, l.anchor]), [
    ['wiki', 'gw', null],
    ['wiki', 'Red', null],
    ['wiki', 'Proxy', 'Red'],
    ['wiki', 'Proxy', 'No existe'],
    ['wiki', 'Nota que no existe', null],
    ['markdown', 'Proxy.md', null],
    ['markdown', '../proyectos/thoth/Plan.md', null],
    ['markdown', 'no-existe.md', null],
  ])
  assert.equal(links[5]!.display, 'Proxy en Markdown')
  assert.ok(!extract(vault('hogar/enlaces.md')).tags.length, 'el # de una URL no es tag')
})

test('rutas parciales en wikilinks', () => {
  assert.deepEqual(targets(vault('diario/2026-09-24.md')), ['Plan', 'Tareas', 'proyectos/blog/Plan', 'blog/Plan'])
})

test('encabezados con nivel y texto', () => {
  const h = extract(vault('hogar/Proxy.md')).headings
  assert.deepEqual(h.map((x) => [x.level, x.text]), [[1, 'Proxy'], [2, 'Red'], [2, 'Almacenamiento']])
})

test('los offsets apuntan al texto original, con frontmatter, BOM y CRLF', () => {
  for (const file of ['frontmatter/bom-crlf.md', 'hogar/enlaces.md', 'tags.md']) {
    const text = vault(file)
    const x = extract(text)
    for (const l of x.links) assert.equal(text.slice(l.from, l.to), l.raw, `${file}: ${l.raw}`)
    for (const t of x.tags) if (t.from !== null) assert.equal(text.slice(t.from, t.to!).toLowerCase(), '#' + t.name, file)
  }
})

test('el frontmatter no se interpreta como Markdown', () => {
  const x = extract('---\ntitle: "#noEsTag [[NoEsEnlace]]"\n---\n# Cuerpo\n')
  assert.deepEqual(x.links, [])
  assert.deepEqual(x.tags, [])
  assert.deepEqual(x.headings.map((h) => h.text), ['Cuerpo'])
})

test('casos límite de la sintaxis', () => {
  assert.deepEqual(targets('[[]] [[a\nb]] [[x[y]]'), [], 'vacíos, multilínea o con corchetes dentro no son enlaces')
  assert.deepEqual(targets('[[#Sección]]'), [''], 'ancla a la propia nota')
  assert.deepEqual(targets('[a](mailto:x@y.z) [b](//cdn/x) [c](Nota%20con%20espacios.md)'), ['Nota con espacios.md'])
  assert.deepEqual(tagNames('a#b #c-d_e #/x #á #1a'), ['1a', 'c-d_e', 'á'])
})
