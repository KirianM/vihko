// Users and groups: one-time links, disabling and
// deleting, the last admin, groups, one's own account and sessions, and
// state.db's migration. The hub's connections of a disabled user are in
// users-hub.test.ts (a real server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { CONFIRM_WINDOW_MS, STATE_VERSION, openState } from '@vihko/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const m = mother(import.meta.url)
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** How vihko lists names (SQLite's `collate nocase`): ASCII letters ignore case, everything else by code point. */
const nocase = (a: string, b: string) => {
  const [x, y] = [a, b].map((s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())) as [string, string]
  return x < y ? -1 : x > y ? 1 : 0
}
/** The same name in other cases: vihko must take it for the same one. */
const swapCase = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')

/** Signs in with a password: the session cookie, or the status if it failed. */
async function login(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, username: string, password: string) {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  return res.status === 200 ? res.headers.get('set-cookie')!.split(';')[0]! : res.status
}

/** A request with no session (a link's page). */
async function anon(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) as any, cookie: res.headers.get('set-cookie') }
}

// Names become keys of the grants (and other maps keyed by name): the names
// JavaScript objects already have would be dropped or misread there. The
// values are the case under test, hence literal.
test('names objects already have are no user or group name, in any case', async () => {
  const s = await setup()
  try {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'HasOwnProperty', '__PROTO__']) {
      const user = await s.admin('POST', '/api/admin/users', { username: name, role: 'member' })
      assert.deepEqual([user.status, user.body.error], [400, 'invalid_username'], name)
      const group = await s.admin('POST', '/api/admin/groups', { name })
      assert.deepEqual([group.status, group.body.error], [400, 'invalid_group_name'], name)
    }
    // One that only contains such a name is fine.
    const fine = `${m.aUsername()}_constructor`
    assert.equal((await s.admin('POST', '/api/admin/users', { username: fine, role: 'member' })).status, 201)
  } finally { await s.close() }
})

