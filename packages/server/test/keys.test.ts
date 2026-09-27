import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ApiKeys, Auth, Integrations, LAST_USED_EVERY_MS, ROTATION_GRACE_MS, integrationsLockedFrom, keyIdOf, openState } from '@thoth/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** SQLite's `collate nocase` order, which thoth lists usernames in: ASCII letters folded, then bytes. */
const nocase = (a: string, b: string) => Buffer.compare(Buffer.from(a.replace(/[A-Z]/g, (c) => c.toLowerCase())), Buffer.from(b.replace(/[A-Z]/g, (c) => c.toLowerCase())))

/** Each test's folder, removed at the end. */
const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function setup() {
  const dir = tempDir('thoth-keys-')
  dirs.push(dir)
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const clock = { now: new Date('2026-09-26T10:00:00Z') }
  const keys = new ApiKeys(state, { now: () => clock.now })
  const person = m.aUser({ role: 'admin' })
  const admin = await auth.createUser(person.username, person.password, 'admin')
  return { state, auth, keys, admin, clock }
}

test('a key: thoth_<id>_<secret>, shown once; only the sha256 of the secret and its last 4 characters are kept', async () => {
  const { state, keys, admin } = await setup()
  const name = m.aKeyName()
  const { key, token } = keys.create(admin, { name })
  const parts = /^thoth_([0-9A-Z]{26})_([A-Za-z0-9_-]{43})$/.exec(token)
  assert.ok(parts, token)
  assert.equal(Buffer.from(parts[2]!, 'base64url').length, 32, '256 bits of secret')
  assert.equal(keyIdOf(token), key.id)
  const row = state.prepare('select * from api_keys where id = ?').get(key.id) as Record<string, unknown>
  // Checked by an independent route: node's sha256 of the secret as written in the key.
  assert.equal(row.secret_hash, createHash('sha256').update(parts[2]!).digest('hex'))
  assert.equal(row.last4, token.slice(-4))
  assert.ok(!JSON.stringify(row).includes(parts[2]!), 'the secret itself is not stored')
  assert.ok(!JSON.stringify(keys.list(admin.id)).includes(parts[2]!), 'nor listed')
  // New keys: read-only, every folder, no expiry.
  assert.deepEqual({ ...key, id: '', createdAt: '' }, {
    id: '', userId: admin.id, name, canWrite: false, folders: [], expiresAt: null, createdAt: '',
    lastUsedAt: null, lastVia: null, revokedAt: null, last4: token.slice(-4), status: 'active', client: null, previousUntil: null,
  })
})

test('authenticating: the right secret of a live key of an enabled user, and nothing else', async () => {
  const { state, keys, admin, clock } = await setup()
  const [name, folder] = [m.aKeyName(), m.aFolder()]
  // Its folder as written, with a trailing slash: kept without it.
  const { key, token } = keys.create(admin, { name, canWrite: true, folders: [`${folder}/`] })
  const p = keys.authenticate(token, 'api')
  assert.deepEqual(p, { kind: 'agent', via: 'api', user: { ...admin }, key: { id: key.id, name, canWrite: true, folders: [folder] } })
  const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  for (const bad of [wrong, '', 'thoth_', token + 'x', token.replace('thoth_', 'toth_'), `thoth_${'0'.repeat(26)}_${token.slice(-43)}`]) {
    assert.equal(keys.authenticate(bad, 'api'), null, bad)
  }
  assert.equal(keys.authenticate(token, 'telnet' as 'api'), null)
  // Expired.
  keys.update(key.id, { expiresAt: '2026-09-27T00:00:00Z' })
  clock.now = new Date('2026-09-27T00:00:00Z')
  assert.equal(keys.authenticate(token, 'api'), null)
  assert.equal(keys.get(key.id)!.status, 'expired')
  clock.now = new Date('2026-09-26T12:00:00Z')
  assert.ok(keys.authenticate(token, 'api'))
  // A disabled user invalidates their keys.
  state.prepare('update users set disabled = 1 where id = ?').run(admin.id)
  assert.equal(keys.authenticate(token, 'api'), null)
  state.prepare('update users set disabled = 0 where id = ?').run(admin.id)
  // Revoked, for good.
  assert.equal(keys.revoke(key.id).status, 'revoked')
  assert.equal(keys.authenticate(token, 'api'), null)
  assert.throws(() => keys.update(key.id, { canWrite: false }), { code: 'invalid' })
})

