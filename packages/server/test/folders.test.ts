import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, dumpIndex, openIndex, type Actor } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const me: Actor = { kind: 'user', id: 'noa' }
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

/** A small vault where a folder move touches every kind of reference. */
const FILES: Record<string, string | Buffer> = {
  'a/Uno.md': '# Uno\n\n- [[Dos]] al lado\n- [[sub/Tres]] debajo\n- [raíz](../Raiz.md)\n- ![](foto.png)\n- ![](../fuera.png)\n',
  'a/Dos.md': '# Dos\n\n[[Uno]]\n',
  'a/foto.png': PNG,
  'a/sub/Tres.md': '# Tres\n\n[arriba](../Uno.md)\n',
  'a/vacia/.keep': '',
  'Raiz.md': '# Raiz\n\n- [[a/Uno]] con carpeta\n- [[Dos]] por nombre\n- [md](a/Dos.md)\n- ![](a/foto.png)\n',
  'otra/Nada.md': '# Nada\n\nSin enlaces.\n',
  'fuera.png': PNG,
}

function setup(files = FILES) {
  const dir = tempDir('thoth-folders-')
  const notesDir = join(dir, 'notes')
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  const body = (p: string) => { const t = read(p); return t.slice(readFrontmatter(t).bodyStart) }
  const dst = (src: string, raw: string) => (db.prepare('select dst_path from links where src_path = ? and raw = ?').get(src, raw) as { dst_path: string } | undefined)?.dst_path
  const folders = () => (db.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
  /** The index a full rebuild from disk gives: incremental updates must match it. */
  const rebuilt = () => {
    const fresh = openIndex(join(tempDir('thoth-folders-idx-'), 'index.db'))
    new Indexer({ notesDir, db: fresh }).scan()
    return dumpIndex(fresh)
  }
  return { dir, notesDir, db, indexer, notes, read, body, dst, folders, rebuilt }
}

const code = (c: string) => (e: unknown) => e instanceof NoteError && e.code === c

test('the index lists every folder, empty ones included, and a rescan or rebuild keeps them', () => {
  const { notes, indexer, db, folders, rebuilt } = setup()
  assert.deepEqual(folders(), ['a', 'a/sub', 'a/vacia', 'otra'])
  notes.createFolder('nueva/honda', me)
  assert.deepEqual(folders(), ['a', 'a/sub', 'a/vacia', 'nueva', 'nueva/honda', 'otra'])
  indexer.scan()
  assert.deepEqual(folders(), ['a', 'a/sub', 'a/vacia', 'nueva', 'nueva/honda', 'otra'])
  assert.equal(dumpIndex(db), rebuilt())
})

test('a note created in a new folder records the folder at once', async () => {
  const { notes, folders, db, rebuilt } = setup()
  await notes.create('x/y/Nota.md', '# Nota\n', me)
  assert.ok(folders().includes('x') && folders().includes('x/y'))
  assert.equal(dumpIndex(db), rebuilt())
})

test('creating a folder never reuses an existing one and rejects hidden or odd paths', () => {
  const { notes } = setup()
  assert.throws(() => notes.createFolder('a', me), code('exists'))
  assert.throws(() => notes.createFolder('Raiz.md', me), code('invalid_path'))
  for (const bad of ['', '.oculta', 'a/.git', '../fuera', '/abs', 'a/', 'a//b', 'x~']) {
    assert.throws(() => notes.createFolder(bad, me), code('invalid_path'), bad)
  }
})

test('only a folder without files is deleted, empty subfolders with it', () => {
  const { notesDir, notes, folders } = setup()
  mkdirSync(join(notesDir, 'vacia/dentro/mas'), { recursive: true })
  notes.createFolder('sola', me)
  notes.deleteFolder('vacia', me)
  notes.deleteFolder('sola', me)
  assert.ok(!existsSync(join(notesDir, 'vacia')) && !existsSync(join(notesDir, 'sola')))
  assert.ok(!folders().some((f) => f.startsWith('vacia') || f === 'sola'))
  assert.throws(() => notes.deleteFolder('otra', me), code('not_empty'))
  // A hidden file counts: deleting the folder would delete it.
  assert.throws(() => notes.deleteFolder('a/vacia', me), code('not_empty'))
  assert.ok(existsSync(join(notesDir, 'otra/Nada.md')) && existsSync(join(notesDir, 'a/vacia/.keep')))
  assert.throws(() => notes.deleteFolder('no-existe', me), code('not_found'))
})

test('moving a folder takes every file along and keeps every link, inside and outside', async () => {
  const { notesDir, db, notes, body, dst, folders, rebuilt } = setup()
  const r = await notes.moveFolder('a', 'c/d', { actor: me })
  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.notes.map((n) => n.to), ['c/d/Dos.md', 'c/d/Uno.md', 'c/d/sub/Tres.md'])
  assert.equal(r.files, 1, 'the image (the hidden .keep is not counted)')
  assert.ok(!existsSync(join(notesDir, 'a')))
  for (const p of ['c/d/Uno.md', 'c/d/Dos.md', 'c/d/sub/Tres.md', 'c/d/foto.png', 'c/d/vacia/.keep']) assert.ok(existsSync(join(notesDir, p)), p)

  // Inside: relative links out of the folder climb one more level; links between moved notes stay.
  const uno = body('c/d/Uno.md')
  assert.ok(uno.includes('- [[Dos]] al lado') && uno.includes('- [[sub/Tres]] debajo'), uno)
  assert.ok(uno.includes('- [raíz](../../Raiz.md)'), uno)
  assert.ok(uno.includes('- ![](foto.png)'), uno)
  assert.ok(uno.includes('- ![](../../fuera.png)'), uno)
  assert.ok(body('c/d/sub/Tres.md').includes('[arriba](../Uno.md)'))
  // Outside: path links, relative links and image references follow the folder.
  const raiz = body('Raiz.md')
  assert.ok(raiz.includes('- [md](c/d/Dos.md)'), raiz)
  assert.ok(raiz.includes('- ![](c/d/foto.png)'), raiz)
  assert.ok(!raiz.includes('[[a/Uno]]'), raiz)
  assert.ok(raiz.includes('- [[Dos]] por nombre'), 'a link by name keeps working untouched')
  assert.equal(dst('Raiz.md', '[[Dos]]'), 'c/d/Dos.md')
  assert.equal(dst('c/d/Uno.md', '[raíz](../../Raiz.md)'), 'Raiz.md')
  assert.equal((db.prepare("select count(*) n from links where dst_path like 'a/%'").get() as { n: number }).n, 0)
  assert.equal((db.prepare("select count(*) n from notes where path like 'a/%'").get() as { n: number }).n, 0)
  assert.deepEqual(folders(), ['c', 'c/d', 'c/d/sub', 'c/d/vacia', 'otra'])
  assert.equal(dumpIndex(db), rebuilt(), 'the index is what a rebuild from disk gives')
  assert.equal(readFileSync(join(notesDir, 'c/d/foto.png')).compare(PNG), 0)
})