test('an invitation: the admin creates someone, they choose their password with the link once, and they are in', async () => {
  const s = await setup()
  try {
    const newcomer = m.aUser({ role: 'member' })
    const created = await s.admin('POST', '/api/admin/users', { username: newcomer.username, role: 'member' })
    assert.equal(created.status, 201)
    const { user, link } = created.body
    assert.deepEqual([user.username, user.role, user.status, user.link.kind], [newcomer.username, 'member', 'invited', 'invite'])
    assert.equal(link.kind, 'invite')
    assert.match(link.path, /^\/invite\/[A-Za-z0-9_-]{43}$/)
    assert.equal(link.url, null, 'no public URL: the UI puts its own origin in front')
    assert.equal(Date.parse(link.expiresAt) - Date.now() > 6.9 * 86_400_000, true, 'valid for 7 days')
    const token = link.token as string
    assert.equal(await login(s.app, newcomer.username, ''), 401, 'no password until they choose one')

    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${token}`)).body, { kind: 'invite', username: newcomer.username })
    const weak = await anon(s.app, 'POST', `/api/invite/${token}`, { password: m.aWeakPassword() })
    assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
    assert.equal((await anon(s.app, 'GET', `/api/invite/${token}`)).status, 200, 'a weak password leaves the link unused')

    const accepted = await anon(s.app, 'POST', `/api/invite/${token}`, { password: newcomer.password })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.user.username, newcomer.username)
    const cookie = accepted.cookie!.split(';')[0]!
    const me = await s.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal((await me.json() as any).user.username, newcomer.username, 'signed in by the link')
    assert.equal(typeof await login(s.app, newcomer.username, newcomer.password), 'string')

    // Used: the same neutral answer as a link that never existed (well-formed or not).
    for (const t of [token, m.aSecret(43), 'nonsense']) {
      assert.deepEqual([(await anon(s.app, 'GET', `/api/invite/${t}`)).body.error], ['invalid_link'], t)
    }
    assert.deepEqual((await anon(s.app, 'POST', `/api/invite/${token}`, { password: m.aPassword() })).body.error, 'invalid_link')
    const listed = (await s.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.username === newcomer.username)
    assert.deepEqual([listed.status, listed.link, listed.twoFactor], ['active', null, { enabled: false, enabledAt: null }])
  } finally {
    await s.close()
  }
})

test('the API never sets a new user\'s password: they choose it with their link (the CLI is for whoever operates the server)', async () => {
  const s = await setup()
  try {
    for (const role of ['member', 'admin'] as const) {
      const newcomer = m.aUser({ role })
      const refused = await s.admin('POST', '/api/admin/users', { username: newcomer.username, role, password: newcomer.password, confirm: s.users.admin.password })
      assert.deepEqual([refused.status, refused.body.error], [400, 'invalid'], role)
      assert.ok(!(await s.admin('GET', '/api/admin/users')).body.users.some((u: any) => u.username === newcomer.username), 'nobody created')
      assert.equal(await login(s.app, newcomer.username, newcomer.password), 401)
    }
  } finally {
    await s.close()
  }
})

test('links: a new one ends the previous one, they expire after 7 days, a reset ends the sessions, and none for someone disabled', async () => {
  const s = await setup()
  try {
    const newcomer = m.aUser({ role: 'member' })
    const confirm = s.users.admin.password
    const { user, link: first } = (await s.admin('POST', '/api/admin/users', { username: newcomer.username, role: 'member' })).body
    const again = await s.admin('POST', `/api/admin/users/${user.id}/link`)
    assert.equal(again.body.link.kind, 'invite', 'still no password: an invitation')
    assert.equal((await anon(s.app, 'GET', `/api/invite/${first.token}`)).status, 404, 'the earlier link no longer works')
    assert.equal((await anon(s.app, 'POST', `/api/invite/${again.body.link.token}`, { password: newcomer.password })).status, 200)

    // A reset for someone with a password, with a session open.
    const cookie = await login(s.app, newcomer.username, newcomer.password) as string
    const reset = (await s.admin('POST', `/api/admin/users/${user.id}/link`, { confirm })).body.link
    assert.equal(reset.kind, 'reset')
    assert.equal((await s.app.request('/api/auth/me', { headers: { cookie } })).status, 200, 'a link alone ends nothing')
    assert.equal((await anon(s.app, 'POST', `/api/invite/${reset.token}`, { password: m.aPassword() })).status, 200)
    assert.equal((await s.app.request('/api/auth/me', { headers: { cookie } })).status, 401, 'using a reset ends every session')
    assert.equal(await login(s.app, newcomer.username, newcomer.password), 401)

    // Expired: the same neutral answer.
    const late = (await s.admin('POST', `/api/admin/users/${user.id}/link`, { confirm })).body.link
    s.auth.state.prepare("update user_links set expires_at = '2020-01-01T00:00:00.000Z'").run()
    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${late.token}`)).body.error, 'invalid_link')

    // Disabled: no new link, and a pending one stops working.
    const pending = (await s.admin('POST', `/api/admin/users/${user.id}/link`, { confirm })).body.link
    await s.admin('POST', `/api/admin/users/${user.id}/disable`, { confirm: s.users.admin.password })
    assert.equal((await anon(s.app, 'GET', `/api/invite/${pending.token}`)).status, 404)
    const none = await s.admin('POST', `/api/admin/users/${user.id}/link`)
    assert.deepEqual([none.status, none.body.error], [409, 'user_disabled'])
  } finally {
    await s.close()
  }
})

test('guessing links counts in the login limits', async () => {
  const s = await setup()
  try {
    let status = 0
    for (let i = 0; i < 8 && status !== 429; i++) status = (await anon(s.app, 'GET', `/api/invite/${m.aSecret(43)}`)).status
    assert.equal(status, 429)
  } finally {
    await s.close()
  }
})

test('the admin only: members get 403, and only see names in the directory', async () => {
  const s = await setup()
  try {
    for (const [method, path] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['GET', '/api/admin/groups'], ['POST', '/api/admin/groups'], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings']] as const) {
      assert.equal((await s.member(method, path, method === 'GET' ? undefined : {})).status, 403, `${method} ${path}`)
    }
    const group = m.aGroupName()
    await s.admin('POST', '/api/admin/groups', { name: group })
    const dir = await s.member('GET', '/api/directory')
    assert.deepEqual(dir.body, { users: [s.users.member.username, s.users.admin.username].sort(nocase), groups: [group] })
  } finally {
    await s.close()
  }
})

