// Per-note attachments (vihko.yaml `attachments.mode: per-note`, D-031.5):
// a note's own folder of images (`plan.md` → `plan.assets/`) goes with it
// whole, renamed to match, and every link into it keeps working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Indexer, NoteError, NoteService, openIndex, type Actor, type HotDocuments } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// The user the writes are made as (an id, as vihko has them).
const m = mother(import.meta.url)
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
// The names of the notes, folders and images (one token each: they sit in Markdown links' destinations).
const token = () => m.aUniqueWord()
const [PROJ, PLAN, ROADMAP, OTHER, ELSEWHERE, FAR, ARCHIVE, LOOSE, INNER] = [token(), token(), token(), token(), token(), token(), token(), token(), token()]
const [CHART, PHOTO, SPEC, OLD] = [token(), token(), token(), token()]
/** A new name with a space in it, and how a Markdown link writes it. */
const SPACED = `${m.aTitle()} ${m.aWord()}`
const SPACED_URL = SPACED.replaceAll(' ', '%20')
const HEADING = m.aHeading()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const body = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, '')

function setup(files: Record<string, string | Uint8Array>, opts: { suffix?: string; hot?: HotDocuments } = {}) {
  const dir = tempDir('vihko-move-assets-')
  const notesDir = join(dir, ELSEWHERE)
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
  const { notes, has } = setup({ [`${PROJ}/${PLAN}.md`]: `# ${HEADING}\n` })
  const r = await notes.attach(`${PROJ}/${PLAN}.md`, PNG, me, new Date('2026-09-25T10:12:00Z'))
  assert.deepEqual(r, { path: `${PROJ}/${PLAN}.assets/2026-09-25-1012.png`, src: `${PLAN}.assets/2026-09-25-1012.png` })
  assert.ok(has(r.path))
  const again = await notes.attach(`${PROJ}/${PLAN}.md`, PNG, me, new Date('2026-09-25T10:12:30Z'))
  assert.equal(again.path, `${PROJ}/${PLAN}.assets/2026-09-25-1012-2.png`, 'never overwritten')
})

