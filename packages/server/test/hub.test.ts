import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { connect as tcp } from 'node:net'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { contentHash, readFrontmatter } from '@vihko/core'
import { MAX_WS_MESSAGE } from '@vihko/server'
import { NoteLink, type Lineage } from '../../web/src/editor/lineage.ts'
import { api, closeAll, connect, login, makeDirs, open, sleep, socket, startServer, typeLine, waitFor, type Client, type Srv } from './_collab.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** Lines typed or written to find again: words no other text has. */
const MARK = {
  after: m.aUniqueWord(),
  afterDelete: m.aUniqueWord(),
  afterMove: m.aUniqueWord(),
  afterTheFlush: m.aUniqueWord(),
  agent: m.aUniqueWord(),
  agentMark: m.aUniqueWord(),
  before: m.aUniqueWord(),
  beforeDelete: m.aUniqueWord(),
  beforeDrop: m.aUniqueWord(),
  external: m.aUniqueWord(),
  flushed: m.aUniqueWord(),
  lastLine: m.aUniqueWord(),
  line: m.aUniqueWord(),
  live: m.aUniqueWord(),
  newer: m.aUniqueWord(),
  offline: m.aUniqueWord(),
  offlineCut: m.aUniqueWord(),
  offlineRestart: m.aUniqueWord(),
  older: m.aUniqueWord(),
  other: m.aUniqueWord(),
  pending: m.aUniqueWord(),
  sent: m.aUniqueWord(),
  stillEditing: m.aUniqueWord(),
  unflushed: m.aUniqueWord(),
  unsent: m.aUniqueWord(),
}

const NOTE = inShared('hogar/Proxy.md')

/** Paths from the pending-copy alerts. */
const orphaned = async (srv: Parameters<typeof api>[0], cookie: string) =>
  ((await api(srv, cookie, 'GET', '/api/alerts')).body.alerts as { code: string; path: string }[])
    .filter((a) => a.code === 'orphaned_note').map((a) => a.path)

test('two clients, the API and an external editor on an open note; the file converges and gets a uid', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const b = await connect(srv, cookie, NOTE)
    const saved: string[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'vihko:saved') saved.push(m.etag) })
    for (let i = 0; i < 20; i++) { typeLine(a, `A-${i}`); typeLine(b, `B-${i}`); await sleep(5) }
    // Editing via the API with the note hot: goes through the live document. While
    // the clients are writing, the ETag keeps changing: it's retried like a real client would.
    let put = { status: 0, body: null as any }
    for (let i = 0; i < 20 && put.status !== 200; i++) {
      const cur = await api(srv, cookie, 'GET', `/api/note?path=${encodeURIComponent(NOTE)}`)
      put = await api(srv, cookie, 'PUT', `/api/note?path=${encodeURIComponent(NOTE)}`, { text: cur.body.text.replace('## Red', '## Red (edited via API)') }, { 'if-match': `"${cur.body.etag}"` })
      assert.ok([200, 412].includes(put.status), `status ${put.status}`)
    }
    assert.equal(put.status, 200)
    // External editor.
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes('A-0'), 'first flush')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Almacenamiento', '## Almacenamiento (edited outside)'))
    await waitFor(() => a.text().includes('(edited outside)') && b.text().includes('(edited outside)'), 'external change reaches the clients')
    await waitFor(() => a.text() === b.text() && a.text().includes('(edited via API)'), 'convergence')
    const final = a.text()
    await waitFor(() => saved.includes(contentHash(final)), 'saved notice with the hash of the flushed text')
    for (let i = 0; i < 20; i++) assert.ok(final.includes(`A-${i}\n`) && final.includes(`B-${i}\n`), `missing A-${i}/B-${i}`)
    a.close(); b.close()
    await waitFor(() => readFileSync(file, 'utf8') === final, 'final flush')
    const fm = readFrontmatter(final)
    assert.deepEqual(fm.data.aliases, ['gw', 'Hipervisor'], 'the original frontmatter is kept')
    assert.match(String(fm.data.uid), /^[0-9A-Z]{26}$/, 'gets a uid when vihko writes it')
  } finally { closeAll(); await srv.stop() }
})

