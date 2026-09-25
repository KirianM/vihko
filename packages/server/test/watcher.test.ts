import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Indexer, Watcher, openIndex } from '@thoth/server'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, what: string, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`timeout: ${what}`)
    await sleep(25)
  }
}

test('the watcher indexes additions, changes, removals and renamed folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-watch-'))
  const notes = join(dir, 'notes')
  mkdirSync(join(notes, 'a'), { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir: notes, db })
  indexer.scan()
  const w = new Watcher({ notesDir: notes, indexer, db, debounceMs: 50, rescanMs: 60_000 })
  w.start()
  const has = (p: string) => !!db.prepare('select 1 from notes where path = ?').get(p)
  const title = (p: string) => (db.prepare('select title from notes where path = ?').get(p) as { title: string } | undefined)?.title
  try {
    writeFileSync(join(notes, 'a/uno.md'), '# Uno\n')
    await waitFor(() => has('a/uno.md'), 'added')
    writeFileSync(join(notes, 'a/uno.md'), '# Uno bis\n')
    await waitFor(() => title('a/uno.md') === 'Uno bis', 'changed')
    renameSync(join(notes, 'a'), join(notes, 'b'))
    await waitFor(() => has('b/uno.md') && !has('a/uno.md'), 'renamed folder')
    rmSync(join(notes, 'b/uno.md'))
    await waitFor(() => !has('b/uno.md'), 'removed')
    writeFileSync(join(notes, 'b/.temporal.md.swp'), 'x')
    await sleep(200)
    assert.ok(!has('b/.temporal.md.swp'))
  } finally {
    w.stop()
    db.close()
  }
})

test('the periodic rescan picks up changes the watcher misses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-rescan-'))
  const notes = join(dir, 'notes')
  mkdirSync(notes)
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir: notes, db })
  indexer.scan()
  // No start(): only the rescan, like a change made from another machine over NFS.
  const w = new Watcher({ notesDir: notes, indexer, db, rescanMs: 100 })
  writeFileSync(join(notes, 'externa.md'), '# Externa\n')
  w.rescan()
  assert.ok(db.prepare('select 1 from notes where path = ?').get('externa.md'))
  db.close()
})
