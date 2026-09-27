// A note open in an editor that another tool renames on disk (D-031.4): the
// hub follows the file instead of taking the note as deleted (D-022). The
// editors reopen it at the new path, what was typed meanwhile ends up there
// once, and the old path is never written again. When the hub can't tell
// it's the same note (no uid, and the text changed), it stays as deleted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatter } from '@thoth/core'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Client, type Srv } from './_collab.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** Lines typed or written to find again: words no other text has. */
const MARK = {
  afterMove: m.aUniqueWord(),
  changed: m.aUniqueWord(),
  flushed: m.aUniqueWord(),
  keptAside: m.aUniqueWord(),
  otherTool: m.aUniqueWord(),
  pending: m.aUniqueWord(),
  sent: m.aUniqueWord(),
  typed: m.aUniqueWord(),
}

const NOTE = 'hogar/Proxy.md'
// The vault's note, renamed on disk (the new name is the mother's).
const TO = m.aNotePath('hogar')

const once = (text: string, line: string) => text.split('\n').filter((l) => l === line).length === 1

/** The stateless messages an editor gets, by type. */
function listen(c: Client) {
  const got: { type: string; to?: string; external?: boolean }[] = []
  c.provider.on('stateless', ({ payload }: { payload: string }) => got.push(JSON.parse(payload)))
  return got
}

async function alerts(srv: Srv, cookie: string) {
  return (await api(srv, cookie, 'GET', '/api/alerts')).body.alerts as { code: string; path?: string; moves?: { from: string; to: string }[]; links?: number }[]
}

/**
 * Two editors type, the file is renamed on disk while one of them keeps
 * typing, and both follow it. `uid`: the note has one (it's flushed first,
 * which adds it) and the other tool also edits it on the way; otherwise the
 * rename happens before any flush, and only the identical text proves it.
 */
async function renamedWhileTyping(uid: boolean) {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const from = join(notes, NOTE)
  const to = join(notes, TO)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const b = await connect(srv, cookie, NOTE)
    const ma = listen(a)
    const mb = listen(b)
    const lines: string[] = []
    if (uid) {
      for (let i = 0; i < 5; i++) { typeLine(a, `${MARK.flushed}-${i}`); lines.push(`${MARK.flushed}-${i}`) }
      await waitFor(() => readFileSync(from, 'utf8').includes(`${MARK.flushed}-4\n`), 'flush')
      assert.ok(readFrontmatter(readFileSync(from, 'utf8')).data.uid, 'flushing gave it a uid')
    }
    // Sent to the hub, not yet flushed (1 s debounce).
    for (let i = 0; i < 5; i++) { typeLine(b, `${MARK.sent}-${i}`); lines.push(`${MARK.sent}-${i}`) }
    await waitFor(() => b.provider.unsyncedChanges === 0, 'sent')
    if (!uid) assert.ok(!readFrontmatter(readFileSync(from, 'utf8')).data.uid, 'not flushed yet: no uid')
    // From here, each acknowledgement confirms one of a's lines.
    await waitFor(() => a.provider.unsyncedChanges === 0, 'a synced')
    let acks = 0
    const decrement = a.provider.decrementUnsyncedChanges.bind(a.provider)
    a.provider.decrementUnsyncedChanges = () => { acks++; decrement() }
    const typed: string[] = []
    const moved = () => ma.some((m) => m.type === 'thoth:moved') && mb.some((m) => m.type === 'thoth:moved')
    let renamed = false
    const typing = (async () => {
      for (let n = 0; !moved() && n < 500; n++) {
        typeLine(a, `${MARK.typed}-${n}.`)
        typed.push(`${MARK.typed}-${n}.`)
        if (n === 10) {
          // Another tool renames it (and, with a uid, edits it on the way).
          renameSync(from, to)
          if (uid) writeFileSync(to, readFileSync(to, 'utf8') + `${MARK.otherTool}\n`)
          renamed = true
        }
        await sleep(20)
      }
    })()
    await waitFor(moved, 'both editors told it moved', 15000)
    await typing
    assert.ok(renamed)
    const msg = ma.find((m) => m.type === 'thoth:moved')!
    assert.deepEqual(msg, { type: 'thoth:moved', from: NOTE, to: TO, external: true })
    assert.ok(!ma.some((m) => m.type === 'thoth:deleted-externally'), 'never announced as deleted')
    a.close(); b.close()
    const acked = typed.slice(0, acks)
    assert.ok(acked.length > 10, `typing went on after the rename (${acked.length} acknowledged)`)
    if (uid) lines.push(MARK.otherTool)
    // What arrived just before the editors were closed is written right after telling them.
    await waitFor(() => { const t = readFileSync(to, 'utf8'); return [...lines, ...acked].every((l) => t.includes(`${l}\n`)) }, 'everything acknowledged reaches the new path')
    const text = readFileSync(to, 'utf8')
    for (const line of [...lines, ...acked]) assert.ok(once(text, line), `${line} exactly once at the new path:\n${text}`)
    for (const line of typed) assert.ok(text.split('\n').filter((l) => l === line).length <= 1, `${line} repeated`)
    // Reopened at the new path, it's the same text and editing goes on there.
    const c = await connect(srv, cookie, TO)
    assert.equal(c.text(), text)
    typeLine(c, MARK.afterMove)
    await waitFor(() => readFileSync(to, 'utf8').includes(`${MARK.afterMove}\n`), 'flushed at the new path')
    await sleep(1500)
    assert.ok(!existsSync(from), 'the old path is not recreated')
    const list = await alerts(srv, cookie)
    assert.deepEqual(list.filter((x) => x.code === 'orphaned_note'), [], 'no copy pending a decision')
    const move = list.find((x) => x.code === 'external_move')
    assert.deepEqual(move?.moves, [{ from: NOTE, to: TO }], 'the alert offers to update the links')
    assert.ok(move!.links! > 0)
  } finally { closeAll(); await srv.stop() }
}

