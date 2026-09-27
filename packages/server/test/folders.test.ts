import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFrontmatter } from '@thoth/core'
import { Indexer, NoteError, NoteService, dumpIndex, openIndex, type Actor } from '@thoth/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// The user the writes are made as (an id, as thoth has them).
const m = mother(import.meta.url)
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

// The names of the small vault below. Whatever sits in a Markdown link's
// destination is one token (no spaces, which a destination would escape).
const token = () => m.aUniqueWord()
/** The folder that moves (A), its subfolders (one empty but for a hidden file), another folder. */
const [A, SUB, EMPTY, OTHER] = [token(), token(), token(), token()]
/** Notes: two in A, one in A/SUB, one at the root, one in OTHER; two images, in A and at the root. */
const [ONE, TWO, THREE, ROOT, NOTHING] = [token(), token(), token(), token(), token()]
const [PHOTO, OUTSIDE] = [token(), token()]
/** The texts around the links (any will do). */
const T = { beside: m.aWord(), below: m.aWord(), root: m.aWord(), up: m.aWord(), withFolder: m.aHeading(), byName: m.aHeading(), md: m.aWord() }
/** Where the folder goes. */
const [C, D, B] = [token(), token(), token()]

/** A small vault where a folder move touches every kind of reference. */
const FILES: Record<string, string | Buffer> = {
  [`${A}/${ONE}.md`]: `# ${ONE}\n\n- [[${TWO}]] ${T.beside}\n- [[${SUB}/${THREE}]] ${T.below}\n- [${T.root}](../${ROOT}.md)\n- ![](${PHOTO}.png)\n- ![](../${OUTSIDE}.png)\n`,
  [`${A}/${TWO}.md`]: `# ${TWO}\n\n[[${ONE}]]\n`,
  [`${A}/${PHOTO}.png`]: PNG,
  [`${A}/${SUB}/${THREE}.md`]: `# ${THREE}\n\n[${T.up}](../${ONE}.md)\n`,
  [`${A}/${EMPTY}/.keep`]: '',
  [`${ROOT}.md`]: `# ${ROOT}\n\n- [[${A}/${ONE}]] ${T.withFolder}\n- [[${TWO}]] ${T.byName}\n- [${T.md}](${A}/${TWO}.md)\n- ![](${A}/${PHOTO}.png)\n`,
  [`${OTHER}/${NOTHING}.md`]: `# ${NOTHING}\n\n${m.aSentence()}\n`,
  [`${OUTSIDE}.png`]: PNG,
}
/** Folders as the index lists them (by path, as SQLite compares it). */
const sorted = (...paths: string[]) => [...paths].sort()

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
  const initial = [A, `${A}/${SUB}`, `${A}/${EMPTY}`, OTHER]
  assert.deepEqual(folders(), sorted(...initial))
  const [created, deep] = [m.aFolder(), m.aFolder()]
  notes.createFolder(`${created}/${deep}`, me)
  assert.deepEqual(folders(), sorted(...initial, created, `${created}/${deep}`))
  indexer.scan()
  assert.deepEqual(folders(), sorted(...initial, created, `${created}/${deep}`))
  assert.equal(dumpIndex(db), rebuilt())
})

test('a note created in a new folder records the folder at once', async () => {
  const { notes, folders, db, rebuilt } = setup()
  const [x, y] = [m.aFolder(), m.aFolder()]
  await notes.create(m.aNotePath(`${x}/${y}`), `# ${m.aHeading()}\n`, me)
  assert.ok(folders().includes(x) && folders().includes(`${x}/${y}`))
  assert.equal(dumpIndex(db), rebuilt())
})

test('creating a folder never reuses an existing one and rejects hidden or odd paths', () => {
  const { notes } = setup()
  assert.throws(() => notes.createFolder(A, me), code('exists'))
  assert.throws(() => notes.createFolder(`${ROOT}.md`, me), code('invalid_path'))
  // Each kind of invalid folder path (the case under test).
  for (const bad of ['', '.oculta', 'a/.git', '../fuera', '/abs', 'a/', 'a//b', 'x~']) {
    assert.throws(() => notes.createFolder(bad, me), code('invalid_path'), bad)
  }
})