test('rotating: a new secret shown once, the same key otherwise; the old one works 10 more minutes and then never', async () => {
  const { state, keys, admin, clock } = await setup()
  const [name, folder] = [m.aKeyName(), m.aFolder()]
  const { key, token: old } = keys.create(admin, { name, canWrite: true, folders: [folder] })
  keys.authenticate(old, 'mcp')
  const start = clock.now.getTime()
  const { key: rotated, token } = keys.rotate(key.id)
  assert.notEqual(token, old)
  assert.equal(keyIdOf(token), key.id, 'the same key: same id, and so the same name in the history')
  assert.deepEqual({ ...rotated, last4: '', previousUntil: '' }, { ...keys.get(key.id)!, last4: '', previousUntil: '' })
  assert.deepEqual([rotated.name, rotated.canWrite, rotated.folders, rotated.lastVia, rotated.last4], [name, true, [folder], 'mcp', token.slice(-4)])
  assert.equal(rotated.previousUntil, new Date(start + ROTATION_GRACE_MS).toISOString())
  const secret = (t: string) => t.slice(-43)
  const row = state.prepare('select * from api_keys where id = ?').get(key.id) as Record<string, unknown>
  assert.equal(row.previous_secret_hash, createHash('sha256').update(secret(old)).digest('hex'))
  assert.ok(!JSON.stringify(row).includes(secret(token)) && !JSON.stringify(row).includes(secret(old)), 'no secret stored, old or new')
  // Both work during the grace.
  assert.ok(keys.authenticate(token, 'api'))
  clock.now = new Date(start + ROTATION_GRACE_MS - 1000)
  assert.ok(keys.authenticate(old, 'api'))
  // Then only the new one.
  clock.now = new Date(start + ROTATION_GRACE_MS)
  assert.equal(keys.authenticate(old, 'api'), null)
  assert.ok(keys.authenticate(token, 'api'))
  assert.equal(keys.get(key.id)!.previousUntil, null)
  // Rotating again: the one replaced gets the grace, the one before it stops at once.
  const third = keys.rotate(key.id).token
  assert.equal(keys.authenticate(old, 'api'), null)
  assert.ok(keys.authenticate(token, 'api'))
  assert.ok(keys.authenticate(third, 'api'))
  // Revoking ends the grace too; a revoked key can't rotate.
  keys.revoke(key.id)
  assert.equal(keys.authenticate(token, 'api'), null)
  assert.equal(keys.get(key.id)!.previousUntil, null)
  assert.throws(() => keys.rotate(key.id), { code: 'invalid' })
  // Nor an expired one, nor an OAuth authorization (revoked instead), nor one that doesn't exist.
  const exp = keys.create(admin, { name: m.aKeyName(), expiresAt: new Date(clock.now.getTime() + 60_000).toISOString() })
  clock.now = new Date(clock.now.getTime() + 60_000)
  assert.throws(() => keys.rotate(exp.key.id), { code: 'invalid' })
  const client = { id: m.faker.string.uuid(), name: m.aKeyName() }
  state.prepare(`insert into oauth_clients (id, name, redirect_uris, auth_method, created_at) values (?, ?, '["https://c.example/cb"]', 'none', ?)`).run(client.id, client.name, clock.now.toISOString())
  const auth = keys.authorizeClient(admin.id, client, { canWrite: false, folders: [] })
  assert.throws(() => keys.rotate(auth), { code: 'invalid' })
  assert.throws(() => keys.rotate(m.faker.string.ulid()), { code: 'not_found' })
})

test('last use: written at most every 5 minutes, or when the way in changes', async () => {
  const { keys, admin, clock } = await setup()
  const { key, token } = keys.create(admin, { name: m.aKeyName() })
  const t0 = clock.now
  keys.authenticate(token, 'api')
  assert.deepEqual([keys.get(key.id)!.lastUsedAt, keys.get(key.id)!.lastVia], [t0.toISOString(), 'api'])
  clock.now = new Date(t0.getTime() + LAST_USED_EVERY_MS - 1000)
  keys.authenticate(token, 'api')
  assert.equal(keys.get(key.id)!.lastUsedAt, t0.toISOString(), 'not on every request')
  keys.authenticate(token, 'mcp')
  assert.deepEqual([keys.get(key.id)!.lastUsedAt, keys.get(key.id)!.lastVia], [clock.now.toISOString(), 'mcp'])
  clock.now = new Date(clock.now.getTime() + LAST_USED_EVERY_MS)
  keys.authenticate(token, 'mcp')
  assert.equal(keys.get(key.id)!.lastUsedAt, clock.now.toISOString())
})

