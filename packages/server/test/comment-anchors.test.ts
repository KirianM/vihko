// «The text has changed» (D-031.6): the index remembers, per comment thread,
// the text it was anchored to when first seen, and the API says which threads'
// text differs now. A rebuild forgets it: the text then becomes the baseline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Indexer, NoteService, openIndex, type Actor } from '@thoth/server'
import { setup as appSetup } from './_app.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// Comments' authors (usernames); the actor who writes is a user id.
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()

const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
const C1 = `<!-- @${AUTHOR} 2026-09-24T08:12Z · no, use SQLite -->`
const C2 = `<!-- @${REPLIER} 2026-09-24T09:00Z · ↳ agreed -->`
const C3 = `<!-- @${REPLIER} 2026-09-24T09:30Z · which one? -->`

function setup() {
  const dir = tempDir('thoth-comment-anchors-')
  const notesDir = join(dir, 'notes')
  mkdirSync(notesDir, { recursive: true })
  let n = 0
  const write = (p: string, text: string) => {
    writeFileSync(join(notesDir, p), text)
    // A distinct whole-second mtime each time, so a rescan never takes it for unchanged.
    const t = 1_800_000_000 + ++n
    utimesSync(join(notesDir, p), t, t)
  }
  const open = (file = 'index.db') => {
    const db = openIndex(join(dir, file))
    const indexer = new Indexer({ notesDir, db })
    indexer.scan()
    const rows = (p: string) => (db.prepare('select thread, original from comment_anchors where src_path = ? and orphaned = 0 order by original').all(p) as { thread: string; original: string }[]).map((r) => r.original)
    return { db, indexer, rows }
  }
  return { dir, notesDir, write, open }
}

test('the first text a thread is seen with is kept while the note changes', () => {
  const { write, open } = setup()
  write('plan.md', `# Plan\n\nIntro. We'll use Postgres for the index.${C1}\n${C2}\n\n- Two options${C3}\n`)
  const { indexer, rows } = open()
  assert.deepEqual(rows('plan.md'), ['Two options', "We'll use Postgres for the index."])

  write('plan.md', `# Plan\n\nIntro. We'll use SQLite for the index.${C1}\n${C2}\n\n- Two options${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows('plan.md'), ['Two options', "We'll use Postgres for the index."], 'the original, not the new text')

  // Resolving deletes the thread: its memory goes too. The same comment added again starts over.
  write('plan.md', `# Plan\n\nIntro. We'll use SQLite for the index.\n\n- Two options${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows('plan.md'), ['Two options'])
  write('plan.md', `# Plan\n\nIntro. We'll use SQLite for the index.${C1}\n\n- Two options${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows('plan.md'), ['Two options', "We'll use SQLite for the index."])
})

test('a rebuilt index takes the text as it is then; the note file is never touched', () => {
  const { dir, notesDir, write, open } = setup()
  write('plan.md', `We'll use Postgres.${C1}\n`)
  const first = open()
  write('plan.md', `We'll use SQLite.${C1}\n`)
  first.indexer.scan()
  assert.deepEqual(first.rows('plan.md'), ["We'll use Postgres."])
  first.db.close()
  rmSync(join(dir, 'index.db'))
  const rebuilt = open()
  assert.deepEqual(rebuilt.rows('plan.md'), ["We'll use SQLite."])
  assert.equal(readFileSync(join(notesDir, 'plan.md'), 'utf8'), `We'll use SQLite.${C1}\n`)
})

test('moving or renaming a note keeps its threads\' original text', async () => {
  const { dir, notesDir, write, open } = setup()
  write('plan.md', `We'll use Postgres.${C1}\n`)
  const { db, indexer, rows } = open()
  write('plan.md', `We'll use SQLite.${C1}\n`)
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  await notes.move('plan.md', 'archive/roadmap.md', { actor: me })
  assert.deepEqual(rows('archive/roadmap.md'), ["We'll use Postgres."])
  assert.deepEqual(rows('plan.md'), [])
  assert.equal((db.prepare('select count(*) n from comment_anchors').get() as { n: number }).n, 1, 'nothing left behind')
})

test('GET /api/note/comments: the original text and whether it changed', async () => {
  const { notesDir, runtime, admin } = await appSetup()
  const path = 'Plan comentado.md'
  const file = join(notesDir, path)
  writeFileSync(file, `Intro. We'll use Postgres for the index.${C1}\n\nA general remark.\n\n${C3}\n`)
  runtime.rescan({})
  const r1 = await admin('GET', `/api/note/comments?path=${encodeURIComponent(path)}`)
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.body.threads.map((t: any) => [t.original, t.changed]), [["We'll use Postgres for the index.", false], ['', false]])
  assert.equal(r1.body.threads[0].id, `${AUTHOR}|2026-09-24T08:12Z|no, use SQLite|0`)

  // Reflowing or spacing is not a change; rewording is.
  writeFileSync(file, `Intro.  We'll  use \tPostgres for the index. ${C1}\n\nA general remark.\n\n${C3}\n`)
  runtime.rescan({})
  assert.deepEqual((await admin('GET', `/api/note/comments?path=${encodeURIComponent(path)}`)).body.threads.map((t: any) => t.changed), [false, false])
  writeFileSync(file, `Intro. We'll not use Postgres for the index, ever.${C1}\n\nA general remark.\n\n${C3}\n`)
  runtime.rescan({})
  const r2 = await admin('GET', `/api/note/comments?path=${encodeURIComponent(path)}`)
  assert.deepEqual(r2.body.threads.map((t: any) => [t.original, t.changed]), [["We'll use Postgres for the index.", true], ['', false]])

  assert.equal((await admin('GET', '/api/note/comments?path=nope.md')).status, 404)
})
