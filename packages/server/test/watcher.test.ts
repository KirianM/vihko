import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Indexer, Watcher, openIndex } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, what: string, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`timeout: ${what}`)
    await sleep(25)
  }
}

test('the watcher indexes additions, changes, removals and renamed folders', async () => {
  const dir = tempDir('vihko-watch-')
  const notes = join(dir, 'notes')
  const [a, b, name] = [m.aFolder(), m.aFolder(), `${m.aTitle()}.md`]
  const [title, retitled] = [m.aHeading(), m.aHeading()]
  mkdirSync(join(notes, a), { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir: notes, db })
  indexer.scan()
  const w = new Watcher({ notesDir: notes, indexer, db, debounceMs: 50, rescanMs: 60_000 })
  w.start()
  const has = (p: string) => !!db.prepare('select 1 from notes where path = ?').get(p)
  const titleOf = (p: string) => (db.prepare('select title from notes where path = ?').get(p) as { title: string } | undefined)?.title
  try {
    writeFileSync(join(notes, a, name), `# ${title}\n`)
    await waitFor(() => has(`${a}/${name}`), 'added')
    writeFileSync(join(notes, a, name), `# ${retitled}\n`)
    await waitFor(() => titleOf(`${a}/${name}`) === retitled, 'changed')
    renameSync(join(notes, a), join(notes, b))
    await waitFor(() => has(`${b}/${name}`) && !has(`${a}/${name}`), 'renamed folder')
    rmSync(join(notes, b, name))
    await waitFor(() => !has(`${b}/${name}`), 'removed')
    // An editor's swap file: hidden, never a note.
    const swap = `${b}/.${name}.swp`
    writeFileSync(join(notes, swap), m.aSentence())
    await sleep(200)
    assert.ok(!has(swap))
  } finally {
    w.stop()
    db.close()
  }
})

test('the periodic rescan picks up changes the watcher misses', async () => {
  const dir = tempDir('vihko-rescan-')
  const notes = join(dir, 'notes')
  mkdirSync(notes)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir: notes, db })
  indexer.scan()
  // No start(): only the rescan, like a change made from another machine over NFS.
  const w = new Watcher({ notesDir: notes, indexer, db, rescanMs: 100 })
  const outside = m.aNotePath()
  writeFileSync(join(notes, outside), `# ${m.aHeading()}\n`)
  w.rescan()
  assert.ok(db.prepare('select 1 from notes where path = ?').get(outside))
  db.close()
})
