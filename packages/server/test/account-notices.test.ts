// The admin and someone else's account: a reset link, the
// second factor's reset and a new role ask for the confirmation at the moment
// (the current code, or the password without a second factor), and the
// person and every other admin are told, each until they dismiss it. An
// invitation (no password yet) needs neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Notices, base32Decode, totp } from '@vihko/server'
import { setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
type H = Awaited<ReturnType<typeof setup>>
interface Res { status: number; body: any }
interface Notice { code: string; id: string; change?: string; role?: string | null; by: string; user?: string; at: string; actions: string[] }

/** Signs someone in with their password: requests with that session. */
async function session(h: H, { username, password }: { username: string; password: string }) {
  const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('vihko_session='))!.split(';')[0]!
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const r = await h.app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
}

const accountNotices = async (as: (m: string, p: string) => Promise<Res>) =>
  ((await as('GET', '/api/alerts')).body.alerts as Notice[]).filter((a) => a.code === 'account_changed' || a.code === 'user_account_changed')

test('a reset link, a second factor\'s reset and a new role are confirmed, and told to the person and the other admins', async () => {
  const h = await setup()
  try {
    const [admin, member] = [h.users.admin, h.users.member]
    const password = admin.password
    const second = m.aUser({ role: 'admin' })
    await h.auth.createUser(second.username, second.password, 'admin')
    const otherAdmin = await session(h, second)
    const id = member.id

    // A reset link: the password (the admin has no second factor), or nothing happens.
    const missing = await h.admin('POST', `/api/admin/users/${id}/link`)
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/link`, { confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal((await h.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.id === id).link, null, 'no link made')
    const link = await h.admin('POST', `/api/admin/users/${id}/link`, { confirm: password })
    assert.deepEqual([link.status, link.body.link.kind], [200, 'reset'])

    // An invitation needs no confirmation, and tells nobody.
    const invited = (await h.admin('POST', '/api/admin/users', { username: m.aUsername(), role: 'member' })).body.user
    assert.equal((await h.admin('POST', `/api/admin/users/${invited.id}/link`)).body.link.kind, 'invite')

    // A new role: confirmed; the same role again changes nothing and asks nothing.
    assert.equal((await h.admin('PUT', `/api/admin/users/${id}/role`, { role: 'admin' })).body.error, 'confirmation_required')
    assert.equal((await h.admin('PUT', `/api/admin/users/${id}/role`, { role: 'member' })).status, 200)
    assert.equal((await h.admin('PUT', `/api/admin/users/${id}/role`, { role: 'owner', confirm: password })).body.error, 'invalid')
    assert.equal((await h.admin('PUT', `/api/admin/users/${id}/role`, { role: 'admin', confirm: password })).body.user.role, 'admin')

    // Their second factor: with one of their own, the admin confirms with its code, never the password.
    const s = await h.member('POST', '/api/account/2fa/setup', { password: member.password })
    await h.member('POST', '/api/account/2fa/enable', { code: totp(base32Decode(s.body.secret), h.clock.now.getTime()) })
    const k = await h.admin('POST', '/api/account/2fa/setup', { password })
    const adminSecret = base32Decode(k.body.secret)
    await h.admin('POST', '/api/account/2fa/enable', { code: totp(adminSecret, h.clock.now.getTime()) })
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/2fa/reset`, { confirm: password })).body.error, 'invalid_code')
    const reset = await h.admin('POST', `/api/admin/users/${id}/2fa/reset`, { confirm: totp(adminSecret, h.clock.now.getTime()) })
    assert.deepEqual(reset.body.user.twoFactor, { enabled: false, enabledAt: null })

    // The member is told what, by whom and when; the other admin, the same about them; the admin who did it, nothing; the invited one, nothing.
    const theirs = await accountNotices(h.member)
    assert.deepEqual(theirs.map((n) => [n.code, n.change, n.role, n.by]), [
      ['account_changed', 'reset_link', null, admin.username],
      ['account_changed', 'role_changed', 'admin', admin.username],
      ['account_changed', 'two_factor_reset', null, admin.username],
    ])
    assert.ok(theirs.every((n) => n.at && n.actions[0] === 'dismiss'))
    assert.deepEqual((await accountNotices(otherAdmin)).map((n) => [n.code, n.change, n.user, n.by]), [
      ['user_account_changed', 'reset_link', member.username, admin.username],
      ['user_account_changed', 'role_changed', member.username, admin.username],
      ['user_account_changed', 'two_factor_reset', member.username, admin.username],
    ])
    assert.deepEqual(await accountNotices(h.admin), [])
    assert.deepEqual(await accountNotices(await session(h, member)), theirs, 'still there on signing in again')

    // Each dismisses their own, and only their own.
    assert.equal((await otherAdmin('DELETE', `/api/account/notices/${theirs[0]!.id}`)).status, 404)
    assert.equal((await h.member('DELETE', `/api/account/notices/${theirs[0]!.id}`)).status, 200)
    assert.equal((await accountNotices(h.member)).length, 2)
    assert.equal((await accountNotices(otherAdmin)).length, 3)

  } finally { await h.close() }
})

