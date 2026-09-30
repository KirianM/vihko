// What the hub keeps of a closed note under its path (its saved editor state,
// `.ystate`, and a recovery log, `.ylog`) follows the note when it's renamed
// or moved, goes when it's deleted, and a state whose note no longer exists
// is removed on startup; a copy pending a decision (D-022) is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Srv } from './_collab.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

// Notes of testdata/vault: the tests open, rename and delete them.
const NOTE = inShared('hogar/Proxy.md')
const OTHER = inShared('hogar/Red.md')
const THIRD = inShared('hogar/Firewall.md')

/** The name the hub gives a note's files (hub.ts, logBase): its path URL-encoded, or `#` and its SHA-256 when that's too long. */
function savedName(path: string): string {
  const encoded = encodeURIComponent(path)
  return Buffer.byteLength(encoded) <= 240 ? encoded : `#${createHash('sha256').update(path).digest('hex')}`
}
const collab = (srv: Srv) => join(srv.env.VIHKO_STATE_DIR!, 'collab')
const saved = (srv: Srv, path: string, ext: '.ystate' | '.ylog') => join(collab(srv), savedName(path) + ext)
/** The hub's files, sorted. */
const files = (srv: Srv) => readdirSync(collab(srv)).sort()

/** A deep path whose files are named by a hash (URL-encoded, well past a file name's 255 bytes). */
function longFolder(): string {
  let dir = ''
  while (Buffer.byteLength(encodeURIComponent(dir)) <= 300) dir = `${dir ? `${dir}/` : ''}${m.aTitle()} ${m.aTitle()}`
  return dir
}

/** Opens the note, types a line (so it's written with a uid) and closes it: the hub saves its state. */
async function openAndClose(srv: Srv, cookie: string, notes: string, path: string) {
  const c = await connect(srv, cookie, path)
  const line = m.aUniqueWord()
  typeLine(c, line)
  await waitFor(() => readFileSync(join(notes, path), 'utf8').includes(`${line}\n`), `flush of ${path}`)
  c.close()
  await waitFor(() => existsSync(saved(srv, path, '.ystate')) && !existsSync(saved(srv, path, '.ylog')), `${path} closed`)
}

test('a closed note renamed or deleted from vihko: its saved state follows it or goes, and none is left under an old path', async () => {
  const { notes, env } = makeDirs()
  const folder = inShared(longFolder())
  const long = `${folder}/${m.aTitle()}.md`
  mkdirSync(join(notes, folder), { recursive: true })
  writeFileSync(join(notes, long), `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  let srv = await startServer(env)
  const renamed = inShared(`hogar/${m.aTitle()}.md`)
  const longRenamed = `${folder}/${m.aTitle()}.md`
  try {
    const cookie = await login(srv)
    for (const path of [NOTE, long, OTHER]) await openAndClose(srv, cookie, notes, path)
    for (const [from, to] of [[NOTE, renamed], [long, longRenamed]] as const) {
      const r = await api(srv, cookie, 'POST', '/api/note/move', { from, to })
      assert.equal(r.status, 200, JSON.stringify(r.body))
    }
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(OTHER)}`)
    assert.equal(del.status, 200)
    assert.deepEqual(files(srv), [savedName(renamed), savedName(longRenamed)].map((n) => `${n}.ystate`).sort())
    // A hash names the long one: the path inside is the new one.
    assert.ok(readFileSync(saved(srv, longRenamed, '.ystate')).includes(Buffer.from(longRenamed)))
    assert.ok(!readFileSync(saved(srv, longRenamed, '.ystate')).includes(Buffer.from(long)))

    // On the next start both still match their file, and the notes reopen from them.
    await srv.stop()
    srv = await startServer(env)
    const out = () => srv.out.join('')
    assert.ok(out().includes('saved editor states: 2 of 2 match their file'), out())
    assert.ok(!out().includes('whose note no longer exists'), out())
    const cookie2 = await login(srv)
    for (const path of [renamed, longRenamed]) {
      const c = await connect(srv, cookie2, path)
      assert.equal(c.text(), readFileSync(join(notes, path), 'utf8'))
      c.close()
    }
    assert.ok(!out().includes('new generation'), out())
  } finally { closeAll(); await srv.stop() }
})

