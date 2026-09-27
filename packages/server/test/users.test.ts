// Users and groups (M4, D-038.3 and .8): one-time links, disabling and
// deleting, the last admin, groups, one's own account and sessions, and
// state.db's migration. The hub's connections of a disabled user are in
// users-hub.test.ts (a real server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { STATE_VERSION, openState } from '@thoth/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const PASSWORD = 'a-long-password'

/** Signs in with a password: the session cookie, or the status if it failed. */
async function login(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, username: string, password = PASSWORD) {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  return res.status === 200 ? res.headers.get('set-cookie')!.split(';')[0]! : res.status
}

/** A request with no session (a link's page). */
async function anon(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) as any, cookie: res.headers.get('set-cookie') }
}

test('an invitation: the admin creates someone, they choose their password with the link once, and they are in', async () => {
  const s = await setup()
  try {
    const created = await s.noa('POST', '/api/admin/users', { username: 'marta', role: 'member' })
    assert.equal(created.status, 201)
    const { user, link } = created.body
    assert.deepEqual([user.username, user.role, user.status, user.link.kind], ['marta', 'member', 'invited', 'invite'])
    assert.equal(link.kind, 'invite')
    assert.match(link.path, /^\/invite\/[A-Za-z0-9_-]{43}$/)
    assert.equal(link.url, null, 'no public URL: the UI puts its own origin in front')
    assert.equal(Date.parse(link.expiresAt) - Date.now() > 6.9 * 86_400_000, true, 'valid for 7 days')
    const token = link.token as string
    assert.equal(await login(s.app, 'marta', ''), 401, 'no password until they choose one')

    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${token}`)).body, { kind: 'invite', username: 'marta' })
    const weak = await anon(s.app, 'POST', `/api/invite/${token}`, { password: 'short' })
    assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
    assert.equal((await anon(s.app, 'GET', `/api/invite/${token}`)).status, 200, 'a weak password leaves the link unused')

    const accepted = await anon(s.app, 'POST', `/api/invite/${token}`, { password: 'marta-long-password' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.user.username, 'marta')
    const cookie = accepted.cookie!.split(';')[0]!
    const me = await s.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal((await me.json() as any).user.username, 'marta', 'signed in by the link')
    assert.equal(typeof await login(s.app, 'marta', 'marta-long-password'), 'string')

    // Used: the same neutral answer as a link that never existed.
    for (const t of [token, 'x'.repeat(43), 'nonsense']) {
      assert.deepEqual([(await anon(s.app, 'GET', `/api/invite/${t}`)).body.error], ['invalid_link'], t)
    }
    assert.deepEqual((await anon(s.app, 'POST', `/api/invite/${token}`, { password: 'another-long-password' })).body.error, 'invalid_link')
    const listed = (await s.noa('GET', '/api/admin/users')).body.users.find((u: any) => u.username === 'marta')
    assert.deepEqual([listed.status, listed.link, listed.twoFactor], ['active', null, { enabled: false, enabledAt: null }])
  } finally {
    await s.close()
  }
})

test('links: a new one ends the previous one, they expire after 7 days, a reset ends the sessions, and none for someone disabled', async () => {
  const s = await setup()
  try {
    const { user, link: first } = (await s.noa('POST', '/api/admin/users', { username: 'marta', role: 'member' })).body
    const again = await s.noa('POST', `/api/admin/users/${user.id}/link`)
    assert.equal(again.body.link.kind, 'invite', 'still no password: an invitation')
    assert.equal((await anon(s.app, 'GET', `/api/invite/${first.token}`)).status, 404, 'the earlier link no longer works')
    assert.equal((await anon(s.app, 'POST', `/api/invite/${again.body.link.token}`, { password: 'marta-long-password' })).status, 200)

    // A reset for someone with a password, with a session open.
    const cookie = await login(s.app, 'marta', 'marta-long-password') as string
    const reset = (await s.noa('POST', `/api/admin/users/${user.id}/link`)).body.link
    assert.equal(reset.kind, 'reset')
    assert.equal((await s.app.request('/api/auth/me', { headers: { cookie } })).status, 200, 'a link alone ends nothing')
    assert.equal((await anon(s.app, 'POST', `/api/invite/${reset.token}`, { password: 'marta-new-password' })).status, 200)
    assert.equal((await s.app.request('/api/auth/me', { headers: { cookie } })).status, 401, 'using a reset ends every session')
    assert.equal(await login(s.app, 'marta', 'marta-long-password'), 401)

    // Expired: the same neutral answer.
    const late = (await s.noa('POST', `/api/admin/users/${user.id}/link`)).body.link
    s.auth.state.prepare("update user_links set expires_at = '2020-01-01T00:00:00.000Z'").run()
    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${late.token}`)).body.error, 'invalid_link')

    // Disabled: no new link, and a pending one stops working.
    const pending = (await s.noa('POST', `/api/admin/users/${user.id}/link`)).body.link
    await s.noa('POST', `/api/admin/users/${user.id}/disable`)
    assert.equal((await anon(s.app, 'GET', `/api/invite/${pending.token}`)).status, 404)
    const none = await s.noa('POST', `/api/admin/users/${user.id}/link`)
    assert.deepEqual([none.status, none.body.error], [409, 'user_disabled'])
  } finally {
    await s.close()
  }
})