test('a new admin is confirmed at the moment, as making someone admin is; a new member is not', async () => {
  const h = await setup()
  try {
    const password = h.users.admin.password
    const exists = async (username: string) => (await h.admin('GET', '/api/admin/users')).body.users.some((u: any) => u.username === username)
    assert.equal((await h.admin('POST', '/api/admin/users', { username: m.aUsername(), role: 'member' })).status, 201, 'a member: nothing asked')

    // Without a second factor: the admin's password, or nobody is created.
    const newcomer = m.aUsername()
    const missing = await h.admin('POST', '/api/admin/users', { username: newcomer, role: 'admin' })
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.admin('POST', '/api/admin/users', { username: newcomer, role: 'admin', confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal(await exists(newcomer), false, 'nobody created')
    // The name is checked before anything is asked: a taken or invalid one spends no code.
    assert.equal((await h.admin('POST', '/api/admin/users', { username: h.users.member.username, role: 'admin' })).body.error, 'user_exists')
    assert.equal((await h.admin('POST', '/api/admin/users', { username: '', role: 'admin' })).body.error, 'invalid_username')
    // Another admin, to be told.
    const other = m.aUser({ role: 'admin' })
    await h.auth.createUser(other.username, other.password, 'admin')
    const otherAdmin = await session(h, other)
    const created = await h.admin('POST', '/api/admin/users', { username: newcomer, role: 'admin', confirm: password })
    assert.deepEqual([created.status, created.body.user.role, created.body.link.kind], [201, 'admin', 'invite'])
    // The other admins are told as when someone is made admin; whoever did it and the newcomer, nothing.
    assert.deepEqual((await accountNotices(otherAdmin)).map((n) => [n.code, n.change, n.role, n.user, n.by]),
      [['user_account_changed', 'role_changed', 'admin', newcomer, h.users.admin.username]])
    assert.equal((await h.admin('POST', '/api/admin/users', { username: m.aUsername(), role: 'member' })).status, 201)
    assert.equal((await accountNotices(otherAdmin)).length, 1, 'a new member tells nobody')
    assert.deepEqual(await accountNotices(h.admin), [])
    assert.deepEqual(new Notices(h.auth.state).of(created.body.user.id), [])

    // With a second factor: its current code, never the password.
    const s = await h.admin('POST', '/api/account/2fa/setup', { password })
    const secret = base32Decode(s.body.secret)
    await h.admin('POST', '/api/account/2fa/enable', { code: totp(secret, h.clock.now.getTime()) })
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    const another = m.aUsername()
    assert.equal((await h.admin('POST', '/api/admin/users', { username: another, role: 'admin' })).body.with, 'code')
    assert.equal((await h.admin('POST', '/api/admin/users', { username: another, role: 'admin', confirm: password })).body.error, 'invalid_code')
    assert.equal(await exists(another), false)
    assert.equal((await h.admin('POST', '/api/admin/users', { username: another, role: 'admin', confirm: totp(secret, h.clock.now.getTime()) })).status, 201)
  } finally { await h.close() }
})

test('enabling a disabled admin is confirmed at the moment, as making one is; a member is not', async () => {
  const h = await setup()
  try {
    const password = h.users.admin.password
    const second = m.aUser({ role: 'admin' })
    const id = (await h.auth.createUser(second.username, second.password, 'admin')).id
    const status = async (who: string) => (await h.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.id === who).status
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/disable`, { confirm: h.users.admin.password })).status, 200)

    const missing = await h.admin('POST', `/api/admin/users/${id}/enable`)
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/enable`, { confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal(await status(id), 'disabled', 'still disabled')
    const enabled = await h.admin('POST', `/api/admin/users/${id}/enable`, { confirm: password })
    assert.deepEqual([enabled.status, enabled.body.user.status, enabled.body.user.role], [200, 'active', 'admin'])
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/enable`)).status, 200, 'already enabled: nothing to confirm')

    // A member comes back without anything asked.
    const member = h.users.member.id
    await h.admin('POST', `/api/admin/users/${member}/disable`, { confirm: h.users.admin.password })
    const back = await h.admin('POST', `/api/admin/users/${member}/enable`)
    assert.deepEqual([back.status, back.body.user.status], [200, 'active'])
  } finally { await h.close() }
})

test('disabling and deleting someone, and a new invitation for an admin, are confirmed at the moment and told to the other admins', async () => {
  const h = await setup()
  try {
    const password = h.users.admin.password
    const second = m.aUser({ role: 'admin' })
    await h.auth.createUser(second.username, second.password, 'admin')
    const otherAdmin = await session(h, second)
    const id = h.users.member.id
    const status = async () => (await h.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.id === id)?.status
    // Disabling: nothing without the confirmation.
    const missing = await h.admin('POST', `/api/admin/users/${id}/disable`)
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/disable`, { confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal(await status(), 'active')
    assert.equal((await h.admin('POST', `/api/admin/users/${id}/disable`, { confirm: password })).status, 200)
    // Deleting: the same.
    assert.equal((await h.admin('DELETE', `/api/admin/users/${id}`)).body.error, 'confirmation_required')
    assert.equal(await status(), 'disabled')
    assert.equal((await h.admin('DELETE', `/api/admin/users/${id}`, { confirm: password })).status, 200)
    assert.equal(await status(), undefined)
    // A new invitation for an admin who hasn't chosen a password yet: confirmed too; a member's isn't.
    const invited = (await h.admin('POST', '/api/admin/users', { username: m.aUsername(), role: 'admin', confirm: password })).body.user
    assert.equal((await h.admin('POST', `/api/admin/users/${invited.id}/link`)).body.error, 'confirmation_required')
    assert.equal((await h.admin('POST', `/api/admin/users/${invited.id}/link`, { confirm: password })).body.link.kind, 'invite')
    // The other admin is told of each; whoever did it isn't.
    const told = (await accountNotices(otherAdmin)).filter((n) => n.code === 'user_account_changed').map((n) => [n.change, n.by])
    for (const change of ['disabled', 'deleted', 'invite_link']) assert.ok(told.some(([c, by]) => c === change && by === h.users.admin.username), `${change}: ${JSON.stringify(told)}`)
    assert.deepEqual((await accountNotices(h.admin)).filter((n) => ['disabled', 'deleted', 'invite_link'].includes(n.change!)), [])
  } finally { await h.close() }
})

test('notices: kept per person, the latest only, never for a deleted user, oldest first', async () => {
  const h = await setup()
  try {
    const store = new Notices(h.auth.state, { now: () => h.clock.now })
    const member = h.users.member.id
    const admin = h.users.admin.id
    for (let i = 0; i < 105; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 1000)
      store.add(member, { code: 'account_changed', change: 'reset_link', by: admin, role: null })
    }
    const list = store.of(member)
    assert.equal(list.length, 100)
    assert.ok(list[0]!.at < list[99]!.at)
    assert.equal(store.of(admin).length, 0)
    await h.admin('POST', `/api/admin/users/${member}/disable`, { confirm: h.users.admin.password })
    await h.admin('DELETE', `/api/admin/users/${member}`, { confirm: h.users.admin.password })
    assert.equal(store.of(member).length, 0, 'deleting someone takes their notices')
    assert.equal(store.add(member, { code: 'account_changed', change: 'reset_link', by: admin, role: null }), null)
  } finally { await h.close() }
})
