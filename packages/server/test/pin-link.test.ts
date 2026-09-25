// Pinning an ambiguous link (D-031.2): one occurrence is rewritten to the
// shortest form that leads to the chosen candidate, alias and anchor kept,
// and only when asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LinkIndex, extract, readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, openIndex, rewriteLink, type Actor } from '@thoth/server'
import { setup as appSetup } from './_app.ts'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: 'noa' }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-pin-'))
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const body = (p: string) => { const t = readFileSync(join(notesDir, p), 'utf8'); return t.slice(readFrontmatter(t).bodyStart) }
  const write = (p: string, text: string) => { mkdirSync(join(notesDir, p, '..'), { recursive: true }); writeFileSync(join(notesDir, p), text); indexer.indexPaths([p]) }
  const status = (src: string, raw: string) => db.prepare('select status, dst_path from links where src_path = ? and raw = ? order by ord').all(src, raw) as { status: string; dst_path: string | null }[]
  return { notesDir, db, indexer, notes, body, write, status }
}

// --- The rewrite -----------------------------------------------------------

const index = () => {
  const i = new LinkIndex()
  for (const path of ['proyectos/thoth/Tareas.md', 'proyectos/blog/Tareas.md', 'archivo/thoth/Tareas.md', 'diario/hoy.md']) i.set({ path, headings: ['Hoy'] })
  return i
}
const linkIn = (text: string) => extract(text).links[0]!

test('the rewrite: the shortest suffix that leads to the chosen note, alias and anchor kept', () => {
  const i = index()
  assert.equal(rewriteLink(linkIn('[[Tareas]]'), 'diario/hoy.md', 'proyectos/blog/Tareas.md', i), '[[blog/Tareas]]')
  assert.equal(rewriteLink(linkIn('[[Tareas|las tareas]]'), 'diario/hoy.md', 'proyectos/blog/Tareas.md', i), '[[blog/Tareas|las tareas]]')
  assert.equal(rewriteLink(linkIn('[[Tareas#Hoy]]'), 'diario/hoy.md', 'proyectos/blog/Tareas.md', i), '[[blog/Tareas#Hoy]]')
  assert.equal(rewriteLink(linkIn('[[ Tareas #Hoy| las de hoy ]]'), 'diario/hoy.md', 'proyectos/blog/Tareas.md', i), '[[ blog/Tareas #Hoy| las de hoy ]]')
  assert.equal(rewriteLink(linkIn('![[Tareas]]'), 'diario/hoy.md', 'proyectos/blog/Tareas.md', i), '![[blog/Tareas]]')
  // `thoth/Tareas` is still ambiguous (proyectos/thoth and archivo/thoth): one more folder.
  assert.equal(rewriteLink(linkIn('[[Tareas]]'), 'diario/hoy.md', 'proyectos/thoth/Tareas.md', i), '[[proyectos/thoth/Tareas]]')
})

test('the rewrite: the absolute path when no suffix reaches the note from there', () => {
  const i = new LinkIndex()
  for (const path of ['Plan.md', 'a/Plan.md', 'a/b/Plan.md']) i.set({ path })
  // From a/, [[Plan]] is a/Plan.md: the root one is only reached from the root.
  assert.equal(rewriteLink(linkIn('[[Plan|el de la raíz]]'), 'a/nota.md', 'Plan.md', i), '[[/Plan|el de la raíz]]')
})

// --- The note service ----------------------------------------------------------

