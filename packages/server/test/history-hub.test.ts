// The history with the collaboration hub, on a real server: who typed each
// version, direct writes and external changes on open notes, restoring an
// open note, and kill -9 at the recorder's crash points.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { everyone, inShared } from './_permissions.ts'
import { CLI, adminOf, api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Srv } from './_collab.ts'
import { mother, type NewUser } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** What the tests type and write: words nothing else in a note has. */
const OUTSIDE = m.aUniqueWord()
const [OUTSIDE_1, OUTSIDE_2, MEMBER_TYPED_1, BEFORE_KILL, MID_GIT, FROM_THE_API, SAVED_OUTSIDE, JUST_BEFORE_KILL, ADMIN_TYPED_1, ADMIN_TYPED_2, MEMBER_API, TYPED_BEFORE_KILL, TYPED_AFTER, TYPED_BEFORE, TYPED_FIRST, ONCE] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]

// The setup copies the fixed vault (testdata/vault) into the shared space: this note, its «## Red»
// heading, hogar/enlaces.md that links to it and tags.md are the vault's.
// What is typed or written is the mother's.
const NOTE = inShared('hogar/Proxy.md')
const TAGS = inShared('tags.md')
const LINKS = inShared('hogar/enlaces.md')
const q = encodeURIComponent
const FAST = { VIHKO_HISTORY_QUIET_SECONDS: '0.4', VIHKO_HISTORY_MAX_SECONDS: '30' }

/** A member (new) beside the admin of makeDirs; both edit everything, as before M4 (_permissions.ts). */
function withMember(env: Record<string, string>, admin: NewUser): NewUser {
  const member = m.aUser({ role: 'member' })
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  writeFileSync(join(env.VIHKO_NOTES_DIR!, 'vihko.yaml'), everyone(admin.username, member.username))
  return member
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
  const { notes, env, admin } = makeDirs()
  const member = withMember(env, admin)
  const srv = await startServer({ ...env, ...FAST, VIHKO_HISTORY_QUIET_SECONDS: '1.5' })
  try {
    const k = await login(srv)
    const a = await login(srv, member)
    const ck = await connect(srv, k, NOTE)
    const ca = await connect(srv, a, NOTE)
    typeLine(ck, ADMIN_TYPED_1)
    await waitFor(() => ca.text().includes(ADMIN_TYPED_1), 'the admin\'s typing reaches the member')
    // The member's first change closes the admin's version as it was right before it: a new writer starts a new version.
    typeLine(ca, MEMBER_TYPED_1)
    await waitFor(() => ck.text().includes(MEMBER_TYPED_1), 'the member\'s typing reaches the admin')
    // The admin was already writing: they go on in the member's version, without closing it.
    typeLine(ck, ADMIN_TYPED_2)
    await waitFor(() => { const t = readFileSync(join(notes, NOTE), 'utf8'); return t.includes(ADMIN_TYPED_2) && t.includes(MEMBER_TYPED_1) }, 'flush of both')
    const open = await versionsOf(srv, k, NOTE)
    assert.deepEqual(open.pending.authors.map((x: any) => x.name).sort(), [admin.username, member.username].sort())
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length === 3, 'the version closes after the quiet time')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), [`${member.username},${admin.username}`, admin.username, 'system'])
    const first = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(first.includes(ADMIN_TYPED_1) && !first.includes(MEMBER_TYPED_1), 'the admin\'s version is the text right before the member\'s first change')
    const second = await textOf(srv, k, NOTE, versions[0].id)
    assert.ok(second.includes(MEMBER_TYPED_1) && second.includes(ADMIN_TYPED_2))
    assert.equal(versions[0].change, 'modified')
  } finally { closeAll(); await srv.stop() }
})

test('a direct write to an open note is its own version; what was typed before it closes first, with the text from before', async () => {
  const { env, admin } = makeDirs()
  const member = withMember(env, admin)
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await login(srv, member)
    const ck = await connect(srv, k, NOTE)
    typeLine(ck, TYPED_BEFORE)
    await sleep(50) // typed, not necessarily flushed yet
    const edit = await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${FROM_THE_API}\n` }] })
    assert.equal(edit.status, 200)
    await waitFor(() => ck.text().includes(FROM_THE_API), 'the write reaches the editor')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'both versions')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.slice(0, 2).map(who), [member.username, admin.username])
    const typed = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(typed.includes(TYPED_BEFORE) && !typed.includes(FROM_THE_API), 'the typed version is the text right before the write')
    assert.ok((await textOf(srv, k, NOTE, versions[0].id)).includes(FROM_THE_API))
  } finally { closeAll(); await srv.stop() }
})

test('a direct write to an open note without a uid: the uid the hub adds on flushing is part of that write\'s version', async () => {
  const { notes, env, admin } = makeDirs()
  const member = withMember(env, admin)
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await login(srv, member)
    await connect(srv, k, NOTE) // open, nobody types
    assert.ok(!readFileSync(join(notes, NOTE), 'utf8').includes('uid:'))
    assert.equal((await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${MEMBER_API}\n` }] })).status, 200)
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('uid:'), 'flushed with a uid')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 2, 'the version closes')
    await sleep(800)
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), [member.username, 'system'])
    assert.match(await textOf(srv, k, NOTE, versions[0].id), new RegExp(`uid: \\w+[\\s\\S]*${MEMBER_API}`))
  } finally { closeAll(); await srv.stop() }
})

