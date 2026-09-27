// THOTH_SECRET_KEY (M4.1, D-040 3.4b): the TOTP secrets in state.db stored
// encrypted with a key outside it. Every transition: none → key (the
// plaintext ones are encrypted at startup), key → the same key, key → none
// or another key (thoth starts, the admin is told, those codes can't be
// checked, recovery codes still work, and a reset fixes it), and back to the
// right key. The key never reaches state.db, the logs or thoth's children.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_SECRET_KEY, SecretBox, TwoFactor, base32Decode, isSealed, openState, secretBoxFrom, totp, type SetupData } from '@thoth/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const KEY = 'k5Q1n0mZrT8vYc2WbXe7LpA4sDf9GhJ3uIo6'
const OTHER = 'a-completely-different-key-of-40-characters'

test('the box: AES-256-GCM with a nonce each time, bound to its owner; another key, another owner or a change open nothing', () => {
  const box = new SecretBox(KEY)
  assert.match(box.id, /^[0-9a-f]{8}$/)
  const a = box.seal('JBSWY3DPEHPK3PXP', 'u1')
  const b = box.seal('JBSWY3DPEHPK3PXP', 'u1')
  assert.match(a, new RegExp(`^v1:${box.id}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$`))
  assert.notEqual(a, b, 'a random nonce for each secret')
  assert.ok(isSealed(a) && !isSealed('JBSWY3DPEHPK3PXP'), 'base32 never has a colon')
  assert.equal(box.open(a, 'u1'), 'JBSWY3DPEHPK3PXP')
  assert.equal(box.open(a, 'u2'), null, 'copied to another user\'s row, it doesn\'t open')
  assert.equal(new SecretBox(OTHER).open(a, 'u1'), null)
  assert.equal(new SecretBox(KEY).open(a, 'u1'), 'JBSWY3DPEHPK3PXP', 'the same key, derived again')
  const parts = a.split(':')
  const body = Buffer.from(parts[3]!, 'base64url')
  body[0] = body[0]! ^ 1
  assert.equal(box.open([...parts.slice(0, 3), body.toString('base64url')].join(':'), 'u1'), null, 'tampered with')
  assert.equal(box.open('v2:whatever', 'u1'), null)
  assert.throws(() => new SecretBox('x'.repeat(MIN_SECRET_KEY - 1)), /at least 32/)
})