test('guessing links counts in the login limits', async () => {
  const s = await setup()
  try {
    let status = 0
    for (let i = 0; i < 8 && status !== 429; i++) status = (await anon(s.app, 'GET', `/api/invite/${'a'.repeat(42)}${i}`)).status
    assert.equal(status, 429)
  } finally {
    await s.close()
  }
})

test('the admin only: members get 403, and only see names in the directory', async () => {
  const s = await setup()
  try {
    for (const [method, path] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['GET', '/api/admin/groups'], ['POST', '/api/admin/groups'], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings']] as const) {
      assert.equal((await s.ana(method, path, method === 'GET' ? undefined : {})).status, 403, `${method} ${path}`)
    }
    await s.noa('POST', '/api/admin/groups', { name: 'familia' })
    const dir = await s.ana('GET', '/api/directory')
    assert.deepEqual(dir.body, { users: ['ana', 'noa'], groups: ['familia'] })
  } finally {
    await s.close()
  }
})

test('the last active admin can\'t be demoted, disabled or deleted; with another one, they can', async () => {
  const s = await setup()
  try {
    const id = s.users.noa.id
    for (const [method, path, body] of [['PUT', `/api/admin/users/${id}/role`, { role: 'member' }], ['POST', `/api/admin/users/${id}/disable`, undefined]] as const) {
      const r = await s.noa(method, path, body)
      assert.deepEqual([r.status, r.body.error], [409, 'last_admin'], path)
    }
    // An invited admin can't sign in yet: they don't count.
    const invited = (await s.noa('POST', '/api/admin/users', { username: 'laura', role: 'admin' })).body
    assert.equal((await s.noa('PUT', `/api/admin/users/${id}/role`, { role: 'member' })).body.error, 'last_admin')
    await anon(s.app, 'POST', `/api/invite/${invited.link.token}`, { password: 'laura-long-password' })
    const demoted = await s.noa('PUT', `/api/admin/users/${id}/role`, { role: 'member' })
    assert.deepEqual([demoted.status, demoted.body.user.role], [200, 'member'])
    assert.equal((await s.noa('GET', '/api/admin/users')).status, 403, 'the role applies at once')
    const laura = await login(s.app, 'laura', 'laura-long-password') as string
    const bad = await s.app.request(`/api/admin/users/${id}/role`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: laura }, body: JSON.stringify({ role: 'owner' }) })
    assert.equal(bad.status, 400, 'only admin or member')
  } finally {
    await s.close()
  }
})

