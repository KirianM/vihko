// The admin and someone else's account (M4.1, D-040 3.1): a reset link, the
// second factor's reset and a new role ask for the confirmation at the moment
// (the current code, or the password without a second factor), and the
// person and every other admin are told, each until they dismiss it. An
// invitation (no password yet) needs neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Notices, base32Decode, totp } from '@thoth/server'
import { setup } from './_agents.ts'

const PASSWORD = 'a-long-password'
type H = Awaited<ReturnType<typeof setup>>
interface Res { status: number; body: any }
interface Notice { code: string; id: string; change?: string; role?: string | null; by: string; user?: string; at: string; actions: string[] }

/** Signs in with a password: requests with that session. */
async function session(h: H, username: string) {
  const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) })
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
    assert.equal((await h.noa('POST', '/api/admin/users', { username: 'bea', password: PASSWORD, role: 'admin' })).status, 201)
    const bea = await session(h, 'bea')
    const ana = h.users.ana.id

    // A reset link: the password (Noa has no second factor), or nothing happens.
    const missing = await h.noa('POST', `/api/admin/users/${ana}/link`)
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.noa('POST', `/api/admin/users/${ana}/link`, { confirm: 'not-it' })).body.error, 'wrong_password')
    assert.equal((await h.noa('GET', '/api/admin/users')).body.users.find((u: any) => u.id === ana).link, null, 'no link made')
    const link = await h.noa('POST', `/api/admin/users/${ana}/link`, { confirm: PASSWORD })
    assert.deepEqual([link.status, link.body.link.kind], [200, 'reset'])

    // An invitation needs no confirmation, and tells nobody.
    const carla = (await h.noa('POST', '/api/admin/users', { username: 'carla', role: 'member' })).body.user
    assert.equal((await h.noa('POST', `/api/admin/users/${carla.id}/link`)).body.link.kind, 'invite')

    // A new role: confirmed; the same role again changes nothing and asks nothing.
    assert.equal((await h.noa('PUT', `/api/admin/users/${ana}/role`, { role: 'admin' })).body.error, 'confirmation_required')
    assert.equal((await h.noa('PUT', `/api/admin/users/${ana}/role`, { role: 'member' })).status, 200)
    assert.equal((await h.noa('PUT', `/api/admin/users/${ana}/role`, { role: 'owner', confirm: PASSWORD })).body.error, 'invalid')
    assert.equal((await h.noa('PUT', `/api/admin/users/${ana}/role`, { role: 'admin', confirm: PASSWORD })).body.user.role, 'admin')

    // Her second factor: with his own, Noa confirms with its code, never the password.
    const s = await h.ana('POST', '/api/account/2fa/setup', { password: PASSWORD })
    await h.ana('POST', '/api/account/2fa/enable', { code: totp(base32Decode(s.body.secret), h.clock.now.getTime()) })
    const k = await h.noa('POST', '/api/account/2fa/setup', { password: PASSWORD })
    const noaSecret = base32Decode(k.body.secret)
    await h.noa('POST', '/api/account/2fa/enable', { code: totp(noaSecret, h.clock.now.getTime()) })
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    assert.equal((await h.noa('POST', `/api/admin/users/${ana}/2fa/reset`, { confirm: PASSWORD })).body.error, 'invalid_code')
    const reset = await h.noa('POST', `/api/admin/users/${ana}/2fa/reset`, { confirm: totp(noaSecret, h.clock.now.getTime()) })
    assert.deepEqual(reset.body.user.twoFactor, { enabled: false, enabledAt: null })

    // Ana is told what, by whom and when; Bea, the same about Ana; Noa, who did it, nothing; Carla, nothing.
    const hers = await accountNotices(h.ana)
    assert.deepEqual(hers.map((n) => [n.code, n.change, n.role, n.by]), [
      ['account_changed', 'reset_link', null, 'noa'],
      ['account_changed', 'role_changed', 'admin', 'noa'],
      ['account_changed', 'two_factor_reset', null, 'noa'],
    ])
    assert.ok(hers.every((n) => n.at && n.actions[0] === 'dismiss'))
    assert.deepEqual((await accountNotices(bea)).map((n) => [n.code, n.change, n.user, n.by]), [
      ['user_account_changed', 'reset_link', 'ana', 'noa'],
      ['user_account_changed', 'role_changed', 'ana', 'noa'],
      ['user_account_changed', 'two_factor_reset', 'ana', 'noa'],
    ])
    assert.deepEqual(await accountNotices(h.noa), [])
    assert.deepEqual(await accountNotices(await session(h, 'ana')), hers, 'still there on signing in again')

    // Each dismisses their own, and only their own.
    assert.equal((await bea('DELETE', `/api/account/notices/${hers[0]!.id}`)).status, 404)
    assert.equal((await h.ana('DELETE', `/api/account/notices/${hers[0]!.id}`)).status, 200)
    assert.equal((await accountNotices(h.ana)).length, 2)
    assert.equal((await accountNotices(bea)).length, 3)

  } finally { await h.close() }
})

test('notices: kept per person, the latest only, never for a deleted user, oldest first', async () => {
  const h = await setup()
  try {
    const store = new Notices(h.auth.state, { now: () => h.clock.now })
    const ana = h.users.ana.id
    const noa = h.users.noa.id
    for (let i = 0; i < 105; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 1000)
      store.add(ana, { code: 'account_changed', change: 'reset_link', by: noa, role: null })
    }
    const list = store.of(ana)
    assert.equal(list.length, 100)
    assert.ok(list[0]!.at < list[99]!.at)
    assert.equal(store.of(noa).length, 0)
    await h.noa('POST', `/api/admin/users/${ana}/disable`)
    await h.noa('DELETE', `/api/admin/users/${ana}`)
    assert.equal(store.of(ana).length, 0, 'deleting someone takes their notices')
    assert.equal(store.add(ana, { code: 'account_changed', change: 'reset_link', by: noa, role: null }), null)
  } finally { await h.close() }
})