test('pinning rewrites only the occurrence asked for, and the index then resolves it', async () => {
  const { notes, body, write, status } = setup()
  const text = '# Fuente\n\nPrimero [[Tareas]] y luego [[Tareas|otra vez]] y [[Tareas]].\n'
  write('ux/Fuente.md', text)
  assert.deepEqual(status('ux/Fuente.md', '[[Tareas]]').map((s) => s.status), ['ambiguous', 'ambiguous'])
  const second = text.lastIndexOf('[[Tareas]]')
  const r = await notes.pinLink('ux/Fuente.md', { raw: '[[Tareas]]', at: second + 1 }, 'proyectos/blog/Tareas.md', { actor: me })
  assert.equal(r.raw, '[[blog/Tareas]]')
  assert.equal(body('ux/Fuente.md'), '# Fuente\n\nPrimero [[Tareas]] y luego [[Tareas|otra vez]] y [[blog/Tareas]].\n')
  assert.deepEqual(status('ux/Fuente.md', '[[blog/Tareas]]'), [{ status: 'resolved', dst_path: 'proyectos/blog/Tareas.md' }])
  assert.deepEqual(status('ux/Fuente.md', '[[Tareas]]').map((s) => s.status), ['ambiguous'])
  // The first one, without a position; the alias stays.
  const alias = await notes.pinLink('ux/Fuente.md', { raw: '[[Tareas|otra vez]]' }, 'proyectos/thoth/Tareas.md', { actor: me })
  assert.equal(alias.raw, '[[thoth/Tareas|otra vez]]')
  assert.ok(body('ux/Fuente.md').includes('luego [[thoth/Tareas|otra vez]] y'))
})

test("pinning is refused for a note that isn't a candidate or a link that isn't there, and is a no-op once it leads there", async () => {
  const { notes, body, write, notesDir } = setup()
  write('ux/Fuente.md', '# Fuente\n\n[[Tareas]] y [[Plan]]\n')
  const before = readFileSync(join(notesDir, 'ux/Fuente.md'), 'utf8')
  await assert.rejects(notes.pinLink('ux/Fuente.md', { raw: '[[Tareas]]' }, 'Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  await assert.rejects(notes.pinLink('ux/Fuente.md', { raw: '[[Nada]]' }, 'Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  // [[Plan]] resolves (the root one): it isn't ambiguous, so nothing to pin elsewhere.
  await assert.rejects(notes.pinLink('ux/Fuente.md', { raw: '[[Plan]]' }, 'proyectos/blog/Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  assert.equal(readFileSync(join(notesDir, 'ux/Fuente.md'), 'utf8'), before, 'nothing written')
  await notes.pinLink('ux/Fuente.md', { raw: '[[Tareas]]' }, 'proyectos/thoth/Tareas.md', { actor: me })
  const pinned = body('ux/Fuente.md')
  // Asking again (another tab) for the same destination: it already leads there.
  const again = await notes.pinLink('ux/Fuente.md', { raw: '[[thoth/Tareas]]' }, 'proyectos/thoth/Tareas.md', { actor: me })
  assert.equal(again.raw, '[[thoth/Tareas]]')
  assert.equal(body('ux/Fuente.md'), pinned)
})

// --- HTTP -----------------------------------------------------------------------

test('HTTP: the links carry where they are and their candidates\' titles; pinning goes through the API', async () => {
  const { noa, notesDir } = await appSetup()
  const links = await noa('GET', '/api/note/links?path=diario/2026-09-24.md')
  const tareas = links.body.outgoing.find((l: { raw: string }) => l.raw === '[[Tareas]]')
  assert.equal(tareas.status, 'ambiguous')
  assert.equal(typeof tareas.pos_from, 'number')
  assert.deepEqual(links.body.titles, { 'proyectos/blog/Tareas.md': 'Tareas de blog', 'proyectos/thoth/Tareas.md': 'Tareas de thoth' })

  const r = await noa('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', at: tareas.pos_from, target: 'proyectos/thoth/Tareas.md' })
  assert.equal(r.status, 200)
  assert.equal(r.body.raw, '[[thoth/Tareas]]')
  assert.ok(readFileSync(join(notesDir, 'diario/2026-09-24.md'), 'utf8').includes('- [[thoth/Tareas]] es ambiguo'))
  const bad = await noa('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', target: 'proyectos/thoth/Tareas.md' })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'edit_mismatch')
  const invalid = await noa('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', at: 'x', target: 'a.md' })
  assert.equal(invalid.status, 400)
})