test('disabling cuts sessions, keys and OAuth at once and keeps them for later; deleting leaves a tombstone', async () => {
  const s = await setup()
  try {
    await s.enableApi()
    const ana = s.users.ana.id
    const { key: k, token } = await s.newKey({ name: 'Script de Ana' }, 'ana')
    const key = s.withKey(token)
    assert.equal((await key('GET', '/api/tree')).status, 200)
    const cookie = await login(s.app, 'ana') as string

    // Deleting needs a disabled user.
    const early = await s.noa('DELETE', `/api/admin/users/${ana}`)
    assert.deepEqual([early.status, early.body.error], [409, 'not_disabled'])

    const disabled = await s.noa('POST', `/api/admin/users/${ana}/disable`)
    assert.equal(disabled.body.user.status, 'disabled')
    assert.equal((await s.ana('GET', '/api/tree')).status, 401, 'their sessions ended')
    assert.equal((await s.app.request('/api/tree', { headers: { cookie } })).status, 401)
    assert.equal((await key('GET', '/api/tree')).status, 401, 'their key stops working')
    assert.equal(await login(s.app, 'ana'), 401, 'they can\'t sign in')
    assert.equal(s.services.keys.principal(k.id, 'oauth'), null, 'nor anything given through OAuth (its tokens reach its user through this)')

    // Enabled again: the key works again (it was never revoked); sessions start anew.
    await s.noa('POST', `/api/admin/users/${ana}/enable`)
    assert.equal((await key('GET', '/api/tree')).status, 200)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie } })).status, 401, 'old sessions stay ended')
    assert.equal(typeof await login(s.app, 'ana'), 'string')

    // Deleted: the grants hook runs first; if it fails, nothing is deleted.
    const calls: string[] = []
    s.services.users.hooks.onUserDeleted = () => { throw new Error('thoth.yaml could not be written') }
    await s.noa('POST', `/api/admin/users/${ana}/disable`)
    assert.equal((await s.noa('DELETE', `/api/admin/users/${ana}`)).status, 500)
    assert.ok((await s.noa('GET', '/api/admin/users')).body.users.some((u: any) => u.username === 'ana'), 'still there')
    s.services.users.hooks.onUserDeleted = (name) => { calls.push(name) }
    await s.noa('POST', '/api/admin/groups', { name: 'familia' }).then((g) => s.noa('POST', `/api/admin/groups/${g.body.group.id}/members`, { userId: ana }))
    assert.equal((await s.noa('DELETE', `/api/admin/users/${ana}`)).status, 200)
    assert.deepEqual(calls, ['ana'])
    assert.ok(!(await s.noa('GET', '/api/admin/users')).body.users.some((u: any) => u.username === 'ana'))
    assert.deepEqual((await s.noa('GET', '/api/directory')).body, { users: ['noa'], groups: ['familia'] })
    assert.deepEqual((await s.noa('GET', '/api/admin/groups')).body.groups[0].members, [])
    assert.equal(s.auth.username(ana), 'ana', 'the history still names them')
    assert.equal((await key('GET', '/api/tree')).status, 401)
    assert.equal(s.services.keys.list(ana)[0]!.status, 'revoked')
    assert.equal(s.services.keys.nameOf(s.services.keys.list(ana)[0]!.id), 'Script de Ana', 'the key keeps its name, for the history')
    assert.ok(!(await s.noa('GET', '/api/keys?all=1')).body.keys.some((k: any) => k.userId === ana && k.status !== 'revoked'))
    const again = await s.noa('POST', '/api/admin/users', { username: 'Ana', role: 'member' })
    assert.deepEqual([again.status, again.body.error], [409, 'user_exists'], 'the name is never given to someone else')
    for (const path of [`/api/admin/users/${ana}/enable`, `/api/admin/users/${ana}/link`]) assert.equal((await s.noa('POST', path)).status, 404, path)
  } finally {
    await s.close()
  }
})

test('the admin closes someone\'s sessions', async () => {
  const s = await setup()
  try {
    const other = await login(s.app, 'ana') as string
    const r = await s.noa('DELETE', `/api/admin/users/${s.users.ana.id}/sessions`)
    assert.equal(r.body.ended, 2)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie: other } })).status, 401)
    assert.equal(typeof await login(s.app, 'ana'), 'string', 'they can sign in again')
  } finally {
    await s.close()
  }
})

