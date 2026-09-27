import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, dumpIndex, openIndex, type Actor } from '@thoth/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }

function setup() {
  const dir = tempDir('thoth-move-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const body = (p: string) => { const t = readFileSync(join(notesDir, p), 'utf8'); return t.slice(readFrontmatter(t).bodyStart) }
  const dst = (src: string, raw: string) => (db.prepare('select dst_path from links where src_path = ? and raw = ?').get(src, raw) as { dst_path: string } | undefined)?.dst_path
  return { dir, notesDir, db, indexer, notes, body, dst }
}

test('renaming rewrites wikilinks (with an anchor) and Markdown links, and leaves the still-valid ones alone', async () => {
  const { notes, body, dst } = setup()
  const r = await notes.move('hogar/Proxy.md', 'hogar/Hipervisor Proxy.md', { actor: me })
  assert.deepEqual(r.failed, [])
  const t = body('hogar/enlaces.md')
  assert.ok(t.includes('- [[gw]] resuelve por alias'), "the alias still works: it's left alone")
  assert.ok(t.includes('[[Hipervisor Proxy#Red]]'))
  assert.ok(t.includes('[[Hipervisor Proxy#No existe]]'))
  assert.ok(t.includes('[Proxy en Markdown](Hipervisor%20Proxy.md)'))
  assert.equal(dst('hogar/enlaces.md', '[[Hipervisor Proxy#Red]]'), 'hogar/Hipervisor Proxy.md')
  assert.equal(dst('hogar/enlaces.md', '[Proxy en Markdown](Hipervisor%20Proxy.md)'), 'hogar/Hipervisor Proxy.md')
})

test('moving to another folder uses the shortest unambiguous suffix and keeps visible text and embeds', async () => {
  const { notes, body, dst } = setup()
  await notes.move('proyectos/thoth/Plan.md', 'archivo/Plan.md', { actor: me })
  const t = body('proyectos/thoth/notas.md')
  // From proyectos/thoth/, [[Plan]] would now go to proyectos/blog/Plan.md: it needs disambiguating.
  assert.ok(t.includes('- [[archivo/Plan]] resuelve'))
  assert.ok(t.includes('- [[archivo/Plan|el plan]]'))
  assert.ok(t.includes('- ![[archivo/Plan]]'))
  assert.equal(dst('proyectos/thoth/notas.md', '[[archivo/Plan|el plan]]'), 'archivo/Plan.md')
  assert.ok(body('hogar/enlaces.md').includes('[Plan de thoth](../archivo/Plan.md)'))
})

test('a rename doesn\'t "steal" links from other notes; an absolute path is used if needed', async () => {
  const { notes, body, dst } = setup()
  // [[Plan]] in diario/ resolves to the root Plan.md. Bringing a Plan.md into diario/ would make it point there instead.
  const r = await notes.move('proyectos/blog/Plan.md', 'diario/Plan.md', { actor: me })
  assert.ok(r.relinked.some((x) => x.path === 'diario/2026-09-24.md'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[/Plan]] resuelve'), 'the root is only reached with an absolute path')
  assert.equal(dst('diario/2026-09-24.md', '[[/Plan]]'), 'Plan.md')
  // [[proyectos/blog/Plan]] and [[blog/Plan]] pointed to the moved note: they switch to the shortest form.
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] ruta parcial'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] sufijo de ruta'))
  assert.equal(dst('diario/2026-09-24.md', '[[Plan]]'), 'diario/Plan.md')
})

test("the moved note's own links keep pointing to the same thing", async () => {
  const { notes, body, dst } = setup()
  await notes.move('proyectos/thoth/notas.md', 'ideas/notas thoth.md', { actor: me })
  const t = body('ideas/notas thoth.md')
  assert.ok(t.includes('- [[proyectos/thoth/Plan]] resuelve') || t.includes('- [[thoth/Plan]] resuelve'), t)
  assert.ok(t.includes('- [[notas thoth]] enlace a sí misma'))
  assert.equal(dst('ideas/notas thoth.md', '[[notas thoth]]'), 'ideas/notas thoth.md')
})

test('the preview details every link that changes and those that keep working untouched', async () => {
  const { notes } = setup()
  const r = await notes.move('hogar/Proxy.md', 'hogar/Hipervisor Proxy.md', { actor: me, dryRun: true })
  const enlaces = r.relinked.find((x) => x.path === 'hogar/enlaces.md')!
  assert.deepEqual(enlaces.changes, [
    { before: '[[Proxy#Red]]', after: '[[Hipervisor Proxy#Red]]' },
    { before: '[[Proxy#No existe]]', after: '[[Hipervisor Proxy#No existe]]' },
    { before: '[Proxy en Markdown](Proxy.md)', after: '[Proxy en Markdown](Hipervisor%20Proxy.md)' },
  ])
  assert.equal(enlaces.links, enlaces.changes.length)
  assert.deepEqual(r.kept.filter((k) => k.path === 'hogar/enlaces.md'), [{ path: 'hogar/enlaces.md', raw: '[[gw]]', via: 'alias' }])
  // Moving without renaming: links by name keep working.
  const m = await notes.move('hogar/Proxy.md', 'infra/Proxy.md', { actor: me, dryRun: true })
  assert.ok(m.kept.some((k) => k.raw === '[[Proxy#Red]]' && k.via === 'path'))
  assert.ok(!m.relinked.some((x) => x.changes.some((c) => c.before === '[[Proxy#Red]]')))
})