test('the key from the environment or a Docker secret\'s file; both, a file that can\'t be read or a short key stop the start', () => {
  const dir = tempDir('thoth-key-')
  const file = join(dir, 'secret')
  writeFileSync(file, `${KEY}\n`)
  assert.equal(secretBoxFrom({}), null)
  assert.equal(secretBoxFrom({ THOTH_SECRET_KEY: '' }), null)
  assert.equal(secretBoxFrom({ THOTH_SECRET_KEY: KEY })!.id, new SecretBox(KEY).id)
  assert.equal(secretBoxFrom({ THOTH_SECRET_KEY_FILE: file })!.id, new SecretBox(KEY).id, 'its trailing newline is not part of the key')
  assert.throws(() => secretBoxFrom({ THOTH_SECRET_KEY: KEY, THOTH_SECRET_KEY_FILE: file }), /not both/)
  const unreadable = (() => { try { secretBoxFrom({ THOTH_SECRET_KEY_FILE: join(dir, 'missing') }); return null } catch (err) { return err as Error } })()
  assert.match(unreadable?.message ?? '', /can't be read \(ENOENT\)/)
  assert.throws(() => secretBoxFrom({ THOTH_SECRET_KEY: 'short' }), (err: Error) => !err.message.includes('short'), 'never says the key')
  // Read from the process's environment, it leaves it: nothing thoth runs inherits it.
  process.env.THOTH_SECRET_KEY = KEY
  assert.ok(secretBoxFrom())
  assert.equal(process.env.THOTH_SECRET_KEY, undefined)
})

/** state.db with two users, on a clock the test moves. */
function store() {
  const dir = tempDir('thoth-2fa-key-')
  const file = join(dir, 'state.db')
  const state = openState(file)
  for (const [id, name] of [['u1', 'noa'], ['u2', 'ana']]) {
    state.prepare("insert into users (id, username, password_hash, role, created_at) values (?, ?, 'x', 'member', '2026-01-01T00:00:00Z')").run(id, name)
  }
  const clock = { t: Date.parse('2026-09-27T10:00:05Z') }
  const tf = (box: SecretBox | null) => new TwoFactor(state, { now: () => new Date(clock.t), box })
  const code = (s: SetupData) => totp(base32Decode(s.secret), clock.t)
  const next = () => { clock.t += 30_000 }
  const stored = (id: string) => (state.prepare('select secret from two_factor where user_id = ?').get(id) as { secret: string }).secret
  return { file, state, tf, code, next, stored }
}

test('transitions: plaintext, encrypted at startup with a key, unreadable without it or with another, readable again with it; a reset fixes it', () => {
  const s = store()
  // No key: plaintext, as before.
  const plain = s.tf(null)
  const noa = plain.beginSetup('u1', 'noa')
  const recovery = plain.finishSetup('u1', s.code(noa))!
  assert.equal(s.stored('u1'), noa.secret.replace(/ /g, ''))
  assert.equal(plain.sealPlaintext(), 0, 'without a key, nothing to do')
  assert.deepEqual(plain.unreadable(), [])

  // A key: the plaintext ones are encrypted, once; codes go on working.
  const box = new SecretBox(KEY)
  const keyed = s.tf(box)
  assert.equal(keyed.sealPlaintext(), 1)
  assert.equal(keyed.sealPlaintext(), 0, 'the same key again: nothing left to encrypt')
  assert.ok(isSealed(s.stored('u1')) && !s.stored('u1').includes(noa.secret.replace(/ /g, '')))
  s.next()
  assert.equal(keyed.verify('u1', s.code(noa)).ok, true)
  // A new one with the key is stored encrypted from the start, and both coexist with plaintext ones.
  const ana = keyed.beginSetup('u2', 'ana')
  keyed.finishSetup('u2', s.code(ana))
  assert.ok(isSealed(s.stored('u2')))
  assert.deepEqual(keyed.unreadable(), [])

  // The key gone (or another one): thoth still works; those codes can't be checked, recovery codes can.
  for (const other of [null, new SecretBox(OTHER)]) {
    const without = s.tf(other)
    assert.deepEqual(without.unreadable().sort(), ['u1', 'u2'])
    assert.equal(without.sealPlaintext(), 0, 'what another key encrypted is left as it is')
    s.next()
    assert.deepEqual(without.verify('u1', s.code(noa)), { ok: false, reason: 'invalid' })
    assert.equal(without.enabled('u1'), true, 'still theirs: asked for at sign-in, never skipped')
  }
  assert.equal(s.tf(null).verify('u1', recovery[0], { recovery: true }).ok, true, 'a recovery code still works')

  // The right key back: everything is readable again.
  s.next()
  assert.deepEqual(s.tf(box).unreadable(), [])
  assert.equal(s.tf(box).verify('u1', s.code(noa)).ok, true)

  // `thoth user reset-2fa` (or the admin's reset) takes an unreadable one away.
  assert.equal(s.tf(null).disable('u2'), true)
  assert.deepEqual(s.tf(null).unreadable(), ['u1'])

  // Nothing of the key, and no secret in the clear, in the file.
  s.state.pragma('wal_checkpoint(truncate)')
  const bytes = readFileSync(s.file).toString('latin1')
  assert.ok(!bytes.includes(KEY) && !bytes.includes(noa.secret.replace(/ /g, '')))
})

test('the admin is told whose second factor can\'t be read; that person signs in with a recovery code', async () => {
  const h = await setup()
  try {
    const s = await h.ana('POST', '/api/account/2fa/setup', { password: 'a-long-password' })
    const r = await h.ana('POST', '/api/account/2fa/enable', { code: totp(base32Decode(s.body.secret), h.clock.now.getTime()) })
    // Encrypted with a key this thoth doesn't have (as after THOTH_SECRET_KEY changed).
    assert.equal(new TwoFactor(h.auth.state, { box: new SecretBox(OTHER) }).sealPlaintext(), 1)
    const alerts = async (as: typeof h.noa) => ((await as('GET', '/api/alerts')).body.alerts as { code: string; users?: string[] }[]).filter((a) => a.code === 'two_factor_unreadable')
    assert.deepEqual(await alerts(h.noa), [{ code: 'two_factor_unreadable', users: ['ana'], actions: [] }])
    assert.deepEqual(await alerts(h.ana), [], 'only admins')
    const login = async () => (await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'a-long-password' }) })).json() as Promise<any>
    const code = async (pending: string, c: string) => (await h.app.request('/api/auth/login/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pending, code: c }) })).status
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    const first = await login()
    assert.equal(first.step, 'code', 'never skipped')
    assert.equal(await code(first.pending, totp(base32Decode(s.body.secret), h.clock.now.getTime())), 401)
    assert.equal(await code(first.pending, r.body.recoveryCodes[0]), 200)
    // The admin's reset fixes it.
    assert.equal((await h.noa('POST', `/api/admin/users/${h.users.ana.id}/2fa/reset`, { confirm: 'a-long-password' })).status, 200)
    assert.deepEqual(await alerts(h.noa), [])
  } finally { await h.close() }
})