test('groups: created, renamed and deleted by the admin (the grants hooks first), with members', async () => {
  const s = await setup()
  try {
    const renamed: [string, string][] = []
    const deleted: string[] = []
    s.services.users.hooks.onGroupRenamed = (from, to) => { renamed.push([from, to]) }
    s.services.users.hooks.onGroupDeleted = (name) => { deleted.push(name) }
    const g = (await s.noa('POST', '/api/admin/groups', { name: 'familia' })).body.group
    assert.deepEqual([(await s.noa('POST', '/api/admin/groups', { name: 'Familia' })).body.error], ['group_exists'])
    for (const name of ['', 'x', '@familia', 'con espacio', 'a/b']) assert.deepEqual((await s.noa('POST', '/api/admin/groups', { name })).body.error, 'invalid_group_name', name)
    await s.noa('POST', `/api/admin/groups/${g.id}/members`, { userId: s.users.ana.id })
    const both = await s.noa('POST', `/api/admin/groups/${g.id}/members`, { userId: s.users.noa.id })
    assert.deepEqual(both.body.group.members.map((m: any) => m.username), ['ana', 'noa'])
    assert.deepEqual(s.services.users.groupsOf(s.users.ana.id), ['familia'])
    const list = (await s.noa('GET', '/api/admin/users')).body.users
    assert.deepEqual(list.find((u: any) => u.username === 'ana').groups, ['familia'])

    const r = await s.noa('PATCH', `/api/admin/groups/${g.id}`, { name: 'casa' })
    assert.equal(r.body.group.name, 'casa')
    assert.deepEqual(renamed, [['familia', 'casa']])
    assert.deepEqual(s.services.users.groupsOf(s.users.ana.id), ['casa'])
    await s.noa('DELETE', `/api/admin/groups/${g.id}/members/${s.users.ana.id}`)
    assert.deepEqual(s.services.users.groupsOf(s.users.ana.id), [])
    s.services.users.hooks.onGroupRenamed = () => { throw new Error('no') }
    assert.equal((await s.noa('PATCH', `/api/admin/groups/${g.id}`, { name: 'hogar' })).status, 500)
    assert.equal((await s.noa('GET', '/api/admin/groups')).body.groups[0].name, 'casa', 'the hook failed: the name stays')
    assert.equal((await s.noa('DELETE', `/api/admin/groups/${g.id}`)).status, 200)
    assert.deepEqual(deleted, ['casa'])
    assert.deepEqual(s.services.users.groupsOf(s.users.noa.id), [])
    assert.equal((await s.noa('DELETE', `/api/admin/groups/${g.id}`)).status, 404)
  } finally {
    await s.close()
  }
})

test('one\'s own account: sessions (the current one marked), closing the others, and a new password that ends them', async () => {
  const s = await setup()
  try {
    const other = await login(s.app, 'ana') as string
    const third = await login(s.app, 'ana') as string
    const list = (await s.ana('GET', '/api/account/sessions')).body.sessions
    assert.equal(list.length, 3)
    assert.equal(list.filter((x: any) => x.current).length, 1)
    assert.ok(list.every((x: any) => /^[0-9a-f]{32}$/.test(x.id) && !('token' in x) && !('token_hash' in x)))
    // One, by its id (the noa's session list doesn't have it).
    const target = list.find((x: any) => !x.current)
    assert.equal((await s.noa('DELETE', `/api/account/sessions/${target.id}`)).status, 404, 'only one\'s own')
    assert.equal((await s.ana('DELETE', `/api/account/sessions/${target.id}`)).status, 200)
    assert.equal((await s.ana('GET', '/api/account/sessions')).body.sessions.length, 2)
    assert.equal((await s.ana('DELETE', '/api/account/sessions')).body.ended, 1)
    for (const c of [other, third]) assert.equal((await s.app.request('/api/tree', { headers: { cookie: c } })).status, 401)
    assert.equal((await s.ana('GET', '/api/tree')).status, 200, 'the current one stays')

    const again = await login(s.app, 'ana') as string
    const wrong = await s.ana('POST', '/api/auth/password', { current: 'not-it-at-all', password: 'ana-new-password' })
    assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password'])
    const weak = await s.ana('POST', '/api/auth/password', { current: PASSWORD, password: 'short' })
    assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
    assert.equal((await s.ana('POST', '/api/auth/password', { current: PASSWORD, password: 'ana-new-password' })).status, 200)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie: again } })).status, 401, 'other sessions end')
    assert.equal((await s.ana('GET', '/api/tree')).status, 200, 'this one stays')
    assert.equal(await login(s.app, 'ana'), 401)
    assert.equal(typeof await login(s.app, 'ana', 'ana-new-password'), 'string')
  } finally {
    await s.close()
  }
})

