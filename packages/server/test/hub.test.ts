import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { contentHash, readFrontmatter } from '@thoth/core'
import { api, closeAll, connect, login, makeDirs, open, sleep, socket, startServer, typeLine, waitFor } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'

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
    a.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:saved') saved.push(m.etag) })
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
    assert.match(String(fm.data.uid), /^[0-9A-Z]{26}$/, 'gets a uid when thoth writes it')
  } finally { closeAll(); await srv.stop() }
})

test("an external editor saving over an old version doesn't erase what was typed in the UI", async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const file = join(notes, NOTE)
    typeLine(a, 'BEFORE')
    await waitFor(() => readFileSync(file, 'utf8').includes('BEFORE\n'), 'flush')
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
    for (let i = 0; i < 10; i++) typeLine(a, `UNFLUSHED-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL') // before the flush (1 s debounce)
    assert.equal(readFileSync(file, 'utf8'), before, "hadn't been flushed yet")
    srv = await startServer(env)
    await waitFor(() => readFileSync(file, 'utf8').includes('UNFLUSHED-9'), 'recovery')
    for (let i = 0; i < 10; i++) assert.ok(readFileSync(file, 'utf8').includes(`UNFLUSHED-${i}\n`))
    await waitFor(() => readdirSync(join(env.THOTH_STATE_DIR!, 'collab')).every((f) => !f.endsWith('.ylog')), 'log recovered and removed')
  } finally { closeAll(); await srv.stop() }
})

test("deleting an open note closes it and doesn't resurrect it", async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    typeLine(a, 'BEFORE-DELETE')
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('BEFORE-DELETE'), 'flush')
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
    const doc = new Y.Doc()
    class AuthedWS extends WebSocket { constructor(u: string, p?: string | string[]) { super(u, p, { headers: { cookie } }) } }
    const wsp = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: AuthedWS })
    const p = new HocuspocusProvider({ websocketProvider: wsp, name: 'no-existe.md', document: doc })
    p.attach()
    open.push(p, wsp)
    await sleep(800)
    assert.equal(p.isSynced, false)
    assert.ok(!existsSync(join(env.THOTH_NOTES_DIR!, 'no-existe.md')))
    wsp.destroy()
  } finally { closeAll(); await srv.stop() }
})


test('external deletion with the note open: live notice, not recreated, and the copy is kept on request', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const messages: string[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => messages.push(JSON.parse(payload).type))
    typeLine(a, 'BEFORE')
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes('BEFORE\n'), 'flush')
    const { rmSync } = await import('node:fs')
    rmSync(file) // someone deletes it with the file explorer
    await waitFor(() => messages.includes('thoth:deleted-externally'), 'live notice')
    typeLine(a, 'AFTER-DELETE')
    await sleep(2500)
    assert.ok(!existsSync(file), "thoth doesn't undo the deletion on its own")
    assert.deepEqual(await orphaned(srv, cookie), [NOTE])
    const r = await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'restore' })
    assert.equal(r.status, 200)
    const back = readFileSync(file, 'utf8')
    assert.ok(back.includes('BEFORE\n') && back.includes('AFTER-DELETE\n'), 'the copy keeps everything that was written')
    await waitFor(() => messages.includes('thoth:orphan-resolved'), 'resolution notice')
    typeLine(a, 'STILL-EDITING')
    await waitFor(() => readFileSync(file, 'utf8').includes('STILL-EDITING'), 'flushes normally again')
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
    const { rmSync } = await import('node:fs')
    rmSync(file)
    await waitFor(async () => (await orphaned(srv, cookie)).length === 1, 'alert')
    assert.equal((await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'discard' })).status, 200)
    await sleep(1500)
    assert.ok(!existsSync(file))
    assert.deepEqual(await orphaned(srv, cookie), [])
    await waitFor(() => readdirSync(join(env.THOTH_STATE_DIR!, 'collab')).length === 0, 'log removed')
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
    a.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:orphan-resolved') resolved.push(m.action) })
    const file = join(notes, NOTE)
    const { rmSync } = await import('node:fs')
    rmSync(file)
    await waitFor(async () => (await orphaned(srv, cookie)).length === 1, 'alert')
    assert.equal((await api(srv, cookie, 'POST', '/api/note/orphan', { path: NOTE, action: 'discard' })).status, 200)
    await waitFor(() => resolved.includes('discard'), 'discard notice')
    // The notice arrives before the hub closes the document. The web client drops
    // the provider from the socket then (collab.ts): destroying it while still
    // attached would send a close that Hocuspocus queues and applies to the next
    // opening of this path on the socket, killing it on arrival.
    ws.configuration.providerMap.delete(NOTE)
    a.close() // the user leaves the note
    await sleep(500)
    writeFileSync(file, '# Proxy\n\nBACK\n') // the note comes back with the same path
    const b = await connect(srv, cookie, NOTE, ws)
    assert.equal(b.text(), '# Proxy\n\nBACK\n')
    await sleep(500)
    assert.ok(b.provider.isAuthenticated, 'the new session is still open on the server')
    typeLine(b, 'LIVE')
    await waitFor(() => readFileSync(file, 'utf8').includes('LIVE\n'), 'edits reach the file')
  } finally { closeAll(); await srv.stop() }
})

test("deleted with the server down and pending edits: it isn't emptied or recreated; the copy awaits a decision", async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 5; i++) typeLine(a, `PENDING-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL')
    const { rmSync } = await import('node:fs')
    rmSync(file) // deleted while the server is down
    srv = await startServer(env)
    await sleep(1500)
    assert.ok(!existsSync(file), "recovery doesn't recreate it")
    const cookie2 = await login(srv)
    assert.deepEqual(await orphaned(srv, cookie2), [NOTE])
    assert.equal((await api(srv, cookie2, 'POST', '/api/note/orphan', { path: NOTE, action: 'restore' })).status, 200)
    const back = readFileSync(file, 'utf8')
    for (let i = 0; i < 5; i++) assert.ok(back.includes(`PENDING-${i}\n`), `missing PENDING-${i}`)
    assert.ok(back.includes('# Proxy'), "the document wasn't emptied")
  } finally { closeAll(); await srv.stop() }
})