test('dryRun changes nothing; an existing destination and a stale if_match are rejected', async () => {
  const { notesDir, db, notes } = setup()
  const snapshot = dumpIndex(db)
  const r = await notes.move('hogar/Proxy.md', 'hogar/GW.md', { actor: me, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.ok(r.relinked.some((x) => x.path === 'hogar/enlaces.md'))
  assert.ok(existsSync(join(notesDir, 'hogar/Proxy.md')) && !existsSync(join(notesDir, 'hogar/GW.md')))
  assert.equal(dumpIndex(db), snapshot)
  await assert.rejects(notes.move('hogar/Proxy.md', '../fuera.md', { actor: me, dryRun: true }), (e: NoteError) => e.code === 'invalid_path')
  await assert.rejects(notes.move('hogar/Proxy.md', 'hogar/Red.md', { actor: me }), (e: NoteError) => e.code === 'exists')
  await assert.rejects(notes.move('hogar/Proxy.md', 'x.md', { actor: me, ifMatch: 'sha256:bad' }), (e: NoteError) => e.code === 'precondition_failed')
})

test('if a rewrite fails, the old name is kept as an alias', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, indexer, notes, dst } = setup()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(notesDir, 'otra'))
  mkdirSync(join(notesDir, 'bloqueada'))
  writeFileSync(join(notesDir, 'otra/Destino.md'), '# Destino\n')
  writeFileSync(join(notesDir, 'bloqueada/enlaza.md'), '[[Destino]]\n')
  indexer.scan()
  chmodSync(join(notesDir, 'bloqueada'), 0o555)
  try {
    const r = await notes.move('otra/Destino.md', 'otra/Nuevo nombre.md', { actor: me })
    assert.deepEqual(r.failed.map((f) => [f.path, f.error]), [['bloqueada/enlaza.md', 'internal']])
    assert.equal(r.aliasAdded, 'Destino')
    assert.deepEqual(readFrontmatter(readFileSync(join(notesDir, 'otra/Nuevo nombre.md'), 'utf8')).data.aliases, ['Destino'])
    assert.equal(readFileSync(join(notesDir, 'bloqueada/enlaza.md'), 'utf8'), '[[Destino]]\n')
    assert.equal(dst('bloqueada/enlaza.md', '[[Destino]]'), 'otra/Nuevo nombre.md', 'the unrewritten link still resolves via the alias')
  } finally {
    chmodSync(join(notesDir, 'bloqueada'), 0o755)
  }
})

test('with links.aliases off, a failed rewrite adds no alias: it would save nothing', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, indexer, notes, dst } = setup()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(notesDir, 'otra'))
  mkdirSync(join(notesDir, 'bloqueada'))
  writeFileSync(join(notesDir, 'otra/Destino.md'), '# Destino\n')
  writeFileSync(join(notesDir, 'bloqueada/enlaza.md'), '[[Destino]]\n')
  indexer.scan()
  indexer.setLinkAliases(false)
  chmodSync(join(notesDir, 'bloqueada'), 0o555)
  try {
    const r = await notes.move('otra/Destino.md', 'otra/Nuevo nombre.md', { actor: me })
    assert.deepEqual(r.failed.map((f) => [f.path, f.error]), [['bloqueada/enlaza.md', 'internal']], 'the failure is still reported')
    assert.equal(r.aliasAdded, null)
    assert.equal(readFrontmatter(readFileSync(join(notesDir, 'otra/Nuevo nombre.md'), 'utf8')).data.aliases, undefined, 'no alias added')
    assert.equal(dst('bloqueada/enlaza.md', '[[Destino]]'), null, 'the link left behind is broken')
  } finally {
    chmodSync(join(notesDir, 'bloqueada'), 0o755)
  }
})

test("if the source can't be removed, the note isn't left duplicated", { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, notes } = setup()
  chmodSync(join(notesDir, 'recetas'), 0o555)
  try {
    await assert.rejects(notes.move('recetas/Notas de reunión (2026).md', 'reuniones/2026.md', { actor: me }))
    assert.ok(!existsSync(join(notesDir, 'reuniones/2026.md')))
    assert.ok(existsSync(join(notesDir, 'recetas/Notas de reunión (2026).md')))
  } finally {
    chmodSync(join(notesDir, 'recetas'), 0o755)
  }
})

test('a move says when the note is in place, counts its rewrites, and moves run one at a time', async () => {
  const { notes } = setup()
  const events: string[] = []
  const hooks = (name: string) => ({
    onMoved: (n: number) => { events.push(`${name} moved (${n} to rewrite)`) },
    onProgress: (done: number, total: number) => { if (done === total) events.push(`${name} ${done}/${total}`) },
  })
  const [a, b] = await Promise.all([
    notes.move('hogar/Proxy.md', 'hogar/GW.md', { actor: me, ...hooks('a') }).then((r) => { events.push('a done'); return r }),
    notes.moveFolder('proyectos/blog', 'blog', { actor: me, ...hooks('b') }).then((r) => { events.push('b done'); return r }),
  ])
  assert.deepEqual([a.failed, b.failed], [[], []])
  assert.deepEqual(events, ['a moved (1 to rewrite)', 'a 1/1', 'a done', 'b moved (1 to rewrite)', 'b 1/1', 'b done'])
})
