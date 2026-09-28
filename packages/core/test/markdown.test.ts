import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extract, withoutRanges } from '@thoth/core'
import { mother } from '../../../test/mother.ts'

// Comments' authors (usernames).
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()
const AGENT = m.aUsername()

const vault = (p: string) => readFileSync(new URL(`../../../testdata/vault/${p}`, import.meta.url), 'utf8')
const targets = (text: string) => extract(text).links.map((l) => l.target)
const tagNames = (text: string) => [...new Set(extract(text).tags.map((t) => t.name))].sort()

test('nothing inside a code block is a link or a tag', () => {
  const x = extract(vault('codigo.md'))
  assert.deepEqual(x.links.map((l) => l.raw), ['[[Plan]]'])
  assert.deepEqual(x.tags.map((t) => t.name), ['hogar'])
})

test('tags: uppercase, nested, frontmatter, numeric and headings', () => {
  assert.deepEqual(tagNames(vault('tags.md')), ['hogar', 'hogar/red', 'proyectos'])
  const x = extract(vault('tags.md'))
  assert.equal(x.tags.filter((t) => t.source === 'frontmatter').length, 2)
  assert.ok(x.headings.some((h) => h.text === 'Título' && h.level === 1))
})

test('wikilinks: display text, embed, anchor and self-reference', () => {
  const links = extract(vault('proyectos/thoth/notas.md')).links
  assert.deepEqual(links.map((l) => [l.kind, l.target, l.display]), [
    ['wiki', 'Plan', null],
    ['wiki', 'plan', null],
    ['wiki', 'Plan', 'el plan'],
    ['embed', 'Plan', null],
    ['wiki', 'notas', null],
  ])
})

test('hogar links: alias, anchors, broken, relative Markdown and external', () => {
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
  assert.ok(!extract(vault('hogar/enlaces.md')).tags.length, 'a `#` inside a URL is not a tag')
})

test('partial paths in wikilinks', () => {
  assert.deepEqual(targets(vault('diario/2026-09-24.md')), ['Plan', 'Tareas', 'proyectos/blog/Plan', 'blog/Plan'])
})

test('headings with level and text', () => {
  const h = extract(vault('hogar/Proxy.md')).headings
  assert.deepEqual(h.map((x) => [x.level, x.text]), [[1, 'Proxy'], [2, 'Red'], [2, 'Almacenamiento']])
})

test('offsets point into the original text, with frontmatter, BOM and CRLF', () => {
  for (const file of ['frontmatter/bom-crlf.md', 'hogar/enlaces.md', 'tags.md']) {
    const text = vault(file)
    const x = extract(text)
    for (const l of x.links) assert.equal(text.slice(l.from, l.to), l.raw, `${file}: ${l.raw}`)
    for (const t of x.tags) if (t.from !== null) assert.equal(text.slice(t.from, t.to!).toLowerCase(), '#' + t.name, file)
  }
})

test('frontmatter is not parsed as Markdown', () => {
  const x = extract('---\ntitle: "#noEsTag [[NoEsEnlace]]"\n---\n# Cuerpo\n')
  assert.deepEqual(x.links, [])
  assert.deepEqual(x.tags, [])
  assert.deepEqual(x.headings.map((h) => h.text), ['Cuerpo'])
})

test('syntax edge cases', () => {
  assert.deepEqual(targets('[[]] [[a\nb]] [[x[y]]'), [], 'empty, multiline or with brackets inside are not links')
  assert.deepEqual(targets('[[#Sección]]'), [''], 'anchor to the note itself')
  assert.deepEqual(targets('[a](mailto:x@y.z) [b](//cdn/x) [c](Nota%20con%20espacios.md)'), ['Nota con espacios.md'])
  assert.deepEqual(tagNames('a#b #c-d_e #/x #á #1a'), ['1a', 'c-d_e', 'á'])
})

test('HTML comments: found inline and in blocks, never in code; what they hold is not a link or a tag', () => {
  const text = [
    '---',
    'uid: x',
    '---',
    `# Plan <!-- @${REPLIER} 2026-09-24T08:10Z · rename it? -->`,
    '',
    `Use Postgres.<!-- @${AUTHOR} 2026-09-24T08:12Z · no, [[SQLite]] #db -->`,
    `<!-- @${AGENT} 2026-09-24T08:15Z · ↳ agreed --> after it`,
    '',
    '`<!-- code -->`',
    '',
    '```',
    '<!-- fenced -->',
    '```',
    '<div>',
    '<!-- in html -->',
    '</div>',
    '',
  ].join('\n')
  const x = extract(text)
  assert.deepEqual(x.comments.map((c) => text.slice(c.from, c.to)), [
    `<!-- @${REPLIER} 2026-09-24T08:10Z · rename it? -->`,
    `<!-- @${AUTHOR} 2026-09-24T08:12Z · no, [[SQLite]] #db -->`,
    `<!-- @${AGENT} 2026-09-24T08:15Z · ↳ agreed -->`,
    '<!-- in html -->',
  ])
  assert.deepEqual(x.links, [])
  assert.deepEqual(x.tags, [])
  assert.deepEqual(x.headings.map((h) => h.text), ['Plan'], "a heading's comment is not part of its text")
  assert.ok(withoutRanges(text, x.comments).includes('\n after it\n'), 'the text after a comment block on its line stays')
})

test('withoutRanges: removes the ranges within the window and keeps words apart', () => {
  const text = 'one<!-- a -->two <!-- b -->three.<!-- c -->\nfour'
  const x = extract(text)
  assert.equal(withoutRanges(text, x.comments), 'one two three.\nfour')
  assert.equal(withoutRanges(text, x.comments, 5, 33), 'two three.', 'ranges cut by the window are clipped')
  assert.equal(withoutRanges(text, []), text)
})