test('renaming a folder in place keeps a path-qualified link on its note', async () => {
  const { notes, body, dst } = setup()
  await notes.moveFolder('a', 'b', { actor: me })
  const raiz = body('Raiz.md')
  const link = /\[\[([^\]]*Uno)\]\] con carpeta/.exec(raiz)?.[0]
  assert.ok(link, raiz)
  assert.equal(dst('Raiz.md', link!.replace(' con carpeta', '')), 'b/Uno.md')
})

test('the preview lists notes, files and every change, and changes nothing', async () => {
  const { notesDir, db, notes } = setup()
  const snapshot = dumpIndex(db)
  const r = await notes.moveFolder('a', 'c/d', { actor: me, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(r.notes.length, 3)
  assert.deepEqual(r.relinked.map((x) => x.path).sort(), ['Raiz.md', 'c/d/Uno.md'])
  const raiz = r.relinked.find((x) => x.path === 'Raiz.md')!
  assert.ok(raiz.changes.some((c) => c.before === '[md](a/Dos.md)' && c.after === '[md](c/d/Dos.md)'), JSON.stringify(raiz.changes))
  assert.ok(raiz.changes.some((c) => c.before === '![](a/foto.png)' && c.after === '![](c/d/foto.png)'))
  assert.equal(raiz.links, raiz.changes.length)
  assert.ok(existsSync(join(notesDir, 'a/Uno.md')) && !existsSync(join(notesDir, 'c')))
  assert.equal(dumpIndex(db), snapshot)
})

test('a folder move never overwrites and refuses impossible moves', async () => {
  const { notesDir, notes } = setup()
  await assert.rejects(notes.moveFolder('a', 'otra', { actor: me }), code('exists'))
  await assert.rejects(notes.moveFolder('a', 'a/sub/x', { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder('a', 'a', { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder('no-existe', 'x', { actor: me }), code('not_found'))
  await assert.rejects(notes.moveFolder('a', '../fuera', { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder('Raiz.md', 'x', { actor: me }), code('invalid_path'))
  // A file with that name is not a folder to merge into either.
  writeFileSync(join(notesDir, 'ocupado'), 'x')
  await assert.rejects(notes.moveFolder('a', 'ocupado', { actor: me }), code('exists'))
  assert.equal(readFileSync(join(notesDir, 'ocupado'), 'utf8'), 'x')
  assert.ok(existsSync(join(notesDir, 'a/Uno.md')))
})

test('if the rename fails, nothing moves and nothing is left at the destination', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, db, notes } = setup({ ...FILES, 'p/a/Nota.md': '# Nota\n\n[r](../../Raiz.md)\n' })
  const snapshot = dumpIndex(db)
  const before = readFileSync(join(notesDir, 'p/a/Nota.md'), 'utf8')
  chmodSync(join(notesDir, 'p'), 0o555) // the folder can't leave p/
  try {
    await assert.rejects(notes.moveFolder('p/a', 'q', { actor: me }))
    assert.ok(!existsSync(join(notesDir, 'q')), 'the claimed destination is removed again')
    assert.equal(readFileSync(join(notesDir, 'p/a/Nota.md'), 'utf8'), before)
    assert.equal(dumpIndex(db), snapshot)
  } finally {
    chmodSync(join(notesDir, 'p'), 0o755)
  }
})

test('a note outside that cannot be rewritten is reported, and the move stands', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, indexer, notes } = setup({ ...FILES, 'bloqueada/Ve.md': '[x](../a/Dos.md)\n' })
  indexer.scan()
  chmodSync(join(notesDir, 'bloqueada'), 0o555)
  try {
    const r = await notes.moveFolder('a', 'b', { actor: me })
    assert.deepEqual(r.failed.map((f) => f.path), ['bloqueada/Ve.md'])
    assert.ok(existsSync(join(notesDir, 'b/Dos.md')))
    assert.ok(readFileSync(join(notesDir, 'Raiz.md'), 'utf8').includes('[md](b/Dos.md)'))
  } finally {
    chmodSync(join(notesDir, 'bloqueada'), 0o755)
  }
})

test('moving a single note still rewrites links as before (shared machinery)', async () => {
  const { notes, body } = setup()
  const r = await notes.move('a/Dos.md', 'otra/Dos.md', { actor: me })
  assert.deepEqual(r.failed, [])
  assert.ok(body('Raiz.md').includes('[md](otra/Dos.md)'))
  assert.ok(body('otra/Dos.md').includes('[[Uno]]'))
})
