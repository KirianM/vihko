// The history with the collaboration hub, on a real server: who typed each
// version, direct writes and external changes on open notes, restoring an
// open note, and kill -9 at the recorder's crash points.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVERYONE } from './_permissions.ts'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Srv } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'
const q = encodeURIComponent
const FAST = { THOTH_HISTORY_QUIET_SECONDS: '0.4', THOTH_HISTORY_MAX_SECONDS: '30' }

function withAna(env: Record<string, string>) {
  spawnSync(process.execPath, [CLI, 'user', 'create', 'ana'], { env: { ...process.env, ...env }, input: 'a-long-password' })
  // ana edits everything, as before M4 (_permissions.ts).
  writeFileSync(join(env.THOTH_NOTES_DIR!, 'thoth.yaml'), EVERYONE)
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

test('someone who starts writing where another was closes their version first, with the text from before; whoever was writing goes on with them', async () => {
  const { notes, env } = makeDirs()
  withAna(env)
  const srv = await startServer({ ...env, ...FAST, THOTH_HISTORY_QUIET_SECONDS: '1.5' })
  try {
    const k = await login(srv)
    const a = await loginAs(srv, 'ana')
    const ck = await connect(srv, k, NOTE)
    const ca = await connect(srv, a, NOTE)
    typeLine(ck, 'K-TYPED-1')
    await waitFor(() => ca.text().includes('K-TYPED-1'), 'Noa\'s typing reaches Ana')
    // Ana's first change closes Noa's version as it was right before it (D-034 3.4).
    typeLine(ca, 'A-TYPED-1')
    await waitFor(() => ck.text().includes('A-TYPED-1'), 'Ana\'s typing reaches Noa')
    // Noa was already writing: he goes on in Ana's version, without closing it.
    typeLine(ck, 'K-TYPED-2')
    await waitFor(() => { const t = readFileSync(join(notes, NOTE), 'utf8'); return t.includes('K-TYPED-2') && t.includes('A-TYPED-1') }, 'flush of both')
    const open = await versionsOf(srv, k, NOTE)
    assert.deepEqual(open.pending.authors.map((x: any) => x.name).sort(), ['ana', 'noa'])
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length === 3, 'the version closes after the quiet time')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), ['ana,noa', 'noa', 'system'])
    const first = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(first.includes('K-TYPED-1') && !first.includes('A-TYPED-1'), 'Noa\'s version is the text right before Ana\'s first change')
    const second = await textOf(srv, k, NOTE, versions[0].id)
    assert.ok(second.includes('A-TYPED-1') && second.includes('K-TYPED-2'))
    assert.equal(versions[0].change, 'modified')
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

test('a direct write to an open note without a uid: the uid the hub adds on flushing is part of that write\'s version', async () => {
  const { notes, env } = makeDirs()
  withAna(env)
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await loginAs(srv, 'ana')
    await connect(srv, k, NOTE) // open, nobody types
    assert.ok(!readFileSync(join(notes, NOTE), 'utf8').includes('uid:'))
    assert.equal((await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'ANA-API\n' }] })).status, 200)
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('uid:'), 'flushed with a uid')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 2, 'the version closes')
    await sleep(800)
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), ['ana', 'system'])
    assert.match(await textOf(srv, k, NOTE, versions[0].id), /uid: \w+[\s\S]*ANA-API/)
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

test('external changes in a row to an open note are one version; typing in it closes that version first', async () => {
  const { notes, env } = makeDirs()
  // A quiet time long enough for both external saves to fall in one version.
  const srv = await startServer({ ...env, ...FAST, THOTH_HISTORY_QUIET_SECONDS: '4' })
  try {
    const k = await login(srv)
    const ck = await connect(srv, k, NOTE)
    const file = join(notes, NOTE)
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Red', '## Red (OUTSIDE-1)'))
    await waitFor(() => ck.text().includes('OUTSIDE-1'), 'the first save reaches the editor')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Red (OUTSIDE-1)', '## Red (OUTSIDE-1) (OUTSIDE-2)'))
    await waitFor(() => ck.text().includes('OUTSIDE-2'), 'the second save reaches the editor')
    const open = await versionsOf(srv, k, NOTE)
    assert.deepEqual(open.versions.map(who), ['system'])
    assert.deepEqual(open.pending.authors.map((a: any) => a.kind), ['external'])
    typeLine(ck, 'TYPED-AFTER')
    await waitFor(() => readFileSync(file, 'utf8').includes('TYPED-AFTER'), 'flush')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'the typed version closes too', 15_000)
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), ['noa', 'external', 'system'])
    const ext = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(ext.includes('(OUTSIDE-1) (OUTSIDE-2)') && !ext.includes('TYPED-AFTER'), 'both saves, and nothing typed after them')
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