test("an external editor saving over an old version doesn't erase what was typed in the UI", async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const file = join(notes, NOTE)
    typeLine(a, MARK.before)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.before}\n`), 'flush')
    const opened = readFileSync(file, 'utf8') // the external editor opens it here…
    for (let i = 0; i < 3; i++) {
      typeLine(a, `UI-${i}`)
      await waitFor(() => readFileSync(file, 'utf8').includes(`UI-${i}\n`), 'flush')
    }
    writeFileSync(file, opened.replace('## Red', '## Red (slow editor)')) // …and saves much later
    await waitFor(() => a.text().includes('(slow editor)'), 'merge')
    for (let i = 0; i < 3; i++) assert.ok(a.text().includes(`UI-${i}\n`), `lost UI-${i}`)
  } finally { closeAll(); await srv.stop() }
})

test('server crash with unflushed edits: they recover on startup', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  const before = readFileSync(file, 'utf8')
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 10; i++) typeLine(a, `${MARK.unflushed}-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL') // before the flush (1 s debounce)
    assert.equal(readFileSync(file, 'utf8'), before, "hadn't been flushed yet")
    srv = await startServer(env)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.unflushed}-9`), 'recovery')
    for (let i = 0; i < 10; i++) assert.ok(readFileSync(file, 'utf8').includes(`${MARK.unflushed}-${i}\n`))
    await waitFor(() => readdirSync(join(env.VIHKO_STATE_DIR!, 'collab')).every((f) => !f.endsWith('.ylog')), 'log recovered and removed')
  } finally { closeAll(); await srv.stop() }
})

test("deleting an open note closes it and doesn't resurrect it", async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    typeLine(a, MARK.beforeDelete)
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes(MARK.beforeDelete), 'flush')
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(NOTE)}`)
    assert.equal(del.status, 200)
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)), "isn't recreated")
    const trash = await api(srv, cookie, 'GET', '/api/trash')
    assert.equal(trash.body.entries[0].path, NOTE)
  } finally { closeAll(); await srv.stop() }
})

test('WebSocket: rejected without a session, from another origin, or for a nonexistent note', async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const url = srv.base.replace('http', 'ws') + '/collab'
    const status = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers })
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
      ws.on('open', () => { resolve(101); ws.close() })
      ws.on('error', () => {})
    })
    assert.equal(await status({}), 401)
    assert.equal(await status({ cookie, origin: 'https://malicious.example' }), 403)
    assert.equal(await status({ cookie }), 101)
    // Nonexistent note: the connection is accepted but the document never loads.
    const missing = m.aNotePath(inShared(''))
    const doc = new Y.Doc()
    class AuthedWS extends WebSocket { constructor(u: string, p?: string | string[]) { super(u, p, { headers: { cookie } }) } }
    const wsp = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: AuthedWS })
    const p = new HocuspocusProvider({ websocketProvider: wsp, name: missing, document: doc })
    p.attach()
    open.push(p, wsp)
    await sleep(800)
    assert.equal(p.isSynced, false)
    assert.ok(!existsSync(join(env.VIHKO_NOTES_DIR!, missing)))
    wsp.destroy()
  } finally { closeAll(); await srv.stop() }
})

test('WebSocket: a malformed upgrade request or frame is refused and the server stays up', async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const host = new URL(srv.base).host
    /**
     * The status an upgrade request written by hand gets (0: the connection
     * closed without an answer). Accepted, `frame` is sent next, and it
     * resolves once the server closes the connection.
     */
    const upgrade = (target: string, headers: string[], frame?: Buffer) => new Promise<number>((resolve) => {
      const s = tcp(Number(env.VIHKO_PORT), '127.0.0.1')
      let data = ''
      const status = () => Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)
      s.on('data', (d) => {
        const first = !status()
        data += d.toString('latin1')
        if (!first || !status()) return
        if (status() === 101 && frame) s.write(frame)
        else { resolve(status()); s.destroy() }
      })
      s.on('error', () => {})
      s.on('close', () => resolve(status()))
      s.write([
        `GET ${target} HTTP/1.1`, ...headers,
        'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, '', '',
      ].join('\r\n'))
      setTimeout(() => s.destroy(), 5000)
    })
    const alive = async () => srv.proc.exitCode === null && (await fetch(srv.base + '/api/health').then((r) => r.status, () => 0)) === 200
    // The literal values are the cases: what a browser sends from an opaque
    // origin, a Host that isn't one, a target that isn't a path, a cookie
    // that isn't percent-encoded.
    const cases: [string, string, string[], number][] = [
      ['Origin: null', '/collab', [`Host: ${host}`, `Cookie: ${cookie}`, 'Origin: null'], 403],
      ['an Origin that is not a URL', '/collab', [`Host: ${host}`, `Cookie: ${cookie}`, 'Origin: ://'], 403],
      ['a malformed Host', '/collab', ['Host: [', `Cookie: ${cookie}`, `Origin: ${srv.base}`], 403],
      ['a malformed Host, without a session', '/collab', ['Host: ['], 401],
      ['a target that is not a path', '//[', [`Host: ${host}`], 400],
      ['a path that takes no WebSocket', `/${encodeURIComponent(m.aUniqueWord())}`, [`Host: ${host}`, `Cookie: ${cookie}`], 404],
      ['a session cookie that is not percent-encoded', '/collab', [`Host: ${host}`, 'Cookie: vihko_session=%'], 401],
    ]
    for (const [what, target, headers, status] of cases) {
      assert.equal(await upgrade(target, headers), status, what)
      assert.ok(await alive(), `the server is still up after ${what}`)
    }
    // A well-formed request still gets through; a frame the protocol forbids
    // (a client's must be masked) closes that connection, not the server.
    assert.equal(await upgrade('/collab', [`Host: ${host}`, `Cookie: ${cookie}`, `Origin: ${srv.base}`]), 101)
    assert.equal(await upgrade('/collab', [`Host: ${host}`, `Cookie: ${cookie}`], Buffer.from([0x82, 0x01, 0x00])), 101)
    assert.ok(await alive(), 'the server is still up after an invalid frame')
  } finally { await srv.stop() }
})

