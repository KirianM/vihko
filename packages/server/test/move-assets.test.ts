// Per-note attachments (thoth.yaml `attachments.mode: per-note`, D-031.5):
// a note's own folder of images (`plan.md` → `plan.assets/`) goes with it
// whole, renamed to match, and every link into it keeps working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Indexer, NoteError, NoteService, openIndex, type Actor, type HotDocuments } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const me: Actor = { kind: 'user', id: 'noa' }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const body = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, '')

function setup(files: Record<string, string | Uint8Array>, opts: { suffix?: string; hot?: HotDocuments } = {}) {
  const dir = tempDir('thoth-move-assets-')
  const notesDir = join(dir, 'notes')
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    if (p.endsWith('/')) continue
    writeFileSync(join(notesDir, p), content)
  }
  mkdirSync(notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db, hot: opts.hot, attachments: () => ({ folder: null, perNote: opts.suffix ?? '.assets' }) })
  const has = (p: string) => existsSync(join(notesDir, p))
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  const folders = () => (db.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
  return { notesDir, db, notes, has, read, folders }
}

test('uploads in per-note mode go to the note\'s own folder', async () => {
  const { notes, has } = setup({ 'proj/plan.md': '# Plan\n' })
  const r = await notes.attach('proj/plan.md', PNG, me, new Date('2026-09-25T10:12:00Z'))
  assert.deepEqual(r, { path: 'proj/plan.assets/2026-09-25-1012.png', src: 'plan.assets/2026-09-25-1012.png' })
  assert.ok(has(r.path))
  const again = await notes.attach('proj/plan.md', PNG, me, new Date('2026-09-25T10:12:30Z'))
  assert.equal(again.path, 'proj/plan.assets/2026-09-25-1012-2.png', 'never overwritten')
})

test('renaming a note renames its folder; links from it and from other notes are rewritten', async () => {
  const files = {
    'proj/plan.md': '# Plan\n\n![chart](plan.assets/chart.png)\n![[plan.assets/photo.png]]\n',
    'proj/plan.assets/chart.png': PNG,
    'proj/plan.assets/photo.png': PNG,
    'proj/plan.assets/spec.pdf': '%PDF-1.7', // not an image: it goes along (thoth only tracks links to images)
    'proj/other.md': 'See ![](plan.assets/chart.png)\n',
    'notes/far.md': 'From afar: ![x](../proj/plan.assets/chart.png) and ![[/proj/plan.assets/photo.png]]\n',
  }
  const { notes, has, read, folders } = setup(files)
  const dry = await notes.move('proj/plan.md', 'proj/roadmap.md', { actor: me, dryRun: true })
  assert.deepEqual(dry.images.folder, { from: 'proj/plan.assets', to: 'proj/roadmap.assets', files: 3 })
  assert.deepEqual([dry.images.moved, dry.images.stayed, dry.images.failed], [[], [], []])
  assert.deepEqual(dry.relinked.map((r) => [r.path, r.changes]), [
    ['proj/roadmap.md', [
      { before: '![chart](plan.assets/chart.png)', after: '![chart](roadmap.assets/chart.png)' },
      { before: '![[plan.assets/photo.png]]', after: '![[roadmap.assets/photo.png]]' },
    ]],
    ['notes/far.md', [
      { before: '![x](../proj/plan.assets/chart.png)', after: '![x](../proj/roadmap.assets/chart.png)' },
      { before: '![[/proj/plan.assets/photo.png]]', after: '![[/proj/roadmap.assets/photo.png]]' },
    ]],
    ['proj/other.md', [{ before: '![](plan.assets/chart.png)', after: '![](roadmap.assets/chart.png)' }]],
  ])
  assert.ok(has('proj/plan.assets/chart.png') && !has('proj/roadmap.assets'), 'a dry run touches nothing')

  const r = await notes.move('proj/plan.md', 'proj/roadmap.md', { actor: me })
  assert.deepEqual(r.images.folder, { from: 'proj/plan.assets', to: 'proj/roadmap.assets', files: 3 })
  assert.deepEqual(r.failed, [])
  assert.ok(!has('proj/plan.assets'))
  for (const f of ['chart.png', 'photo.png', 'spec.pdf']) assert.ok(has(`proj/roadmap.assets/${f}`), f)
  assert.equal(body(read('proj/roadmap.md')), '# Plan\n\n![chart](roadmap.assets/chart.png)\n![[roadmap.assets/photo.png]]\n')
  assert.equal(body(read('proj/other.md')), 'See ![](roadmap.assets/chart.png)\n')
  assert.equal(body(read('notes/far.md')), 'From afar: ![x](../proj/roadmap.assets/chart.png) and ![[/proj/roadmap.assets/photo.png]]\n')
  assert.ok(folders().includes('proj/roadmap.assets') && !folders().includes('proj/plan.assets'))
})