test('only a folder without files is deleted, empty subfolders with it', () => {
  const { notesDir, notes, folders } = setup()
  const [empty, alone] = [m.aFolder(), m.aFolder()]
  mkdirSync(join(notesDir, empty, m.aFolder(), m.aFolder()), { recursive: true })
  notes.createFolder(alone, me)
  notes.deleteFolder(empty, me)
  notes.deleteFolder(alone, me)
  assert.ok(!existsSync(join(notesDir, empty)) && !existsSync(join(notesDir, alone)))
  assert.ok(!folders().some((f) => f === empty || f.startsWith(`${empty}/`) || f === alone))
  assert.throws(() => notes.deleteFolder(OTHER, me), code('not_empty'))
  // A hidden file counts: deleting the folder would delete it.
  assert.throws(() => notes.deleteFolder(`${A}/${EMPTY}`, me), code('not_empty'))
  assert.ok(existsSync(join(notesDir, `${OTHER}/${NOTHING}.md`)) && existsSync(join(notesDir, `${A}/${EMPTY}/.keep`)))
  assert.throws(() => notes.deleteFolder(m.aFolder(), me), code('not_found'))
})

test('moving a folder takes every file along and keeps every link, inside and outside', async () => {
  const { notesDir, db, notes, body, dst, folders, rebuilt } = setup()
  const to = `${C}/${D}`
  const r = await notes.moveFolder(A, to, { actor: me })
  assert.deepEqual(r.failed, [])
  // The notes in the order of their paths inside the folder.
  assert.deepEqual(r.notes.map((n) => n.to), sorted(`${TWO}.md`, `${ONE}.md`, `${SUB}/${THREE}.md`).map((p) => `${to}/${p}`))
  assert.equal(r.files, 1, 'the image (the hidden .keep is not counted)')
  assert.ok(!existsSync(join(notesDir, A)))
  for (const p of [`${ONE}.md`, `${TWO}.md`, `${SUB}/${THREE}.md`, `${PHOTO}.png`, `${EMPTY}/.keep`]) assert.ok(existsSync(join(notesDir, to, p)), p)

  // Inside: relative links out of the folder climb one more level; links between moved notes stay.
  const one = body(`${to}/${ONE}.md`)
  assert.ok(one.includes(`- [[${TWO}]] ${T.beside}`) && one.includes(`- [[${SUB}/${THREE}]] ${T.below}`), one)
  assert.ok(one.includes(`- [${T.root}](../../${ROOT}.md)`), one)
  assert.ok(one.includes(`- ![](${PHOTO}.png)`), one)
  assert.ok(one.includes(`- ![](../../${OUTSIDE}.png)`), one)
  assert.ok(body(`${to}/${SUB}/${THREE}.md`).includes(`[${T.up}](../${ONE}.md)`))
  // Outside: path links, relative links and image references follow the folder.
  const root = body(`${ROOT}.md`)
  assert.ok(root.includes(`- [${T.md}](${to}/${TWO}.md)`), root)
  assert.ok(root.includes(`- ![](${to}/${PHOTO}.png)`), root)
  assert.ok(!root.includes(`[[${A}/${ONE}]]`), root)
  assert.ok(root.includes(`- [[${TWO}]] ${T.byName}`), 'a link by name keeps working untouched')
  assert.equal(dst(`${ROOT}.md`, `[[${TWO}]]`), `${to}/${TWO}.md`)
  assert.equal(dst(`${to}/${ONE}.md`, `[${T.root}](../../${ROOT}.md)`), `${ROOT}.md`)
  assert.equal((db.prepare('select count(*) n from links where dst_path like ?').get(`${A}/%`) as { n: number }).n, 0)
  assert.equal((db.prepare('select count(*) n from notes where path like ?').get(`${A}/%`) as { n: number }).n, 0)
  assert.deepEqual(folders(), sorted(C, to, `${to}/${SUB}`, `${to}/${EMPTY}`, OTHER))
  assert.equal(dumpIndex(db), rebuilt(), 'the index is what a rebuild from disk gives')
  assert.equal(readFileSync(join(notesDir, to, `${PHOTO}.png`)).compare(PNG), 0)
})

test('renaming a folder in place keeps a path-qualified link on its note', async () => {
  const { notes, body, dst } = setup()
  await notes.moveFolder(A, B, { actor: me })
  const root = body(`${ROOT}.md`)
  const link = new RegExp(`\\[\\[([^\\]]*${ONE})\\]\\] ${T.withFolder}`, 'u').exec(root)?.[0]
  assert.ok(link, root)
  assert.equal(dst(`${ROOT}.md`, link!.replace(` ${T.withFolder}`, '')), `${B}/${ONE}.md`)
})

