// D-019: an ambiguous link is never resolved silently. A move doesn't rewrite
// links that weren't resolved, but the preview (and the report after the move)
// lists the ones whose resolution it changes, by source note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Indexer, NoteService, openIndex, type Actor } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: 'noa' }
const DIARY = 'diario/2026-09-24.md'
const BOTH = ['proyectos/blog/Tareas.md', 'proyectos/thoth/Tareas.md']

function setup(extra: Record<string, string> = {}) {
  const dir = tempDir('thoth-shifts-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  for (const [p, text] of Object.entries(extra)) writeFileSync(join(notesDir, p), text)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  const link = (src: string, raw: string) => db.prepare('select status, dst_path, candidates from links where src_path = ? and raw = ?').get(src, raw) as { status: string; dst_path: string | null; candidates: string | null }
  return { notes, read, link }
}

test('an ambiguous link the move would resolve is listed in the preview, left as it is, and in the report', async () => {
  const { notes, read, link } = setup()
  const diary = read(DIARY)
  assert.equal(link(DIARY, '[[Tareas]]').status, 'ambiguous')
  const expected = [{
    path: DIARY, links: 1,
    changes: [{ raw: '[[Tareas]]', code: 'resolves', before: { status: 'ambiguous', candidates: BOTH }, after: { status: 'resolved', path: 'proyectos/Tareas.md' } }],
  }]
  const preview = await notes.move('proyectos/blog/Tareas.md', 'proyectos/Tareas.md', { actor: me, dryRun: true })
  assert.deepEqual(preview.shifted, expected)
  assert.ok(!preview.relinked.some((r) => r.path === DIARY), 'nothing is rewritten for it')

  const report = await notes.move('proyectos/blog/Tareas.md', 'proyectos/Tareas.md', { actor: me })
  assert.deepEqual(report.shifted, expected, 'the report after the move says the same')
  assert.equal(read(DIARY), diary, 'the file is not touched')
  assert.equal(link(DIARY, '[[Tareas]]').dst_path, 'proyectos/Tareas.md')
})

test('leaving a tie also resolves a link silently: it is listed with the note it will lead to', async () => {
  const { notes } = setup()
  const r = await notes.move('proyectos/blog/Tareas.md', 'proyectos/blog/Pendientes.md', { actor: me, dryRun: true })
  assert.deepEqual(r.shifted.map((g) => [g.path, g.changes.map((c) => [c.raw, c.code, c.after])]), [
    [DIARY, [['[[Tareas]]', 'resolves', { status: 'resolved', path: 'proyectos/thoth/Tareas.md' }]]],
  ])
})

test("the moved note's own ambiguous links count too, under its new path", async () => {
  const { notes } = setup({ 'suelta.md': '# Suelta\n\n- [[Tareas]] desde la raíz es ambiguo.\n' })
  const r = await notes.move('suelta.md', 'proyectos/thoth/suelta.md', { actor: me, dryRun: true })
  assert.deepEqual(r.shifted, [{
    path: 'proyectos/thoth/suelta.md', links: 1,
    changes: [{ raw: '[[Tareas]]', code: 'resolves', before: { status: 'ambiguous', candidates: BOTH }, after: { status: 'resolved', path: 'proyectos/thoth/Tareas.md' } }],
  }])
})

test('a broken link that a rename would repair is listed as well', async () => {
  const { notes } = setup({ 'pendiente.md': 'Ver [[Red local]] y [[Red local#Subredes]].\n' })
  const r = await notes.move('hogar/Red.md', 'hogar/Red local.md', { actor: me, dryRun: true })
  const group = r.shifted.find((g) => g.path === 'pendiente.md')
  assert.equal(group?.links, 2)
  assert.deepEqual(group?.changes.map((c) => [c.raw, c.code, c.before]), [
    ['[[Red local]]', 'resolves', { status: 'missing' }],
    ['[[Red local#Subredes]]', 'resolves', { status: 'missing' }],
  ])
})

test('a link that stays ambiguous, among other candidates, is not a shift', async () => {
  const { notes } = setup()
  const r = await notes.move('proyectos/blog/Tareas.md', 'archivo/x/Tareas.md', { actor: me, dryRun: true })
  assert.deepEqual(r.shifted, [])
})

test('a folder move lists the links it would resolve, in its preview and its report', async () => {
  const { notes, read } = setup()
  const expected = [{
    path: DIARY, links: 1,
    changes: [{ raw: '[[Tareas]]', code: 'resolves', before: { status: 'ambiguous', candidates: BOTH }, after: { status: 'resolved', path: 'blog/Tareas.md' } }],
  }]
  const preview = await notes.moveFolder('proyectos/blog', 'blog', { actor: me, dryRun: true })
  assert.deepEqual(preview.shifted, expected)
  const report = await notes.moveFolder('proyectos/blog', 'blog', { actor: me })
  assert.deepEqual(report.shifted, expected)
  assert.ok(read(DIARY).includes('- [[Tareas]] es ambiguo'), 'not rewritten')
})
