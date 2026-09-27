// Moves made outside thoth (D-031.4): a note leaving one path and entering
// another in the same batch (or a few seconds apart) with the same `uid`, or
// the same content without one, is the same note. Never a guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Indexer, NoteService, matchMoves, openIndex, type DetectedMove, type MoveCandidate } from '@thoth/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const USER_ID = m.faker.string.ulid()

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const UID = m.faker.string.ulid()

// --- Pairing -------------------------------------------------------------------

const c = (path: string, hash: string, uid: string | null = null, extra: Partial<MoveCandidate> = {}): MoveCandidate => ({ path, hash, uid, ...extra })

test('pairing: by uid (even if the text changed), then by identical content among notes without uid', () => {
  assert.deepEqual(matchMoves([c('a.md', 'h1', 'U')], [c('b.md', 'h2', 'U')]).map((m) => [m.from.path, m.to.path, m.by]), [['a.md', 'b.md', 'uid']])
  assert.deepEqual(matchMoves([c('a.md', 'h1')], [c('b.md', 'h1')]).map((m) => [m.from.path, m.to.path, m.by]), [['a.md', 'b.md', 'hash']])
  // A rename that also changes the text of a note without uid: not a move (documented).
  assert.deepEqual(matchMoves([c('a.md', 'h1')], [c('b.md', 'h2')]), [])
})

test('pairing: never a guess when several notes could be the one', () => {
  // Two removed with the same content, one added: which one moved?
  assert.deepEqual(matchMoves([c('a.md', 'h'), c('b.md', 'h')], [c('c.md', 'h')]), [])
  // One removed, two added with its content (a copy and the move).
  assert.deepEqual(matchMoves([c('a.md', 'h')], [c('b.md', 'h'), c('c.md', 'h')]), [])
  // The same uid twice (a copy made by hand): not guessed by uid, nor by its content.
  assert.deepEqual(matchMoves([c('a.md', 'h', 'U'), c('b.md', 'h', 'U')], [c('c.md', 'h', 'U')]), [])
  // Empty notes all look the same.
  assert.deepEqual(matchMoves([c('a.md', 'h')], [c('b.md', 'h', null, { blank: true })]), [])
  // Two from earlier batches were already weighed together.
  assert.deepEqual(matchMoves([c('a.md', 'h', null, { recent: true })], [c('b.md', 'h', null, { recent: true })]), [])
  assert.equal(matchMoves([c('a.md', 'h', null, { recent: true })], [c('b.md', 'h')]).length, 1)
})

// --- The indexer ---------------------------------------------------------------
// Over a copy of the test vault; the notes the tests add and move are the mother's.

function indexed(opts: { now?: () => number } = {}) {
  const dir = tempDir('thoth-xmove-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const moves: DetectedMove[][] = []
  const indexer = new Indexer({ notesDir, db, now: opts.now, onMoves: (m) => moves.push(m) })
  indexer.scan()
  const has = (p: string) => !!db.prepare('select 1 from notes where path = ?').get(p)
  const put = (p: string, text: string) => { mkdirSync(join(notesDir, p, '..'), { recursive: true }); writeFileSync(join(notesDir, p), text) }
  const mv = (a: string, b: string) => { mkdirSync(join(notesDir, b, '..'), { recursive: true }); renameSync(join(notesDir, a), join(notesDir, b)) }
  return { dir, notesDir, db, indexer, moves, has, put, mv }
}

/** A note of its own: a heading and a text no other note has (moves without uid pair by content). */
const note = () => `# ${m.aHeading()}\n\n${m.aUniqueWord()} ${m.aSentence()}\n`

test('a scan detects a rename by uid and by content, and keeps it out of added and removed', () => {
  const { indexer, moves, put, mv, has } = indexed()
  const [dir, other] = [m.aFolder(), m.aFolder()]
  const [withUid, withoutUid] = [m.aNotePath(dir), m.aNotePath(dir)]
  const [renamed, moved] = [m.aNotePath(other), withoutUid.replace(dir, other)]
  put(withUid, `---\nuid: ${UID}\n---\n${note()}`)
  put(withoutUid, note())
  indexer.scan()
  mv(withUid, renamed)
  writeFileSync(join(indexer['opts'].notesDir, renamed), `---\nuid: ${UID}\n---\n${note()}`)
  mv(withoutUid, moved)
  const r = indexer.scan()
  const byFrom = (a: { from: string }, b: { from: string }) => a.from.localeCompare(b.from)
  assert.deepEqual(r.moved.sort(byFrom), [
    { from: withUid, to: renamed, by: 'uid' },
    { from: withoutUid, to: moved, by: 'hash' },
  ].sort(byFrom))
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
  assert.ok(has(moved) && !has(withoutUid))
  assert.equal(moves.length, 1, 'announced once, as one batch')
})

test('not detected: a rename that changes the text of a note without uid, and a content that isn\'t unique', () => {
  const { indexer, put, mv } = indexed()
  const dir = m.aFolder()
  const [edited, twin1, twin2] = [m.aNotePath(dir), m.aNotePath(dir), m.aNotePath(dir)]
  const [editedTo, twin3] = [m.aNotePath(dir), m.aNotePath(dir)]
  const text = note()
  const twins = note()
  put(edited, text)
  put(twin1, twins)
  put(twin2, twins)
  indexer.scan()
  mv(edited, editedTo)
  writeFileSync(join(indexer['opts'].notesDir, editedTo), `${text}${m.aSentence()}\n`)
  mv(twin1, twin3)
  const r = indexer.scan()
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.removed.sort(), [edited, twin1].sort())
  assert.deepEqual(r.added.sort(), [editedTo, twin3].sort())
})

