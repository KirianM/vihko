import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSearchQuery } from '@vihko/core'
import { setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

// Over the test vault (its tags and folders are the fixture); what the tests add is the mother's.
const m = mother(import.meta.url)

/** The results' paths, from the shared space's root (where the setup puts the vault). */
const paths = (r: { body: { results: { path: string }[] } }) => r.body.results.map((x) => x.path.slice(inShared('').length + 1)).sort()

test('the query parser takes filters out of the text: quotes, negation, case', () => {
  assert.deepEqual(parseSearchQuery('proxy tag:HoGar path:"mis notas/" -tag:#hecho red'), {
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
  // Only a whole word is a filter: "etag:x" is never `tag:` (it is a frontmatter field, `etag`).
  assert.deepEqual(parseSearchQuery('etag:x').filters, [{ kind: 'field', key: 'etag', value: 'x', negate: false }])
})

test('tag: matches case-insensitively and includes nested tags; path: a folder or a note', async () => {
  const { admin } = await setup()
  const q = (s: string) => admin('GET', `/api/search?q=${encodeURIComponent(s)}`)
  assert.deepEqual(paths(await q('tag:hogar')), ['codigo.md', 'tags.md'])
  assert.deepEqual(paths(await q('tag:HOGAR/red')), ['tags.md'])
  assert.deepEqual(paths(await q('tag:hog')), [], 'a tag is never matched by a prefix of its name')
  assert.deepEqual(paths(await q('tag:hogar -tag:proyectos')), ['codigo.md'])
  assert.deepEqual(paths(await q(`tag:a path:"${inShared('frontmatter')}/"`)), ['frontmatter/exotico.md'])
  assert.deepEqual(paths(await q(`tag:a -path:"${inShared('frontmatter')}"`)), [])
  assert.deepEqual(paths(await q(`path:"${inShared('hogar')}"`)), ['hogar/Firewall.md', 'hogar/Proxy.md', 'hogar/Red.md', 'hogar/enlaces.md'])
  assert.deepEqual(paths(await q(`path:"${inShared('recetas/Notas de reunión (2026).md')}"`)), ['recetas/Notas de reunión (2026).md'])
  assert.deepEqual(paths(await q(`path:"${inShared('proyectos/vihko')}"`)), ['proyectos/vihko/Plan.md', 'proyectos/vihko/Tareas.md', 'proyectos/vihko/notas.md'])
  // With text: the full-text search, narrowed by the filters.
  const all = paths(await q('plan'))
  const inVihko = paths(await q(`plan path:"${inShared('proyectos/vihko')}"`))
  assert.ok(inVihko.length > 0 && inVihko.length < all.length, `${inVihko} / ${all}`)
  assert.ok(inVihko.every((p) => p.startsWith('proyectos/vihko/')))
  const r = await q(`plan path:"${inShared('proyectos/vihko')}"`)
  assert.ok(r.body.results.some((x: { snippet: string }) => x.snippet.includes(r.body.highlight.start)), 'text results keep their snippet')
  assert.deepEqual(paths(await q('tag:')), [])
  // LIKE wildcards in a value are literal.
  assert.deepEqual(paths(await q('path:homel_b')), [])
})

test('the tags list counts notes per tag, with and without nested tags', async () => {
  const { notesDir, admin } = await setup()
  const r = await admin('GET', '/api/tags')
  assert.equal(r.status, 200)
  const by = new Map((r.body.tags as { tag: string; count: number; total: number }[]).map((t) => [t.tag, t]))
  assert.deepEqual(by.get('hogar'), { tag: 'hogar', count: 2, total: 2 })
  assert.deepEqual(by.get('hogar/red'), { tag: 'hogar/red', count: 1, total: 1 })
  assert.deepEqual(by.get('proyectos'), { tag: 'proyectos', count: 1, total: 1 })
  assert.ok(!by.has('notag') && !by.has('tampoco'), 'tags inside code are not tags')
  // Only nested tags: one under the vault's `hogar`, one under a parent nobody writes.
  const parent = m.aTag()
  writeFileSync(join(notesDir, m.aNotePath(inShared(''))), `#hogar/${m.aTag()} ${m.aWord()} #${parent}/2026\n`)
  await admin('POST', '/api/admin/rescan', {})
  const after = new Map(((await admin('GET', '/api/tags')).body.tags as { tag: string; count: number; total: number }[]).map((t) => [t.tag, t]))
  assert.deepEqual(after.get('hogar'), { tag: 'hogar', count: 2, total: 3 }, 'a note with only a nested tag counts in the total')
  assert.ok(!after.has(parent), 'a parent nobody writes is not a tag in use (the view groups it)')
})

test('the tree lists folders, the empty ones too; folders are created, moved and deleted over HTTP', async () => {
  const { notesDir, admin } = await setup()
  const [empty, created, infra] = [inShared(m.aFolder()), inShared(m.aFolder()), inShared(m.aFolder())]
  const [hogar, recetas] = [inShared('hogar'), inShared('recetas')]
  // A note of its own linking to two of the vault's in `hogar`, the folder that moves.
  const linking = m.aNotePath(inShared(''))
  mkdirSync(join(notesDir, empty))
  writeFileSync(join(notesDir, linking), `[[hogar/Proxy]] ${m.aWord()} [${m.aWord()}](hogar/Red.md)\n`)
  await admin('POST', '/api/admin/rescan', {})
  let tree = await admin('GET', '/api/tree')
  assert.ok(tree.body.folders.includes(empty) && tree.body.folders.includes(hogar))
  assert.ok(!tree.body.folders.some((f: string) => f.startsWith('.')), 'hidden folders are not listed')

  assert.equal((await admin('POST', '/api/folder', { path: created })).status, 201)
  assert.equal((await admin('POST', '/api/folder', { path: created })).body.error, 'exists')
  assert.equal((await admin('POST', '/api/folder', { path: inShared(`.${m.aFolder()}`) })).body.error, 'invalid_path')

  const preview = await admin('POST', '/api/folder/move', { from: hogar, to: `${infra}/hogar`, dryRun: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.notes.length, 4)
  assert.ok(preview.body.relinked.some((x: { path: string }) => x.path === linking))
  assert.ok(existsSync(join(notesDir, hogar, 'Proxy.md')))
  const moved = await admin('POST', '/api/folder/move', { from: hogar, to: `${infra}/hogar` })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.failed, [])
  tree = await admin('GET', '/api/tree')
  assert.ok(tree.body.notes.some((n: { path: string }) => n.path === `${infra}/hogar/Proxy.md`))
  assert.ok(!tree.body.folders.includes(hogar) && tree.body.folders.includes(`${infra}/hogar`))
  const links = await admin('GET', `/api/note/links?path=${encodeURIComponent(linking)}`)
  assert.deepEqual(links.body.outgoing.map((l: { dstPath: string }) => l.dstPath), [`${infra}/hogar/Proxy.md`, `${infra}/hogar/Red.md`])

  assert.equal((await admin('POST', '/api/folder/move', { from: recetas, to: infra })).status, 409)
  const folder = (path: string) => `/api/folder?path=${encodeURIComponent(path)}`
  assert.equal((await admin('DELETE', folder(infra))).status, 409)
  assert.equal((await admin('DELETE', folder(infra))).body.error, 'not_empty')
  assert.equal((await admin('DELETE', folder(empty))).status, 200)
  assert.ok(!(await admin('GET', '/api/tree')).body.folders.includes(empty))
})