test('the last active admin can\'t be demoted, disabled or deleted; with another one, they can', async () => {
  const s = await setup()
  try {
    const id = s.users.admin.id
    const confirm = s.users.admin.password
    for (const [method, path, body] of [['PUT', `/api/admin/users/${id}/role`, { role: 'member', confirm }], ['POST', `/api/admin/users/${id}/disable`, undefined]] as const) {
      const r = await s.admin(method, path, body)
      assert.deepEqual([r.status, r.body.error], [409, 'last_admin'], path)
    }
    // An invited admin can't sign in yet: they don't count.
    const second = m.aUser({ role: 'admin' })
    const invited = (await s.admin('POST', '/api/admin/users', { username: second.username, role: 'admin', confirm })).body
    assert.equal((await s.admin('PUT', `/api/admin/users/${id}/role`, { role: 'member', confirm })).body.error, 'last_admin')
    await anon(s.app, 'POST', `/api/invite/${invited.link.token}`, { password: second.password })
    const demoted = await s.admin('PUT', `/api/admin/users/${id}/role`, { role: 'member', confirm })
    assert.deepEqual([demoted.status, demoted.body.user.role], [200, 'member'])
    assert.equal((await s.admin('GET', '/api/admin/users')).status, 403, 'the role applies at once')
    const cookie = await login(s.app, second.username, second.password) as string
    const bad = await s.app.request(`/api/admin/users/${id}/role`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ role: 'owner' }) })
    assert.equal(bad.status, 400, 'only admin or member')
  } finally {
    await s.close()
  }
})

test('disabling cuts sessions, keys and OAuth at once and keeps them for later; deleting leaves a tombstone', async () => {
  const s = await setup()
  try {
    await s.enableApi()
    // The member's own key and authorization: the admin lets members (off on a new vihko).
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    const member = s.users.member
    const keyName = m.aKeyName()
    const { key: k, token } = await s.newKey({ name: keyName }, 'member')
    const key = s.withKey(token)
    assert.equal((await key('GET', '/api/tree')).status, 200)
    const cookie = await login(s.app, member.username, member.password) as string

    // Deleting needs a disabled user.
    const early = await s.admin('DELETE', `/api/admin/users/${member.id}`, { confirm: s.users.admin.password })
    assert.deepEqual([early.status, early.body.error], [409, 'not_disabled'])

    const disabled = await s.admin('POST', `/api/admin/users/${member.id}/disable`, { confirm: s.users.admin.password })
    assert.equal(disabled.body.user.status, 'disabled')
    assert.equal((await s.member('GET', '/api/tree')).status, 401, 'their sessions ended')
    assert.equal((await s.app.request('/api/tree', { headers: { cookie } })).status, 401)
    assert.equal((await key('GET', '/api/tree')).status, 401, 'their key stops working')
    assert.equal(await login(s.app, member.username, member.password), 401, 'they can\'t sign in')
    assert.equal(s.services.keys.principal(k.id, 'oauth'), null, 'nor anything given through OAuth (its tokens reach its user through this)')

    // Enabled again: the key works again (it was never revoked); sessions start anew.
    await s.admin('POST', `/api/admin/users/${member.id}/enable`)
    assert.equal((await key('GET', '/api/tree')).status, 200)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie } })).status, 401, 'old sessions stay ended')
    assert.equal(typeof await login(s.app, member.username, member.password), 'string')

    // Deleted: the grants hook runs first; if it fails, nothing is deleted.
    const calls: string[] = []
    s.services.users.hooks.onUserDeleted = () => { throw new Error('vihko.yaml could not be written') }
    await s.admin('POST', `/api/admin/users/${member.id}/disable`, { confirm: s.users.admin.password })
    assert.equal((await s.admin('DELETE', `/api/admin/users/${member.id}`, { confirm: s.users.admin.password })).status, 500)
    assert.ok((await s.admin('GET', '/api/admin/users')).body.users.some((u: any) => u.username === member.username), 'still there')
    s.services.users.hooks.onUserDeleted = (name) => { calls.push(name) }
    const group = m.aGroupName()
    await s.admin('POST', '/api/admin/groups', { name: group }).then((g) => s.admin('POST', `/api/admin/groups/${g.body.group.id}/members`, { userId: member.id }))
    assert.equal((await s.admin('DELETE', `/api/admin/users/${member.id}`, { confirm: s.users.admin.password })).status, 200)
    assert.deepEqual(calls, [member.username])
    assert.ok(!(await s.admin('GET', '/api/admin/users')).body.users.some((u: any) => u.username === member.username))
    assert.deepEqual((await s.admin('GET', '/api/directory')).body, { users: [s.users.admin.username], groups: [group] })
    assert.deepEqual((await s.admin('GET', '/api/admin/groups')).body.groups[0].members, [])
    assert.equal(s.auth.username(member.id), member.username, 'the history still names them')
    assert.equal((await key('GET', '/api/tree')).status, 401)
    assert.equal(s.services.keys.list(member.id)[0]!.status, 'revoked')
    assert.equal(s.services.keys.nameOf(s.services.keys.list(member.id)[0]!.id), keyName, 'the key keeps its name, for the history')
    assert.ok(!(await s.admin('GET', '/api/keys?all=1')).body.keys.some((k: any) => k.userId === member.id && k.status !== 'revoked'))
    const again = await s.admin('POST', '/api/admin/users', { username: swapCase(member.username), role: 'member' })
    assert.deepEqual([again.status, again.body.error], [409, 'user_exists'], 'the name is never given to someone else')
    for (const path of [`/api/admin/users/${member.id}/enable`, `/api/admin/users/${member.id}/link`]) assert.equal((await s.admin('POST', path)).status, 404, path)
  } finally {
    await s.close()
  }
})