/** Runs `thoth serve` until it listens, then stops it: its log. */
async function serve(env: Record<string, string>): Promise<{ log: string; code: number | null }> {
  const p = spawn(process.execPath, ['--no-experimental-webstorage', CLI, 'serve'], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const done = new Promise<number | null>((resolve) => p.once('exit', resolve))
  await new Promise<void>((resolve) => {
    const on = (b: Buffer) => { log += b.toString('utf8'); if (/listening on|Error/.test(log)) resolve() }
    p.stdout.on('data', on)
    p.stderr.on('data', on)
    void done.then(() => resolve())
  })
  p.kill('SIGTERM')
  return { log, code: await done }
}

test('startup: with the key, the plaintext secrets are encrypted and it says so; with another, thoth starts and says whose can\'t be read; never the key', async () => {
  const dir = tempDir('thoth-serve-key-')
  const notes = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notes, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const state = openState(join(stateDir, 'state.db'))
  state.prepare("insert into users (id, username, password_hash, role, created_at) values ('u1', 'noa', 'x', 'admin', '2026-01-01T00:00:00Z')").run()
  state.prepare("insert into two_factor (user_id, secret, enabled_at) values ('u1', 'JBSWY3DPEHPK3PXP', '2026-01-01T00:00:00Z')").run()
  state.close()
  const base = { THOTH_NOTES_DIR: notes, THOTH_STATE_DIR: stateDir, THOTH_HOST: '127.0.0.1', THOTH_PORT: '0', THOTH_WEB_DIR: join(dir, 'no-ui') }

  const first = await serve({ ...base, THOTH_SECRET_KEY: KEY })
  assert.match(first.log, /second factors are stored encrypted \(1 encrypted now\)/)
  assert.ok(!first.log.includes(KEY))
  const check = openState(join(stateDir, 'state.db'))
  const sealed = (check.prepare("select secret from two_factor where user_id = 'u1'").get() as { secret: string }).secret
  check.close()
  assert.ok(isSealed(sealed))

  const again = await serve({ ...base, THOTH_SECRET_KEY: KEY })
  assert.match(again.log, /second factors are stored encrypted\n/, 'nothing left to encrypt')

  const keyFile = join(dir, 'other')
  writeFileSync(keyFile, OTHER)
  const other = await serve({ ...base, THOTH_SECRET_KEY_FILE: keyFile })
  assert.match(other.log, /listening on/, 'it starts')
  assert.match(other.log, /1 second factor\(s\) can't be read with this THOTH_SECRET_KEY/)
  assert.ok(!other.log.includes(OTHER))

  const none = await serve(base)
  assert.match(none.log, /listening on/)
  assert.match(none.log, /can't be read without THOTH_SECRET_KEY/)
})
