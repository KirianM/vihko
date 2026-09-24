import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, openIndex, type Actor } from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: 'noa' }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-notes-'))
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  return { notesDir, stateDir, db, notes: new NoteService({ notesDir, stateDir, indexer, db }) }
}

const code = (fn: () => unknown) => assert.rejects(async () => fn(), NoteError)
async function errCode(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { if (e instanceof NoteError) return e.code; throw e }
  return 'sin error'
}

test('crear: nace con uid, crea carpetas, nunca sobrescribe y se indexa', async () => {
  const { notesDir, db, notes } = setup()
  const r = await notes.create('nuevo/proyecto/idea.md', '# Idea\n\n[[Plan]]\n', me)
  assert.match(r.uid!, /^[0-9A-Z]{26}$/)
  const text = readFileSync(join(notesDir, 'nuevo/proyecto/idea.md'), 'utf8')
  assert.equal(text, `---\nuid: ${r.uid}\n---\n# Idea\n\n[[Plan]]\n`)
  assert.equal(r.etag, contentHash(text))
  assert.ok(db.prepare('select 1 from notes where path = ? and uid = ?').get('nuevo/proyecto/idea.md', r.uid))
  assert.equal(await errCode(notes.create('Plan.md', 'x', me)), 'exists')
  assert.equal(readFileSync(join(notesDir, 'Plan.md'), 'utf8'), '# Plan general\n', 'crear no pisa')
})

test('escribir: exige if_match, conserva el uid y asigna uno si faltaba', async () => {
  const { notesDir, notes } = setup()
  const before = notes.read('uid/original.md')
  assert.equal(await errCode(notes.write('uid/original.md', 'x', { ifMatch: 'sha256:malo', actor: me })), 'precondition_failed')
  assert.equal(readFileSync(join(notesDir, 'uid/original.md'), 'utf8'), before.text, 'un 412 no toca el archivo')

  // Sobrescribir con un texto sin frontmatter no pierde la identidad.
  await notes.write('uid/original.md', '# Reescrita\n', { ifMatch: before.etag, actor: me })
  assert.equal(readFrontmatter(notes.read('uid/original.md').text).data.uid, '01J8X4M2K9QZ')

  // Una nota sin uid lo recibe en la primera escritura desde thoth (D-015)…
  const plan = notes.read('Plan.md')
  await notes.write('Plan.md', '# Plan general\n\nMás.\n', { ifMatch: plan.etag, actor: me })
  assert.match(String(readFrontmatter(notes.read('Plan.md').text).data.uid), /^[0-9A-Z]{26}$/)

  // …salvo que su frontmatter esté roto: entonces se escribe tal cual.
  const inv = notes.read('frontmatter/invalido.md')
  const broken = inv.text + '\nAñadido.\n'
  await notes.write('frontmatter/invalido.md', broken, { ifMatch: inv.etag, actor: me })
  assert.equal(notes.read('frontmatter/invalido.md').text, broken)
})

test('editar sin if_match aplica sobre lo actual; con if_match viejo falla', async () => {
  const { notes } = setup()
  const old = notes.read('hogar/Proxy.md').etag
  await notes.edit('hogar/Proxy.md', (t) => t + '\n## Backups\n', { actor: me })
  assert.equal(await errCode(notes.edit('hogar/Proxy.md', (t) => t + 'x', { ifMatch: old, actor: me })), 'precondition_failed')
  assert.ok(notes.read('hogar/Proxy.md').text.includes('## Backups'))
  // El frontmatter original se conserva byte a byte salvo el uid añadido.
  assert.ok(notes.read('hogar/Proxy.md').text.startsWith('---\naliases: [gw, Hipervisor]\nuid: '))
})

test('borrar va a la papelera del volumen de estado y se puede restaurar', async () => {
  const { notesDir, stateDir, db, notes } = setup()
  const r = notes.read('hogar/Red.md')
  assert.equal(await errCode(notes.delete('hogar/Red.md', { ifMatch: 'sha256:malo', actor: me })), 'precondition_failed')
  const entry = await notes.delete('hogar/Red.md', { ifMatch: r.etag, actor: me })
  assert.ok(!existsSync(join(notesDir, 'hogar/Red.md')))
  assert.ok(existsSync(join(stateDir, 'trash', entry.id, 'note.md')))
  assert.ok(!db.prepare('select 1 from notes where path = ?').get('hogar/Red.md'))
  const link = db.prepare('select dst_path from links where src_path = ? and raw = ?').get('hogar/enlaces.md', '[[Red]]') as { dst_path: string }
  assert.equal(link.dst_path, 'hogar/Firewall.md', 'los enlaces se re-resuelven al borrar')
  assert.deepEqual(notes.trash().map((t) => t.path), ['hogar/Red.md'])

  writeFileSync(join(notesDir, 'hogar/Red.md'), 'otra nota con el mismo nombre\n')
  assert.equal(await errCode(notes.restore(entry.id, me)), 'exists', 'restaurar no pisa')
  const back = await notes.restore(entry.id, me, 'hogar/Red (restaurada).md')
  assert.equal(notes.read(back.path).text, r.text)
  assert.deepEqual(notes.trash(), [])
})

test('rutas no válidas', async () => {
  const { notes } = setup()
  for (const bad of ['../fuera.md', '/abs.md', 'a/../b.md', 'sin-extension', '.oculta.md', 'a/.git/x.md', 'imagen.png', './x.md']) {
    await code(() => notes.read(bad))
    assert.equal(await errCode(notes.create(bad, 'x', me)), 'invalid_path', bad)
  }
})

test('uid → ruta, y conflicto si el uid está duplicado', () => {
  const { notes } = setup()
  assert.throws(() => notes.pathOfUid('01J8X4M2K9QZ'), NoteError, 'duplicado en el vault')
  assert.throws(() => notes.pathOfUid('NOEXISTE'), NoteError)
})

test('ediciones por operación: find_replace contado y append', async () => {
  const { applyEdits } = await import('@thoth/server')
  assert.equal(applyEdits('a\nb\n', [{ op: 'find_replace', find: 'b', replace: 'c' }, { op: 'append', text: 'd\n' }]), 'a\nc\nd\n')
  assert.equal(applyEdits('x', [{ op: 'append', text: 'y' }]), 'x\ny')
  assert.equal(applyEdits('a a', [{ op: 'find_replace', find: 'a', replace: 'b', expectedCount: 2 }]), 'b b')
  assert.throws(() => applyEdits('a a', [{ op: 'find_replace', find: 'a', replace: 'b' }]), (e: NoteError) => e.code === 'edit_mismatch')
  assert.throws(() => applyEdits('a', [{ op: 'find_replace', find: 'z', replace: 'b' }]), (e: NoteError) => e.code === 'edit_mismatch')
})