test('the admin closes someone\'s sessions', async () => {
  const s = await setup()
  try {
    const { username, password } = s.users.member
    const other = await login(s.app, username, password) as string
    const r = await s.admin('DELETE', `/api/admin/users/${s.users.member.id}/sessions`)
    assert.equal(r.body.ended, 2)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie: other } })).status, 401)
    assert.equal(typeof await login(s.app, username, password), 'string', 'they can sign in again')
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
    const [name, renamedTo, refused] = [m.aGroupName(), m.aGroupName(), m.aGroupName()]
    const g = (await s.admin('POST', '/api/admin/groups', { name })).body.group
    assert.deepEqual([(await s.admin('POST', '/api/admin/groups', { name: swapCase(name) })).body.error], ['group_exists'])
    // Invalid by their form: empty, one character, a subject's `@`, a space, a slash.
    for (const bad of ['', 'x', `@${name}`, 'con espacio', 'a/b']) assert.deepEqual((await s.admin('POST', '/api/admin/groups', { name: bad })).body.error, 'invalid_group_name', bad)
    // Reserved for grants to everyone, should they come: the names are the case under test, in any case.
    for (const reserved of ['everyone', 'All', 'PUBLIC', 'anyone']) {
      assert.deepEqual((await s.admin('POST', '/api/admin/groups', { name: reserved })).body.error, 'invalid_group_name', reserved)
      assert.deepEqual((await s.admin('PATCH', `/api/admin/groups/${g.id}`, { name: reserved })).body.error, 'invalid_group_name', reserved)
    }
    await s.admin('POST', `/api/admin/groups/${g.id}/members`, { userId: s.users.member.id })
    const both = await s.admin('POST', `/api/admin/groups/${g.id}/members`, { userId: s.users.admin.id })
    assert.deepEqual(both.body.group.members.map((u: any) => u.username), [s.users.member.username, s.users.admin.username].sort(nocase))
    assert.deepEqual(s.services.users.groupsOf(s.users.member.id), [name])
    const list = (await s.admin('GET', '/api/admin/users')).body.users
    assert.deepEqual(list.find((u: any) => u.username === s.users.member.username).groups, [name])

    const r = await s.admin('PATCH', `/api/admin/groups/${g.id}`, { name: renamedTo })
    assert.equal(r.body.group.name, renamedTo)
    assert.deepEqual(renamed, [[name, renamedTo]])
    assert.deepEqual(s.services.users.groupsOf(s.users.member.id), [renamedTo])
    await s.admin('DELETE', `/api/admin/groups/${g.id}/members/${s.users.member.id}`)
    assert.deepEqual(s.services.users.groupsOf(s.users.member.id), [])
    s.services.users.hooks.onGroupRenamed = () => { throw new Error('no') }
    assert.equal((await s.admin('PATCH', `/api/admin/groups/${g.id}`, { name: refused })).status, 500)
    assert.equal((await s.admin('GET', '/api/admin/groups')).body.groups[0].name, renamedTo, 'the hook failed: the name stays')
    assert.equal((await s.admin('DELETE', `/api/admin/groups/${g.id}`)).status, 200)
    assert.deepEqual(deleted, [renamedTo])
    assert.deepEqual(s.services.users.groupsOf(s.users.admin.id), [])
    assert.equal((await s.admin('DELETE', `/api/admin/groups/${g.id}`)).status, 404)
  } finally {
    await s.close()
  }
})