test('WebSocket: a message over MAX_WS_MESSAGE closes that connection (1009), not the server', async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const ws = new WebSocket(srv.base.replace('http', 'ws') + '/collab', { headers: { cookie } })
    ws.on('error', () => {})
    await new Promise((resolve) => ws.once('open', resolve))
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    // The size is the case: what's in it never gets read.
    ws.send(Buffer.alloc(MAX_WS_MESSAGE + 1))
    assert.equal(await closed, 1009)
    assert.equal(srv.proc.exitCode, null)
    assert.equal((await fetch(srv.base + '/api/health')).status, 200)
  } finally { await srv.stop() }
})


test('external deletion with the note open: live notice, not recreated, and the copy is kept on request', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const messages: string[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => messages.push(JSON.parse(payload).type))
    typeLine(a, MARK.before)
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.before}\n`), 'flush')
    rmSync(file) // someone deletes it with the file explorer
    await waitFor(() => messages.includes('vihko:deleted-externally'), 'live notice', 15000) // after the grace for a move (6 s)
    typeLine(a, MARK.afterDelete)
    await sleep(2500)
    assert.ok(!existsSync(file), "vihko doesn't undo the deletion on its own")
    assert.deepEqual(await orphaned(srv, cookie), [NOTE])
    const r = await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'restore' })
    assert.equal(r.status, 200)
    const back = readFileSync(file, 'utf8')
    assert.ok(back.includes(`${MARK.before}\n`) && back.includes(`${MARK.afterDelete}\n`), 'the copy keeps everything that was written')
    await waitFor(() => messages.includes('vihko:orphan-resolved'), 'resolution notice')
    typeLine(a, MARK.stillEditing)
    await waitFor(() => readFileSync(file, 'utf8').includes(MARK.stillEditing), 'flushes normally again')
    assert.deepEqual(await orphaned(srv, cookie), [])
  } finally { closeAll(); await srv.stop() }
})

test('external deletion with the note open: discarding accepts the deletion as final', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    typeLine(a, 'X')
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes('X\n'), 'flush')
    rmSync(file)
    await waitFor(async () => (await orphaned(srv, cookie)).length === 1, 'alert', 15000)
    assert.equal((await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'discard' })).status, 200)
    await sleep(1500)
    assert.ok(!existsSync(file))
    assert.deepEqual(await orphaned(srv, cookie), [])
    await waitFor(() => readdirSync(join(env.VIHKO_STATE_DIR!, 'collab')).length === 0, 'log removed')
  } finally { closeAll(); await srv.stop() }
})

test('discarding the copy of a note deleted outside: once recreated, it reopens live on the same socket', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const ws = socket(srv, cookie) // one socket for every note, like the web UI
    const a = await connect(srv, cookie, NOTE, ws)
    const resolved: string[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'vihko:orphan-resolved') resolved.push(m.action) })
    const file = join(notes, NOTE)
    rmSync(file)
    await waitFor(async () => (await orphaned(srv, cookie)).length === 1, 'alert', 15000)
    assert.equal((await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'discard' })).status, 200)
    await waitFor(() => resolved.includes('discard'), 'discard notice')
    // The notice arrives before the hub closes the document. The web client drops
    // the provider from the socket then (collab.ts): destroying it while still
    // attached would send a close that Hocuspocus queues and applies to the next
    // opening of this path on the socket, killing it on arrival.
    ws.configuration.providerMap.delete(a.provider.effectiveName)
    a.close() // the user leaves the note
    await sleep(500)
    writeFileSync(file, '# Proxy\n\nBACK\n') // the note comes back with the same path
    const b = await connect(srv, cookie, NOTE, ws)
    assert.equal(b.text(), '# Proxy\n\nBACK\n')
    await sleep(500)
    assert.ok(b.provider.isAuthenticated, 'the new session is still open on the server')
    typeLine(b, MARK.live)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.live}\n`), 'edits reach the file')
  } finally { closeAll(); await srv.stop() }
})