test('renaming a note renames its folder; links from it and from other notes are rewritten', async () => {
  const files = {
    [`${PROJ}/${PLAN}.md`]: `# ${HEADING}\n\n![${CHART}](${PLAN}.assets/${CHART}.png)\n![[${PLAN}.assets/${PHOTO}.png]]\n`,
    [`${PROJ}/${PLAN}.assets/${CHART}.png`]: PNG,
    [`${PROJ}/${PLAN}.assets/${PHOTO}.png`]: PNG,
    [`${PROJ}/${PLAN}.assets/${SPEC}.pdf`]: '%PDF-1.7', // not an image: it goes along (vihko only tracks links to images)
    [`${PROJ}/${OTHER}.md`]: `See ![](${PLAN}.assets/${CHART}.png)\n`,
    [`${ELSEWHERE}/${FAR}.md`]: `From afar: ![x](../${PROJ}/${PLAN}.assets/${CHART}.png) and ![[/${PROJ}/${PLAN}.assets/${PHOTO}.png]]\n`,
  }
  const { notes, has, read, folders } = setup(files)
  const dry = await notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${ROADMAP}.md`, { actor: me, dryRun: true })
  assert.deepEqual(dry.images.folder, { from: `${PROJ}/${PLAN}.assets`, to: `${PROJ}/${ROADMAP}.assets`, files: 3 })
  assert.deepEqual([dry.images.moved, dry.images.stayed, dry.images.failed], [[], [], []])
  // The moved note first, then the others in the order of their paths.
  const others: [string, unknown][] = [
    [`${ELSEWHERE}/${FAR}.md`, [
      { before: `![x](../${PROJ}/${PLAN}.assets/${CHART}.png)`, after: `![x](../${PROJ}/${ROADMAP}.assets/${CHART}.png)`, kind: 'image', to: `${PROJ}/${ROADMAP}.assets/${CHART}.png` },
      { before: `![[/${PROJ}/${PLAN}.assets/${PHOTO}.png]]`, after: `![[/${PROJ}/${ROADMAP}.assets/${PHOTO}.png]]`, kind: 'image', to: `${PROJ}/${ROADMAP}.assets/${PHOTO}.png` },
    ]],
    [`${PROJ}/${OTHER}.md`, [{ before: `![](${PLAN}.assets/${CHART}.png)`, after: `![](${ROADMAP}.assets/${CHART}.png)`, kind: 'image', to: `${PROJ}/${ROADMAP}.assets/${CHART}.png` }]],
  ]
  assert.deepEqual(dry.relinked.map((r) => [r.path, r.changes]), [
    [`${PROJ}/${ROADMAP}.md`, [
      { before: `![${CHART}](${PLAN}.assets/${CHART}.png)`, after: `![${CHART}](${ROADMAP}.assets/${CHART}.png)`, kind: 'image', to: `${PROJ}/${ROADMAP}.assets/${CHART}.png` },
      { before: `![[${PLAN}.assets/${PHOTO}.png]]`, after: `![[${ROADMAP}.assets/${PHOTO}.png]]`, kind: 'image', to: `${PROJ}/${ROADMAP}.assets/${PHOTO}.png` },
    ]],
    ...others.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])
  assert.ok(has(`${PROJ}/${PLAN}.assets/${CHART}.png`) && !has(`${PROJ}/${ROADMAP}.assets`), 'a dry run touches nothing')

  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${ROADMAP}.md`, { actor: me })
  assert.deepEqual(r.images.folder, { from: `${PROJ}/${PLAN}.assets`, to: `${PROJ}/${ROADMAP}.assets`, files: 3 })
  assert.deepEqual(r.failed, [])
  assert.ok(!has(`${PROJ}/${PLAN}.assets`))
  for (const f of [`${CHART}.png`, `${PHOTO}.png`, `${SPEC}.pdf`]) assert.ok(has(`${PROJ}/${ROADMAP}.assets/${f}`), f)
  assert.equal(body(read(`${PROJ}/${ROADMAP}.md`)), `# ${HEADING}\n\n![${CHART}](${ROADMAP}.assets/${CHART}.png)\n![[${ROADMAP}.assets/${PHOTO}.png]]\n`)
  assert.equal(body(read(`${PROJ}/${OTHER}.md`)), `See ![](${ROADMAP}.assets/${CHART}.png)\n`)
  assert.equal(body(read(`${ELSEWHERE}/${FAR}.md`)), `From afar: ![x](../${PROJ}/${ROADMAP}.assets/${CHART}.png) and ![[/${PROJ}/${ROADMAP}.assets/${PHOTO}.png]]\n`)
  assert.ok(folders().includes(`${PROJ}/${ROADMAP}.assets`) && !folders().includes(`${PROJ}/${PLAN}.assets`))
})

test('moving a note to another folder takes its folder along; loose images keep today\'s rules', async () => {
  const { notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.assets/a.png) ![](${LOOSE}.png)\n`,
    [`${PROJ}/${PLAN}.assets/a.png`]: PNG,
    [`${PROJ}/${LOOSE}.png`]: PNG,
  })
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/2026/${PLAN}.md`, { actor: me })
  assert.deepEqual(r.images.folder, { from: `${PROJ}/${PLAN}.assets`, to: `${ARCHIVE}/2026/${PLAN}.assets`, files: 1 })
  assert.deepEqual(r.images.moved, [{ from: `${PROJ}/${LOOSE}.png`, to: `${ARCHIVE}/2026/${LOOSE}.png` }])
  assert.ok(has(`${ARCHIVE}/2026/${PLAN}.assets/a.png`) && has(`${ARCHIVE}/2026/${LOOSE}.png`))
  assert.ok(!has(`${PROJ}/${PLAN}.assets`) && !has(`${PROJ}/${LOOSE}.png`))
  assert.equal(body(read(`${ARCHIVE}/2026/${PLAN}.md`)), `![](${PLAN}.assets/a.png) ![](${LOOSE}.png)\n`, 'relative links still reach them')
})

test('a configurable suffix names the folder', async () => {
  const { notes, has, read } = setup({ [`${PLAN}.md`]: `![](${PLAN}_files/a.png)\n`, [`${PLAN}_files/a.png`]: PNG }, { suffix: '_files' })
  const r = await notes.move(`${PLAN}.md`, `${SPACED}.md`, { actor: me })
  assert.deepEqual(r.images.folder, { from: `${PLAN}_files`, to: `${SPACED}_files`, files: 1 })
  assert.ok(has(`${SPACED}_files/a.png`))
  assert.equal(body(read(`${SPACED}.md`)), `![](${SPACED_URL}_files/a.png)\n`)
})

