// The admin and someone else's account (M4.1, D-040 3.1): a reset link, the
// second factor's reset and a new role ask for the confirmation at the moment
// (the current code, or the password without a second factor), and the
// person and every other admin are told, each until they dismiss it. An
// invitation (no password yet) needs neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Notices, base32Decode, totp } from '@thoth/server'
import { setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
type H = Awaited<ReturnType<typeof setup>>
interface Res { status: number; body: any }
interface Notice { code: string; id: string; change?: string; role?: string | null; by: string; user?: string; at: string; actions: string[] }

/** Signs someone in with their password: requests with that session. */
async function session(h: H, { username, password }: { username: string; password: string }) {
  const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('thoth_session='))!.split(';')[0]!
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
    assert.equal((await h.admin('POST', '/api/admin/users', { username: second.username, password: second.password, role: 'admin' })).status, 201)
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
    await h.admin('POST', `/api/admin/users/${member}/disable`)
    await h.admin('DELETE', `/api/admin/users/${member}`)
    assert.equal(store.of(member).length, 0, 'deleting someone takes their notices')
    assert.equal(store.add(member, { code: 'account_changed', change: 'reset_link', by: admin, role: null }), null)
  } finally { await h.close() }
})