test("deleted with the server down and pending edits: it isn't emptied or recreated; the copy awaits a decision", async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 5; i++) typeLine(a, `${MARK.pending}-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL')
    rmSync(file) // deleted while the server is down
    srv = await startServer(env)
    await sleep(1500)
    assert.ok(!existsSync(file), "recovery doesn't recreate it")
    const cookie2 = await login(srv)
    assert.deepEqual(await orphaned(srv, cookie2), [NOTE])
    assert.equal((await api(srv, cookie2, 'POST', '/api/note/orphan', { path: NOTE, action: 'restore' })).status, 200)
    const back = readFileSync(file, 'utf8')
    for (let i = 0; i < 5; i++) assert.ok(back.includes(`${MARK.pending}-${i}\n`), `missing ${MARK.pending}-${i}`)
    assert.ok(back.includes('# Proxy'), "the document wasn't emptied")
  } finally { closeAll(); await srv.stop() }
})

test('a note whose path is too long to name its recovery log opens, and its copy is recovered after a crash', async () => {
  const { notes, env } = makeDirs()
  // Deep and long: URL-encoded, the path is far past the 255 bytes a file name may take (each name on its own fits).
  const note = inShared(`${Array.from({ length: 6 }, () => `${m.aTitle()} ${m.aTitle()}`).join('/')}/${m.aTitle()}.md`)
  assert.ok(Buffer.byteLength(encodeURIComponent(note)) > 255)
  mkdirSync(join(notes, note, '..'), { recursive: true })
  writeFileSync(join(notes, note), `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  const port = String(42450 + Math.floor(Math.random() * 40))
  let srv = await startServer({ ...env, VIHKO_PORT: port })
  const pending = m.aUniqueWord()
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, note)
    typeLine(a, pending)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL')
    rmSync(join(notes, note)) // deleted while the server is down: its copy waits in the log
    srv = await startServer({ ...env, VIHKO_PORT: port })
    await sleep(1500)
    const cookie2 = await login(srv)
    assert.deepEqual(await orphaned(srv, cookie2), [note])
    assert.equal((await api(srv, cookie2, 'POST', '/api/note/orphan', { path: note, action: 'restore' })).status, 200)
    assert.ok(readFileSync(join(notes, note), 'utf8').includes(`${pending}\n`))
  } finally { closeAll(); await srv.stop() }
})

test('renaming an open note: editors are told, nothing is lost and the old path does not reopen', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  // A new name with a space in it.
  const name = `${m.aTitle()} ${m.aWord()}`
  const TO = inShared(`hogar/${name}.md`)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const b = await connect(srv, cookie, NOTE)
    const moved: { from: string; to: string }[] = []
    for (const c of [a, b]) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'vihko:moved') moved.push(m) })
    typeLine(a, MARK.unflushed) // still in the debounce: the move flushes it first
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    const preview = await api(srv, cookie, 'POST', '/api/note/move', { from: NOTE, to: TO, dryRun: true })
    assert.equal(preview.status, 200)
    assert.ok(existsSync(join(notes, NOTE)), 'the preview moves nothing')
    const r = await api(srv, cookie, 'POST', '/api/note/move', { from: NOTE, to: TO })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.relinked.map((x: { path: string }) => x.path), preview.body.relinked.map((x: { path: string }) => x.path))
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved[0], { type: 'vihko:moved', from: NOTE, to: TO })
    assert.ok(!existsSync(join(notes, NOTE)))
    assert.ok(readFileSync(join(notes, TO), 'utf8').includes(`${MARK.unflushed}\n`))
    assert.ok(readFileSync(join(notes, inShared('hogar/enlaces.md')), 'utf8').includes(`[[${name}#Red]]`))
    a.close(); b.close()
    // It reopens at the new path and editing goes on as usual.
    const c = await connect(srv, cookie, TO)
    assert.ok(c.text().includes(`${MARK.unflushed}\n`))
    typeLine(c, MARK.afterMove)
    await waitFor(() => readFileSync(join(notes, TO), 'utf8').includes(MARK.afterMove), 'flushed at the new path')
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)), 'the old path is not recreated')
  } finally { closeAll(); await srv.stop() }
})