/**
 * The server, killed at a history crash point while it does `act`, and
 * started again without it. `dead` looks at the state volume in between.
 */
// The write that sets a crash off may get no answer: under load, the kill can
// come before its response leaves (what the test checks is what survives).
async function crashAt(point: string, act: (srv: Srv, cookie: string) => Promise<void>, dead?: (stateDir: string) => void) {
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
  dead?.(env.THOTH_STATE_DIR)
  srv = await startServer({ ...env, ...FAST })
  return { srv, cookie: await login(srv), notes, stateDir: env.THOTH_STATE_DIR }
}

test('kill -9 after a version is journaled and before git has it: the version keeps its author', async () => {
  const { srv, cookie } = await crashAt('history-queued', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q('tags.md')}`)
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'ANTES-DEL-KILL\n' }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
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
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'UNA-VEZ\n' }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  })
  try {
    await sleep(1500)
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map(who), ['noa', 'system'])
    const changes = (await api(srv, cookie, 'GET', '/api/history/changes')).body.changes
    assert.equal(changes.filter((c: any) => c.files.some((f: any) => f.path === 'tags.md')).length, 2)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 while git commits a version, holding its locks: the restart removes what git left, and the version reaches git once', async () => {
  const LOCKS = ['refs/heads/main.lock', 'HEAD.lock']
  let left: string[] = []
  let head = ''
  const { srv, cookie, stateDir } = await crashAt('history-importing', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q('tags.md')}`)
    await api(s, c, 'PUT', `/api/note?path=${q('tags.md')}`, { text: cur.body.text + 'EN-MITAD-DE-GIT\n' }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  }, (state) => {
    left = LOCKS.filter((f) => existsSync(join(state, 'history.git', f)))
    head = readFileSync(join(state, 'history.git', 'refs/heads/main'), 'utf8').trim()
  })
  try {
    assert.deepEqual(left, LOCKS, 'git died holding its locks')
    await waitFor(async () => (await versionsOf(srv, cookie, 'tags.md')).versions.length === 2, 'the version is committed after the restart')
    assert.deepEqual((await api(srv, cookie, 'GET', '/api/history/status')).body, { mode: 'managed', available: true, error: null })
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map(who), ['noa', 'system'])
    assert.ok((await textOf(srv, cookie, 'tags.md', versions[0].id)).includes('EN-MITAD-DE-GIT'))
    // On top of the commit git had before the kill, once.
    const changes = (await api(srv, cookie, 'GET', '/api/history/changes')).body.changes
    assert.equal(changes[1].id, head)
    assert.equal(changes.filter((c: any) => c.files.some((f: any) => f.path === 'tags.md')).length, 2)
    assert.deepEqual(LOCKS.filter((f) => existsSync(join(stateDir, 'history.git', f))), [])
    const log = srv.out.join('')
    for (const f of LOCKS) assert.ok(log.includes(`removed a stale git lock left by a crash: ${f}`), log)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 while an external version is open: it comes back as seen while thoth ran, not as found at startup', async () => {
  const { srv, cookie } = await crashAt('history-external', async (s) => {
    // Another editor saves; the watcher sees it and the version opens (journaled) before the kill.
    writeFileSync(join(s.env.THOTH_NOTES_DIR!, 'tags.md'), 'GUARDADO-FUERA-ANTES-DEL-KILL\n')
  })
  try {
    await waitFor(async () => (await versionsOf(srv, cookie, 'tags.md')).versions.length === 2, 'the external version closes after the restart')
    const { versions } = await versionsOf(srv, cookie, 'tags.md')
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [['external', false], ['system', false]])
    assert.equal(await textOf(srv, cookie, 'tags.md', versions[0].id), 'GUARDADO-FUERA-ANTES-DEL-KILL\n')
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