test('an external change to an open note is its own version, after what was typed', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const ck = await connect(srv, k, NOTE)
    typeLine(ck, TYPED_FIRST)
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes(TYPED_FIRST), 'flush')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Red', `## Red (${OUTSIDE})`))
    await waitFor(() => ck.text().includes(`(${OUTSIDE})`), 'merged into the editor')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'versions')
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.slice(0, 2).map(who), ['external', adminOf(srv).username])
    const ext = await textOf(srv, k, NOTE, versions[0].id)
    assert.ok(ext.includes(`(${OUTSIDE})`) && ext.includes(TYPED_FIRST))
  } finally { closeAll(); await srv.stop() }
})

test('external changes in a row to an open note are one version; typing in it closes that version first', async () => {
  const { notes, env } = makeDirs()
  // A quiet time long enough for both external saves to fall in one version.
  const srv = await startServer({ ...env, ...FAST, VIHKO_HISTORY_QUIET_SECONDS: '4' })
  try {
    const k = await login(srv)
    const ck = await connect(srv, k, NOTE)
    const file = join(notes, NOTE)
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Red', `## Red (${OUTSIDE_1})`))
    await waitFor(() => ck.text().includes(OUTSIDE_1), 'the first save reaches the editor')
    writeFileSync(file, readFileSync(file, 'utf8').replace(`## Red (${OUTSIDE_1})`, `## Red (${OUTSIDE_1}) (${OUTSIDE_2})`))
    await waitFor(() => ck.text().includes(OUTSIDE_2), 'the second save reaches the editor')
    const open = await versionsOf(srv, k, NOTE)
    assert.deepEqual(open.versions.map(who), ['system'])
    assert.deepEqual(open.pending.authors.map((a: any) => a.kind), ['external'])
    typeLine(ck, TYPED_AFTER)
    await waitFor(() => readFileSync(file, 'utf8').includes(TYPED_AFTER), 'flush')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.length >= 3, 'the typed version closes too', 15_000)
    const { versions } = await versionsOf(srv, k, NOTE)
    assert.deepEqual(versions.map(who), [adminOf(srv).username, 'external', 'system'])
    const ext = await textOf(srv, k, NOTE, versions[1].id)
    assert.ok(ext.includes(`(${OUTSIDE_1}) (${OUTSIDE_2})`) && !ext.includes(TYPED_AFTER), 'both saves, and nothing typed after them')
  } finally { closeAll(); await srv.stop() }
})

test('another program undoing its own change on an open note: only external versions, and vihko writes nothing of its own', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const ck = await connect(srv, k, NOTE)
    const file = join(notes, NOTE)
    const original = readFileSync(file, 'utf8')
    const [first, second] = [m.aUniqueWord(), m.aUniqueWord()]
    const b = original.replace('## Red', `## Red (${first})`)
    const c = b.replace(`(${first})`, `(${first}) (${second})`)
    for (const text of [b, c]) {
      writeFileSync(file, text)
      await waitFor(() => ck.text() === text, 'the save reaches the editor')
    }
    writeFileSync(file, b) // it removes what it added last
    await sleep(2500) // past the hub's check of the file and its flush debounce (1 s each)
    const shown = ck.text()
    ck.close()
    await waitFor(() => !existsSync(join(env.VIHKO_STATE_DIR!, 'collab', `${q(NOTE)}.ylog`)), 'the note is closed')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).pending === null, 'the versions close')
    const { versions } = await versionsOf(srv, k, NOTE)
    // The vault's own version (history enabled), then only what the program saved.
    assert.ok(versions.every((v: any) => v.reason?.code !== 'recovered'), JSON.stringify(versions.map((v: any) => [who(v), v.reason])))
    assert.deepEqual(versions.slice(0, -1).map(who), versions.slice(0, -1).map(() => 'external'))
    assert.equal(await textOf(srv, k, NOTE, versions[0].id), b)
    assert.equal(readFileSync(file, 'utf8'), b, 'the file keeps the revert')
    assert.equal(shown, b, 'the revert reached the editor')
  } finally { closeAll(); await srv.stop() }
})