test('trashing an open note tells its editors the entry, and restoring it reopens it', async () => {
  const { notes, env, admin } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const messages: { type: string; id?: string; by?: string }[] = []
    // When the notice comes, the deletion is over: the note is off the disk and its entry is in the trash
    // (told before, an editor could restore an entry not finished yet; its images were still there).
    const when: { noteThere: boolean; entryThere: boolean }[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => {
      const msg = JSON.parse(payload)
      messages.push(msg)
      if (msg.type === 'vihko:trashed') when.push({ noteThere: existsSync(join(notes, NOTE)), entryThere: existsSync(join(env.VIHKO_STATE_DIR, 'trash', msg.id, 'meta.json')) })
    })
    typeLine(a, MARK.lastLine)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(NOTE)}`)
    assert.equal(del.status, 200)
    await waitFor(() => messages.some((m) => m.type === 'vihko:trashed'), 'trash notice')
    assert.deepEqual(messages.find((m) => m.type === 'vihko:trashed'), { type: 'vihko:trashed', path: NOTE, id: del.body.id, by: admin.username })
    assert.deepEqual(when, [{ noteThere: false, entryThere: true }])
    // The editor is still around and retries: it does not resurrect the note, not even by typing.
    typeLine(a, MARK.afterDelete)
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)))
    const restored = await api(srv, cookie, 'POST', `/api/trash/${del.body.id}/restore`)
    assert.equal(restored.status, 200)
    const back = readFileSync(join(notes, NOTE), 'utf8')
    assert.ok(back.includes(`${MARK.lastLine}\n`), 'the trash has the latest text')
    assert.ok(!back.includes(MARK.afterDelete))
    a.close()
    const c = await connect(srv, cookie, NOTE)
    assert.equal(c.text(), back)
  } finally { closeAll(); await srv.stop() }
})

/** A note open as the web UI keeps it: it follows the hub to a new generation and reports what it sets aside. */
function follow(srv: Srv, cookie: string, name: string) {
  const ws = socket(srv, cookie)
  const aside: string[] = []
  const lineages: Lineage[] = []
  const link = new NoteLink(ws, name, {
    onLineage: (l) => { lineages.push(l); open.unshift(l.provider) },
    onSetAside: (s) => aside.push(s.text),
  })
  return {
    link, aside, lineages,
    text: () => link.lineage.text.toString(),
    type(token: string) {
      const t = link.lineage.text
      const s = t.toString()
      t.insert(s.lastIndexOf('\n', s.length - 2) + 1, token + '\n')
    },
    /** A network drop: the socket closes and the provider reconnects on its own. */
    cut() { (ws as unknown as { webSocket: WebSocket }).webSocket.close() },
    /** The network goes down until `online()`: the socket closes and doesn't try again. */
    offline() { ws.disconnect() },
    online() { void ws.connect() },
    settled: () => link.lineage.provider.isSynced && link.lineage.provider.unsyncedChanges === 0,
  }
}

const once = (text: string, line: string) => text.split('\n').filter((l) => l === line).length === 1

// An open tab keeps its document when the connection drops. Within the same
// generation of the hub's document, what it typed offline merges as usual.
test('same generation: offline typing survives network drops and server restarts, without duplicating', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  try {
    const a = follow(srv, await login(srv), NOTE)
    await waitFor(a.settled, 'sync')
    a.type(MARK.beforeDrop)
    await waitFor(() => readFileSync(file, 'utf8').includes(MARK.beforeDrop), 'flush')
    const lines = ['# Proxy', '## Red', MARK.beforeDrop]
    for (let i = 0; i < 3; i++) {
      // 1. Network drop: the hub closes the document when its last editor
      // leaves, and reopens it from its saved state.
      a.cut()
      await waitFor(() => !a.link.lineage.provider.isSynced, 'disconnected')
      a.type(`${MARK.offlineCut}-${i}`)
      await waitFor(() => a.settled() && readFileSync(file, 'utf8').includes(`${MARK.offlineCut}-${i}\n`), 'resync', 15000)
      // 2. Server restart while the tab types.
      await srv.stop()
      a.type(`${MARK.offlineRestart}-${i}`)
      srv = await startServer(env)
      await waitFor(() => a.settled() && readFileSync(file, 'utf8').includes(`${MARK.offlineRestart}-${i}\n`), 'resync after the restart', 15000)
      lines.push(`${MARK.offlineCut}-${i}`, `${MARK.offlineRestart}-${i}`)
    }
    assert.equal(a.lineages.length, 1, 'the copy was never refused')
    assert.deepEqual(a.aside, [])
    const b = await connect(srv, await login(srv), NOTE)
    await waitFor(() => b.text() === a.text() && readFileSync(file, 'utf8') === a.text(), 'convergence')
    for (const line of lines) assert.ok(once(a.text(), line), `${line} exactly once in:\n${a.text()}`)
  } finally { closeAll(); await srv.stop() }
})

// If the hub has to start the document again without a saved state that
// continues it (lost, or not matching the file on startup: changed with vihko
// stopped, or restored from a backup), a tab's old copy would add its text a
// second time. The hub refuses it; the tab reopens the note and sets aside
// what it hadn't sent.
test('a copy from another generation is refused: no duplication, and what was not sent is set aside', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  // The hub's saved state: the document as it was left (.ystate) or, if the
  // process ended before unloading it, its recovery log (.ylog).
  const saved = ['.ystate', '.ylog'].map((ext) => join(env.VIHKO_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + ext))
  const takeState = () => new Map(saved.filter((f) => existsSync(f)).map((f) => [f, readFileSync(f)]))
  const putState = (files: Map<string, Buffer>) => {
    for (const f of saved) rmSync(f, { force: true })
    for (const [f, data] of files) writeFileSync(f, data)
  }
  try {
    const a = follow(srv, await login(srv), NOTE)
    await waitFor(a.settled, 'sync')
    const lines = ['# Proxy', '## Red']
    /** Stops the server (the hub saves the document's state on the way out), runs `meanwhile` and starts it again. */
    const restart = async (meanwhile: () => void) => {
      await srv.stop()
      assert.ok(saved.some((f) => existsSync(f)), 'the state was saved')
      meanwhile()
      srv = await startServer(env)
    }
    const scenarios = ['state deleted', 'old state restored', 'file changed while closed', 'nothing unsent'] as const
    for (let round = 0; round < 2; round++) {
      for (const scenario of scenarios) {
        const tag = `${round}-${scenarios.indexOf(scenario)}`
        let backup: Map<string, Buffer> | null = null
        if (scenario === 'old state restored') {
          // A backup of the state volume, then more typing that reaches the file.
          await restart(() => { backup = takeState() })
          await waitFor(a.settled, 'resync', 15000)
          a.type(`${MARK.newer}-${tag}`)
          await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.newer}-${tag}\n`), 'flush')
          lines.push(`${MARK.newer}-${tag}`)
        }
        const lineages = a.lineages.length
        const aside = a.aside.length
        await restart(() => {
          if (scenario === 'state deleted' || scenario === 'nothing unsent') putState(new Map())
          if (backup) putState(backup)
          if (scenario === 'file changed while closed') {
            writeFileSync(file, readFileSync(file, 'utf8') + `${MARK.external}-${tag}\n`)
            lines.push(`${MARK.external}-${tag}`)
          }
          if (scenario !== 'nothing unsent') a.type(`${MARK.unsent}-${tag}`) // typed while the server is down
        })
        await waitFor(a.settled, `${scenario}: in sync again`, 15000)
        await sleep(1500) // flushed
        const text = a.text()
        assert.equal(readFileSync(file, 'utf8'), text, `${scenario}: the file is the hub's document`)
        for (const line of lines) assert.ok(once(text, line), `${scenario}: ${line} exactly once in:\n${text}`)
        assert.ok(!text.includes(`${MARK.unsent}-${tag}`), `${scenario}: the refused copy isn't merged`)
        assert.equal(a.lineages.length, lineages + 1, `${scenario}: the old copy was replaced`)
        if (scenario === 'nothing unsent') {
          await sleep(500)
          assert.equal(a.aside.length, aside, `${scenario}: nothing to set aside`)
        } else {
          await waitFor(() => a.aside.length === aside + 1, `${scenario}: set aside`)
          assert.ok(a.aside.at(-1)!.includes(`${MARK.unsent}-${tag}\n`), `${scenario}: the unsent line is what's set aside`)
        }
        // Editing goes on in the new document.
        a.type(`${MARK.after}-${tag}`)
        await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.after}-${tag}\n`), 'flush')
        lines.push(`${MARK.after}-${tag}`)
      }
    }
  } finally { closeAll(); await srv.stop() }
})

// A saved state the hub trusts (written during this run, or matching its file
// on startup) carries its generation on although the file changed after the
// note was closed, while vihko was running: the change is merged into it as
// another editor's, and what a tab typed offline merges as usual.
test('changed outside while vihko runs and the note is closed: what a tab typed offline merges, without a copy or duplicates', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  const saved = (ext: string) => join(env.VIHKO_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + ext)
  try {
    const cookie = await login(srv)
    const a = follow(srv, cookie, NOTE)
    await waitFor(a.settled, 'sync')
    a.type(MARK.sent)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.sent}\n`), 'flush')
    const lines = ['# Proxy', '## Red', MARK.sent]
    const scenarios = ['another editor', 'another editor, state checked on startup', 'another editor, and someone opens it meanwhile', 'an agent edits the closed note'] as const
    for (const scenario of scenarios) {
      const tag = `${scenarios.indexOf(scenario)}`
      // The tab loses the network: the hub closes the note and saves its state.
      a.offline()
      await waitFor(() => existsSync(saved('.ystate')) && !existsSync(saved('.ylog')), `${scenario}: the note closed`)
      if (scenario === 'another editor, state checked on startup') {
        await srv.stop()
        srv = await startServer(env)
        assert.ok(srv.out.join('').includes('saved editor states: 1 of 1 match their file'), srv.out.join(''))
      }
      a.type(`${MARK.offline}-${tag}`)
      if (scenario === 'an agent edits the closed note') {
        const r = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${MARK.agent}-${tag}\n` }] })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        lines.push(`${MARK.agent}-${tag}`)
      } else {
        writeFileSync(file, readFileSync(file, 'utf8').replace('## Red\n', `## Red\n${MARK.external}-${tag}\n`))
        lines.push(`${MARK.external}-${tag}`)
      }
      let b: Client | null = null
      if (scenario === 'another editor, and someone opens it meanwhile') {
        b = await connect(srv, await login(srv), NOTE)
        assert.ok(b.text().includes(`${MARK.external}-${tag}\n`), 'the change is merged when the note opens')
        typeLine(b, `B-${tag}`)
        await waitFor(() => readFileSync(file, 'utf8').includes(`B-${tag}\n`), 'flush')
        lines.push(`B-${tag}`)
      }
      a.online()
      await waitFor(() => a.settled() && readFileSync(file, 'utf8').includes(`${MARK.offline}-${tag}\n`), `${scenario}: merged`, 15000)
      lines.push(`${MARK.offline}-${tag}`)
      await waitFor(() => readFileSync(file, 'utf8') === a.text() && (!b || b.text() === a.text()), `${scenario}: convergence`)
      for (const line of lines) assert.ok(once(a.text(), line), `${scenario}: ${line} exactly once in:\n${a.text()}`)
      assert.equal(a.lineages.length, 1, `${scenario}: the copy was never refused`)
      assert.deepEqual(a.aside, [], `${scenario}: nothing set aside`)
      b?.close()
    }
  } finally { closeAll(); await srv.stop() }
})