test('one\'s own account: sessions (the current one marked), closing the others, and a new password that ends them', async () => {
  const s = await setup()
  try {
    const { username, password } = s.users.member
    const other = await login(s.app, username, password) as string
    const third = await login(s.app, username, password) as string
    const list = (await s.member('GET', '/api/account/sessions')).body.sessions
    assert.equal(list.length, 3)
    assert.equal(list.filter((x: any) => x.current).length, 1)
    assert.ok(list.every((x: any) => /^[0-9a-f]{32}$/.test(x.id) && !('token' in x) && !('token_hash' in x)))
    // One, by its id (the admin's session list doesn't have it).
    const target = list.find((x: any) => !x.current)
    assert.equal((await s.admin('DELETE', `/api/account/sessions/${target.id}`)).status, 404, 'only one\'s own')
    assert.equal((await s.member('DELETE', `/api/account/sessions/${target.id}`)).status, 200)
    assert.equal((await s.member('GET', '/api/account/sessions')).body.sessions.length, 2)
    assert.equal((await s.member('DELETE', '/api/account/sessions')).body.ended, 1)
    for (const c of [other, third]) assert.equal((await s.app.request('/api/tree', { headers: { cookie: c } })).status, 401)
    assert.equal((await s.member('GET', '/api/tree')).status, 200, 'the current one stays')

    const again = await login(s.app, username, password) as string
    const renewed = m.aPassword()
    const wrong = await s.member('POST', '/api/auth/password', { current: m.aPassword(), password: renewed })
    assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password'])
    const weak = await s.member('POST', '/api/auth/password', { current: password, password: m.aWeakPassword() })
    assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
    assert.equal((await s.member('POST', '/api/auth/password', { current: password, password: renewed, endSessions: true })).status, 200)
    assert.equal((await s.app.request('/api/tree', { headers: { cookie: again } })).status, 401, 'other sessions end')
    assert.equal((await s.member('GET', '/api/tree')).status, 200, 'this one stays')
    assert.equal(await login(s.app, username, password), 401)
    assert.equal(typeof await login(s.app, username, renewed), 'string')
  } finally {
    await s.close()
  }
})

