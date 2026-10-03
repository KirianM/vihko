// A session that ends ends its live connections too (users.ts, the hub):
// disabling someone cuts their open editor and their key at once, and a new
// password ends the other sessions' editors, never the one that changed it.
// On a real server.
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminOf, api, closeAll, connect, login, makeDirs, startServer, typeLine, waitFor, type Client, type Srv } from './_collab.ts'
import { everyone, inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
// A note of the test vault (testdata/vault), which makeDirs copies.
const NOTE = inShared('hogar/Proxy.md')

/**
 * The notes folder, with its admin managing the shared space and a member (created
 * by the test) editing it (a member sees nothing until granted).
 */
function dirs() {
  const d = makeDirs()
  const member = m.aUser()
  writeFileSync(join(d.notes, 'vihko.yaml'), everyone(d.admin.username, member.username))
  return { ...d, member }
}

async function signIn(srv: Srv, username: string, password: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

/** What an editor hears: the hub's messages, and whether its connection is up. */
function watch(c: Client) {
  const heard: string[] = []
  let status = 'connected'
  c.provider.on('stateless', ({ payload }: { payload: string }) => { heard.push(JSON.parse(payload).type) })
  c.provider.on('status', ({ status: s }: { status: string }) => { status = s })
  return { heard, status: () => status }
}

test('disabling someone ends their open editor and their key at once', async () => {
  const { env, member } = dirs()
  const srv = await startServer(env)
  try {
    const admin = await login(srv)
    const created = await api(srv, admin, 'POST', '/api/admin/users', { username: member.username, role: 'member' })
    assert.equal(created.status, 201)
    assert.equal((await api(srv, '', 'POST', `/api/invite/${created.body.link.token}`, { password: member.password })).status, 200)
    // The member makes a key of her own: the admin lets members (off on a new vihko).
    assert.equal((await api(srv, admin, 'PUT', '/api/admin/integrations', { api: true, membersCanCreateKeys: true })).status, 200)
    const session = await signIn(srv, member.username, member.password)
    const key = { authorization: `Bearer ${(await api(srv, session, 'POST', '/api/keys', { name: m.aKeyName(), canWrite: true, confirm: member.password })).body.token}` }
    assert.equal((await api(srv, '', 'GET', '/api/tree', undefined, key)).status, 200)

    const editor = await connect(srv, session, NOTE)
    const seen = watch(editor)
    const bystander = await connect(srv, admin, NOTE)
    const other = watch(bystander)

    assert.equal((await api(srv, admin, 'POST', `/api/admin/users/${created.body.user.id}/disable`, { confirm: adminOf(srv).password })).status, 200)
    await waitFor(() => seen.heard.includes('vihko:session-ended'), 'the editor is told its session ended')
    await waitFor(() => seen.status() === 'disconnected', 'and its connection closes')
    assert.equal((await api(srv, '', 'GET', '/api/tree', undefined, key)).status, 401, 'the key stops at once')
    // It tries to reconnect, and the hub refuses it: what it types never reaches anyone.
    const afterDisable = m.aUniqueWord()
    typeLine(editor, afterDisable)
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(!bystander.text().includes(afterDisable))
    assert.notEqual(seen.status(), 'connected')
    assert.ok(!other.heard.includes('vihko:session-ended'), 'someone else\'s editor goes on')
    assert.equal(other.status(), 'connected')
  } finally {
    closeAll()
    await srv.stop()
  }
})

test('a new password ends the editors of the other sessions, not the one that changed it', async () => {
  const { env, admin: who } = dirs()
  const srv = await startServer(env)
  try {
    const admin = await login(srv)
    const second = await login(srv)
    const here = await connect(srv, admin, NOTE)
    const there = await connect(srv, second, NOTE)
    const hereSeen = watch(here)
    const thereSeen = watch(there)
    const r = await api(srv, admin, 'POST', '/api/auth/password', { current: who.password, password: m.aPassword(), endSessions: true })
    assert.equal(r.status, 200)
    await waitFor(() => thereSeen.status() === 'disconnected', 'the other session\'s editor closes')
    assert.ok(thereSeen.heard.includes('vihko:session-ended'))
    const stillHere = m.aUniqueWord()
    typeLine(here, stillHere)
    await waitFor(async () => (await api(srv, admin, 'GET', `/api/note?path=${encodeURIComponent(NOTE)}`)).body?.text?.includes(stillHere), 'this session keeps writing')
    assert.ok(!hereSeen.heard.includes('vihko:session-ended'))
    assert.equal(hereSeen.status(), 'connected')
  } finally {
    closeAll()
    await srv.stop()
  }
})

test('a session that expires on its own ends its open editor too, within seconds', async () => {
  const { env } = dirs()
  const srv = await startServer(env)
  try {
    const expiring = await login(srv)
    const staying = await login(srv)
    const a = await connect(srv, expiring, NOTE)
    const b = await connect(srv, staying, NOTE)
    const [seenA, seenB] = [watch(a), watch(b)]
    // The first session's time runs out (as the clock would make it), with nobody signing out.
    const db = new Database(join(env.VIHKO_STATE_DIR!, 'state.db'))
    try {
      const rows = db.prepare('select token_hash from sessions order by created_at').all() as { token_hash: string }[]
      assert.equal(rows.length, 2)
      db.prepare("update sessions set expires_at = '2000-01-01T00:00:00.000Z' where token_hash = ?").run(rows[0]!.token_hash)
    } finally { db.close() }
    await waitFor(() => seenA.status() === 'disconnected' || seenB.status() === 'disconnected', 'one editor ends', 15_000)
    assert.ok(seenA.heard.includes('vihko:session-ended') !== seenB.heard.includes('vihko:session-ended'), 'only the expired one')
  } finally {
    closeAll()
    await srv.stop()
  }
})