test('watcher batches: a removal and an addition a moment apart pair within the window, not after it', () => {
  let now = 1_000_000
  const { indexer, put, mv, moves } = indexed({ now: () => now })
  const dir = m.aFolder()
  const [late, lateTo, far, farTo] = [m.aNotePath(dir), m.aNotePath(dir), m.aNotePath(dir), m.aNotePath(dir)]
  put(late, note())
  put(far, note())
  indexer.scan()
  // A tool that writes the copy first and removes the original later.
  mv(late, lateTo)
  let r = indexer.indexPaths([lateTo], { detectMoves: true })
  assert.deepEqual(r.added, [lateTo])
  now += 2000
  r = indexer.indexPaths([late], { detectMoves: true })
  assert.deepEqual(r.moved, [{ from: late, to: lateTo, by: 'hash' }])
  assert.deepEqual(r.removed, [])
  // Removed, and the copy shows up after the window: two unrelated events.
  mv(far, farTo)
  r = indexer.indexPaths([far], { detectMoves: true })
  assert.deepEqual(r.removed, [far])
  now += 6000
  r = indexer.indexPaths([farTo], { detectMoves: true })
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.added, [farTo])
  assert.equal(moves.length, 1)
})

test("thoth's own writes are not someone else's move", async () => {
  const { dir, notesDir, db, indexer, moves } = indexed()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const [archive, infra] = [m.aFolder(), m.aFolder()]
  await notes.move('proyectos/thoth/Plan.md', `${archive}/Plan.md`, { actor: { kind: 'user', id: USER_ID } })
  await notes.moveFolder('hogar', infra, { actor: { kind: 'user', id: USER_ID } })
  // What the watcher would see afterwards changes nothing.
  indexer.indexPaths(['proyectos/thoth/Plan.md', `${archive}/Plan.md`, 'hogar/Proxy.md', `${infra}/Proxy.md`], { detectMoves: true })
  indexer.scan()
  assert.deepEqual(moves, [])
})

test('a folder renamed with another tool is a move of its notes, not a mass deletion', () => {
  const dir = tempDir('thoth-xmove-mass-')
  const notesDir = join(dir, 'notes')
  const [from, to] = [m.aFolder(), m.aFolder()]
  mkdirSync(join(notesDir, from), { recursive: true })
  for (let i = 0; i < 30; i++) writeFileSync(join(notesDir, m.aNotePath(from)), note())
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  renameSync(join(notesDir, from), join(notesDir, to))
  const r = indexer.scan()
  assert.equal(r.aborted, null)
  assert.equal(r.moved.length, 30)
  assert.deepEqual(r.removed, [])
})
