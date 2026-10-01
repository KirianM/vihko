// Moving a note with images: the images only it uses, in its folder,
// go with it; the rest stay and its links to them are rewritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Indexer, NoteService, dumpIndex, openIndex, type Actor } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// The user the writes are made as (an id, as vihko has them).
const m = mother(import.meta.url)
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
// The names of the notes, folders and images (one token each: they sit in Markdown links' destinations).
const token = () => m.aUniqueWord()
const [PROJ, PLAN, ARCHIVE, OTHER, SHARED, IMG, SUB, ASSETS, LOGO, CHART, DIAGRAM, PHOTO] = [token(), token(), token(), token(), token(), token(), token(), token(), token(), token(), token(), token()]
const [ALT, CAPTION, RENAMED, HEADING] = [m.aWord(), m.aHeading(), m.aTitle(), m.aHeading()]
/** Notes by path, as the index lists them (SQLite's order). */
const sorted = (...paths: string[]) => [...paths].sort()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function setup(files: Record<string, string | Uint8Array>) {
  const dir = tempDir('vihko-move-images-')
  const notesDir = join(dir, 'notes')
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  mkdirSync(notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const has = (p: string) => existsSync(join(notesDir, p))
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  const users = (path: string) => (db.prepare('select distinct src_path from images where path = ? order by src_path').all(path) as { src_path: string }[]).map((r) => r.src_path)
  return { dir, notesDir, db, indexer, notes, has, read, users }
}

test('an image only the note uses, in its folder, goes with it; the link keeps working', async () => {
  const { notes, has, read, users } = setup({
    [`${PROJ}/${PLAN}.md`]: `# ${HEADING}\n\n![${ALT}](${DIAGRAM}.png)\n![[${PHOTO}.jpg|${CAPTION}]]\n![](https://example.com/x.png)\n`,
    [`${PROJ}/${DIAGRAM}.png`]: PNG,
    [`${PROJ}/${PHOTO}.jpg`]: PNG,
  })
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me })
  assert.deepEqual(r.images.moved, [{ from: `${PROJ}/${DIAGRAM}.png`, to: `${ARCHIVE}/${DIAGRAM}.png` }, { from: `${PROJ}/${PHOTO}.jpg`, to: `${ARCHIVE}/${PHOTO}.jpg` }])
  assert.deepEqual([r.images.stayed, r.images.failed], [[], []])
  assert.ok(has(`${ARCHIVE}/${DIAGRAM}.png`) && has(`${ARCHIVE}/${PHOTO}.jpg`))
  assert.ok(!has(`${PROJ}/${DIAGRAM}.png`) && !has(`${PROJ}/${PHOTO}.jpg`))
  // Same name, relative: the text does not need to change.
  assert.equal(read(`${ARCHIVE}/${PLAN}.md`).replace(/^---\n[\s\S]*?\n---\n/, ''), `# ${HEADING}\n\n![${ALT}](${DIAGRAM}.png)\n![[${PHOTO}.jpg|${CAPTION}]]\n![](https://example.com/x.png)\n`)
  assert.deepEqual(r.relinked, [])
  assert.deepEqual(users(`${ARCHIVE}/${DIAGRAM}.png`), [`${ARCHIVE}/${PLAN}.md`])
  assert.deepEqual(users(`${PROJ}/${DIAGRAM}.png`), [])
})

