// The history with the collaboration hub, on a real server: who typed each
// version, direct writes and external changes on open notes, restoring an
// open note, and kill -9 at the recorder's crash points.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Srv } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'
const q = encodeURIComponent
const FAST = { THOTH_HISTORY_QUIET_SECONDS: '0.4', THOTH_HISTORY_MAX_SECONDS: '30' }

function withAna(env: Record<string, string>) {
  spawnSync(process.execPath, [CLI, 'user', 'create', 'ana'], { env: { ...process.env, ...env }, input: 'a-long-password' })
}

async function loginAs(srv: Srv, username: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a-long-password' }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

const who = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? a.name : a.kind)).join(',')

async function versionsOf(srv: Srv, cookie: string, path: string) {
  const r = await api(srv, cookie, 'GET', `/api/history/versions?path=${q(path)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body as { versions: any[]; pending: any }
}

async function textOf(srv: Srv, cookie: string, path: string, id: string) {
  return (await api(srv, cookie, 'GET', `/api/history/version?path=${q(path)}&id=${id}`)).body.text as string
}

test('what two people type in the same window is one version with both of them', async () => {
  const { notes, env } = makeDirs()
  withAna(env)
  const srv = await startServer({ ...env, ...FAST, THOTH_HISTORY_QUIET_SECONDS: '1.5' })
  try {
    const k = await login(srv)
    const a = await loginAs(srv, 'ana')
    const ck = await connect(srv, k, NOTE)
    const ca = await connect(srv, a, NOTE)
    typeLine(ck, 'K-TYPED-1')
    await sleep(200)
    typeLine(ca, 'A-TYPED-1')
    await waitFor(() => { const t = readFileSync(join(notes, NOTE), 'utf8'); return t.includes('K-TYPED-1') && t.includes('A-TYPED-1') }, 'flush of both')
    const open = await versionsOf(srv, k, NOTE)
    assert.deepEqual(open.pending.authors.map((x: any) => x.name).sort(), ['ana', 'noa'])
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length === 2, 'the version closes after the quiet time')
    const [v] = (await versionsOf(srv, k, NOTE)).versions
    assert.deepEqual(v.authors.map((x: any) => x.name).sort(), ['ana', 'noa'])
    assert.equal(v.change, 'modified')
  } finally { closeAll(); await srv.stop() }
})

test('a direct write to an open note is its own version; what was typed before it closes first, with the text from before', async () => {
  const { env } = makeDirs()
  withAna(env)
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await loginAs(srv, 'ana')
    const ck = await connect(srv, k, NOTE)
    typeLine(ck, 'TYPED-BEFORE')
    await sleep(50) // typed, not necessarily flushed yet
    const edit = await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'FROM-THE-API\n' }] })
    assert.equal(edit.status, 200)
    await waitFor(() => ck.text().includes('FROM-THE-API'), 'the write reaches the editor')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'both versions')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.slice(0, 2).map(who), ['ana', 'noa'])
    const typed = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(typed.includes('TYPED-BEFORE') && !typed.includes('FROM-THE-API'), 'the typed version is the text right before the write')
    assert.ok((await textOf(srv, k, NOTE, versions[0].id)).includes('FROM-THE-API'))
  } finally { closeAll(); await srv.stop() }
})

test('an external change to an open note is its own version, after what was typed', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const ck = await connect(srv, k, NOTE)
    typeLine(ck, 'TYPED-FIRST')
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes('TYPED-FIRST'), 'flush')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Red', '## Red (outside)'))
    await waitFor(() => ck.text().includes('(outside)'), 'merged into the editor')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'versions')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.slice(0, 2).map(who), ['external', 'noa'])
    const ext = await textOf(srv, k, NOTE, versions[0].id)
    assert.ok(ext.includes('(outside)') && ext.includes('TYPED-FIRST'))
  } finally { closeAll(); await srv.stop() }
})

test('a rename rewrites the links of an open note in the same system commit, and restoring an open note changes it for its editors at once', async () => {
  const { env } = makeDirs()
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const links = await connect(srv, k, 'hogar/enlaces.md')
    const mv = await api(srv, k, 'POST', '/api/note/move', { from: NOTE, to: 'hogar/GW.md' })
    assert.equal(mv.status, 200)
    await waitFor(() => links.text().includes('[[GW#Red]]'), 'the rewrite reaches the open note')
    await waitFor(async () => ((await api(srv, k, 'GET', '/api/history/changes')).body.changes[0]?.reason?.code === 'note_moved'), 'the system commit')
    const system = (await api(srv, k, 'GET', '/api/history/changes')).body.changes[0]
    assert.deepEqual(system.files.map((f: any) => f.path), ['hogar/enlaces.md'])
    // Restore the version before the rename on the open note.
    const { versions } = await versionsOf(srv, k, 'hogar/enlaces.md')
    const before = versions.find((v: any) => v.reason?.code === 'history_enabled')
    const r = await api(srv, k, 'POST', '/api/history/restore', { path: 'hogar/enlaces.md', id: before.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    await waitFor(() => links.text().includes('[[Proxy#Red]]') && !links.text().includes('[[GW#Red]]'), 'the editor shows the restored text')
    await waitFor(async () => (await versionsOf(srv, k, 'hogar/enlaces.md')).versions[0].change === 'restored', 'restored version')
    assert.equal(who((await versionsOf(srv, k, 'hogar/enlaces.md')).versions[0]), 'noa')
  } finally { closeAll(); await srv.stop() }
})

/** The server, killed at a history crash point while it does `act`, and started again without it. */
async function crashAt(point: string, act: (srv: Srv, cookie: string) => Promise<void>) {
  const { notes, env } = makeDirs()
  // First start: the history begins (its own commit), with no crash point.
  let srv = await startServer({ ...env, ...FAST })
  await srv.stop()
  srv = await startServer({ ...env, ...FAST, THOTH_TEST_CRASH_AT: point })
  const cookie = await login(srv)
  await act(srv, cookie)
  await waitFor(() => srv.proc.signalCode !== null || srv.proc.exitCode !== null, `killed at ${point}`, 15_000)
  assert.equal(srv.proc.signalCode, 'SIGKILL')
  closeAll()
  srv = await startServer({ ...env, ...FAST })
  return { srv, cookie: await login(srv), notes }
}

test('kill -9 after a version is journaled and before git has it: the version keeps its author', async () => {
  const { srv, cookie } = await crashAt('history-queued', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q('tags.md')}`)
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'ANTES-DEL-KILL\n' }, { 'if-match': `"${cur.body.etag}"` })
  })
  try {
    await waitFor(async () => (await versionsOf(srv, cookie, 'tags.md')).versions.length === 2, 'the version is committed after the restart')
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map(who), ['noa', 'system'])
    assert.ok((await textOf(srv, cookie, 'tags.md', versions[0].id)).includes('ANTES-DEL-KILL'))
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 right after a write reaches the disk, before the history recorded it: the version keeps its author', async () => {
  const { srv, cookie, notes } = await crashAt('history-written', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q('tags.md')}`)
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'JUSTO-ANTES-DEL-KILL\n' }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  })
  try {
    assert.ok(readFileSync(join(notes, 'tags.md'), 'utf8').includes('JUSTO-ANTES-DEL-KILL'), 'the write reached the disk')
    await waitFor(async () => (await versionsOf(srv, cookie, 'tags.md')).versions.length === 2, 'the version')
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [['noa', false], ['system', false]])
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 after git has a commit and before the journal knows: it is not repeated', async () => {
  const { srv, cookie } = await crashAt('history-committed', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q('tags.md')}`)
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'UNA-VEZ\n' }, { 'if-match': `"${cur.body.etag}"` })
  })
  try {
    await sleep(1500)
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map(who), ['noa', 'system'])
    const changes = (await api(srv, cookie, 'GET', '/api/history/changes')).body.changes
    assert.equal(changes.filter((c: any) => c.files.some((f: any) => f.path === 'tags.md')).length, 2)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 after a flush is journaled and before the file is written: the typed text comes back with its typist', async () => {
  const { srv, cookie, notes } = await crashAt('history-flushing', async (s, c) => {
    const ed = await connect(s, c, NOTE)
    typeLine(ed, 'TECLEADO-ANTES-DEL-KILL')
  })
  try {
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('TECLEADO-ANTES-DEL-KILL'), 'the hub recovered the text')
    await waitFor(async () => (await versionsOf(srv, cookie, NOTE)).versions.length === 2, 'the typed version')
    const { versions } = await versionsOf(srv, cookie, NOTE)
    assert.deepEqual(versions.map(who), ['noa', 'system'])
    assert.equal(versions[0].foundAtStartup, false)
    assert.ok((await textOf(srv, cookie, NOTE, versions[0].id)).includes('TECLEADO-ANTES-DEL-KILL'))
  } finally { closeAll(); await srv.stop() }
})