// What a trusted state doesn't cover. Another note put at its path isn't what
// the tab was writing; and an older state put back from outside is caught by
// its hash, even while vihko runs (a backup is restored with vihko stopped, and
// then it doesn't match its file on startup: the test above this one).
test('a trusted state starts a new generation for another note at its path, or when an older state is put back', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const file = join(notes, NOTE)
  const state = join(env.VIHKO_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + '.ystate')
  const log = join(env.VIHKO_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + '.ylog')
  try {
    const a = follow(srv, await login(srv), NOTE)
    await waitFor(a.settled, 'sync')
    a.type(MARK.sent)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.sent}\n`), 'flush')
    assert.ok(readFrontmatter(readFileSync(file, 'utf8')).data.uid, 'the note got a uid')
    const lines = ['# Another note', 'Its own text.']
    for (const scenario of ['another note at the path', 'an older state put back'] as const) {
      const tag = scenario === 'another note at the path' ? MARK.other : MARK.older
      const lineages = a.lineages.length
      a.offline()
      await waitFor(() => existsSync(state) && !existsSync(log), 'the note closed')
      if (scenario === 'another note at the path') {
        writeFileSync(file, '---\nuid: 01OTHERNOTE0000000000000000\n---\n# Another note\n\nIts own text.\n')
      } else {
        // A copy of the state, then more typing that reaches the file, and the copy put back.
        const older = readFileSync(state)
        a.online()
        await waitFor(a.settled, 'resync')
        a.type(`${MARK.newer}-${tag}`)
        await waitFor(() => readFileSync(file, 'utf8').includes(`${MARK.newer}-${tag}\n`), 'flush')
        lines.push(`${MARK.newer}-${tag}`)
        a.offline()
        await waitFor(() => existsSync(state) && !existsSync(log) && !readFileSync(state).equals(older), 'the note closed again')
        writeFileSync(state, older)
      }
      const aside = a.aside.length
      a.type(`${MARK.unsent}-${tag}`)
      a.online()
      await waitFor(() => a.lineages.length === lineages + 1 && a.settled(), `${scenario}: the copy was refused and the note reopened`, 15000)
      await waitFor(() => a.aside.length === aside + 1, `${scenario}: set aside`)
      assert.ok(a.aside.at(-1)!.includes(`${MARK.unsent}-${tag}\n`), `${scenario}: the unsent line is what's set aside`)
      await waitFor(() => readFileSync(file, 'utf8') === a.text(), `${scenario}: the file is the hub's document`)
      assert.ok(!a.text().includes(`${MARK.unsent}-${tag}`), `${scenario}: the refused copy isn't merged`)
      for (const line of lines) assert.ok(once(a.text(), line), `${scenario}: ${line} exactly once in:\n${a.text()}`)
    }
  } finally { closeAll(); await srv.stop() }
})

