// VIHKO_SECRET_KEY: the TOTP secrets in state.db stored
// encrypted with a key outside it. Every transition: none → key (the
// plaintext ones are encrypted at startup), key → the same key, key → none
// or another key (vihko starts, the admin is told, those codes can't be
// checked, recovery codes still work, and a reset fixes it), and back to the
// right key. The key never reaches state.db, the logs or vihko's children.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_SECRET_KEY, SecretBox, TwoFactor, base32Decode, isSealed, openState, secretBoxFrom, totp, type SetupData } from '@vihko/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
/** VIHKO_SECRET_KEY, and another one: long enough (MIN_SECRET_KEY), and different. */
const KEY = m.aSecret(m.anInt(MIN_SECRET_KEY, 64))
const OTHER = m.aSecret(m.anInt(MIN_SECRET_KEY, 64))
/** A TOTP secret as vihko stores it without a key: base32. */
const TOTP_SECRET = m.faker.string.fromCharacters('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 32)

test('the box: AES-256-GCM with a nonce each time, bound to its owner; another key, another owner or a change open nothing', () => {
  const box = new SecretBox(KEY)
  assert.match(box.id, /^[0-9a-f]{8}$/)
  const a = box.seal(TOTP_SECRET, 'u1')
  const b = box.seal(TOTP_SECRET, 'u1')
  assert.match(a, new RegExp(`^v1:${box.id}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$`))
  assert.notEqual(a, b, 'a random nonce for each secret')
  assert.ok(isSealed(a) && !isSealed(TOTP_SECRET), 'base32 never has a colon')
  assert.equal(box.open(a, 'u1'), TOTP_SECRET)
  assert.equal(box.open(a, 'u2'), null, 'copied to another user\'s row, it doesn\'t open')
  assert.equal(new SecretBox(OTHER).open(a, 'u1'), null)
  assert.equal(new SecretBox(KEY).open(a, 'u1'), TOTP_SECRET, 'the same key, derived again')
  const parts = a.split(':')
  const body = Buffer.from(parts[3]!, 'base64url')
  body[0] = body[0]! ^ 1
  assert.equal(box.open([...parts.slice(0, 3), body.toString('base64url')].join(':'), 'u1'), null, 'tampered with')
  assert.equal(box.open('v2:whatever', 'u1'), null)
  assert.throws(() => new SecretBox('x'.repeat(MIN_SECRET_KEY - 1)), /at least 32/)
})

test('the key from the environment or a Docker secret\'s file; both, a file that can\'t be read or a short key stop the start', () => {
  const dir = tempDir('vihko-key-')
  const file = join(dir, 'secret')
  writeFileSync(file, `${KEY}\n`)
  assert.equal(secretBoxFrom({}), null)
  assert.equal(secretBoxFrom({ VIHKO_SECRET_KEY: '' }), null)
  assert.equal(secretBoxFrom({ VIHKO_SECRET_KEY: KEY })!.id, new SecretBox(KEY).id)
  assert.equal(secretBoxFrom({ VIHKO_SECRET_KEY_FILE: file })!.id, new SecretBox(KEY).id, 'its trailing newline is not part of the key')
  assert.throws(() => secretBoxFrom({ VIHKO_SECRET_KEY: KEY, VIHKO_SECRET_KEY_FILE: file }), /not both/)
  const unreadable = (() => { try { secretBoxFrom({ VIHKO_SECRET_KEY_FILE: join(dir, 'missing') }); return null } catch (err) { return err as Error } })()
  assert.match(unreadable?.message ?? '', /can't be read \(ENOENT\)/)
  const short = m.aSecret(m.anInt(8, MIN_SECRET_KEY - 1))
  assert.throws(() => secretBoxFrom({ VIHKO_SECRET_KEY: short }), (err: Error) => !err.message.includes(short), 'never says the key')
  // Read from the process's environment, it leaves it: nothing vihko runs inherits it.
  process.env.VIHKO_SECRET_KEY = KEY
  assert.ok(secretBoxFrom())
  assert.equal(process.env.VIHKO_SECRET_KEY, undefined)
})

/** state.db with two users (u1 and u2, `names`), on a clock the test moves. */
function store() {
  const dir = tempDir('vihko-2fa-key-')
  const file = join(dir, 'state.db')
  const state = openState(file)
  const names = { u1: m.aUsername(), u2: m.aUsername() }
  for (const [id, name] of Object.entries(names)) {
    state.prepare("insert into users (id, username, password_hash, role, created_at) values (?, ?, 'x', 'member', '2026-01-01T00:00:00Z')").run(id, name)
  }
  const clock = { t: Date.parse('2026-09-27T10:00:05Z') }
  const tf = (box: SecretBox | null) => new TwoFactor(state, { now: () => new Date(clock.t), box })
  const code = (s: SetupData) => totp(base32Decode(s.secret), clock.t)
  const next = () => { clock.t += 30_000 }
  const stored = (id: string) => (state.prepare('select secret from two_factor where user_id = ?').get(id) as { secret: string }).secret
  return { file, state, names, tf, code, next, stored }
}

test('transitions: plaintext, encrypted at startup with a key, unreadable without it or with another, readable again with it; a reset fixes it', async () => {
  const s = store()
  // No key: plaintext, as before.
  const plain = s.tf(null)
  const first = plain.beginSetup('u1', s.names.u1)
  const recovery = (await plain.finishSetup('u1', s.code(first)))!
  assert.equal(s.stored('u1'), first.secret.replace(/ /g, ''))
  assert.equal(plain.sealPlaintext(), 0, 'without a key, nothing to do')
  assert.deepEqual(plain.unreadable(), [])

  // A key: the plaintext ones are encrypted, once; codes go on working.
  const box = new SecretBox(KEY)
  const keyed = s.tf(box)
  assert.equal(keyed.sealPlaintext(), 1)
  assert.equal(keyed.sealPlaintext(), 0, 'the same key again: nothing left to encrypt')
  assert.ok(isSealed(s.stored('u1')) && !s.stored('u1').includes(first.secret.replace(/ /g, '')))
  s.next()
  assert.equal((await keyed.verify('u1', s.code(first))).ok, true)
  // A new one with the key is stored encrypted from the start, and both coexist with plaintext ones.
  const second = keyed.beginSetup('u2', s.names.u2)
  await keyed.finishSetup('u2', s.code(second))
  assert.ok(isSealed(s.stored('u2')))
  assert.deepEqual(keyed.unreadable(), [])

  // The key gone (or another one): vihko still works; those codes can't be checked, recovery codes can.
  for (const other of [null, new SecretBox(OTHER)]) {
    const without = s.tf(other)
    assert.deepEqual(without.unreadable().sort(), ['u1', 'u2'])
    assert.equal(without.sealPlaintext(), 0, 'what another key encrypted is left as it is')
    s.next()
    assert.deepEqual(await without.verify('u1', s.code(first)), { ok: false, reason: 'invalid' })
    assert.equal(without.enabled('u1'), true, 'still theirs: asked for at sign-in, never skipped')
  }
  assert.equal((await s.tf(null).verify('u1', recovery[0], { recovery: true })).ok, true, 'a recovery code still works')

  // The right key back: everything is readable again.
  s.next()
  assert.deepEqual(s.tf(box).unreadable(), [])
  assert.equal((await s.tf(box).verify('u1', s.code(first))).ok, true)

  // `vihko user reset-2fa` (or the admin's reset) takes an unreadable one away.
  assert.equal(s.tf(null).disable('u2'), true)
  assert.deepEqual(s.tf(null).unreadable(), ['u1'])

  // Nothing of the key, and no secret in the clear, in the file.
  s.state.pragma('wal_checkpoint(truncate)')
  const bytes = readFileSync(s.file).toString('latin1')
  assert.ok(!bytes.includes(KEY) && !bytes.includes(first.secret.replace(/ /g, '')))
})

test('the admin is told whose second factor can\'t be read; that person signs in with a recovery code', async () => {
  const h = await setup()
  try {
    const s = await h.member('POST', '/api/account/2fa/setup', { password: h.users.member.password })
    const r = await h.member('POST', '/api/account/2fa/enable', { code: totp(base32Decode(s.body.secret), h.clock.now.getTime()) })
    // Encrypted with a key this vihko doesn't have (as after VIHKO_SECRET_KEY changed).
    assert.equal(new TwoFactor(h.auth.state, { box: new SecretBox(OTHER) }).sealPlaintext(), 1)
    const alerts = async (as: typeof h.admin) => ((await as('GET', '/api/alerts')).body.alerts as { code: string; users?: string[] }[]).filter((a) => a.code === 'two_factor_unreadable')
    assert.deepEqual(await alerts(h.admin), [{ code: 'two_factor_unreadable', users: [h.users.member.username], actions: [] }])
    assert.deepEqual(await alerts(h.member), [], 'only admins')
    const { username, password } = h.users.member
    const login = async () => (await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).json() as Promise<any>
    const code = async (pending: string, c: string) => (await h.app.request('/api/auth/login/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pending, code: c }) })).status
    h.clock.now = new Date(h.clock.now.getTime() + 30_000)
    const first = await login()
    assert.equal(first.step, 'code', 'never skipped')
    assert.equal(await code(first.pending, totp(base32Decode(s.body.secret), h.clock.now.getTime())), 401)
    assert.equal(await code(first.pending, r.body.recoveryCodes[0]), 200)
    // The admin's reset fixes it.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.users.member.id}/2fa/reset`, { confirm: h.users.admin.password })).status, 200)
    assert.deepEqual(await alerts(h.admin), [])
  } finally { await h.close() }
})

/** Runs `vihko serve` until it listens, then stops it: its log. */
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

test('startup: with the key, the plaintext secrets are encrypted and it says so; with another, vihko starts and says whose can\'t be read; never the key', async () => {
  const dir = tempDir('vihko-serve-key-')
  const notes = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notes, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const state = openState(join(stateDir, 'state.db'))
  state.prepare("insert into users (id, username, password_hash, role, created_at) values ('u1', ?, 'x', 'admin', '2026-01-01T00:00:00Z')").run(m.aUsername())
  state.prepare("insert into two_factor (user_id, secret, enabled_at) values ('u1', ?, '2026-01-01T00:00:00Z')").run(TOTP_SECRET)
  state.close()
  const base = { VIHKO_NOTES_DIR: notes, VIHKO_STATE_DIR: stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(dir, 'no-ui') }

  const first = await serve({ ...base, VIHKO_SECRET_KEY: KEY })
  assert.match(first.log, /second factors are stored encrypted \(1 encrypted now\)/)
  assert.ok(!first.log.includes(KEY))
  const check = openState(join(stateDir, 'state.db'))
  const sealed = (check.prepare("select secret from two_factor where user_id = 'u1'").get() as { secret: string }).secret
  check.close()
  assert.ok(isSealed(sealed))

  const again = await serve({ ...base, VIHKO_SECRET_KEY: KEY })
  assert.match(again.log, /second factors are stored encrypted\n/, 'nothing left to encrypt')

  const keyFile = join(dir, 'other')
  writeFileSync(keyFile, OTHER)
  const other = await serve({ ...base, VIHKO_SECRET_KEY_FILE: keyFile })
  assert.match(other.log, /listening on/, 'it starts')
  assert.match(other.log, /1 second factor\(s\) can't be read with this VIHKO_SECRET_KEY/)
  assert.ok(!other.log.includes(OTHER))

  const none = await serve(base)
  assert.match(none.log, /listening on/)
  assert.match(none.log, /can't be read without VIHKO_SECRET_KEY/)
})
