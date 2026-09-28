// Deleting a note takes to the trash the images next to it that only it uses
// (D-028: what moving it would take along), in the same entry, and restoring
// it brings them back, never over another file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFrontmatter, type AttachmentsConfig } from '@vihko/core'
import { Indexer, NoteError, NoteService, openIndex, type Actor } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
// Names that sit in Markdown link destinations: one token each.
const token = () => m.aUniqueWord()
/** Up to ten tokens, to destructure. */
const tokens = (n: number) => Array.from({ length: n }, token) as [string, string, string, string, string, string, string, string, string, string]
/** Some image's bytes (different each time: which file is which is the case under test). */
const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(m.aSentence())])

function setup(files: Record<string, string | Uint8Array>, attachments: AttachmentsConfig = { folder: null }) {
  const dir = tempDir('vihko-trash-images-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  for (const [p, content] of Object.entries(files)) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir, indexer, db, attachments: () => attachments })
  const has = (p: string) => existsSync(join(notesDir, p))
  const bytes = (p: string) => readFileSync(join(notesDir, p))
  const body = (p: string) => { const t = readFileSync(join(notesDir, p), 'utf8'); return t.slice(readFrontmatter(t).bodyStart) }
  const trashDirs = () => { try { return readdirSync(join(stateDir, 'trash')) } catch { return [] } }
  const folders = () => (db.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
  return { dir, notesDir, stateDir, db, indexer, notes, has, bytes, body, trashDirs, folders }
}

const code = (c: string) => (e: unknown) => e instanceof NoteError && e.code === c

test('a note goes to the trash with the images only it uses, next to it; the others stay', async () => {
  const [DIR, SUB, SHARED_DIR, NOTE, OTHER, OWN, EMBED, SHARED, BELOW, GLOBAL] = tokens(10)
  const note = `${DIR}/${NOTE}.md`
  const text = `# ${m.aHeading()}\n\n![](${OWN}.png) ![[${EMBED}.png]] ![](${SHARED}.png) ![](${SUB}/${BELOW}.png) ![](../${SHARED_DIR}/${GLOBAL}.png) ![](${m.aUniqueWord()}.png)\n`
  const files = { [`${DIR}/${OWN}.png`]: png(), [`${DIR}/${EMBED}.png`]: png(), [`${DIR}/${SHARED}.png`]: png(), [`${DIR}/${SUB}/${BELOW}.png`]: png(), [`${SHARED_DIR}/${GLOBAL}.png`]: png() }
  const { notes, has, bytes, stateDir } = setup({
    [note]: text,
    [`${DIR}/${OTHER}.md`]: `${m.aSentence()} ![](${SHARED}.png)\n`,
    ...files,
  }, { folder: SHARED_DIR })

  const entry = await notes.delete(note, { actor: me })
  assert.deepEqual(entry.files?.map((f) => f.path), [`${DIR}/${EMBED}.png`, `${DIR}/${OWN}.png`].sort())
  assert.ok(!has(note) && !has(`${DIR}/${OWN}.png`) && !has(`${DIR}/${EMBED}.png`))
  // Shared with another note, in a folder below, in the shared attachments folder: left alone.
  for (const p of [`${DIR}/${SHARED}.png`, `${DIR}/${SUB}/${BELOW}.png`, `${SHARED_DIR}/${GLOBAL}.png`]) assert.ok(has(p), p)
  // The entry records them, and holds their bytes.
  const meta = JSON.parse(readFileSync(join(stateDir, 'trash', entry.id, 'meta.json'), 'utf8'))
  assert.deepEqual(meta.files, entry.files)
  for (const f of entry.files!) assert.ok(readFileSync(join(stateDir, 'trash', entry.id, f.stored)).equals(files[f.path]!), f.path)
  assert.deepEqual(notes.trash().map((e) => e.id), [entry.id])

  const back = await notes.restore(entry.id, me)
  assert.equal(back.path, note)
  assert.deepEqual(back.files, entry.files!.map((f) => ({ from: f.path, to: f.path })))
  assert.deepEqual(back.left, [])
  assert.equal(readFileSync(join(dirname(stateDir), 'notes', note), 'utf8'), text, 'the note comes back as it was')
  for (const f of entry.files!) assert.ok(bytes(f.path).equals(files[f.path]!), f.path)
  assert.deepEqual(notes.trash(), [], 'the entry is gone')
})

test('an image in the shared attachments folder stays, even next to the note', async () => {
  const [SHARED_DIR, NOTE, IMG] = [token(), token(), token()]
  const note = `${SHARED_DIR}/${NOTE}.md`
  const { notes, has } = setup({ [note]: `![](${IMG}.png)\n`, [`${SHARED_DIR}/${IMG}.png`]: png() }, { folder: SHARED_DIR })
  const entry = await notes.delete(note, { actor: me })
  assert.equal(entry.files, undefined)
  assert.ok(has(`${SHARED_DIR}/${IMG}.png`))
})

test('an image whose name was taken meanwhile comes back with a suffix, and the note links it there', async () => {
  const [DIR, NOTE, IMG] = [token(), token(), token()]
  const note = `${DIR}/${NOTE}.md`
  const mine = png()
  const { notes, has, bytes, body, notesDir } = setup({ [note]: `![${m.aWord()}](${IMG}.png) and ![[${IMG}.png]]\n`, [`${DIR}/${IMG}.png`]: mine })
  const entry = await notes.delete(note, { actor: me })
  const theirs = png()
  writeFileSync(join(notesDir, DIR, `${IMG}.png`), theirs)

  const back = await notes.restore(entry.id, me)
  assert.deepEqual(back.files, [{ from: `${DIR}/${IMG}.png`, to: `${DIR}/${IMG}-2.png` }])
  assert.ok(bytes(`${DIR}/${IMG}.png`).equals(theirs), 'never overwritten')
  assert.ok(bytes(`${DIR}/${IMG}-2.png`).equals(mine))
  assert.ok(body(note).includes(`(${IMG}-2.png)`) && body(note).includes(`![[${IMG}-2.png]]`), body(note))
  assert.ok(!body(note).includes(`(${IMG}.png)`))
  assert.ok(has(note))
})

test('an identical image already back counts as restored; a note whose name is taken is not restored at all', async () => {
  const [DIR, NOTE, IMG, TAKEN_IMG] = [token(), token(), token(), token()]
  const note = `${DIR}/${NOTE}.md`
  const [same, other] = [png(), png()]
  const { notes, notesDir, has, bytes } = setup({ [note]: `![](${IMG}.png) ![](${TAKEN_IMG}.png)\n`, [`${DIR}/${IMG}.png`]: same, [`${DIR}/${TAKEN_IMG}.png`]: other })
  const entry = await notes.delete(note, { actor: me })

  // Someone made a note at its path: nothing comes back, and the entry stays whole.
  const squatter = m.aSentence()
  writeFileSync(join(notesDir, note), squatter)
  await assert.rejects(notes.restore(entry.id, me), code('exists'))
  assert.ok(!has(`${DIR}/${IMG}.png`) && !has(`${DIR}/${TAKEN_IMG}.png`), 'no image placed for a note that did not come back')
  assert.equal(readFileSync(join(notesDir, note), 'utf8'), squatter)

  // To another path, then: an identical copy already there (the history brought it back, say) is used.
  writeFileSync(join(notesDir, DIR, `${IMG}.png`), same)
  const elsewhere = `${DIR}/${token()}.md`
  const back = await notes.restore(entry.id, me, elsewhere)
  // In the entry's order: by path.
  assert.deepEqual(back.files, [`${DIR}/${IMG}.png`, `${DIR}/${TAKEN_IMG}.png`].sort().map((p) => ({ from: p, to: p })))
  assert.ok(!has(`${DIR}/${IMG}-2.png`))
  assert.ok(bytes(`${DIR}/${TAKEN_IMG}.png`).equals(other))
})

test('restored to another folder, the images go next to the note', async () => {
  const [DIR, TO, NOTE, IMG] = [token(), token(), token(), token()]
  const note = `${DIR}/${NOTE}.md`
  const img = png()
  const { notes, has, bytes, body } = setup({ [note]: `![](${IMG}.png)\n`, [`${DIR}/${IMG}.png`]: img })
  const entry = await notes.delete(note, { actor: me })
  const back = await notes.restore(entry.id, me, `${TO}/${NOTE}.md`)
  assert.deepEqual(back.files, [{ from: `${DIR}/${IMG}.png`, to: `${TO}/${IMG}.png` }])
  assert.ok(bytes(`${TO}/${IMG}.png`).equals(img) && !has(`${DIR}/${IMG}.png`))
  assert.equal(body(`${TO}/${NOTE}.md`), `![](${IMG}.png)\n`)
})

test('per-note mode: the note\'s folder of images goes with it (what only it uses) and comes back', async () => {
  const [DIR, NOTE, OTHER, A, B, LOOSE, SHARED] = tokens(7)
  const note = `${DIR}/${NOTE}.md`
  const assets = `${DIR}/${NOTE}.assets`
  const files = { [`${assets}/${A}.png`]: png(), [`${assets}/${B}.png`]: png(), [`${assets}/${LOOSE}.png`]: png() }
  const { notes, has, bytes, folders } = setup({ [note]: `![](${NOTE}.assets/${A}.png) ![[${NOTE}.assets/${B}.png]]\n`, ...files }, { folder: null, perNote: '.assets' })
  const entry = await notes.delete(note, { actor: me })
  assert.deepEqual(entry.files?.map((f) => f.path), Object.keys(files).sort(), 'what it links and what else is in its folder')
  assert.ok(!has(assets), 'its folder of images goes once empty')
  assert.ok(!folders().includes(assets))
  await notes.restore(entry.id, me)
  for (const [p, b] of Object.entries(files)) assert.ok(bytes(p).equals(b), p)

  // Used by another note too: that one stays, and so does the folder.
  const { notes: n2, has: has2 } = setup({
    [note]: `![](${NOTE}.assets/${A}.png)\n`, [`${DIR}/${OTHER}.md`]: `![](${NOTE}.assets/${SHARED}.png)\n`,
    [`${assets}/${A}.png`]: png(), [`${assets}/${SHARED}.png`]: png(),
  }, { folder: null, perNote: '.assets' })
  const e2 = await n2.delete(note, { actor: me })
  assert.deepEqual(e2.files?.map((f) => f.path), [`${assets}/${A}.png`])
  assert.ok(has2(`${assets}/${SHARED}.png`))
})

test('images the one deleting may not write stay; restored where they may not write, they stay in the trash', async () => {
  const [DIR, NOTE, A, B] = [token(), token(), token(), token()]
  const note = `${DIR}/${NOTE}.md`
  const { notes, has } = setup({ [note]: `![](${A}.png) ![](${B}.png)\n`, [`${DIR}/${A}.png`]: png(), [`${DIR}/${B}.png`]: png() })
  const entry = await notes.delete(note, { actor: me, canWrite: (p) => !p.endsWith(`${A}.png`) })
  assert.deepEqual(entry.files?.map((f) => f.path), [`${DIR}/${B}.png`])
  assert.ok(has(`${DIR}/${A}.png`))

  const back = await notes.restore(entry.id, me, undefined, { canWrite: () => false })
  assert.deepEqual([back.path, back.files, back.left], [note, [], [`${DIR}/${B}.png`]])
  assert.ok(has(note) && !has(`${DIR}/${B}.png`))
  // What stayed is an entry of files alone, in the note's folder, restorable later.
  const [rest] = notes.trash()
  assert.deepEqual([rest?.id, rest?.kind, rest?.path, rest?.files?.map((f) => f.path)], [entry.id, 'files', DIR, [`${DIR}/${B}.png`]])
  const later = await notes.restore(entry.id, me)
  assert.deepEqual([later.etag, later.files], [null, [{ from: `${DIR}/${B}.png`, to: `${DIR}/${B}.png` }]])
  assert.ok(has(`${DIR}/${B}.png`))
  assert.deepEqual(notes.trash(), [])
})