test('a taken destination name is never overwritten: the folder stays and the note links it there', async () => {
  const { notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.assets/a.png)\n`,
    [`${PROJ}/${PLAN}.assets/a.png`]: PNG,
    [`${PROJ}/${ROADMAP}.assets/${OLD}.png`]: PNG,
  })
  const taken = await notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${ROADMAP}.md`, { actor: me, dryRun: true })
  assert.equal(taken.images.folder, null)
  assert.deepEqual(taken.images.failed.map((f) => [f.path, f.outcome, f.error]), [[`${PROJ}/${PLAN}.assets`, 'stayed', 'exists']])
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${ROADMAP}.md`, { actor: me })
  assert.equal(r.images.folder, null)
  assert.ok(has(`${PROJ}/${PLAN}.assets/a.png`) && has(`${PROJ}/${ROADMAP}.assets/${OLD}.png`) && !has(`${PROJ}/${ROADMAP}.assets/a.png`))
  assert.equal(body(read(`${PROJ}/${ROADMAP}.md`)), `![](${PLAN}.assets/a.png)\n`)
})

test('a note moved to another folder whose own folder can\'t follow links it where it stays', async () => {
  const { notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.assets/a.png)\n`,
    [`${PROJ}/${PLAN}.assets/a.png`]: PNG,
    [`${PROJ}/${PLAN}.assets/${INNER}.md`]: 'a note inside\n',
  })
  const r = await notes.move(`${PROJ}/${PLAN}.md`, `${ARCHIVE}/${PLAN}.md`, { actor: me })
  assert.equal(r.images.folder, null)
  assert.deepEqual(r.images.failed.map((f) => [f.path, f.outcome, f.error]), [[`${PROJ}/${PLAN}.assets`, 'stayed', 'not_empty']])
  assert.deepEqual(r.images.stayed, [{ path: `${PROJ}/${PLAN}.assets/a.png`, reason: 'elsewhere' }])
  assert.ok(has(`${PROJ}/${PLAN}.assets/a.png`) && has(`${PROJ}/${PLAN}.assets/${INNER}.md`))
  assert.equal(body(read(`${ARCHIVE}/${PLAN}.md`)), `![](../${PROJ}/${PLAN}.assets/a.png)\n`)
})

test('if the note can\'t move, its folder goes back', async () => {
  const { notesDir, notes, has, read } = setup({
    [`${PROJ}/${PLAN}.md`]: `![](${PLAN}.assets/a.png)\n`,
    [`${PROJ}/${PLAN}.assets/a.png`]: PNG,
  })
  // Someone writes to the note while it moves: the move is undone.
  const hot: HotDocuments = {
    has: () => true,
    edit: () => { throw new Error('unused') },
    discard: async () => {},
    move: async (_from, _to, run) => {
      const running = run()
      while (!existsSync(join(notesDir, `${PROJ}/${ROADMAP}.assets`))) await new Promise((r) => setImmediate(r))
      writeFileSync(join(notesDir, `${PROJ}/${PLAN}.md`), `changed meanwhile ![](${PLAN}.assets/a.png)\n`)
      return (await running).result
    },
  }
  ;(notes as unknown as { opts: { hot: HotDocuments } }).opts.hot = hot
  await assert.rejects(notes.move(`${PROJ}/${PLAN}.md`, `${PROJ}/${ROADMAP}.md`, { actor: me }), (e: unknown) => e instanceof NoteError && e.code === 'precondition_failed')
  assert.ok(has(`${PROJ}/${PLAN}.assets/a.png`) && !has(`${PROJ}/${ROADMAP}.assets`) && !has(`${PROJ}/${ROADMAP}.md`))
  assert.equal(read(`${PROJ}/${PLAN}.md`), `changed meanwhile ![](${PLAN}.assets/a.png)\n`)
})

test('in the other modes a folder named like one is left alone', async () => {
  const dir = tempDir('vihko-move-assets-')
  const notesDir = join(dir, ELSEWHERE)
  mkdirSync(join(notesDir, `${PLAN}.assets`), { recursive: true })
  writeFileSync(join(notesDir, `${PLAN}.md`), `![](${PLAN}.assets/a.png)\n`)
  writeFileSync(join(notesDir, `${PLAN}.assets/a.png`), PNG)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const r = await notes.move(`${PLAN}.md`, `${ROADMAP}.md`, { actor: me })
  assert.equal(r.images.folder, null)
  assert.ok(existsSync(join(notesDir, `${PLAN}.assets/a.png`)))
})