test('renamed on disk while typing, with a uid (edited on the way too): the editors follow, nothing lost or repeated', () => renamedWhileTyping(true))

test('renamed on disk while typing, without a uid (identical text): the editors follow, nothing lost or repeated', () => renamedWhileTyping(false))

test('renamed and changed on disk without a uid: not provably the same note, so it stays as deleted outside thoth', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const from = join(notes, NOTE)
  const to = join(notes, TO)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const got = listen(a)
    const changed = readFileSync(from, 'utf8') + `${MARK.changed}\n`
    writeFileSync(to, changed)
    rmSync(from)
    await waitFor(() => got.some((m) => m.type === 'thoth:deleted-externally'), 'deleted notice', 15000)
    assert.ok(!got.some((m) => m.type === 'thoth:moved'))
    typeLine(a, MARK.keptAside)
    await sleep(1500)
    assert.ok(!existsSync(from), 'not recreated')
    assert.equal(readFileSync(to, 'utf8'), changed, 'the other note is left alone')
    assert.deepEqual((await alerts(srv, cookie)).filter((x) => x.code === 'orphaned_note').map((x) => x.path), [NOTE])
  } finally { closeAll(); await srv.stop() }
})

test('moved with the server down and edits pending in the log: they land at the new path', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const from = join(notes, NOTE)
  const to = join(notes, TO)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 5; i++) typeLine(a, `${MARK.pending}-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL') // before the flush
    renameSync(from, to) // no uid yet: the same text
    srv = await startServer(env)
    await waitFor(() => existsSync(to) && readFileSync(to, 'utf8').includes(`${MARK.pending}-4\n`), 'the pending edits reach the new path')
    const text = readFileSync(to, 'utf8')
    for (let i = 0; i < 5; i++) assert.ok(once(text, `${MARK.pending}-${i}`), `${MARK.pending}-${i} exactly once`)
    await sleep(1500)
    assert.ok(!existsSync(from), 'the old path is not recreated')
    const cookie2 = await login(srv)
    assert.deepEqual((await alerts(srv, cookie2)).filter((x) => x.code === 'orphaned_note'), [], 'no copy pending a decision')
  } finally { closeAll(); await srv.stop() }
})
