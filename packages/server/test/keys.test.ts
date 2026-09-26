import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiKeys, Auth, Integrations, LAST_USED_EVERY_MS, integrationsLockedFrom, keyIdOf, openState } from '@thoth/server'

/** Each test's folder, removed at the end. */
const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-keys-'))
  dirs.push(dir)
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const clock = { now: new Date('2026-09-26T10:00:00Z') }
  const keys = new ApiKeys(state, { now: () => clock.now })
  const noa = await auth.createUser('noa', 'a-long-password', 'admin')
  return { state, auth, keys, noa, clock }
}

test('a key: thoth_<id>_<secret>, shown once; only the sha256 of the secret and its last 4 characters are kept', async () => {
  const { state, keys, noa } = await setup()
  const { key, token } = keys.create(noa, { name: 'Claude Code' })
  const m = /^thoth_([0-9A-Z]{26})_([A-Za-z0-9_-]{43})$/.exec(token)
  assert.ok(m, token)
  assert.equal(Buffer.from(m[2]!, 'base64url').length, 32, '256 bits of secret')
  assert.equal(keyIdOf(token), key.id)
  const row = state.prepare('select * from api_keys where id = ?').get(key.id) as Record<string, unknown>
  // Checked by an independent route: node's sha256 of the secret as written in the key.
  assert.equal(row.secret_hash, createHash('sha256').update(m[2]!).digest('hex'))
  assert.equal(row.last4, token.slice(-4))
  assert.ok(!JSON.stringify(row).includes(m[2]!), 'the secret itself is not stored')
  assert.ok(!JSON.stringify(keys.list(noa.id)).includes(m[2]!), 'nor listed')
  // New keys: read-only, every folder, no expiry.
  assert.deepEqual({ ...key, id: '', createdAt: '' }, {
    id: '', userId: noa.id, name: 'Claude Code', canWrite: false, folders: [], expiresAt: null, createdAt: '',
    lastUsedAt: null, lastVia: null, revokedAt: null, last4: token.slice(-4), status: 'active', client: null,
  })
})

test('authenticating: the right secret of a live key of an enabled user, and nothing else', async () => {
  const { state, keys, noa, clock } = await setup()
  const { key, token } = keys.create(noa, { name: 'Blog', canWrite: true, folders: ['proyectos/'] })
  const p = keys.authenticate(token, 'api')
  assert.deepEqual(p, { kind: 'agent', via: 'api', user: { ...noa }, key: { id: key.id, name: 'Blog', canWrite: true, folders: ['proyectos'] } })
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
  state.prepare('update users set disabled = 1 where id = ?').run(noa.id)
  assert.equal(keys.authenticate(token, 'api'), null)
  state.prepare('update users set disabled = 0 where id = ?').run(noa.id)
  // Revoked, for good.
  assert.equal(keys.revoke(key.id).status, 'revoked')
  assert.equal(keys.authenticate(token, 'api'), null)
  assert.throws(() => keys.update(key.id, { canWrite: false }), { code: 'invalid' })
})

test('last use: written at most every 5 minutes, or when the way in changes', async () => {
  const { keys, noa, clock } = await setup()
  const { key, token } = keys.create(noa, { name: 'x' })
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
  const { keys, noa } = await setup()
  for (const name of ['', '   ', 'x'.repeat(101), 'two\nlines', 3]) assert.throws(() => keys.create(noa, { name }), { code: 'invalid' }, String(name))
  for (const folders of [['../fuera'], ['/abs'], ['.oculta'], ['a/.git'], [''], 'proyectos', [3]]) {
    assert.throws(() => keys.create(noa, { name: 'x', folders }), { code: /^invalid/ }, JSON.stringify(folders))
  }
  assert.throws(() => keys.create(noa, { name: 'x', canWrite: 'yes' }), { code: 'invalid' })
  assert.throws(() => keys.create(noa, { name: 'x', expiresAt: '2020-01-01T00:00:00Z' }), { code: 'invalid' })
  assert.throws(() => keys.create(noa, { name: 'x', expiresAt: 'mañana' }), { code: 'invalid' })
  // NFC, without a trailing slash, without repeats or folders inside others on the list.
  const k = keys.create(noa, { name: ' Café ', folders: ['Café/', 'Café', 'Café/recetas', 'b'] }).key
  assert.deepEqual([k.name, k.folders], ['Café', ['Café', 'b']])
  assert.deepEqual(keys.update(k.id, { folders: [] }).folders, [], 'back to every folder')
})

test('the admin sees everyone\'s keys with their user; names stay for the history once revoked', async () => {
  const { auth, keys, noa } = await setup()
  const ana = await auth.createUser('ana', 'a-long-password', 'member')
  const a = keys.create(ana, { name: 'Ana bot' }).key
  keys.create(noa, { name: 'Claude Code' })
  assert.deepEqual(keys.list(ana.id).map((k) => k.name), ['Ana bot'])
  assert.deepEqual(keys.listAll().map((k) => [k.user.username, k.name]), [['ana', 'Ana bot'], ['noa', 'Claude Code']])
  keys.revoke(a.id)
  assert.equal(keys.nameOf(a.id), 'Ana bot')
  assert.equal(keys.nameOf('nope'), null)
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