test('moving a note to another folder takes its folder along; loose images keep today\'s rules', async () => {
  const { notes, has, read } = setup({
    'proj/plan.md': '![](plan.assets/a.png) ![](loose.png)\n',
    'proj/plan.assets/a.png': PNG,
    'proj/loose.png': PNG,
  })
  const r = await notes.move('proj/plan.md', 'archive/2026/plan.md', { actor: me })
  assert.deepEqual(r.images.folder, { from: 'proj/plan.assets', to: 'archive/2026/plan.assets', files: 1 })
  assert.deepEqual(r.images.moved, [{ from: 'proj/loose.png', to: 'archive/2026/loose.png' }])
  assert.ok(has('archive/2026/plan.assets/a.png') && has('archive/2026/loose.png'))
  assert.ok(!has('proj/plan.assets') && !has('proj/loose.png'))
  assert.equal(body(read('archive/2026/plan.md')), '![](plan.assets/a.png) ![](loose.png)\n', 'relative links still reach them')
})

test('a configurable suffix names the folder', async () => {
  const { notes, has, read } = setup({ 'plan.md': '![](plan_files/a.png)\n', 'plan_files/a.png': PNG }, { suffix: '_files' })
  const r = await notes.move('plan.md', 'Roadmap 2027.md', { actor: me })
  assert.deepEqual(r.images.folder, { from: 'plan_files', to: 'Roadmap 2027_files', files: 1 })
  assert.ok(has('Roadmap 2027_files/a.png'))
  assert.equal(body(read('Roadmap 2027.md')), '![](Roadmap%202027_files/a.png)\n')
})

test('a taken destination name is never overwritten: the folder stays and the note links it there', async () => {
  const { notes, has, read } = setup({
    'proj/plan.md': '![](plan.assets/a.png)\n',
    'proj/plan.assets/a.png': PNG,
    'proj/roadmap.assets/old.png': PNG,
  })
  const taken = await notes.move('proj/plan.md', 'proj/roadmap.md', { actor: me, dryRun: true })
  assert.equal(taken.images.folder, null)
  assert.deepEqual(taken.images.failed.map((f) => [f.path, f.outcome, f.error]), [['proj/plan.assets', 'stayed', 'exists']])
  const r = await notes.move('proj/plan.md', 'proj/roadmap.md', { actor: me })
  assert.equal(r.images.folder, null)
  assert.ok(has('proj/plan.assets/a.png') && has('proj/roadmap.assets/old.png') && !has('proj/roadmap.assets/a.png'))
  assert.equal(body(read('proj/roadmap.md')), '![](plan.assets/a.png)\n')
})

test('a note moved to another folder whose own folder can\'t follow links it where it stays', async () => {
  const { notes, has, read } = setup({
    'proj/plan.md': '![](plan.assets/a.png)\n',
    'proj/plan.assets/a.png': PNG,
    'proj/plan.assets/inner.md': 'a note inside\n',
  })
  const r = await notes.move('proj/plan.md', 'archive/plan.md', { actor: me })
  assert.equal(r.images.folder, null)
  assert.deepEqual(r.images.failed.map((f) => [f.path, f.outcome, f.error]), [['proj/plan.assets', 'stayed', 'not_empty']])
  assert.deepEqual(r.images.stayed, [{ path: 'proj/plan.assets/a.png', reason: 'elsewhere' }])
  assert.ok(has('proj/plan.assets/a.png') && has('proj/plan.assets/inner.md'))
  assert.equal(body(read('archive/plan.md')), '![](../proj/plan.assets/a.png)\n')
})

test('if the note can\'t move, its folder goes back', async () => {
  const { notesDir, notes, has, read } = setup({
    'proj/plan.md': '![](plan.assets/a.png)\n',
    'proj/plan.assets/a.png': PNG,
  })
  // Someone writes to the note while it moves: the move is undone.
  const hot: HotDocuments = {
    has: () => true,
    edit: () => { throw new Error('unused') },
    discard: async () => {},
    move: async (_from, _to, run) => {
      const running = run()
      while (!existsSync(join(notesDir, 'proj/roadmap.assets'))) await new Promise((r) => setImmediate(r))
      writeFileSync(join(notesDir, 'proj/plan.md'), 'changed meanwhile ![](plan.assets/a.png)\n')
      return (await running).result
    },
  }
  ;(notes as unknown as { opts: { hot: HotDocuments } }).opts.hot = hot
  await assert.rejects(notes.move('proj/plan.md', 'proj/roadmap.md', { actor: me }), (e: unknown) => e instanceof NoteError && e.code === 'precondition_failed')
  assert.ok(has('proj/plan.assets/a.png') && !has('proj/roadmap.assets') && !has('proj/roadmap.md'))
  assert.equal(read('proj/plan.md'), 'changed meanwhile ![](plan.assets/a.png)\n')
})

test('in the other modes a folder named like one is left alone', async () => {
  const dir = tempDir('thoth-move-assets-')
  const notesDir = join(dir, 'notes')
  mkdirSync(join(notesDir, 'plan.assets'), { recursive: true })
  writeFileSync(join(notesDir, 'plan.md'), '![](plan.assets/a.png)\n')
  writeFileSync(join(notesDir, 'plan.assets/a.png'), PNG)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const r = await notes.move('plan.md', 'roadmap.md', { actor: me })
  assert.equal(r.images.folder, null)
  assert.ok(existsSync(join(notesDir, 'plan.assets/a.png')))
})
