import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, dumpIndex, openIndex, type Actor } from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: 'noa' }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-move-'))
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

test('renombrar reescribe wikilinks (con ancla) y enlaces Markdown, y deja los que siguen valiendo', async () => {
  const { notes, body, dst } = setup()
  const r = await notes.move('hogar/Proxy.md', 'hogar/Hipervisor Proxy.md', { actor: me })
  assert.deepEqual(r.failed, [])
  const t = body('hogar/enlaces.md')
  assert.ok(t.includes('- [[gw]] resuelve por alias'), 'el alias sigue valiendo: no se toca')
  assert.ok(t.includes('[[Hipervisor Proxy#Red]]'))
  assert.ok(t.includes('[[Hipervisor Proxy#No existe]]'))
  assert.ok(t.includes('[Proxy en Markdown](Hipervisor%20Proxmox.md)'))
  assert.equal(dst('hogar/enlaces.md', '[[Hipervisor Proxy#Red]]'), 'hogar/Hipervisor Proxy.md')
  assert.equal(dst('hogar/enlaces.md', '[Proxy en Markdown](Hipervisor%20Proxmox.md)'), 'hogar/Hipervisor Proxy.md')
})

test('mover a otra carpeta usa el sufijo más corto que no sea ambiguo y conserva texto visible y embeds', async () => {
  const { notes, body, dst } = setup()
  await notes.move('proyectos/thoth/Plan.md', 'archivo/Plan.md', { actor: me })
  const t = body('proyectos/thoth/notas.md')
  // Desde proyectos/thoth/, [[Plan]] ahora iría a proyectos/blog/Plan.md: hay que desambiguar.
  assert.ok(t.includes('- [[archivo/Plan]] resuelve'))
  assert.ok(t.includes('- [[archivo/Plan|el plan]]'))
  assert.ok(t.includes('- ![[archivo/Plan]]'))
  assert.equal(dst('proyectos/thoth/notas.md', '[[archivo/Plan|el plan]]'), 'archivo/Plan.md')
  assert.ok(body('hogar/enlaces.md').includes('[Plan de thoth](../archivo/Plan.md)'))
})

test('un renombrado no "roba" enlaces de otras notas; si hace falta, ruta absoluta', async () => {
  const { notes, body, dst } = setup()
  // [[Plan]] en diario/ resuelve a Plan.md de la raíz. Al traer un Plan.md a diario/, pasaría a apuntar a él.
  const r = await notes.move('proyectos/blog/Plan.md', 'diario/Plan.md', { actor: me })
  assert.ok(r.relinked.some((x) => x.path === 'diario/2026-09-24.md'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[/Plan]] resuelve'), 'la raíz solo se alcanza con ruta absoluta')
  assert.equal(dst('diario/2026-09-24.md', '[[/Plan]]'), 'Plan.md')
  // [[proyectos/blog/Plan]] y [[blog/Plan]] apuntaban a la nota movida: pasan a la forma más corta.
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] ruta parcial'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] sufijo de ruta'))
  assert.equal(dst('diario/2026-09-24.md', '[[Plan]]'), 'diario/Plan.md')
})

test('los enlaces de la propia nota movida siguen apuntando a lo mismo', async () => {
  const { notes, body, dst } = setup()
  await notes.move('proyectos/thoth/notas.md', 'ideas/notas thoth.md', { actor: me })
  const t = body('ideas/notas thoth.md')
  assert.ok(t.includes('- [[proyectos/thoth/Plan]] resuelve') || t.includes('- [[thoth/Plan]] resuelve'), t)
  assert.ok(t.includes('- [[notas thoth]] enlace a sí misma'))
  assert.equal(dst('ideas/notas thoth.md', '[[notas thoth]]'), 'ideas/notas thoth.md')
})

test('dryRun no toca nada; destino existente e if_match viejo se rechazan', async () => {
  const { notesDir, db, notes } = setup()
  const snapshot = dumpIndex(db)
  const r = await notes.move('hogar/Proxy.md', 'hogar/GW.md', { actor: me, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.ok(r.relinked.some((x) => x.path === 'hogar/enlaces.md'))
  assert.ok(existsSync(join(notesDir, 'hogar/Proxy.md')) && !existsSync(join(notesDir, 'hogar/GW.md')))
  assert.equal(dumpIndex(db), snapshot)
  await assert.rejects(notes.move('hogar/Proxy.md', 'hogar/Red.md', { actor: me }), (e: NoteError) => e.code === 'exists')
  await assert.rejects(notes.move('hogar/Proxy.md', 'x.md', { actor: me, ifMatch: 'sha256:malo' }), (e: NoteError) => e.code === 'precondition_failed')
})

test('si una reescritura falla, el nombre antiguo queda como alias (D-018)', { skip: process.getuid?.() === 0 }, async () => {
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
    assert.deepEqual(r.failed.map((f) => f.path), ['bloqueada/enlaza.md'])
    assert.equal(r.aliasAdded, 'Destino')
    assert.deepEqual(readFrontmatter(readFileSync(join(notesDir, 'otra/Nuevo nombre.md'), 'utf8')).data.aliases, ['Destino'])
    assert.equal(readFileSync(join(notesDir, 'bloqueada/enlaza.md'), 'utf8'), '[[Destino]]\n')
    assert.equal(dst('bloqueada/enlaza.md', '[[Destino]]'), 'otra/Nuevo nombre.md', 'el enlace no reescrito sigue resolviendo por alias')
  } finally {
    chmodSync(join(notesDir, 'bloqueada'), 0o755)
  }
})

test('si no se puede retirar el origen, no queda la nota duplicada', { skip: process.getuid?.() === 0 }, async () => {
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