test('renaming an open note: editors are told, nothing is lost and the old path does not reopen', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  const TO = 'hogar/Hipervisor Proxy.md'
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const b = await connect(srv, cookie, NOTE)
    const moved: { from: string; to: string }[] = []
    for (const c of [a, b]) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:moved') moved.push(m) })
    typeLine(a, 'UNFLUSHED') // still in the debounce: the move flushes it first
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    const preview = await api(srv, cookie, 'POST', '/api/note/move', { from: NOTE, to: TO, dryRun: true })
    assert.equal(preview.status, 200)
    assert.ok(existsSync(join(notes, NOTE)), 'the preview moves nothing')
    const r = await api(srv, cookie, 'POST', '/api/note/move', { from: NOTE, to: TO })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.relinked.map((x: { path: string }) => x.path), preview.body.relinked.map((x: { path: string }) => x.path))
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved[0], { type: 'thoth:moved', from: NOTE, to: TO })
    assert.ok(!existsSync(join(notes, NOTE)))
    assert.ok(readFileSync(join(notes, TO), 'utf8').includes('UNFLUSHED\n'))
    assert.ok(readFileSync(join(notes, 'hogar/enlaces.md'), 'utf8').includes('[[Hipervisor Proxy#Red]]'))
    a.close(); b.close()
    // It reopens at the new path and editing goes on as usual.
    const c = await connect(srv, cookie, TO)
    assert.ok(c.text().includes('UNFLUSHED\n'))
    typeLine(c, 'AFTER-MOVE')
    await waitFor(() => readFileSync(join(notes, TO), 'utf8').includes('AFTER-MOVE'), 'flushed at the new path')
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)), 'the old path is not recreated')
  } finally { closeAll(); await srv.stop() }
})