test('a shared image and one in another folder stay; the moved note links them from its new place', async () => {
  const { notes, has, read, users } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${SHARED}.png) ![[${IMG}/${SUB}.png]] ![](../${ASSETS}/${LOGO}.png) ![](/${ASSETS}/${LOGO}.png)\n`,
    [`${PROJ}/${OTHER}.md`]: `Also here: ![](${SHARED}.png)\n`,
    [`${PROJ}/${SHARED}.png`]: PNG,
    [`${PROJ}/${IMG}/${SUB}.png`]: PNG,
    [`${ASSETS}/${LOGO}.png`]: PNG,
  })
  const dry = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/2026/${PLAN}.md`, { actor: me, dryRun: true })
  assert.deepEqual(dry.images.moved, [])
  assert.deepEqual(dry.images.stayed, [
    { path: `${PROJ}/${SHARED}.png`, reason: 'shared' },
    { path: `${PROJ}/${IMG}/${SUB}.png`, reason: 'elsewhere' },
    { path: `${ASSETS}/${LOGO}.png`, reason: 'elsewhere' },
  ])
  assert.deepEqual(dry.relinked, [{ path: `${ARCHIVE}/2026/${PLAN}.md`, links: 3, changes: [
    { before: `![](${SHARED}.png)`, after: `![](../../${PROJ}/${SHARED}.png)`, kind: 'image', to: `${PROJ}/${SHARED}.png` },
    { before: `![[${IMG}/${SUB}.png]]`, after: `![[/${PROJ}/${IMG}/${SUB}.png]]`, kind: 'image', to: `${PROJ}/${IMG}/${SUB}.png` },
    { before: `![](../${ASSETS}/${LOGO}.png)`, after: `![](../../${ASSETS}/${LOGO}.png)`, kind: 'image', to: `${ASSETS}/${LOGO}.png` },
  ] }])
  await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/2026/${PLAN}.md`, { actor: me })
  assert.ok(has(`${PROJ}/${SHARED}.png`) && has(`${PROJ}/${IMG}/${SUB}.png`) && has(`${ASSETS}/${LOGO}.png`))
  assert.ok(read(`${ARCHIVE}/2026/${PLAN}.md`).endsWith(`![](../../${PROJ}/${SHARED}.png) ![[/${PROJ}/${IMG}/${SUB}.png]] ![](../../${ASSETS}/${LOGO}.png) ![](/${ASSETS}/${LOGO}.png)\n`))
  assert.equal(read(`${PROJ}/${OTHER}.md`), `Also here: ![](${SHARED}.png)\n`)
  assert.deepEqual(users(`${PROJ}/${SHARED}.png`), sorted(`${ARCHIVE}/2026/${PLAN}.md`, `${PROJ}/${OTHER}.md`))
  assert.deepEqual(users(`${ASSETS}/${LOGO}.png`), [`${ARCHIVE}/2026/${PLAN}.md`])
})

test('a taken name at the destination gets a suffix; nothing is overwritten', async () => {
  const { notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${CHART}.png) and again ![${CHART}](${CHART}.png "title")\n`,
    [`${PROJ}/${CHART}.png`]: PNG,
    [`${ARCHIVE}/${CHART}.png`]: 'someone else\'s',
  })
  const dry = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me, dryRun: true })
  assert.deepEqual(dry.images.moved, [{ from: `${PROJ}/${CHART}.png`, to: `${ARCHIVE}/${CHART}-2.png` }])
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me })
  assert.deepEqual(r.images.moved, [{ from: `${PROJ}/${CHART}.png`, to: `${ARCHIVE}/${CHART}-2.png` }])
  assert.equal(read(`${ARCHIVE}/${CHART}.png`), 'someone else\'s')
  assert.ok(has(`${ARCHIVE}/${CHART}-2.png`) && !has(`${PROJ}/${CHART}.png`))
  assert.ok(read(`${ARCHIVE}/${PLAN}.md`).endsWith(`![](${CHART}-2.png) and again ![${CHART}](${CHART}-2.png "title")\n`))
  assert.deepEqual(r.relinked[0]!.changes, [
    { before: `![](${CHART}.png)`, after: `![](${CHART}-2.png)`, kind: 'image', to: `${ARCHIVE}/${CHART}-2.png` },
    { before: `![${CHART}](${CHART}.png "title")`, after: `![${CHART}](${CHART}-2.png "title")`, kind: 'image', to: `${ARCHIVE}/${CHART}-2.png` },
  ])
})

