import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Indexer, SCHEMA_VERSION, dumpIndex, openIndex, type Db } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// Comments' authors (usernames).
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()
const AGENT = m.aUsername()

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

function tmp(name: string) {
  return tempDir(`vihko-${name}-`)
}

/** Copy of the vault in a temp directory, with its index. */
function setup(name: string) {
  const dir = tmp(name)
  const notes = join(dir, 'notes')
  cpSync(VAULT, notes, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  return { dir, notes, db, indexer: new Indexer({ notesDir: notes, db }) }
}

function freshDump(notes: string) {
  const db = openIndex(join(tmp('fresh'), 'index.db'))
  new Indexer({ notesDir: notes, db }).scan()
  const d = dumpIndex(db)
  db.close()
  return d
}

const link = (db: Db, src: string, raw: string) =>
  db.prepare('select status, dst_path, via, anchor_ok, candidates from links where src_path = ? and raw = ?').get(src, raw) as
    { status: string; dst_path: string | null; via: string | null; anchor_ok: number | null; candidates: string | null }

test('indexes the vault: notes, ignored files, conflicts and links', () => {
  const { db, indexer } = setup('full')
  const r = indexer.scan()
  assert.equal(r.aborted, null)
  const paths = (db.prepare('select path from notes order by path').all() as { path: string }[]).map((x) => x.path)
  assert.ok(paths.includes('Plan.md'))
  assert.ok(!paths.some((p) => p.includes('.obsidian') || p.includes('.trash') || p.includes('sync-conflict') || p.endsWith('~') || p.includes('.nfs')))
  assert.ok(!paths.some((p) => !p.endsWith('.md')), 'attachments excluded')
  assert.deepEqual(db.prepare('select path, kind from alerts').all(), [{ path: 'proyectos/vihko/Plan.sync-conflict-20260924-120000-ABCDEFG.md', kind: 'sync_conflict' }])

  assert.deepEqual(link(db, 'diario/2026-09-24.md', '[[Plan]]'), { status: 'resolved', dst_path: 'Plan.md', via: 'path', anchor_ok: null, candidates: null })
  assert.deepEqual(link(db, 'diario/2026-09-24.md', '[[Tareas]]'), { status: 'ambiguous', dst_path: null, via: null, anchor_ok: null, candidates: '["proyectos/blog/Tareas.md","proyectos/vihko/Tareas.md"]' })
  assert.equal(link(db, 'hogar/enlaces.md', '[[gw]]').via, 'alias')
  assert.equal(link(db, 'hogar/enlaces.md', '[[Proxy#No existe]]').anchor_ok, 0)
  assert.equal(link(db, 'hogar/enlaces.md', '[[Nota que no existe]]').status, 'missing')

  assert.deepEqual(indexer.uidConflicts(), [{ uid: '01J8X4M2K9QZ', paths: ['uid/copia.md', 'uid/original.md'] }])
  const inv = db.prepare('select fm_error from notes where path = ?').get('frontmatter/invalido.md') as { fm_error: string }
  assert.ok(inv.fm_error)
  const title = (p: string) => (db.prepare('select title from notes where path = ?').get(p) as { title: string }).title
  assert.equal(title('frontmatter/exotico.md'), 'Título con: dos puntos')
  assert.equal(title('hogar/Proxy.md'), 'Proxy')
  assert.equal(title('frontmatter/vacia.md'), 'vacia')
})

test('full-text search without accents', () => {
  const { db, indexer } = setup('fts')
  indexer.scan()
  const hits = db.prepare("select path from notes_fts where notes_fts match 'cafe' order by path").all() as { path: string }[]
  assert.ok(hits.some((h) => h.path.normalize('NFC') === 'recetas/Café.md'))
})

test('comments inside a note are not body text: not searchable, not in its title', () => {
  const { notes, db, indexer } = setup('comments')
  // Words only this note has: one in its text, one in each comment.
  const [inText, inFirst, inSecond, inThird] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
  const heading = m.aHeading()
  const sentence = `${m.aSentence().slice(0, -1)} ${inText}.`
  const path = m.aNotePath()
  writeFileSync(join(notes, path), [
    `# ${heading} <!-- @${REPLIER} 2026-09-24T08:10Z · ${inFirst}? -->`,
    '',
    `${sentence}<!-- @${AUTHOR} 2026-09-24T08:12Z · ${m.aWord()}, ${inSecond} -->`,
    `<!-- @${AGENT} 2026-09-24T08:15Z · ↳ ${m.aWord()}, ${inThird} -->`,
    '',
  ].join('\n'))
  indexer.scan()
  const hits = (q: string) => (db.prepare('select path from notes_fts where notes_fts match ?').all(q) as { path: string }[]).map((h) => h.path)
  assert.deepEqual(hits(`"${inText}"`), [path])
  assert.deepEqual(hits(`"${inSecond}"`), [])
  assert.deepEqual(hits(`"${inThird}"`), [])
  assert.deepEqual(hits(`"${inFirst}"`), [])
  const row = db.prepare('select title, body from notes_fts where path = ?').get(path) as { title: string; body: string }
  assert.equal(row.title, heading)
  assert.equal(row.body, `# ${heading} \n\n${sentence}\n\n`)
  // Rebuilding from scratch gives the same index, comments and all.
  assert.equal(dumpIndex(db), freshDump(notes))
})

test('the indexer never writes to the notes', () => {
  const { notes, indexer } = setup('readonly')
  const snapshot = () => readdirSync(notes, { recursive: true }).map(String).sort()
    .map((p) => { const s = statSync(join(notes, p)); return s.isFile() ? `${p}:${s.mtimeMs}:${s.size}` : p })
  const before = snapshot()
  indexer.scan()
  indexer.scan()
  assert.deepEqual(snapshot(), before)
})

test('rebuilding twice gives an identical index', () => {
  const { notes } = setup('determinism')
  assert.equal(freshDump(notes), freshDump(notes))
})

test('incremental = rebuild from scratch', () => {
  const { notes, db, indexer } = setup('incremental')
  indexer.scan()
  // Changes that shift link resolutions:
  rmSync(join(notes, 'hogar/Red.md')) // [[Red]] now resolves via alias to Firewall.md
  writeFileSync(join(notes, 'proyectos/Tareas.md'), '# Tareas generales\n') // [[Tareas]] is no longer ambiguous
  writeFileSync(join(notes, 'hogar/Proxy.md'), '---\naliases: [gw]\n---\n# Proxy\n\n## No existe\n') // the broken anchor now exists
  renameSync(join(notes, 'proyectos/blog/Plan.md'), join(notes, 'proyectos/blog/Plan antiguo.md')) // [[blog/Plan]] breaks
  const r = indexer.scan()
  assert.deepEqual(r.removed.sort(), ['hogar/Red.md'])
  // The same content under another name: a move made outside vihko, not a removal (D-031.4).
  assert.deepEqual(r.moved, [{ from: 'proyectos/blog/Plan.md', to: 'proyectos/blog/Plan antiguo.md', by: 'hash' }])
  assert.equal(link(db, 'hogar/enlaces.md', '[[Red]]').dst_path, 'hogar/Firewall.md')
  assert.equal(link(db, 'diario/2026-09-24.md', '[[Tareas]]').dst_path, 'proyectos/Tareas.md')
  assert.equal(link(db, 'hogar/enlaces.md', '[[Proxy#No existe]]').anchor_ok, 1)
  assert.equal(link(db, 'diario/2026-09-24.md', '[[blog/Plan]]').status, 'missing')
  assert.equal(dumpIndex(db), freshDump(notes))
})

test('indexPaths (watcher) = rebuild from scratch', () => {
  const { notes, db, indexer } = setup('paths')
  indexer.scan()
  writeFileSync(join(notes, 'diario/nueva.md'), '# Nueva\n\n[[Tareas]] #diario\n')
  rmSync(join(notes, 'proyectos/vihko/Tareas.md'))
  writeFileSync(join(notes, 'proyectos/vihko/Plan.sync-conflict-20260925-080000-ZZZZZZZ.md'), 'x')
  indexer.indexPaths(['diario/nueva.md', 'proyectos/vihko/Tareas.md', 'proyectos/vihko/Plan.sync-conflict-20260925-080000-ZZZZZZZ.md'])
  assert.equal(link(db, 'diario/nueva.md', '[[Tareas]]').dst_path, 'proyectos/blog/Tareas.md')
  assert.equal(dumpIndex(db), freshDump(notes))
})

test('image references: who uses each image, resolved from the note; external ones are left out; rebuild = incremental', () => {
  const { notes, db, indexer } = setup('images')
  indexer.scan()
  writeFileSync(join(notes, 'proyectos/vihko/galeria.md'), [
    '![a](diagrama%20v2.png) ![[captura.jpg|x]] [ver](../../adjuntos/imagen.png) ![](/adjuntos/imagen.png)',
    '![](https://h/i.png) ![](../../../fuera.png) [[Plan]]', '',
  ].join('\n'))
  writeFileSync(join(notes, 'hogar/Red.md'), '# Red\n\n![](../adjuntos/imagen.png)\n')
  indexer.indexPaths(['proyectos/vihko/galeria.md', 'hogar/Red.md'])
  const rows = db.prepare('select src_path, kind, path from images order by src_path, ord').all() as { src_path: string; kind: string; path: string }[]
  assert.deepEqual(rows.map((r) => [r.src_path, r.kind, r.path]), [
    ['hogar/Red.md', 'image', 'adjuntos/imagen.png'],
    ['proyectos/vihko/galeria.md', 'image', 'proyectos/vihko/diagrama v2.png'],
    ['proyectos/vihko/galeria.md', 'embed', 'proyectos/vihko/captura.jpg'],
    ['proyectos/vihko/galeria.md', 'markdown', 'adjuntos/imagen.png'],
    ['proyectos/vihko/galeria.md', 'image', 'adjuntos/imagen.png'],
  ])
  assert.equal(dumpIndex(db), freshDump(notes))
  rmSync(join(notes, 'proyectos/vihko/galeria.md'))
  indexer.indexPaths(['proyectos/vihko/galeria.md'])
  assert.deepEqual(db.prepare('select distinct src_path from images').all(), [{ src_path: 'hogar/Red.md' }])
  assert.equal(dumpIndex(db), freshDump(notes))
})

test("a change to just mtime doesn't reindex; a content change does", () => {
  const { notes, db, indexer } = setup('mtime')
  indexer.scan()
  const file = join(notes, 'Plan.md')
  writeFileSync(file, readFileSync(file, 'utf8')) // same content, new mtime
  let r = indexer.scan()
  assert.deepEqual([r.changed, r.added, r.removed], [[], [], []])
  assert.equal((db.prepare('select mtime_ms from notes where path = ?').get('Plan.md') as { mtime_ms: number }).mtime_ms, statSync(file).mtimeMs)
  writeFileSync(file, '# Plan general\n\nMás texto.\n')
  r = indexer.scan()
  assert.deepEqual(r.changed, ['Plan.md'])
})

test('guards against mass deletion and an unavailable root', () => {
  const { notes, db, indexer } = setup('massdelete')
  indexer.scan()
  const count = () => (db.prepare('select count(*) n from notes').get() as { n: number }).n
  const before = count()
  for (const d of ['proyectos', 'hogar', 'recetas', 'frontmatter', 'diario', 'uid', 'privado']) rmSync(join(notes, d), { recursive: true })
  const r = indexer.scan()
  assert.equal(r.aborted, 'mass_delete')
  assert.equal(count(), before, 'nothing is deleted without confirmation')
  assert.deepEqual(r.massDelete, { removing: r.massDelete!.removing, total: before })
  assert.ok(r.massDelete!.removing > 10)
  // The confirmation is only valid for what was seen in the alert: if it changed, it stops again.
  const stale = indexer.scan({ confirmRemoval: r.massDelete!.removing + 1 })
  assert.equal(stale.aborted, 'mass_delete')
  assert.equal(count(), before)
  const ok = indexer.scan({ confirmRemoval: r.massDelete!.removing })
  assert.deepEqual([ok.aborted, ok.massDelete, ok.removed.length], [null, null, r.massDelete!.removing])
  assert.equal(count(), before - r.massDelete!.removing)

  const gone = new Indexer({ notesDir: join(notes, 'no-existe'), db })
  assert.equal(gone.scan().aborted, 'root_unavailable')
})

test('force skips the mass-deletion guard', () => {
  const { notes, indexer } = setup('massdelete-force')
  indexer.scan()
  for (const d of ['proyectos', 'hogar', 'recetas', 'frontmatter', 'diario', 'uid', 'privado']) rmSync(join(notes, d), { recursive: true })
  assert.ok(indexer.scan({ force: true }).removed.length > 10)
})

test("an unreadable subdirectory doesn't get its notes treated as deleted", { skip: process.getuid?.() === 0 }, () => {
  const { notes, db, indexer } = setup('unreadable')
  indexer.scan()
  chmodSync(join(notes, 'hogar'), 0o000)
  try {
    const r = indexer.scan()
    assert.deepEqual(r.removed, [])
    assert.ok(db.prepare('select 1 from notes where path = ?').get('hogar/Proxy.md'))
  } finally {
    chmodSync(join(notes, 'hogar'), 0o755)
  }
})

test('a schema version change rebuilds the index', () => {
  const file = join(tmp('schema'), 'index.db')
  const raw = new Database(file)
  raw.exec("create table meta (key text primary key, value text); insert into meta values ('schema_version', '0'); create table basura (x)")
  raw.close()
  const db = openIndex(file)
  assert.equal((db.prepare("select value from meta where key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION))
  assert.equal(db.prepare("select name from sqlite_master where name = 'basura'").get(), undefined)
})

test('links.aliases: off, aliases resolve nothing; switching re-resolves without reindexing notes', () => {
  const { notes, db, indexer } = setup('aliases')
  indexer.scan()
  assert.deepEqual(link(db, 'hogar/enlaces.md', '[[gw]]'), { status: 'resolved', dst_path: 'hogar/Proxy.md', via: 'alias', anchor_ok: null, candidates: null })
  assert.equal(indexer.linkAliases, true, 'on by default')
  const byName = link(db, 'hogar/enlaces.md', '[[Proxy#Red]]')

  const notesBefore = db.prepare('select * from notes order by path').all()
  indexer.setLinkAliases(false)
  assert.deepEqual(link(db, 'hogar/enlaces.md', '[[gw]]'), { status: 'missing', dst_path: null, via: null, anchor_ok: null, candidates: null })
  assert.deepEqual(link(db, 'hogar/enlaces.md', '[[Proxy#Red]]'), byName, 'names and paths are unaffected')
  assert.deepEqual(db.prepare('select * from notes order by path').all(), notesBefore, 'no note reindexed')
  assert.equal(indexer.links.resolve('hogar/enlaces.md', { kind: 'wiki', target: 'gw', anchor: null }).status, 'missing', 'the in-memory index agrees')

  // Same as building the index from scratch with aliases off.
  const off = openIndex(join(tmp('aliases-off'), 'index.db'))
  new Indexer({ notesDir: notes, db: off, linkAliases: false }).scan()
  assert.equal(dumpIndex(db), dumpIndex(off))

  indexer.setLinkAliases(true)
  assert.equal(link(db, 'hogar/enlaces.md', '[[gw]]').via, 'alias')
  assert.equal(dumpIndex(db), freshDump(notes))
})

test('links.aliases: changed while vihko was stopped, the links follow on the next start', () => {
  const { dir, notes, db, indexer } = setup('aliases-restart')
  indexer.scan()
  db.close()
  const again = openIndex(join(dir, 'index.db'))
  new Indexer({ notesDir: notes, db: again, linkAliases: false }).scan()
  assert.equal(link(again, 'hogar/enlaces.md', '[[gw]]').status, 'missing')
  again.close()
  const third = openIndex(join(dir, 'index.db'))
  new Indexer({ notesDir: notes, db: third }).scan()
  assert.equal(link(third, 'hogar/enlaces.md', '[[gw]]').via, 'alias')
})