test('a new key is always told to its person, even when they made it', async () => {
  const s = await setup()
  try {
    await s.enableApi()
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    const told = async () => (await s.member('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'account_key_added')
    // A session taken would make one unnoticed otherwise.
    const name = m.aKeyName()
    const key = await s.newKey({ name }, 'member')
    assert.deepEqual((await told()).map((a: any) => [a.kind, a.name]), [['key', name]])
    assert.equal((await s.withKey(key.token)('GET', '/api/tree')).status, 200)
  } finally {
    await s.close()
  }
})

// Each combination of `endSessions` and `revokeKeys` (and neither sent: both
// off), one after another on the same account: what ends and what stays, the
// current session always staying, and the confirmation of the moment ending
// whatever was chosen.
test('a new password ends the other sessions with endSessions and the keys with revokeKeys, each off unless asked for; the confirmation of the moment always ends', async () => {
  const s = await setup({ confirmWindowMs: CONFIRM_WINDOW_MS })
  try {
    await s.enableApi()
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    const { username } = s.users.member
    let password = s.users.member.password
    const tree = async (cookie: string) => (await s.app.request('/api/tree', { headers: { cookie } })).status
    const rounds: { endSessions?: boolean; revokeKeys?: boolean }[] = [
      {},
      { endSessions: false, revokeKeys: false },
      { endSessions: true, revokeKeys: false },
      { endSessions: false, revokeKeys: true },
      { endSessions: true, revokeKeys: true },
    ]
    for (const also of rounds) {
      const what = JSON.stringify(also)
      // Another browser, and a key confirmed with the password: that opens this session's window.
      const other = await login(s.app, username, password) as string
      const key = await s.member('POST', '/api/keys', { name: m.aKeyName(), confirm: password })
      assert.equal(key.status, 201, what)
      assert.equal((await s.member('POST', '/api/keys', { name: m.aKeyName() })).status, 201, `${what}: the window is open`)
      const othersBefore = (await s.member('GET', '/api/account/sessions')).body.sessions.filter((x: any) => !x.current).length
      const activeBefore = (await s.member('GET', '/api/keys')).body.keys.filter((k: any) => k.status === 'active').length
      assert.ok(othersBefore >= 1 && activeBefore >= 2, what)

      const renewed = m.aPassword()
      const r = await s.member('POST', '/api/auth/password', { current: password, password: renewed, ...also })
      assert.equal(r.status, 200, `${what}: ${r.text}`)
      password = renewed
      assert.deepEqual([r.body.sessionsEnded, r.body.keysRevoked], [also.endSessions ? othersBefore : 0, also.revokeKeys ? activeBefore : 0], what)
      assert.equal(await tree(other), also.endSessions ? 401 : 200, `${what}: the other session`)
      assert.equal((await s.withKey(key.body.token)('GET', '/api/tree')).status, also.revokeKeys ? 401 : 200, `${what}: the key`)
      const keys = (await s.member('GET', '/api/keys')).body.keys
      assert.equal(keys.filter((k: any) => k.status === 'active').length, also.revokeKeys ? 0 : activeBefore, what)
      assert.equal((await s.member('GET', '/api/tree')).status, 200, `${what}: this session stays`)
      const asked = await s.member('POST', '/api/keys', { name: m.aKeyName() })
      assert.deepEqual([asked.status, asked.body.error], [400, 'confirmation_required'], `${what}: the window ended`)
      assert.equal(await login(s.app, username, renewed).then((c) => typeof c), 'string', what)
    }
  } finally {
    await s.close()
  }
})

test('a new password refuses what it doesn\'t take, before changing anything: revokeOthers is gone, and each choice is true or false', async () => {
  const s = await setup()
  try {
    const { username, password } = s.users.member
    const other = await login(s.app, username, password) as string
    for (const extra of [{ revokeOthers: true }, { revokeOthers: false }, { endSessions: 'yes' }, { revokeKeys: 1 }, { endSessions: null }]) {
      const r = await s.member('POST', '/api/auth/password', { current: password, password: m.aPassword(), ...extra })
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(extra))
    }
    assert.equal(typeof await login(s.app, username, password), 'string', 'the password stays')
    assert.equal((await s.app.request('/api/tree', { headers: { cookie: other } })).status, 200, 'so does the other session')
  } finally {
    await s.close()
  }
})

test('revokeKeys revokes a member\'s suspended keys too: letting members have keys again doesn\'t bring them back', async () => {
  const s = await setup()
  try {
    await s.enableApi()
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    const { password } = s.users.member
    const keys = [await s.newKey({ name: m.aKeyName() }, 'member'), await s.newKey({ name: m.aKeyName() }, 'member')]
    const statuses = async () => (await s.member('GET', '/api/keys')).body.keys.map((k: any) => k.status)
    // Suspended while members may not have keys.
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: false })).status, 200)
    assert.deepEqual(await statuses(), ['suspended', 'suspended'])
    // Without revokeKeys, they stay suspended, still theirs; with it, revoked for good.
    const renewed = m.aPassword()
    assert.equal((await s.member('POST', '/api/auth/password', { current: password, password: renewed, revokeKeys: false })).body.keysRevoked, 0)
    assert.deepEqual(await statuses(), ['suspended', 'suspended'])
    const r = await s.member('POST', '/api/auth/password', { current: renewed, password: m.aPassword(), revokeKeys: true })
    assert.deepEqual([r.status, r.body.keysRevoked], [200, 2])
    assert.deepEqual(await statuses(), ['revoked', 'revoked'])
    assert.equal((await s.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    for (const k of keys) assert.equal((await s.withKey(k.token)('GET', '/api/tree')).status, 401)
  } finally {
    await s.close()
  }
})