test('key settings are checked: name, folders as the notes root names them, a future expiry', async () => {
  const { keys, admin } = await setup()
  for (const name of ['', '   ', 'x'.repeat(101), 'two\nlines', 3]) assert.throws(() => keys.create(admin, { name }), { code: 'invalid' }, String(name))
  // Out of the root, absolute, hidden (itself or a folder in it), empty, not a list, not text.
  for (const folders of [[`../${m.aFolder()}`], [`/${m.aFolder()}`], [`.${m.aWord()}`], [`${m.aFolder()}/.${m.aWord()}`], [''], m.aFolder(), [3]]) {
    assert.throws(() => keys.create(admin, { name: m.aKeyName(), folders }), { code: /^invalid/ }, JSON.stringify(folders))
  }
  assert.throws(() => keys.create(admin, { name: m.aKeyName(), canWrite: 'yes' }), { code: 'invalid' })
  assert.throws(() => keys.create(admin, { name: m.aKeyName(), expiresAt: '2020-01-01T00:00:00Z' }), { code: 'invalid' })
  assert.throws(() => keys.create(admin, { name: m.aKeyName(), expiresAt: m.aWord() }), { code: 'invalid' })
  // NFC, without a trailing slash, without repeats or folders inside others on the list:
  // a folder with an accent written decomposed (NFD), again composed, one inside it, and another.
  let folder = m.aFolder()
  while (folder.normalize('NFD') === folder) folder = m.aFolder()
  const [inside, another, name] = [m.aFolder(), m.aFolder(), m.aKeyName()]
  const k = keys.create(admin, { name: ` ${name.normalize('NFD')} `, folders: [`${folder.normalize('NFD')}/`, folder, `${folder}/${inside}`, another] }).key
  assert.deepEqual([k.name, k.folders], [name, [folder, another].sort()])
  assert.deepEqual(keys.update(k.id, { folders: [] }).folders, [], 'back to every folder')
})

test('the admin sees everyone\'s keys with their user; names stay for the history once revoked', async () => {
  const { auth, keys, admin } = await setup()
  const someone = m.aUser()
  const member = await auth.createUser(someone.username, someone.password, 'member')
  const [botName, adminKey] = [m.aKeyName(), m.aKeyName()]
  const a = keys.create(member, { name: botName }).key
  keys.create(admin, { name: adminKey })
  assert.deepEqual(keys.list(member.id).map((k) => k.name), [botName])
  // By username, as thoth lists them.
  const expected = [[member.username, botName], [admin.username, adminKey]].sort(([x], [y]) => nocase(x!, y!))
  assert.deepEqual(keys.listAll().map((k) => [k.user.username, k.name]), expected)
  keys.revoke(a.id)
  assert.equal(keys.nameOf(a.id), botName)
  assert.equal(keys.nameOf(m.faker.string.ulid()), null)
})

test('integration switches: off by default, members may create keys; THOTH_INTEGRATIONS=off locks the API and MCP off', async () => {
  const { state } = await setup()
  const open = new Integrations(state)
  assert.deepEqual(open.view(), { api: false, mcp: false, membersCanCreateKeys: true, oauthRegistration: true, locked: false })
  assert.deepEqual([open.apiEnabled(), open.mcpEnabled()], [false, false])
  open.set({ api: true, membersCanCreateKeys: false })
  assert.deepEqual(open.view(), { api: true, mcp: false, membersCanCreateKeys: false, oauthRegistration: true, locked: false })
  assert.equal(open.apiEnabled(), true)
  assert.throws(() => open.set({ api: 'yes' as unknown as boolean }), { code: 'invalid' })
  assert.throws(() => open.set({ nope: true } as never), { code: 'invalid' })

  const locked = new Integrations(state, { locked: true })
  assert.deepEqual(locked.view(), { api: true, mcp: false, membersCanCreateKeys: false, oauthRegistration: true, locked: true })
  assert.equal(locked.apiEnabled(), false, 'whatever state.db says')
  assert.throws(() => locked.set({ mcp: true }), { code: 'integrations_locked' })
  assert.equal(locked.set({ api: false }).api, false, 'turning off is still stored')
  assert.equal(locked.set({ membersCanCreateKeys: true }).membersCanCreateKeys, true)
  // OAuth registration is its own switch (it only matters while the MCP server is on).
  assert.equal(locked.set({ oauthRegistration: false }).oauthRegistration, false)
  assert.throws(() => open.set({ oauthRegistration: 'no' as unknown as boolean }), { code: 'invalid' })

  assert.equal(integrationsLockedFrom(undefined), false)
  assert.equal(integrationsLockedFrom(''), false)
  assert.equal(integrationsLockedFrom(' OFF '), true)
  assert.throws(() => integrationsLockedFrom('on'), /only be "off"/)
})