test('the preview lists notes, files and every change, and changes nothing', async () => {
  const { notesDir, db, notes } = setup()
  const snapshot = dumpIndex(db)
  const to = `${C}/${D}`
  const r = await notes.moveFolder(A, to, { actor: me, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(r.notes.length, 3)
  assert.deepEqual(r.relinked.map((x) => x.path).sort(), sorted(`${ROOT}.md`, `${to}/${ONE}.md`))
  const root = r.relinked.find((x) => x.path === `${ROOT}.md`)!
  assert.ok(root.changes.some((c) => c.before === `[${T.md}](${A}/${TWO}.md)` && c.after === `[${T.md}](${to}/${TWO}.md)`), JSON.stringify(root.changes))
  assert.ok(root.changes.some((c) => c.before === `![](${A}/${PHOTO}.png)` && c.after === `![](${to}/${PHOTO}.png)`))
  assert.equal(root.links, root.changes.length)
  assert.ok(existsSync(join(notesDir, `${A}/${ONE}.md`)) && !existsSync(join(notesDir, C)))
  assert.equal(dumpIndex(db), snapshot)
})

test('a folder move never overwrites and refuses impossible moves', async () => {
  const { notesDir, notes } = setup()
  await assert.rejects(notes.moveFolder(A, OTHER, { actor: me }), code('exists'))
  await assert.rejects(notes.moveFolder(A, `${A}/${SUB}/${m.aFolder()}`, { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder(A, A, { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder(m.aFolder(), m.aFolder(), { actor: me }), code('not_found'))
  await assert.rejects(notes.moveFolder(A, '../fuera', { actor: me }), code('invalid_path'))
  await assert.rejects(notes.moveFolder(`${ROOT}.md`, m.aFolder(), { actor: me }), code('invalid_path'))
  // A file with that name is not a folder to merge into either.
  const taken = m.aFolder()
  const text = m.aSentence()
  writeFileSync(join(notesDir, taken), text)
  await assert.rejects(notes.moveFolder(A, taken, { actor: me }), code('exists'))
  assert.equal(readFileSync(join(notesDir, taken), 'utf8'), text)
  assert.ok(existsSync(join(notesDir, `${A}/${ONE}.md`)))
})

test('if the rename fails, nothing moves and nothing is left at the destination', { skip: process.getuid?.() === 0 }, async () => {
  const [p, q] = [m.aFolder(), m.aFolder()]
  const note = `${p}/${A}/${token()}.md`
  const { notesDir, db, notes } = setup({ ...FILES, [note]: `# ${m.aHeading()}\n\n[${m.aWord()}](../../${ROOT}.md)\n` })
  const snapshot = dumpIndex(db)
  const before = readFileSync(join(notesDir, note), 'utf8')
  chmodSync(join(notesDir, p), 0o555) // the folder can't leave p/
  try {
    await assert.rejects(notes.moveFolder(`${p}/${A}`, q, { actor: me }))
    assert.ok(!existsSync(join(notesDir, q)), 'the claimed destination is removed again')
    assert.equal(readFileSync(join(notesDir, note), 'utf8'), before)
    assert.equal(dumpIndex(db), snapshot)
  } finally {
    chmodSync(join(notesDir, p), 0o755)
  }
})

test('a note outside that cannot be rewritten is reported, and the move stands', { skip: process.getuid?.() === 0 }, async () => {
  const locked = m.aFolder()
  const note = `${locked}/${token()}.md`
  const { notesDir, indexer, notes } = setup({ ...FILES, [note]: `[${m.aWord()}](../${A}/${TWO}.md)\n` })
  indexer.scan()
  chmodSync(join(notesDir, locked), 0o555)
  try {
    const r = await notes.moveFolder(A, B, { actor: me })
    assert.deepEqual(r.failed.map((f) => f.path), [note])
    assert.ok(existsSync(join(notesDir, `${B}/${TWO}.md`)))
    assert.ok(readFileSync(join(notesDir, `${ROOT}.md`), 'utf8').includes(`[${T.md}](${B}/${TWO}.md)`))
  } finally {
    chmodSync(join(notesDir, locked), 0o755)
  }
})

test('moving a single note still rewrites links as before (shared machinery)', async () => {
  const { notes, body } = setup()
  const r = await notes.move(`${A}/${TWO}.md`, `${OTHER}/${TWO}.md`, { actor: me })
  assert.deepEqual(r.failed, [])
  assert.ok(body(`${ROOT}.md`).includes(`[${T.md}](${OTHER}/${TWO}.md)`))
  assert.ok(body(`${OTHER}/${TWO}.md`).includes(`[[${ONE}]]`))
})