// A flush rewrites the recovery log once the file is replaced: a snapshot of
// what it wrote, then what arrived while it was writing. A kill between the
// two lost that last part, although the hub had already acknowledged it.
test('killed while a flush rewrites the recovery log: nothing acknowledged is lost', async () => {
  const { notes, env } = makeDirs()
  const file = join(notes, NOTE)
  let srv = await startServer({ ...env, VIHKO_TEST_CRASH_AT: 'log-rewrite' })
  const alive = () => srv.proc.exitCode === null && srv.proc.signalCode === null
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
    // Every acknowledgement confirms the oldest update still unconfirmed: one line each.
    let acks = 0
    const decrement = a.provider.decrementUnsyncedChanges.bind(a.provider)
    a.provider.decrementUnsyncedChanges = () => { acks++; decrement() }
    const typed: string[] = []
    // Someone types without pause while an agent's edits make the hub flush again and again.
    let typing = true
    const agent = (async () => {
      for (let k = 0; typing && alive(); k++) {
        await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${MARK.agent}-${k}\n` }] }).catch(() => {})
        await sleep(20)
      }
    })()
    const start = Date.now()
    for (let n = 0; alive() && Date.now() - start < 60_000; n++) {
      typeLine(a, `${MARK.line}-${n}.`)
      typed.push(`${MARK.line}-${n}.`)
      await sleep(2)
    }
    typing = false
    await agent
    assert.equal(srv.proc.signalCode, 'SIGKILL', 'the crash point was reached')
    const acked = typed.slice(0, acks)
    // Read as soon as the server is back: the tab would bring its lines back
    // when it reconnects, but that takes a retry and a flush.
    srv = await startServer(env)
    const disk = readFileSync(file, 'utf8')
    const lost = acked.filter((l) => !once(disk, l))
    assert.deepEqual(lost, [], `${lost.length} of ${acked.length} acknowledged lines missing or repeated`)
    // Closed once connected again: a socket destroyed while retrying keeps the process alive.
    await waitFor(() => a.provider.isSynced, 'reconnected', 30000)
  } finally { closeAll(); await srv.stop() }
})

// The hub's recovery log, as it is when the process dies in the middle of a
// flush: the file already replaced (rename done), the log not yet rewritten.
test('killed after a flush replaced the file but before the log recorded it: nothing is duplicated', async () => {
  const { notes, env } = makeDirs()
  const file = join(notes, NOTE)
  const original = readFileSync(file, 'utf8')
  const doc = new Y.Doc()
  const text = doc.getText('md')
  text.insert(0, original)
  const snapshot = Y.encodeStateAsUpdate(doc)
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  text.insert(text.length, `${MARK.flushed}-1\n`)
  text.insert(text.length, `${MARK.flushed}-2\n`)
  const flushed = text.toString()
  const atFlush = updates.length
  text.insert(text.length, `${MARK.afterTheFlush}\n`)
  const rec = (type: string, payload: Uint8Array) => {
    const head = Buffer.alloc(5)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(payload.length, 1)
    return Buffer.concat([head, payload])
  }
  const log = Buffer.concat([
    rec('S', Buffer.concat([Buffer.from(contentHash(original), 'latin1'), snapshot])),
    ...updates.slice(0, atFlush).map((u) => rec('U', u)),
    rec('F', Buffer.from(contentHash(flushed), 'latin1')),
    ...updates.slice(atFlush).map((u) => rec('U', u)),
  ])
  mkdirSync(join(env.VIHKO_STATE_DIR!, 'collab'), { recursive: true })
  writeFileSync(join(env.VIHKO_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + '.ylog'), log)
  writeFileSync(file, flushed)
  const srv = await startServer(env)
  try {
    await waitFor(() => readFileSync(file, 'utf8').includes(MARK.afterTheFlush), 'recovery')
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of ['# Proxy', `${MARK.flushed}-1`, `${MARK.flushed}-2`, MARK.afterTheFlush]) {
      assert.equal(lines.filter((l) => l === line).length, 1, `${line} exactly once in:\n${lines.join('\n')}`)
    }
  } finally { closeAll(); await srv.stop() }
})

// An agent's edit lands exactly where its operation says, even when the text
// next to it looks like the start of what it inserts: a diff of the whole
// text took the characters someone was typing as part of the agent's line.
test("an agent's edit next to someone typing doesn't interleave the two texts", async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    assert.equal((await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${MARK.agentMark}\n` }] })).status, 200)
    const a = await connect(srv, cookie, NOTE)
    const t = a.doc.getText('md')
    // Concurrent insertions at the same place are ordered by client id: both orders are tried.
    for (const [i, clientID] of [1, 2 ** 32 - 2].entries()) {
      t.insert(t.toString().indexOf(`${MARK.agentMark}\n`) + `${MARK.agentMark}\n`.length, `T${i}-\n`)
      await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
      // A keystroke the hub hasn't seen yet when the agent's edit arrives: typed on a copy of the document.
      const typing = new Y.Doc()
      typing.clientID = clientID
      Y.applyUpdate(typing, Y.encodeStateAsUpdate(a.doc))
      const tt = typing.getText('md')
      tt.insert(tt.toString().indexOf(`T${i}-\n`) + 3, 'typed.')
      const r = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'find_replace', find: `${MARK.agentMark}\n`, replace: `${MARK.agentMark}\nT${i}-AGENT\n` }] })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await waitFor(() => a.text().includes(`T${i}-AGENT`), "the agent's edit reaches the editor")
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(typing, Y.encodeStateVector(a.doc)))
      await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
      const lines = a.text().split('\n')
      const at = lines.indexOf(MARK.agentMark)
      assert.deepEqual(lines.slice(at, at + 3), [MARK.agentMark, `T${i}-AGENT`, `T${i}-typed.`], `client id ${clientID}`)
    }
  } finally { closeAll(); await srv.stop() }
})