// Spaces, %-escapes, angle brackets and a `#` in the names: the case under test, so literal.
test('URL-encoded paths, angle brackets and embeds keep their style', async () => {
  const { notes, has, read } = setup({
    'a b/note.md': '![x](my%20pic.png) ![y](<my pic.png>) ![[my pic.png]] [see](../other%20dir/c%23d.png?v=2)\n',
    'a b/my pic.png': PNG,
    'other dir/c#d.png': PNG,
    'x/y/my pic.png': 'taken',
  })
  const r = await notes.move('a b/note.md', 'x/y/note.md', { actor: me })
  assert.deepEqual(r.images.moved, [{ from: 'a b/my pic.png', to: 'x/y/my pic-2.png' }])
  assert.deepEqual(r.images.stayed, [{ path: 'other dir/c#d.png', reason: 'elsewhere' }])
  assert.ok(has('x/y/my pic-2.png'))
  assert.ok(read('x/y/note.md').endsWith('![x](my%20pic-2.png) ![y](<my%20pic-2.png>) ![[my pic-2.png]] [see](../../other%20dir/c%23d.png?v=2)\n'))
})

test('renaming within the folder moves no image', async () => {
  const { notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.png) ![](../x.png)\n`,
    [`${PROJ}/${PLAN}.png`]: PNG,
    'x.png': PNG,
  })
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${RENAMED}.md`, { actor: me })
  assert.deepEqual(r.images, { moved: [], copied: [], stayed: [], folder: null, failed: [] })
  assert.ok(has(`${PROJ}/${PLAN}.png`))
  assert.ok(read(`${PROJ}/${RENAMED}.md`).endsWith(`![](${PLAN}.png) ![](../x.png)\n`))
})

test('the dry run touches nothing', async () => {
  const { db, notes, has } = setup({ [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.png)\n`, [`${PROJ}/${PLAN}.png`]: PNG })
  const snapshot = dumpIndex(db)
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${PLAN}.md`, { actor: me, dryRun: true })
  assert.deepEqual(r.images.moved, [{ from: `${PROJ}/${PLAN}.png`, to: `${PLAN}.png` }])
  assert.ok(has(`${PROJ}/${PLAN}.png`) && !has(`${PLAN}.png`) && has(`${PROJ}/${PLAN}.md`))
  assert.equal(dumpIndex(db), snapshot)
})

test('if the note cannot leave its folder, the images placed at the destination are removed again', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, notes, has, read } = setup({ [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.png)\n`, [`${PROJ}/${PLAN}.png`]: PNG })
  chmodSync(join(notesDir, PROJ), 0o555)
  try {
    await assert.rejects(notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me }))
    assert.ok(!has(`${ARCHIVE}/${PLAN}.md`) && !has(`${ARCHIVE}/${PLAN}.png`))
    assert.ok(has(`${PROJ}/${PLAN}.png`))
    assert.equal(read(`${PROJ}/${PLAN}.md`), `![](${PLAN}.png)\n`)
  } finally {
    chmodSync(join(notesDir, PROJ), 0o755)
  }
})

test('an image that cannot go with the note stays, and the note links it where it is', async () => {
  const taken: Record<string, string> = { [`${ARCHIVE}/${PLAN}.png`]: 'taken' }
  for (let n = 2; n <= 1000; n++) taken[`${ARCHIVE}/${PLAN}-${n}.png`] = 'taken'
  const { notes, has, read } = setup({ [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.png)\n`, [`${PROJ}/${PLAN}.png`]: PNG, ...taken })
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me })
  assert.deepEqual(r.images.moved, [])
  assert.deepEqual(r.images.failed.map((f) => [f.path, f.to, f.outcome, f.error]), [[`${PROJ}/${PLAN}.png`, null, 'stayed', 'exists']])
  assert.ok(has(`${PROJ}/${PLAN}.png`))
  assert.ok(read(`${ARCHIVE}/${PLAN}.md`).endsWith(`![](../${PROJ}/${PLAN}.png)\n`))
  assert.deepEqual(r.relinked[0]!.changes, [{ before: `![](${PLAN}.png)`, after: `![](../${PROJ}/${PLAN}.png)`, kind: 'image', to: `${PROJ}/${PLAN}.png` }])
})