test('a rename rewrites the links of an open note in the same system commit, and restoring an open note changes it for its editors at once', async () => {
  const { env } = makeDirs()
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const links = await connect(srv, k, LINKS)
    const title = m.aTitle()
    const mv = await api(srv, k, 'POST', '/api/note/move', { from: NOTE, to: inShared(`hogar/${title}.md`) })
    assert.equal(mv.status, 200)
    await waitFor(() => links.text().includes(`[[${title}#Red]]`), 'the rewrite reaches the open note')
    await waitFor(async () => ((await api(srv, k, 'GET', '/api/history/changes')).body.changes[0]?.reason?.code === 'note_moved'), 'the system commit')
    const system = (await api(srv, k, 'GET', '/api/history/changes')).body.changes[0]
    assert.deepEqual(system.files.map((f: any) => f.path), [LINKS])
    // Restore the version before the rename on the open note.
    const { versions } = await versionsOf(srv, k, LINKS)
    const before = versions.find((v: any) => v.reason?.code === 'history_enabled')
    const r = await api(srv, k, 'POST', '/api/history/restore', { path: LINKS, id: before.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    await waitFor(() => links.text().includes('[[Proxy#Red]]') && !links.text().includes(`[[${title}#Red]]`), 'the editor shows the restored text')
    await waitFor(async () => (await versionsOf(srv, k, LINKS)).versions[0].change === 'restored', 'restored version')
    assert.equal(who((await versionsOf(srv, k, LINKS)).versions[0]), adminOf(srv).username)
  } finally { closeAll(); await srv.stop() }
})

/**
 * The server, killed at a history crash point while it does `act`, and
 * started again without it. `dead` looks at the state volume in between.
 */
// The write that sets a crash off may get no answer: under load, the kill can
// come before its response leaves (what the test checks is what survives).
// The crash point only fires for a commit touching tags.md, never for one
// the system makes at startup (VIHKO_TEST_CRASH_PATH).
async function crashAt(point: string, act: (srv: Srv, cookie: string) => Promise<void>, dead?: (stateDir: string) => void) {
  const { notes, env } = makeDirs()
  // First start: the history begins (its own commit), with no crash point.
  let srv = await startServer({ ...env, ...FAST })
  await srv.stop()
  srv = await startServer({ ...env, ...FAST, VIHKO_TEST_CRASH_AT: point, VIHKO_TEST_CRASH_PATH: TAGS })
  const cookie = await login(srv)
  await act(srv, cookie)
  await waitFor(() => srv.proc.signalCode !== null || srv.proc.exitCode !== null, `killed at ${point}`, 15_000)
  assert.equal(srv.proc.signalCode, 'SIGKILL')
  closeAll()
  dead?.(env.VIHKO_STATE_DIR)
  srv = await startServer({ ...env, ...FAST })
  return { srv, cookie: await login(srv), notes, stateDir: env.VIHKO_STATE_DIR }
}

test('kill -9 after a version is journaled and before git has it: the version keeps its author', async () => {
  const { srv, cookie } = await crashAt('history-queued', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q(TAGS)}`)
    await api(s, c, 'PUT', `/api/note?path=${q(TAGS)}`, { text: cur.body.text + `${BEFORE_KILL}\n` }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  })
  try {
    await waitFor(async () => (await versionsOf(srv, cookie, TAGS)).versions.length === 2, 'the version is committed after the restart')
    const { versions } = await versionsOf(srv, cookie, TAGS)
    assert.deepEqual(versions.map(who), [adminOf(srv).username, 'system'])
    assert.ok((await textOf(srv, cookie, TAGS, versions[0].id)).includes(BEFORE_KILL))
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 right after a write reaches the disk, before the history recorded it: the version keeps its author', async () => {
  const { srv, cookie, notes } = await crashAt('history-written', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q(TAGS)}`)
    await api(s, c, 'PUT', `/api/note?path=${q(TAGS)}`, { text: cur.body.text + `${JUST_BEFORE_KILL}\n` }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  })
  try {
    assert.ok(readFileSync(join(notes, TAGS), 'utf8').includes(JUST_BEFORE_KILL), 'the write reached the disk')
    await waitFor(async () => (await versionsOf(srv, cookie, TAGS)).versions.length === 2, 'the version')
    const { versions } = await versionsOf(srv, cookie, TAGS)
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [[adminOf(srv).username, false], ['system', false]])
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 after git has a commit and before the journal knows: it is not repeated', async () => {
  const { srv, cookie, notes } = await crashAt('history-committed', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q(TAGS)}`)
    await api(s, c, 'PUT', `/api/note?path=${q(TAGS)}`, { text: cur.body.text + `${ONCE}\n` }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  })
  try {
    await sleep(1500)
    assert.ok(readFileSync(join(notes, TAGS), 'utf8').includes(ONCE), 'the write reached the disk')
    const { versions } = await versionsOf(srv, cookie, TAGS)
    assert.deepEqual(versions.map(who), [adminOf(srv).username, 'system'])
    const changes = (await api(srv, cookie, 'GET', '/api/history/changes')).body.changes
    assert.equal(changes.filter((c: any) => c.files.some((f: any) => f.path === TAGS)).length, 2)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 while git commits a version, holding its locks: the restart removes what git left, and the version reaches git once', async () => {
  const LOCKS = ['refs/heads/main.lock', 'HEAD.lock']
  let left: string[] = []
  let head = ''
  const { srv, cookie, stateDir } = await crashAt('history-importing', async (s, c) => {
    const cur = await api(s, c, 'GET', `/api/note?path=${q(TAGS)}`)
    await api(s, c, 'PUT', `/api/note?path=${q(TAGS)}`, { text: cur.body.text + `${MID_GIT}\n` }, { 'if-match': `"${cur.body.etag}"` }).catch(() => null)
  }, (state) => {
    left = LOCKS.filter((f) => existsSync(join(state, 'history.git', f)))
    head = readFileSync(join(state, 'history.git', 'refs/heads/main'), 'utf8').trim()
  })
  try {
    assert.deepEqual(left, LOCKS, 'git died holding its locks')
    await waitFor(async () => (await versionsOf(srv, cookie, TAGS)).versions.length === 2, 'the version is committed after the restart')
    assert.deepEqual((await api(srv, cookie, 'GET', '/api/history/status')).body, { mode: 'managed', available: true, error: null })
    const { versions } = await versionsOf(srv, cookie, TAGS)
    assert.deepEqual(versions.map(who), [adminOf(srv).username, 'system'])
    assert.ok((await textOf(srv, cookie, TAGS, versions[0].id)).includes(MID_GIT))
    // On top of the commit git had before the kill, once.
    const changes = (await api(srv, cookie, 'GET', '/api/history/changes')).body.changes
    assert.equal(changes[1].id, head)
    assert.equal(changes.filter((c: any) => c.files.some((f: any) => f.path === TAGS)).length, 2)
    assert.deepEqual(LOCKS.filter((f) => existsSync(join(stateDir, 'history.git', f))), [])
    const log = srv.out.join('')
    for (const f of LOCKS) assert.ok(log.includes(`removed a stale git lock left by a crash: ${f}`), log)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 while an external version is open: it comes back as seen while vihko ran, not as found at startup', async () => {
  const { srv, cookie } = await crashAt('history-external', async (s) => {
    // Another editor saves; the watcher sees it and the version opens (journaled) before the kill.
    writeFileSync(join(s.env.VIHKO_NOTES_DIR!, TAGS), `${SAVED_OUTSIDE}\n`)
  })
  try {
    await waitFor(async () => (await versionsOf(srv, cookie, TAGS)).versions.length === 2, 'the external version closes after the restart')
    const { versions } = await versionsOf(srv, cookie, TAGS)
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [['external', false], ['system', false]])
    assert.equal(await textOf(srv, cookie, TAGS, versions[0].id), `${SAVED_OUTSIDE}\n`)
  } finally { closeAll(); await srv.stop() }
})

test('kill -9 after a flush is journaled and before the file is written: the typed text comes back with its typist', async () => {
  const { srv, cookie, notes } = await crashAt('history-flushing', async (s, c) => {
    const ed = await connect(s, c, NOTE)
    typeLine(ed, TYPED_BEFORE_KILL)
  })
  try {
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes(TYPED_BEFORE_KILL), 'the hub recovered the text')
    await waitFor(async () => (await versionsOf(srv, cookie, NOTE)).versions.length === 2, 'the typed version')
    const { versions } = await versionsOf(srv, cookie, NOTE)
    assert.deepEqual(versions.map(who), [adminOf(srv).username, 'system'])
    assert.equal(versions[0].foundAtStartup, false)
    assert.ok((await textOf(srv, cookie, NOTE, versions[0].id)).includes(TYPED_BEFORE_KILL))
  } finally { closeAll(); await srv.stop() }
})