test('a new password of one\'s own ends a reset link made for them: nobody gets in with it afterwards', async () => {
  const s = await setup()
  try {
    const { id, username, password } = s.users.member
    const reset = (await s.admin('POST', `/api/admin/users/${id}/link`, { confirm: s.users.admin.password })).body.link
    assert.equal(reset.kind, 'reset')
    const renewed = m.aPassword()
    assert.equal((await s.member('POST', '/api/auth/password', { current: password, password: renewed })).status, 200)
    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${reset.token}`)).body.error, 'invalid_link')
    const taken = await anon(s.app, 'POST', `/api/invite/${reset.token}`, { password: m.aPassword() })
    assert.deepEqual([taken.status, taken.body.error], [404, 'invalid_link'])
    assert.equal(typeof await login(s.app, username, renewed), 'string', 'their own password still works')
    assert.equal((await s.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.id === id).link, null)
  } finally {
    await s.close()
  }
})

test('the admin\'s settings: members downloading from the local network, off by default', async () => {
  const s = await setup()
  try {
    assert.deepEqual((await s.admin('GET', '/api/admin/settings')).body, { membersLocalDownloads: false, twoFactor: 'optional', spacesCreation: 'everyone', trashRetentionDays: null, historyRetentionDays: null })
    assert.deepEqual((await s.admin('PUT', '/api/admin/settings', { membersLocalDownloads: true })).body, { membersLocalDownloads: true, twoFactor: 'optional', spacesCreation: 'everyone', trashRetentionDays: null, historyRetentionDays: null })
    assert.equal((await s.admin('PUT', '/api/admin/settings', { membersLocalDownloads: 'yes' })).status, 400)
    assert.equal((await s.admin('PUT', '/api/admin/settings', { other: true })).status, 400)
  } finally {
    await s.close()
  }
})

test('the CLI gives a reset link (the way back for an admin who lost their password)', async () => {
  const s = await setup()
  try {
    const admin = s.users.admin.username
    const publicUrl = `https://${m.aHost()}`
    const env = { ...process.env, VIHKO_STATE_DIR: s.dir, VIHKO_NOTES_DIR: s.notesDir, VIHKO_PUBLIC_URL: publicUrl }
    const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-link', admin], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const token = new RegExp(`${literally(publicUrl)}/invite/([A-Za-z0-9_-]{43})`).exec(r.stdout)?.[1]
    assert.ok(token, r.stdout)
    assert.ok(r.stdout.includes(`password reset link for ${admin}`), r.stdout)
    assert.deepEqual((await anon(s.app, 'GET', `/api/invite/${token}`)).body, { kind: 'reset', username: admin }, 'a running vihko reads it at once')
    const none = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-link', m.aUsername()], { env, encoding: 'utf8' })
    assert.equal(none.status, 1)
    assert.match(none.stderr, /not_found/)
  } finally {
    await s.close()
  }
})

