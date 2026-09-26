// Moving a note with images (D-028): the images only it uses, in its folder,
// go with it; the rest stay and its links to them are rewritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Indexer, NoteService, dumpIndex, openIndex, type Actor } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const me: Actor = { kind: 'user', id: 'noa' }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function setup(files: Record<string, string | Uint8Array>) {
  const dir = tempDir('thoth-move-images-')
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
    'proj/plan.md': '# Plan\n\n![diagram](plan-2026.png)\n![[photo.jpg|a photo]]\n![](https://example.com/x.png)\n',
    'proj/plan-2026.png': PNG,
    'proj/photo.jpg': PNG,
  })
  const r = await notes.move('proj/plan.md', 'archive/plan.md', { actor: me })
  assert.deepEqual(r.images.moved, [{ from: 'proj/plan-2026.png', to: 'archive/plan-2026.png' }, { from: 'proj/photo.jpg', to: 'archive/photo.jpg' }])
  assert.deepEqual([r.images.stayed, r.images.failed], [[], []])
  assert.ok(has('archive/plan-2026.png') && has('archive/photo.jpg'))
  assert.ok(!has('proj/plan-2026.png') && !has('proj/photo.jpg'))
  // Same name, relative: the text does not need to change.
  assert.equal(read('archive/plan.md').replace(/^---\n[\s\S]*?\n---\n/, ''), '# Plan\n\n![diagram](plan-2026.png)\n![[photo.jpg|a photo]]\n![](https://example.com/x.png)\n')
  assert.deepEqual(r.relinked, [])
  assert.deepEqual(users('archive/plan-2026.png'), ['archive/plan.md'])
  assert.deepEqual(users('proj/plan-2026.png'), [])
})

test('a shared image and one in another folder stay; the moved note links them from its new place', async () => {
  const { notes, has, read, users } = setup({
    'proj/plan.md': '![](shared.png) ![[img/sub.png]] ![](../assets/logo.png) ![](/assets/logo.png)\n',
    'proj/other.md': 'Also here: ![](shared.png)\n',
    'proj/shared.png': PNG,
    'proj/img/sub.png': PNG,
    'assets/logo.png': PNG,
  })
  const dry = await notes.move('proj/plan.md', 'archive/2026/plan.md', { actor: me, dryRun: true })
  assert.deepEqual(dry.images.moved, [])
  assert.deepEqual(dry.images.stayed, [
    { path: 'proj/shared.png', reason: 'shared' },
    { path: 'proj/img/sub.png', reason: 'elsewhere' },
    { path: 'assets/logo.png', reason: 'elsewhere' },
  ])
  assert.deepEqual(dry.relinked, [{ path: 'archive/2026/plan.md', links: 3, changes: [
    { before: '![](shared.png)', after: '![](../../proj/shared.png)' },
    { before: '![[img/sub.png]]', after: '![[/proj/img/sub.png]]' },
    { before: '![](../assets/logo.png)', after: '![](../../assets/logo.png)' },
  ] }])
  await notes.move('proj/plan.md', 'archive/2026/plan.md', { actor: me })
  assert.ok(has('proj/shared.png') && has('proj/img/sub.png') && has('assets/logo.png'))
  assert.ok(read('archive/2026/plan.md').endsWith('![](../../proj/shared.png) ![[/proj/img/sub.png]] ![](../../assets/logo.png) ![](/assets/logo.png)\n'))
  assert.equal(read('proj/other.md'), 'Also here: ![](shared.png)\n')
  assert.deepEqual(users('proj/shared.png'), ['archive/2026/plan.md', 'proj/other.md'])
  assert.deepEqual(users('assets/logo.png'), ['archive/2026/plan.md'])
})

test('a taken name at the destination gets a suffix; nothing is overwritten', async () => {
  const { notes, has, read } = setup({
    'proj/plan.md': '![](chart.png) and again ![chart](chart.png "title")\n',
    'proj/chart.png': PNG,
    'archive/chart.png': 'someone else\'s',
  })
  const dry = await notes.move('proj/plan.md', 'archive/plan.md', { actor: me, dryRun: true })
  assert.deepEqual(dry.images.moved, [{ from: 'proj/chart.png', to: 'archive/chart-2.png' }])
  const r = await notes.move('proj/plan.md', 'archive/plan.md', { actor: me })
  assert.deepEqual(r.images.moved, [{ from: 'proj/chart.png', to: 'archive/chart-2.png' }])
  assert.equal(read('archive/chart.png'), 'someone else\'s')
  assert.ok(has('archive/chart-2.png') && !has('proj/chart.png'))
  assert.ok(read('archive/plan.md').endsWith('![](chart-2.png) and again ![chart](chart-2.png "title")\n'))
  assert.deepEqual(r.relinked[0]!.changes, [
    { before: '![](chart.png)', after: '![](chart-2.png)' },
    { before: '![chart](chart.png "title")', after: '![chart](chart-2.png "title")' },
  ])
})

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
    'proj/plan.md': '![](plan.png) ![](../x.png)\n',
    'proj/plan.png': PNG,
    'x.png': PNG,
  })
  const r = await notes.move('proj/plan.md', 'proj/New plan.md', { actor: me })
  assert.deepEqual(r.images, { moved: [], stayed: [], folder: null, failed: [] })
  assert.ok(has('proj/plan.png'))
  assert.ok(read('proj/New plan.md').endsWith('![](plan.png) ![](../x.png)\n'))
})

test('the dry run touches nothing', async () => {
  const { db, notes, has } = setup({ 'proj/plan.md': '![](plan.png)\n', 'proj/plan.png': PNG })
  const snapshot = dumpIndex(db)
  const r = await notes.move('proj/plan.md', 'plan.md', { actor: me, dryRun: true })
  assert.deepEqual(r.images.moved, [{ from: 'proj/plan.png', to: 'plan.png' }])
  assert.ok(has('proj/plan.png') && !has('plan.png') && has('proj/plan.md'))
  assert.equal(dumpIndex(db), snapshot)
})

test('if the note cannot leave its folder, the images placed at the destination are removed again', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, notes, has, read } = setup({ 'proj/plan.md': '![](plan.png)\n', 'proj/plan.png': PNG })
  chmodSync(join(notesDir, 'proj'), 0o555)
  try {
    await assert.rejects(notes.move('proj/plan.md', 'archive/plan.md', { actor: me }))
    assert.ok(!has('archive/plan.md') && !has('archive/plan.png'))
    assert.ok(has('proj/plan.png'))
    assert.equal(read('proj/plan.md'), '![](plan.png)\n')
  } finally {
    chmodSync(join(notesDir, 'proj'), 0o755)
  }
})

test('an image that cannot go with the note stays, and the note links it where it is', async () => {
  const taken: Record<string, string> = { 'archive/plan.png': 'taken' }
  for (let n = 2; n <= 1000; n++) taken[`archive/plan-${n}.png`] = 'taken'
  const { notes, has, read } = setup({ 'proj/plan.md': '![](plan.png)\n', 'proj/plan.png': PNG, ...taken })
  const r = await notes.move('proj/plan.md', 'archive/plan.md', { actor: me })
  assert.deepEqual(r.images.moved, [])
  assert.deepEqual(r.images.failed.map((f) => [f.path, f.to, f.outcome, f.error]), [['proj/plan.png', null, 'stayed', 'exists']])
  assert.ok(has('proj/plan.png'))
  assert.ok(read('archive/plan.md').endsWith('![](../proj/plan.png)\n'))
  assert.deepEqual(r.relinked[0]!.changes, [{ before: '![](plan.png)', after: '![](../proj/plan.png)' }])
})
