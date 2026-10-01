// «The text has changed»: the index remembers, per comment thread,
// the text it was anchored to when first seen, and the API says which threads'
// text differs now. A rebuild forgets it: the text then becomes the baseline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Indexer, NoteService, openIndex, type Actor } from '@vihko/server'
import { setup as appSetup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

// Comments' authors (usernames); the actor who writes is a user id.
const m = mother(import.meta.url)
const AUTHOR = m.aUsername()
const REPLIER = m.aUsername()

const me: Actor = { kind: 'user', id: m.faker.string.ulid() }
/** A thread (a comment and its reply) and a comment of its own, whatever they say. */
const C1_TEXT = m.aComment()
const C1 = `<!-- @${AUTHOR} 2026-09-24T08:12Z · ${C1_TEXT} -->`
const C2 = `<!-- @${REPLIER} 2026-09-24T09:00Z · ↳ ${m.aComment()} -->`
const C3 = `<!-- @${REPLIER} 2026-09-24T09:30Z · ${m.aComment()} -->`
/** The sentence a thread is on, then reworded; a list item; a sentence before them. */
const FIRST = m.aSentence()
const REWORDED = m.aSentence()
const ITEM = m.aHeading()
const INTRO = m.aSentence()
const HEADING = m.aHeading()
/** The originals as the index lists them (by text, as SQLite compares it). */
const sorted = (...texts: string[]) => [...texts].sort()

function setup() {
  const dir = tempDir('vihko-comment-anchors-')
  const notesDir = join(dir, 'notes')
  mkdirSync(notesDir, { recursive: true })
  let n = 0
  const write = (p: string, text: string) => {
    mkdirSync(join(notesDir, p, '..'), { recursive: true })
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
  const note = m.aNotePath()
  write(note, `# ${HEADING}\n\n${INTRO} ${FIRST}${C1}\n${C2}\n\n- ${ITEM}${C3}\n`)
  const { indexer, rows } = open()
  assert.deepEqual(rows(note), sorted(ITEM, FIRST))

  write(note, `# ${HEADING}\n\n${INTRO} ${REWORDED}${C1}\n${C2}\n\n- ${ITEM}${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows(note), sorted(ITEM, FIRST), 'the original, not the new text')

  // Resolving deletes the thread: its memory goes too. The same comment added again starts over.
  write(note, `# ${HEADING}\n\n${INTRO} ${REWORDED}\n\n- ${ITEM}${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows(note), [ITEM])
  write(note, `# ${HEADING}\n\n${INTRO} ${REWORDED}${C1}\n\n- ${ITEM}${C3}\n`)
  indexer.scan()
  assert.deepEqual(rows(note), sorted(ITEM, REWORDED))
})

test('a rebuilt index takes the text as it is then; the note file is never touched', () => {
  const { dir, notesDir, write, open } = setup()
  const note = m.aNotePath()
  write(note, `${FIRST}${C1}\n`)
  const first = open()
  write(note, `${REWORDED}${C1}\n`)
  first.indexer.scan()
  assert.deepEqual(first.rows(note), [FIRST])
  first.db.close()
  rmSync(join(dir, 'index.db'))
  const rebuilt = open()
  assert.deepEqual(rebuilt.rows(note), [REWORDED])
  assert.equal(readFileSync(join(notesDir, note), 'utf8'), `${REWORDED}${C1}\n`)
})

test('moving or renaming a note keeps its threads\' original text', async () => {
  const { dir, notesDir, write, open } = setup()
  const [from, to] = [m.aNotePath(), m.aNotePath(m.aFolder())]
  write(from, `${FIRST}${C1}\n`)
  const { db, indexer, rows } = open()
  write(from, `${REWORDED}${C1}\n`)
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  await notes.move(from, to, { actor: me })
  assert.deepEqual(rows(to), [FIRST])
  assert.deepEqual(rows(from), [])
  assert.equal((db.prepare('select count(*) n from comment_anchors').get() as { n: number }).n, 1, 'nothing left behind')
})

test('GET /api/note/comments: the original text and whether it changed', async () => {
  const { notesDir, runtime, admin } = await appSetup()
  const path = m.aNotePath(inShared(''))
  const file = join(notesDir, path)
  const remark = m.aSentence()
  const comments = async () => (await admin('GET', `/api/note/comments?path=${encodeURIComponent(path)}`)).body
  writeFileSync(file, `${INTRO} ${FIRST}${C1}\n\n${remark}\n\n${C3}\n`)
  runtime.rescan({})
  const r1 = await admin('GET', `/api/note/comments?path=${encodeURIComponent(path)}`)
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.body.threads.map((t: any) => [t.original, t.changed]), [[FIRST, false], ['', false]])
  assert.equal(r1.body.threads[0].id, `${AUTHOR}|2026-09-24T08:12Z|${C1_TEXT}|0`)

  // Reflowing or spacing is not a change; rewording is.
  writeFileSync(file, `${INTRO}  ${FIRST.replaceAll(' ', '  ').replace('  ', ' \t')} ${C1}\n\n${remark}\n\n${C3}\n`)
  runtime.rescan({})
  assert.deepEqual((await comments()).threads.map((t: any) => t.changed), [false, false])
  writeFileSync(file, `${INTRO} ${FIRST.replace(/\.$/, ` ${m.aWord()}.`)}${C1}\n\n${remark}\n\n${C3}\n`)
  runtime.rescan({})
  assert.deepEqual((await comments()).threads.map((t: any) => [t.original, t.changed]), [[FIRST, true], ['', false]])

  assert.equal((await admin('GET', `/api/note/comments?path=${encodeURIComponent(m.aNotePath(inShared('')))}`)).status, 404)
})
