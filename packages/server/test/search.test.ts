import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSearchQuery } from '@thoth/core'
import { setup } from './_app.ts'

const paths = (r: { body: { results: { path: string }[] } }) => r.body.results.map((x) => x.path).sort()

test('the query parser takes filters out of the text: quotes, negation, case', () => {
  assert.deepEqual(parseSearchQuery('proxy tag:Hogar path:"mis notas/" -tag:#hecho red'), {
    text: 'proxy red',
    filters: [
      { kind: 'tag', value: 'hogar', negate: false },
      { kind: 'path', value: 'mis notas', negate: false },
      { kind: 'tag', value: 'hecho', negate: true },
    ],
  })
  // Still being typed: an empty value is no filter, an unclosed quote still is one.
  assert.deepEqual(parseSearchQuery('tag:'), { text: '', filters: [] })
  assert.deepEqual(parseSearchQuery('path:"a b').filters, [{ kind: 'path', value: 'a b', negate: false }])
  // Only a whole word is a filter: "etag:x" is text.
  assert.deepEqual(parseSearchQuery('etag:x').filters, [])
})

test('tag: matches case-insensitively and includes nested tags; path: a folder or a note', async () => {
  const { noa } = await setup()
  const q = (s: string) => noa('GET', `/api/search?q=${encodeURIComponent(s)}`)
  assert.deepEqual(paths(await q('tag:hogar')), ['codigo.md', 'tags.md'])
  assert.deepEqual(paths(await q('tag:HOGAR/red')), ['tags.md'])
  assert.deepEqual(paths(await q('tag:home')), [], 'a tag is never matched by a prefix of its name')
  assert.deepEqual(paths(await q('tag:hogar -tag:proyectos')), ['codigo.md'])
  assert.deepEqual(paths(await q('tag:a path:frontmatter/')), ['frontmatter/exotico.md'])
  assert.deepEqual(paths(await q('tag:a -path:frontmatter')), [])
  assert.deepEqual(paths(await q('path:hogar')), ['hogar/Firewall.md', 'hogar/Proxy.md', 'hogar/Red.md', 'hogar/enlaces.md'])
  assert.deepEqual(paths(await q('path:"recetas/Notas de reunión (2026).md"')), ['recetas/Notas de reunión (2026).md'])
  assert.deepEqual(paths(await q('path:proyectos/thoth')), ['proyectos/thoth/Plan.md', 'proyectos/thoth/Tareas.md', 'proyectos/thoth/notas.md'])
  // With text: the full-text search, narrowed by the filters.
  const all = paths(await q('plan'))
  const inThoth = paths(await q('plan path:proyectos/thoth'))
  assert.ok(inThoth.length > 0 && inThoth.length < all.length, `${inThoth} / ${all}`)
  assert.ok(inThoth.every((p) => p.startsWith('proyectos/thoth/')))
  const r = await q('plan path:proyectos/thoth')
  assert.ok(r.body.results.some((x: { snippet: string }) => x.snippet.includes(r.body.highlight.start)), 'text results keep their snippet')
  assert.deepEqual(paths(await q('tag:')), [])
  // LIKE wildcards in a value are literal.
  assert.deepEqual(paths(await q('path:homel_b')), [])
})