test('the CLI creates a user from its arguments as documented: `--admin` before or after the name; anything else is the usage, status 2', async () => {
  const s = await setup()
  try {
    const env = { ...process.env, VIHKO_STATE_DIR: s.dir, VIHKO_NOTES_DIR: s.notesDir }
    const cli = (args: string[], input = `${m.aPassword()}\n`) => spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, ...args], { env, encoding: 'utf8', input })
    const [member, admin, another] = [m.aUsername(), m.aUsername(), m.aUsername()]
    const made = cli(['user', 'create', member])
    assert.deepEqual([made.status, made.stdout], [0, `user created: ${member} (member)\n`], made.stderr)
    const first = cli(['user', 'create', '--admin', admin])
    assert.deepEqual([first.status, first.stdout], [0, `user created: ${admin} (admin)\n`], first.stderr)
    for (const args of [['user', 'create'], ['user', 'create', '--admin'], ['user', 'create', another, m.aUsername()], ['user', 'create', another, '--member'], ['user', 'reset-link'], ['user', m.aWord()], [m.aWord()], ['version', m.aWord()], ['serve', m.aWord()]]) {
      const r = cli(args)
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`)
      assert.match(r.stderr, /^usage: vihko /, args.join(' '))
    }
    const again = cli(['user', 'create', member])
    assert.equal(again.status, 1, 'a user that exists: an error')
    assert.match(again.stderr, /^error \(user_exists\): /, 'its code, as every other error')
    assert.equal(s.auth.userCount(), 4, 'the two of setup and the two created: none named after an option')
    // A person recreated after state.db was lost: their folder is there, with their notes. Never theirs by default; with --adopt, it is.
    const back = m.aUsername()
    const kept = `people/${back}/${m.aTitle()}.md`
    mkdirSync(join(s.notesDir, 'people', back), { recursive: true })
    writeFileSync(join(s.notesDir, kept), m.aParagraph())
    const refused = cli(['user', 'create', back])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /^error \(personal_folder_exists\): /)
    const adopted = cli(['user', 'create', '--adopt', back])
    assert.equal(adopted.status, 0, adopted.stderr)
    assert.match(adopted.stdout, new RegExp(`^user created: ${back} \\(member\\), with the folder already at people/${back} as theirs\\n$`))
    assert.ok(existsSync(join(s.notesDir, kept)), 'what it held stays')
  } finally {
    await s.close()
  }
})


test('state.db: version 5 migrates keeping its users, with a copy before and a log line that names it', () => {
  const dir = tempDir('vihko-state-m4-')
  const file = join(dir, 'state.db')
  const [admin, member] = [m.aUsername(), m.aUsername()]
  const created: string[] = []
  openState(file, { log: (msg) => created.push(msg) }).close()
  assert.deepEqual(created, [], 'a new database is no news')
  const raw = new Database(file)
  raw.exec(`drop table last_notes; drop table deleted_spaces; drop table grant_starts; drop table pins; drop table notices; drop table recovery_codes; drop table two_factor; drop table user_links; drop table group_members; drop table user_groups;
    alter table users drop column deleted_at; alter table sessions drop column user_agent; alter table profiles drop column language;
    alter table profiles drop column on_open; alter table profiles drop column on_open_note;`)
  raw.prepare("insert into users (id, username, password_hash, role, created_at) values ('01U', ?, 'x', 'admin', '2026-01-01T00:00:00Z')").run(admin)
  raw.prepare("insert into users (id, username, password_hash, role, created_at, disabled) values ('02U', ?, 'x', 'member', '2026-01-01T00:00:00Z', 1)").run(member)
  raw.pragma('user_version = 5')
  raw.close()
  const logged: string[] = []
  const db = openState(file, { log: (msg) => logged.push(msg) })
  assert.deepEqual(logged, [`state.db migrated from version 5 to ${STATE_VERSION}; the previous one is in ${file}.bak-v5`])
  assert.equal(db.pragma('user_version', { simple: true }), STATE_VERSION)
  // The column compares names with `collate nocase`, and so orders them.
  const expected = [{ username: admin, disabled: 0, deleted_at: null }, { username: member, disabled: 1, deleted_at: null }]
    .sort((a, b) => nocase(a.username, b.username))
  assert.deepEqual(db.prepare('select username, disabled, deleted_at from users order by username').all(), expected)
  db.close()
  assert.ok(existsSync(`${file}.bak-v5`))
})

test('names are taken as the permissions compare them: a case in any script, a deleted user\'s too', async () => {
  const s = await setup()
  try {
    // Literal names: the case under test is how «Á» folds (the mother never hands these out, RESERVED).
    const first = await s.admin('POST', '/api/admin/users', { username: 'Ángela', role: 'member' })
    assert.equal(first.status, 201)
    // SQLite's nocase folds only ASCII: «ángela» would have inherited «Ángela»'s grants and `{user}` folder.
    assert.deepEqual([(await s.admin('POST', '/api/admin/users', { username: 'ángela', role: 'member' })).body.error], ['user_exists'])
    assert.equal((await s.admin('POST', `/api/admin/users/${first.body.user.id}/disable`, { confirm: s.users.admin.password })).status, 200)
    assert.equal((await s.admin('DELETE', `/api/admin/users/${first.body.user.id}`, { confirm: s.users.admin.password })).status, 200)
    assert.deepEqual([(await s.admin('POST', '/api/admin/users', { username: 'ÁNGELA', role: 'member' })).body.error], ['user_exists'], 'nor once she is deleted')

    assert.equal((await s.admin('POST', '/api/admin/groups', { name: 'Équipo' })).status, 201)
    assert.deepEqual([(await s.admin('POST', '/api/admin/groups', { name: 'équipo' })).body.error], ['group_exists'])
  } finally {
    await s.close()
  }
})