test('trashing an open note tells its editors the entry, and restoring it reopens it', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const messages: { type: string; id?: string; by?: string }[] = []
    a.provider.on('stateless', ({ payload }: { payload: string }) => messages.push(JSON.parse(payload)))
    typeLine(a, 'LAST-LINE')
    await waitFor(() => a.provider.unsyncedChanges === 0, 'sent to the server')
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(NOTE)}`)
    assert.equal(del.status, 200)
    await waitFor(() => messages.some((m) => m.type === 'thoth:trashed'), 'trash notice')
    assert.deepEqual(messages.find((m) => m.type === 'thoth:trashed'), { type: 'thoth:trashed', path: NOTE, id: del.body.id, by: 'noa' })
    // The editor is still around and retries: it does not resurrect the note, not even by typing.
    typeLine(a, 'AFTER-DELETE')
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)))
    const restored = await api(srv, cookie, 'POST', `/api/trash/${del.body.id}/restore`)
    assert.equal(restored.status, 200)
    const back = readFileSync(join(notes, NOTE), 'utf8')
    assert.ok(back.includes('LAST-LINE\n'), 'the trash has the latest text')
    assert.ok(!back.includes('AFTER-DELETE'))
    a.close()
    const c = await connect(srv, cookie, NOTE)
    assert.equal(c.text(), back)
  } finally { closeAll(); await srv.stop() }
})

// An open tab keeps its document when the connection drops. Reopened from
// the file alone, the hub's document would have a new Yjs identity and the
// tab's resync would add a second copy of the whole text.
test('an editor that lost its connection resyncs without duplicating the note', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  try {
    let cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    typeLine(a, 'BEFORE-DROP')
    await waitFor(() => readFileSync(file, 'utf8').includes('BEFORE-DROP'), 'flush')
    // 1. Network drop: the hub closes the document when its last editor leaves.
    ;(a.provider.configuration.websocketProvider as unknown as { webSocket: WebSocket }).webSocket.close()
    await waitFor(() => !a.provider.isSynced, 'disconnected')
    typeLine(a, 'OFFLINE-1')
    await waitFor(() => a.provider.isSynced && a.provider.unsyncedChanges === 0, 'resync', 15000)
    // 2. Server restart, with a change made to the closed note meanwhile.
    await srv.stop()
    writeFileSync(file, readFileSync(file, 'utf8') + 'EDITED-WHILE-DOWN\n')
    typeLine(a, 'OFFLINE-2')
    srv = await startServer(env)
    cookie = await login(srv)
    await waitFor(() => a.provider.isSynced && a.provider.unsyncedChanges === 0 && a.text().includes('EDITED-WHILE-DOWN'), 'resync after the restart', 15000)
    const b = await connect(srv, cookie, NOTE)
    await waitFor(() => b.text() === a.text() && readFileSync(file, 'utf8') === a.text(), 'convergence')
    const text = a.text()
    for (const line of ['# Proxy', '## Red', 'BEFORE-DROP', 'OFFLINE-1', 'OFFLINE-2', 'EDITED-WHILE-DOWN']) {
      assert.equal(text.split('\n').filter((l) => l === line).length, 1, `${line} exactly once in:\n${text}`)
    }
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
  text.insert(text.length, 'FLUSHED-1\n')
  text.insert(text.length, 'FLUSHED-2\n')
  const flushed = text.toString()
  const atFlush = updates.length
  text.insert(text.length, 'AFTER-THE-FLUSH\n')
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
  mkdirSync(join(env.THOTH_STATE_DIR!, 'collab'), { recursive: true })
  writeFileSync(join(env.THOTH_STATE_DIR!, 'collab', encodeURIComponent(NOTE) + '.ylog'), log)
  writeFileSync(file, flushed)
  const srv = await startServer(env)
  try {
    await waitFor(() => readFileSync(file, 'utf8').includes('AFTER-THE-FLUSH'), 'recovery')
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of ['# Proxy', 'FLUSHED-1', 'FLUSHED-2', 'AFTER-THE-FLUSH']) {
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
    assert.equal((await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'AGENT-MARK\n' }] })).status, 200)
    const a = await connect(srv, cookie, NOTE)
    const t = a.doc.getText('md')
    // Concurrent insertions at the same place are ordered by client id: both orders are tried.
    for (const [i, clientID] of [1, 2 ** 32 - 2].entries()) {
      t.insert(t.toString().indexOf('AGENT-MARK\n') + 'AGENT-MARK\n'.length, `T${i}-\n`)
      await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
      // A keystroke the hub hasn't seen yet when the agent's edit arrives: typed on a copy of the document.
      const typing = new Y.Doc()
      typing.clientID = clientID
      Y.applyUpdate(typing, Y.encodeStateAsUpdate(a.doc))
      const tt = typing.getText('md')
      tt.insert(tt.toString().indexOf(`T${i}-\n`) + 3, 'typed.')
      const r = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'find_replace', find: 'AGENT-MARK\n', replace: `AGENT-MARK\nT${i}-AGENT\n` }] })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await waitFor(() => a.text().includes(`T${i}-AGENT`), "the agent's edit reaches the editor")
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(typing, Y.encodeStateVector(a.doc)))
      await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
      const lines = a.text().split('\n')
      const at = lines.indexOf('AGENT-MARK')
      assert.deepEqual(lines.slice(at, at + 3), ['AGENT-MARK', `T${i}-AGENT`, `T${i}-typed.`], `client id ${clientID}`)
    }
  } finally { closeAll(); await srv.stop() }
})