test('the admin\'s settings: members downloading from the local network, off by default', async () => {
  const s = await setup()
  try {
    assert.deepEqual((await s.noa('GET', '/api/admin/settings')).body, { membersLocalDownloads: false, twoFactor: 'optional' })
    assert.deepEqual((await s.noa('PUT', '/api/admin/settings', { membersLocalDownloads: true })).body, { membersLocalDownloads: true, twoFactor: 'optional' })
    assert.equal((await s.noa('PUT', '/api/admin/settings', { membersLocalDownloads: 'yes' })).status, 400)
    assert.equal((await s.noa('PUT', '/api/admin/settings', { other: true })).status, 400)
  } finally {
    await s.close()
  }
})

test('the CLI gives a reset link (the way back for an admin who lost their password)', async () => {
  const s = await setup()
  try {
    const env = { ...process.env, THOTH_STATE_DIR: s.dir, THOTH_NOTES_DIR: s.notesDir, THOTH_PUBLIC_URL: 'https://notas.example.org' }
    const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-link', 'noa'], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const token = /https:\/\/notas\.example\.org\/invite\/([A-Za-z0-9_-]{43})/.exec(r.stdout)?.[1]
    assert.ok(token, r.stdout)
    assert.match(r.stdout, /password reset link for noa/)
    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${token}`)).body, { kind: 'reset', username: 'noa' }, 'a running thoth reads it at once')
    const none = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-link', 'nadie'], { env, encoding: 'utf8' })
    assert.equal(none.status, 1)
    assert.match(none.stderr, /not_found/)
  } finally {
    await s.close()
  }
})

test('state.db: version 5 migrates keeping its users, with a copy before', () => {
  const dir = tempDir('thoth-state-m4-')
  const file = join(dir, 'state.db')
  openState(file).close()
  const raw = new Database(file)
  raw.exec(`drop table recovery_codes; drop table two_factor; drop table user_links; drop table group_members; drop table user_groups;
    alter table users drop column deleted_at; alter table sessions drop column user_agent;
    insert into users (id, username, password_hash, role, created_at) values ('01U', 'noa', 'x', 'admin', '2026-01-01T00:00:00Z');
    insert into users (id, username, password_hash, role, created_at, disabled) values ('02U', 'ana', 'x', 'member', '2026-01-01T00:00:00Z', 1);`)
  raw.pragma('user_version = 5')
  raw.close()
  const db = openState(file)
  assert.equal(db.pragma('user_version', { simple: true }), STATE_VERSION)
  assert.deepEqual(db.prepare('select username, disabled, deleted_at from users order by username').all(), [
    { username: 'ana', disabled: 1, deleted_at: null }, { username: 'noa', disabled: 0, deleted_at: null },
  ])
  db.close()
  assert.ok(existsSync(`${file}.bak-v5`))
})

test('names are taken as the permissions compare them: a case in any script, a deleted user\'s too', async () => {
  const s = await setup()
  try {
    const first = await s.noa('POST', '/api/admin/users', { username: 'Ángela', role: 'member' })
    assert.equal(first.status, 201)
    // SQLite's nocase folds only ASCII: «ángela» would have inherited «Ángela»'s grants and `{user}` folder.
    assert.deepEqual([(await s.noa('POST', '/api/admin/users', { username: 'ángela', role: 'member' })).body.error], ['user_exists'])
    assert.equal((await s.noa('POST', `/api/admin/users/${first.body.user.id}/disable`)).status, 200)
    assert.equal((await s.noa('DELETE', `/api/admin/users/${first.body.user.id}`)).status, 200)
    assert.deepEqual([(await s.noa('POST', '/api/admin/users', { username: 'ÁNGELA', role: 'member' })).body.error], ['user_exists'], 'nor once she is deleted')

    assert.equal((await s.noa('POST', '/api/admin/groups', { name: 'Équipo' })).status, 201)
    assert.deepEqual([(await s.noa('POST', '/api/admin/groups', { name: 'équipo' })).body.error], ['group_exists'])
  } finally {
    await s.close()
  }
})
