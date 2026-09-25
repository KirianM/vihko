// Moves made outside thoth (D-031.4): a note leaving one path and entering
// another in the same batch (or a few seconds apart) with the same `uid`, or
// the same content without one, is the same note. Never a guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Indexer, NoteService, matchMoves, openIndex, type DetectedMove, type MoveCandidate } from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const UID = '01J8Z6S6ZK3R2V4TQ9WQ4M3N7B'

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

function indexed(opts: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-xmove-'))
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

test('a scan detects a rename by uid and by content, and keeps it out of added and removed', () => {
  const { indexer, moves, put, mv, has } = indexed()
  put('ux/con-uid.md', `---\nuid: ${UID}\n---\n# Con uid\n`)
  put('ux/sin-uid.md', '# Sin uid\n\nTexto único.\n')
  indexer.scan()
  mv('ux/con-uid.md', 'otra/con-uid-renombrada.md')
  writeFileSync(join(indexer['opts'].notesDir, 'otra/con-uid-renombrada.md'), `---\nuid: ${UID}\n---\n# Con uid, y retocada\n`)
  mv('ux/sin-uid.md', 'otra/sin-uid.md')
  const r = indexer.scan()
  assert.deepEqual(r.moved.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: 'ux/con-uid.md', to: 'otra/con-uid-renombrada.md', by: 'uid' },
    { from: 'ux/sin-uid.md', to: 'otra/sin-uid.md', by: 'hash' },
  ])
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
  assert.ok(has('otra/sin-uid.md') && !has('ux/sin-uid.md'))
  assert.equal(moves.length, 1, 'announced once, as one batch')
})

test('not detected: a rename that changes the text of a note without uid, and a content that isn\'t unique', () => {
  const { indexer, put, mv } = indexed()
  put('ux/a.md', '# A\n\nUno.\n')
  put('ux/gemela-1.md', '# Gemela\n')
  put('ux/gemela-2.md', '# Gemela\n')
  indexer.scan()
  mv('ux/a.md', 'ux/b.md')
  writeFileSync(join(indexer['opts'].notesDir, 'ux/b.md'), '# A\n\nUno, retocado.\n')
  mv('ux/gemela-1.md', 'ux/gemela-3.md')
  const r = indexer.scan()
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.removed.sort(), ['ux/a.md', 'ux/gemela-1.md'])
  assert.deepEqual(r.added.sort(), ['ux/b.md', 'ux/gemela-3.md'])
})

test('watcher batches: a removal and an addition a moment apart pair within the window, not after it', () => {
  let now = 1_000_000
  const { indexer, put, mv, moves } = indexed({ now: () => now })
  put('ux/tarde.md', '# Tarde\n\nSe mueve en dos pasos.\n')
  put('ux/lejos.md', '# Lejos\n\nTambién.\n')
  indexer.scan()
  // A tool that writes the copy first and removes the original later.
  mv('ux/tarde.md', 'ux/tarde-2.md')
  let r = indexer.indexPaths(['ux/tarde-2.md'], { detectMoves: true })
  assert.deepEqual(r.added, ['ux/tarde-2.md'])
  now += 2000
  r = indexer.indexPaths(['ux/tarde.md'], { detectMoves: true })
  assert.deepEqual(r.moved, [{ from: 'ux/tarde.md', to: 'ux/tarde-2.md', by: 'hash' }])
  assert.deepEqual(r.removed, [])
  // Removed, and the copy shows up after the window: two unrelated events.
  mv('ux/lejos.md', 'ux/lejos-2.md')
  r = indexer.indexPaths(['ux/lejos.md'], { detectMoves: true })
  assert.deepEqual(r.removed, ['ux/lejos.md'])
  now += 6000
  r = indexer.indexPaths(['ux/lejos-2.md'], { detectMoves: true })
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.added, ['ux/lejos-2.md'])
  assert.equal(moves.length, 1)
})

test("thoth's own writes are not someone else's move", async () => {
  const { dir, notesDir, db, indexer, moves } = indexed()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  await notes.move('proyectos/thoth/Plan.md', 'archivo/Plan.md', { actor: { kind: 'user', id: 'noa' } })
  await notes.moveFolder('hogar', 'infra', { actor: { kind: 'user', id: 'noa' } })
  // What the watcher would see afterwards changes nothing.
  indexer.indexPaths(['proyectos/thoth/Plan.md', 'archivo/Plan.md', 'hogar/Proxy.md', 'infra/Proxy.md'], { detectMoves: true })
  indexer.scan()
  assert.deepEqual(moves, [])
})

test('a folder renamed with another tool is a move of its notes, not a mass deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-xmove-mass-'))
  const notesDir = join(dir, 'notes')
  mkdirSync(join(notesDir, 'todo'), { recursive: true })
  for (let i = 0; i < 30; i++) writeFileSync(join(notesDir, `todo/nota-${i}.md`), `# Nota ${i}\n`)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  renameSync(join(notesDir, 'todo'), join(notesDir, 'todas'))
  const r = indexer.scan()
  assert.equal(r.aborted, null)
  assert.equal(r.moved.length, 30)
  assert.deepEqual(r.removed, [])
})