test('a folder moved from vihko: the saved states of its closed notes follow them, and an open one leaves nothing behind', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const to = inShared(m.aFolder())
  const moved = (p: string) => `${to}/${p.slice(inShared('hogar/').length)}`
  try {
    const cookie = await login(srv)
    for (const path of [NOTE, OTHER]) await openAndClose(srv, cookie, notes, path)
    const open = await connect(srv, cookie, THIRD)
    const r = await api(srv, cookie, 'POST', '/api/folder/move', { from: inShared('hogar'), to })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // The open one's document closes at its old path: its log goes with it.
    await waitFor(() => !existsSync(saved(srv, THIRD, '.ylog')), 'the open note closed at its old path')
    open.close()
    await sleep(500)
    assert.deepEqual(files(srv), [moved(NOTE), moved(OTHER)].map((p) => `${savedName(p)}.ystate`).sort())
  } finally { closeAll(); await srv.stop() }
})

test('a closed note moved outside vihko while it runs: its saved state follows it', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const to = inShared(`hogar/${m.aTitle()}.md`)
  try {
    await openAndClose(srv, await login(srv), notes, NOTE)
    renameSync(join(notes, NOTE), join(notes, to))
    await waitFor(() => existsSync(saved(srv, to, '.ystate')), 'the state followed the note', 15000)
    assert.deepEqual(files(srv), [`${savedName(to)}.ystate`])
  } finally { closeAll(); await srv.stop() }
})

test('on startup, saved states of notes that no longer exist are removed; a pending copy and a note in the trash keep theirs', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const pending = m.aUniqueWord()
  // States a version that didn't carry them left behind: the note is gone (one of them named by a hash, with its path inside).
  const gone = m.aNotePath(inShared(m.aFolder()))
  const goneLong = `${inShared(longFolder())}/${m.aTitle()}.md`
  try {
    const cookie = await login(srv)
    await openAndClose(srv, cookie, notes, NOTE)
    assert.equal((await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(OTHER)}`)).status, 200)
    // Killed with edits not yet written, and the note deleted while stopped: its copy waits in the log.
    const c = await connect(srv, cookie, THIRD)
    typeLine(c, pending)
    await waitFor(() => c.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    c.close()
    await srv.stop('SIGKILL')
    rmSync(join(notes, THIRD))
    assert.ok(existsSync(saved(srv, THIRD, '.ylog')))
    const state = saved(srv, NOTE, '.ystate')
    copyFileSync(state, saved(srv, gone, '.ystate'))
    const pathRecord = Buffer.alloc(5)
    pathRecord.write('P', 0, 'latin1')
    pathRecord.writeUInt32BE(Buffer.byteLength(goneLong), 1)
    writeFileSync(saved(srv, goneLong, '.ystate'), Buffer.concat([readFileSync(state), pathRecord, Buffer.from(goneLong)]))
    // One left behind for a note now in the trash: kept while it's there.
    copyFileSync(state, saved(srv, OTHER, '.ystate'))

    srv = await startServer(env)
    const out = srv.out.join('')
    assert.ok(out.includes('removed 2 saved editor state(s) whose note no longer exists'), out)
    assert.ok(!existsSync(saved(srv, gone, '.ystate')))
    assert.ok(!existsSync(saved(srv, goneLong, '.ystate')))
    assert.ok(existsSync(saved(srv, NOTE, '.ystate')))
    assert.ok(existsSync(saved(srv, OTHER, '.ystate')))
    // The pending copy is still there, and can be kept.
    assert.ok(existsSync(saved(srv, THIRD, '.ylog')))
    const cookie2 = await login(srv)
    const r = await api(srv, cookie2, 'POST', '/api/note/orphan', { path: THIRD, action: 'restore' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(readFileSync(join(notes, THIRD), 'utf8').includes(`${pending}\n`))
  } finally { closeAll(); await srv.stop() }
})
