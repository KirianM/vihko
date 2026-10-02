// The second factor: TOTP against RFC 6238's vectors, its window
// and replay, recovery codes, the QR code, the two-step sign-in and its
// limits, the admin's policy (also after an invitation or a reset), the
// admin's reset and the CLI's, and confirming at the moment before creating
// a key or approving an OAuth client. Keys never ask for a second factor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MAX_CODE_TRIES, TwoFactor, base32Decode, base32Encode, hotp, openState, qrCode, qrModules, totp, type SetupData } from '@vihko/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'
import { join } from 'node:path'
import { mother } from '../../../test/mother.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const m = mother(import.meta.url)
type H = Awaited<ReturnType<typeof setup>>
type Role = keyof H['users']
type App = H['app']

// --- TOTP and its pieces ------------------------------------------------------

test('HOTP and TOTP: the vectors of RFC 4226 (appendix D) and RFC 6238 (appendix B, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890')
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => hotp(secret, i)),
    ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'])
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ]
  for (const [seconds, code] of vectors) {
    assert.equal(totp(secret, seconds * 1000, 8), code, `T = ${seconds}`)
    assert.equal(totp(secret, seconds * 1000), code.slice(2), 'six digits: the same code, its last six')
  }
})

test('base32: the form authenticator apps take, ignoring case, spaces and padding', () => {
  assert.equal(base32Encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(base32Encode(Buffer.from('f')), 'MY')
  assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), Buffer.from('12345678901234567890'))
  assert.deepEqual(base32Decode('MY======'), Buffer.from('f'))
  for (let i = 0; i < 50; i++) {
    const b = randomBytes(i)
    assert.deepEqual(base32Decode(base32Encode(b)), b)
  }
  assert.throws(() => base32Decode('A1'))
})

/** A store on a clock the test moves, with a user (state.db needs one): `name` is theirs. */
async function store() {
  const dir = tempDir('vihko-2fa-')
  const state = openState(join(dir, 'state.db'))
  const clock = { t: Date.parse('2026-09-27T10:00:05Z') }
  const tf = new TwoFactor(state, { now: () => new Date(clock.t) })
  const name = m.aUsername()
  state.prepare("insert into users (id, username, password_hash, role, created_at) values ('u1', ?, 'x', 'admin', '2026-01-01T00:00:00Z')").run(name)
  const code = (s: SetupData, offsetSteps = 0) => totp(base32Decode(s.secret), clock.t + offsetSteps * 30_000)
  return { state, tf, clock, code, name, advance: (steps: number) => { clock.t += steps * 30_000 } }
}

test('setting it up: nothing is theirs until a code from the new secret is verified, and that code is spent', async () => {
  const { tf, code, advance, clock, name } = await store()
  const host = m.aHost()
  const s = tf.beginSetup('u1', name, host)
  assert.match(s.secret, /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/, '160 bits, in groups of four to type it')
  assert.equal(s.uri, `otpauth://totp/vihko:${encodeURIComponent(name)}%40${host}?secret=${s.secret.replace(/ /g, '')}&issuer=vihko&algorithm=SHA1&digits=6&period=30`)
  assert.ok(s.qr && s.qr.size >= 21)
  assert.equal(tf.enabled('u1'), false)
  assert.equal(await tf.finishSetup('u1', '000000'), null, 'a wrong code')
  assert.equal(await tf.finishSetup('u1', code(s, 2)), null, 'two steps ahead: outside the window')
  assert.equal(tf.enabled('u1'), false)
  const codes = await tf.finishSetup('u1', code(s))
  assert.ok(codes)
  assert.equal(codes.length, 10)
  assert.ok(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)))
  assert.deepEqual(tf.status('u1'), { enabled: true, enabledAt: new Date(clock.t).toISOString(), recoveryCodesLeft: 10 })
  assert.deepEqual(await tf.verify('u1', code(s)), { ok: false, reason: 'used' }, 'the code that set it up is spent')
  advance(1)
  assert.equal((await tf.verify('u1', code(s))).ok, true)

  // A new setup replaces nothing until verified, and one that waits too long is forgotten.
  const again = tf.beginSetup('u1', name)
  clock.t += 15 * 60_000
  assert.equal(await tf.finishSetup('u1', code(again)), null)
  assert.equal((await tf.verify('u1', code(s))).ok, true, 'the old secret is still theirs')
})

test('TOTP: one step either side is accepted, two are not; a code, or an earlier one, never works twice', async () => {
  const { tf, code, advance, name } = await store()
  const s = tf.beginSetup('u1', name)
  await tf.finishSetup('u1', code(s))
  advance(10)
  assert.deepEqual(await tf.verify('u1', code(s, -2)), { ok: false, reason: 'invalid' })
  assert.deepEqual(await tf.verify('u1', code(s, 2)), { ok: false, reason: 'invalid' })
  assert.equal((await tf.verify('u1', code(s, -1))).ok, true, 'the previous step: a clock a little behind')
  assert.equal((await tf.verify('u1', code(s, 1))).ok, true, 'the next step: a clock a little ahead')
  assert.deepEqual(await tf.verify('u1', code(s)), { ok: false, reason: 'used' }, 'now is earlier than the step already accepted')
  assert.deepEqual(await tf.verify('u1', code(s, 1)), { ok: false, reason: 'used' }, 'the same code again')
  advance(2)
  assert.equal((await tf.verify('u1', code(s))).ok, true)
  assert.deepEqual(await tf.verify('u1', ` ${code(s).slice(0, 3)} ${code(s).slice(3)} `), { ok: false, reason: 'used' }, 'spaces are ignored')
  for (const junk of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.deepEqual(await tf.verify('u1', junk), { ok: false, reason: 'invalid' })
})

test('recovery codes: ten, single use, stored only as a hash, and new ones end the old ones', async () => {
  const { tf, state, code, name } = await store()
  const s = tf.beginSetup('u1', name)
  const codes = (await tf.finishSetup('u1', code(s)))!
  const stored = state.prepare('select code_hash from recovery_codes').all() as { code_hash: string }[]
  assert.equal(stored.length, 10)
  assert.equal(new Set(codes).size, 10, 'ten different ones')
  const dump = JSON.stringify(state.prepare('select * from recovery_codes').all())
  for (const c of codes) assert.ok(!dump.includes(c) && !dump.includes(c.replace('-', '')), 'never in the clear')
  assert.deepEqual(await tf.verify('u1', codes[0]), { ok: false, reason: 'invalid' }, 'not where a TOTP code is asked for')
  assert.deepEqual(await tf.verify('u1', codes[0], { recovery: true }), { ok: true, recovery: true, recoveryCodesLeft: 9 })
  assert.deepEqual(await tf.verify('u1', codes[0], { recovery: true }), { ok: false, reason: 'invalid' }, 'once')
  assert.equal((await tf.verify('u1', ` ${codes[1]!.toUpperCase().replace('-', ' ')} `, { recovery: true })).ok, true, 'any case, with or without its dash')
  const fresh = (await tf.regenerate('u1'))!
  assert.equal(tf.status('u1').recoveryCodesLeft, 10)
  assert.deepEqual(await tf.verify('u1', codes[2], { recovery: true }), { ok: false, reason: 'invalid' }, 'the old ones no longer work')
  assert.equal((await tf.verify('u1', fresh[2], { recovery: true })).ok, true)
  assert.equal(tf.disable('u1'), true)
  assert.deepEqual(tf.status('u1'), { enabled: false, enabledAt: null, recoveryCodesLeft: 0 })
  assert.equal((state.prepare('select count(*) n from recovery_codes').get() as { n: number }).n, 0)
  assert.equal(await tf.regenerate('u1'), null)
})

/** A stored recovery code's hash as parts: algorithm and parameters, salt, hash (auth.ts's PHC-like form). */
const hashParts = (h: string) => {
  const parts = h.split('$')
  return { salted: parts.slice(0, -1).join('$'), salt: parts.at(-2)!, hash: parts.at(-1)! }
}

test('recovery codes: a slow hash, with one salt for each batch and a new salt for the next', async () => {
  const { tf, state, code, name } = await store()
  const s = tf.beginSetup('u1', name)
  const codes = (await tf.finishSetup('u1', code(s)))!
  const stored = () => (state.prepare('select code_hash from recovery_codes where user_id = ?').all('u1') as { code_hash: string }[]).map((r) => r.code_hash)
  const first = stored()
  // The password's algorithm: argon2id (scrypt only in a Node without it), never a plain sha256.
  for (const h of first) assert.match(h, /^(\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+|scrypt\$\d+\$\d+\$\d+)\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
  assert.equal(new Set(first.map((h) => hashParts(h).salted)).size, 1, 'one salt (and parameters) for the batch')
  assert.equal(new Set(first.map((h) => hashParts(h).hash)).size, 10, 'each code its own hash')
  assert.equal(Buffer.from(hashParts(first[0]!).salt, 'base64').length, 16, 'a salt of 128 bits')
  // A salt that isn't the user's id: two people with the same code would store different hashes, and a batch's salt changes.
  await tf.regenerate('u1')
  const second = stored()
  assert.notEqual(hashParts(second[0]!).salt, hashParts(first[0]!).salt, 'a new batch, a new salt')
  assert.equal((await tf.verify('u1', codes[0], { recovery: true })).ok, false)
})

test('recovery codes kept as a plain sha256 (before the slow hash) still work, each once, until new ones replace them', async () => {
  const { tf, state, code, name } = await store()
  const s = tf.beginSetup('u1', name)
  await tf.finishSetup('u1', code(s))
  // Codes as an earlier vihko stored them: a sha256 of the user's id and the code, in hex.
  const old = Array.from({ length: 3 }, () => m.faker.string.fromCharacters('abcdefghjkmnpqrstvwxyz23456789', 10))
  state.prepare('delete from recovery_codes').run()
  for (const c of old) state.prepare('insert into recovery_codes (user_id, code_hash) values (?, ?)').run('u1', createHash('sha256').update(`u1\n${c}`).digest('hex'))
  assert.deepEqual(await tf.verify('u1', `${old[0]!.slice(0, 5)}-${old[0]!.slice(5)}`, { recovery: true }), { ok: true, recovery: true, recoveryCodesLeft: 2 })
  assert.deepEqual(await tf.verify('u1', old[0], { recovery: true }), { ok: false, reason: 'invalid' }, 'once')
  assert.equal((await tf.verify('u1', old[1], { recovery: true })).ok, true)
  // New ones are slow hashes, and the old ones stop working.
  const fresh = (await tf.regenerate('u1'))!
  assert.equal((await tf.verify('u1', old[2], { recovery: true })).ok, false)
  assert.equal((await tf.verify('u1', fresh[0], { recovery: true })).ok, true)
})

test('the QR code: standard sizes, and the same modules as a code checked with a real decoder', () => {
  const digest = (text: string) => createHash('sha256').update(qrModules(text)!.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('\n')).digest('hex')
  // Checked against jsQR (each decodes to its text) and, 'HELLO WORLD' and the encoder itself, module for module against
  // qrcode-generator (the same data, error correction and layout): fixed vectors, so their texts stay literal (the
  // secret is the RFC 4648 example «Hello!\xDE\xAD\xBE\xEF»).
  assert.equal(digest('otpauth://totp/vihko:ana@notas.example.org?secret=JBSWY3DPEHPK3PXP&issuer=vihko'), '212f8bb206559aa7f0e12718e449a365800d4b59237b6534dca854b5e8a49dcc')
  assert.equal(digest('HELLO WORLD'), '2d21897bf5a7ac606d02da07bdd5e7f02a8b90097f12404b1f7d764f18ef618c')
  assert.equal(digest('vihko: añadir ñ €'), 'df035e3ffb929de916970495ed8b9817122f2b5ba04026d72b0e138b0ce6f882', 'UTF-8')
  // Version 1 holds 14 bytes at level M; 15 need version 2. 2331 is the most version 40 holds.
  assert.equal(qrCode('x'.repeat(14))!.size, 21)
  assert.equal(qrCode('x'.repeat(15))!.size, 25)
  assert.equal(qrCode('x'.repeat(2331))!.size, 177)
  assert.equal(qrCode('x'.repeat(2332)), null)
  // The three finder patterns, where they go.
  const m = qrModules('HELLO WORLD')!
  for (const [x0, y0] of [[0, 0], [14, 0], [0, 14]] as const) {
    const ring = [0, 6].flatMap((i) => [m[y0 + i]![x0 + 3], m[y0 + 3]![x0 + i]])
    assert.ok(ring.every(Boolean) && m[y0 + 3]![x0 + 3] && !m[y0 + 1]![x0 + 3], `finder at ${x0},${y0}`)
  }
})

// --- Over HTTP -------------------------------------------------------------------

async function send(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) as any, cookie: res.headers.getSetCookie().find((c) => c.startsWith('vihko_session='))?.split(';')[0] ?? null }
}

/** Signs in with a password (the user's own by default): the session cookie, or the second step. */
const signIn = (h: H, who: Role | { username: string; password: string }) => {
  const { username, password } = typeof who === 'string' ? h.users[who] : who
  return send(h.app, 'POST', '/api/auth/login', { username, password })
}

/** Sets up the second factor from «Account», with `who`'s session: the secret and the recovery codes. */
async function enable(h: H, who: Role) {
  const as = h.as(who)
  const s = await as('POST', '/api/account/2fa/setup', { password: h.users[who].password })
  assert.equal(s.status, 200, s.text)
  const secret = base32Decode(s.body.secret)
  const r = await as('POST', '/api/account/2fa/enable', { code: totp(secret, h.clock.now.getTime()) })
  assert.equal(r.status, 200, r.text)
  return { secret, recoveryCodes: r.body.recoveryCodes as string[] }
}

/** The clock moves on to the next TOTP step (so that a new code exists). */
const nextStep = (h: H) => { h.clock.now = new Date(h.clock.now.getTime() + 30_000) }

test('two steps: the password gives a pending sign-in, and a TOTP code or a recovery code completes it', async () => {
  const h = await setup()
  try {
    const { username, password } = h.users.admin
    // «Account» asks for the password to set it up; a wrong one gets nothing.
    assert.deepEqual((await h.admin('GET', '/api/account/2fa')).body, { policy: 'optional', enabled: false, enabledAt: null, recoveryCodesLeft: 0, confirmWith: 'password' })
    const wrong = await h.admin('POST', '/api/account/2fa/setup', { password: m.aPassword() })
    assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password'])
    const setupData = (await h.admin('POST', '/api/account/2fa/setup', { password })).body
    assert.ok(setupData.qr.path.startsWith('M'))
    assert.deepEqual((await h.admin('POST', '/api/account/2fa/enable', { code: '000000' })).body.error, 'invalid_code')
    assert.equal((await signIn(h, 'admin')).body.user.username, username, 'not set up until a code is verified: no second step yet')
    const { secret, recoveryCodes } = await enable(h, 'admin')
    assert.deepEqual((await h.admin('GET', '/api/account/2fa')).body.confirmWith, 'code')
    assert.deepEqual((await h.admin('GET', '/api/admin/users')).body.users.find((u: any) => u.username === username).twoFactor,
      { enabled: true, enabledAt: h.clock.now.toISOString() })

    // The password alone: no session, a pending sign-in.
    const first = await signIn(h, 'admin')
    assert.equal(first.status, 200)
    assert.deepEqual([first.body.step, first.body.username, first.body.user, first.cookie], ['code', username, undefined, null])
    assert.match(first.body.pending, /^[A-Za-z0-9_-]{43}$/)
    const bad = await send(h.app, 'POST', '/api/auth/login/code', { pending: first.body.pending, code: '000000' })
    assert.deepEqual([bad.status, bad.body.error, bad.cookie], [401, 'invalid_code', null])
    const used = await send(h.app, 'POST', '/api/auth/login/code', { pending: first.body.pending, code: totp(secret, h.clock.now.getTime()) })
    assert.deepEqual([used.status, used.body.error], [401, 'code_used'], 'the code that set it up')
    nextStep(h)
    const ok = await send(h.app, 'POST', '/api/auth/login/code', { pending: first.body.pending, code: totp(secret, h.clock.now.getTime()) })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.user.username, username)
    assert.equal(ok.body.recoveryCodesLeft, undefined)
    assert.ok(ok.cookie)
    assert.equal((await send(h.app, 'GET', '/api/auth/me', undefined, { cookie: ok.cookie! })).body.user.username, username)
    assert.equal((await send(h.app, 'POST', '/api/auth/login/code', { pending: first.body.pending, code: '123456' })).body.error, 'login_expired', 'a pending sign-in works once')

    // A recovery code, once; the page learns how many are left.
    const second = await signIn(h, 'admin')
    const rec = await send(h.app, 'POST', '/api/auth/login/code', { pending: second.body.pending, code: recoveryCodes[0] })
    assert.deepEqual([rec.status, rec.body.recoveryCodesLeft], [200, 9])
    const third = await signIn(h, 'admin')
    assert.equal((await send(h.app, 'POST', '/api/auth/login/code', { pending: third.body.pending, code: recoveryCodes[0] })).body.error, 'invalid_code')

    // Five minutes, then the password again.
    h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000 + 1)
    assert.equal((await send(h.app, 'POST', '/api/auth/login/code', { pending: third.body.pending, code: totp(secret, h.clock.now.getTime()) })).body.error, 'login_expired')
    assert.equal((await send(h.app, 'POST', '/api/auth/login/code', { pending: 'nonsense', code: '123456' })).status, 401)

    // New recovery codes: a code of the second factor, the app's or a recovery code; never the password.
    nextStep(h)
    const asked = await h.admin('POST', '/api/account/2fa/recovery', {})
    assert.deepEqual([asked.status, asked.body.error, asked.body.with], [400, 'confirmation_required', 'code'])
    assert.equal((await h.admin('POST', '/api/account/2fa/recovery', { confirm: password })).body.error, 'invalid_code', 'the password doesn\'t do')
    const regen = await h.admin('POST', '/api/account/2fa/recovery', { confirm: totp(secret, h.clock.now.getTime()) })
    assert.equal(regen.body.recoveryCodes.length, 10)
    const again = await h.admin('POST', '/api/account/2fa/recovery', { confirm: regen.body.recoveryCodes[0] })
    assert.equal(again.body.recoveryCodes.length, 10, 'a recovery code does, for whoever has no phone at hand')
    assert.equal((await h.admin('POST', '/api/account/2fa/recovery', { confirm: again.body.recoveryCodes[0] })).body.recoveryCodes.length, 10)
    assert.equal((await h.admin('GET', '/api/account/2fa')).body.recoveryCodesLeft, 10)
  } finally { await h.close() }
})

test('with a second factor in force, changing the app takes a code of it (the app\'s or a recovery code), never the password', async () => {
  const h = await setup()
  try {
    const { secret } = await enable(h, 'member')
    // A new key is how the second factor is asked for here: the admin lets members create them (off on a new vihko).
    assert.equal((await h.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: true })).status, 200)
    const password = h.users.member.password
    const asked = await h.member('POST', '/api/account/2fa/setup', { password })
    assert.deepEqual([asked.status, asked.body.error, asked.body.with], [400, 'confirmation_required', 'code'], 'the password isn\'t asked for, nor taken')
    assert.equal((await h.member('POST', '/api/account/2fa/setup', { code: password })).body.error, 'invalid_code')

    // The app's current code: a new secret; the old app works until the new one is verified.
    nextStep(h)
    const s = await h.member('POST', '/api/account/2fa/setup', { code: totp(secret, h.clock.now.getTime()) })
    assert.equal(s.status, 200)
    const next = base32Decode(s.body.secret)
    const done = await h.member('POST', '/api/account/2fa/enable', { code: totp(next, h.clock.now.getTime()) })
    assert.equal(done.body.recoveryCodes.length, 10)
    nextStep(h)
    assert.equal((await h.member('POST', '/api/keys', { name: m.aKeyName(), confirm: totp(secret, h.clock.now.getTime()) })).body.error, 'invalid_code', 'the old app no longer')
    assert.equal((await h.member('POST', '/api/keys', { name: m.aKeyName(), confirm: totp(next, h.clock.now.getTime()) })).status, 201, 'the new one')

    // Without the phone at hand: a recovery code, spent.
    const recovery = done.body.recoveryCodes[0]
    assert.equal((await h.member('POST', '/api/account/2fa/setup', { code: recovery })).status, 200)
    assert.equal((await h.member('POST', '/api/account/2fa/setup', { code: recovery })).body.error, 'invalid_code', 'once')
    assert.equal((await h.member('GET', '/api/account/2fa')).body.recoveryCodesLeft, 9)
  } finally { await h.close() }
})

test('limits: wrong codes count, a right password does not clear them, and a success does', async () => {
  const h = await setup()
  try {
    const { secret } = await enable(h, 'admin')
    const wrongCode = (pending: string) => send(h.app, 'POST', '/api/auth/login/code', { pending, code: '000000' })
    let pending = (await signIn(h, 'admin')).body.pending
    for (let i = 0; i < 4; i++) assert.equal((await wrongCode(pending)).status, 401, `failure ${i + 1} is free`)
    // Signing in again with the right password gives no fresh guesses at the code.
    pending = (await signIn(h, 'admin')).body.pending
    assert.equal((await wrongCode(pending)).status, 401, 'the fifth is free')
    const sixth = await wrongCode(pending)
    assert.deepEqual([sixth.status, sixth.body.error], [429, 'too_many_attempts'], 'the sixth starts a wait')
    nextStep(h)
    const refused = await send(h.app, 'POST', '/api/auth/login/code', { pending, code: totp(secret, h.clock.now.getTime()) })
    assert.equal(refused.status, 429, 'refused while waiting, even with the right code')
    // The code counter is the second factor's own: the password's still works.
    assert.equal((await signIn(h, 'admin')).status, 200)
    await new Promise((r) => setTimeout(r, 1100))
    const ok = await send(h.app, 'POST', '/api/auth/login/code', { pending, code: totp(secret, h.clock.now.getTime()) })
    assert.equal(ok.status, 200)
    // Cleared by the success: five free failures again.
    pending = (await signIn(h, 'admin')).body.pending
    for (let i = 0; i < 5; i++) assert.equal((await wrongCode(pending)).status, 401)
  } finally { await h.close() }
})

test('a pending sign-in ends after a few wrong codes: the password again', async () => {
  const h = await setup()
  try {
    const { secret } = await enable(h, 'member')
    nextStep(h)
    const pending = (await signIn(h, 'member')).body.pending
    for (let i = 0; i < MAX_CODE_TRIES; i++) {
      const r = await send(h.app, 'POST', '/api/auth/login/code', { pending, code: '000000' })
      assert.deepEqual([r.status, r.body.error], [401, 'invalid_code'], `wrong code ${i + 1}`)
    }
    const right = await send(h.app, 'POST', '/api/auth/login/code', { pending, code: totp(secret, h.clock.now.getTime()) })
    assert.deepEqual([right.status, right.body.error], [401, 'login_expired'], 'not even with the right code')
    // The password again gives another: the right code then works.
    const again = (await signIn(h, 'member')).body.pending
    const ok = await send(h.app, 'POST', '/api/auth/login/code', { pending: again, code: totp(secret, h.clock.now.getTime()) })
    assert.equal(ok.status, 200)
  } finally { await h.close() }
})

test('the policy: a change is confirmed; required makes whoever has none set it up at sign-in; disabled only stops new ones', async () => {
  const h = await setup()
  try {
    const confirm = h.users.admin.password
    const member = h.users.member.username
    assert.equal((await h.member('PUT', '/api/admin/settings', { twoFactor: 'required' })).status, 403, 'the admin only')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'sometimes' })).body.error, 'invalid')
    const unconfirmed = await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required' })
    assert.deepEqual([unconfirmed.status, unconfirmed.body.error, unconfirmed.body.with], [400, 'confirmation_required', 'password'], 'a new policy is confirmed at the moment')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required', confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required', confirm })).body.twoFactor, 'required')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required' })).status, 200, 'the same policy again asks nothing')

    // The member has none: the password gives the setup step, not a session.
    const first = await signIn(h, 'member')
    assert.deepEqual([first.body.step, first.cookie], ['setup', null])
    assert.equal((await send(h.app, 'POST', '/api/auth/login/code', { pending: first.body.pending, code: '123456' })).body.error, 'login_expired', 'a setup step is not a code step')
    const s = await send(h.app, 'POST', '/api/auth/2fa/setup', { pending: first.body.pending })
    assert.equal(s.status, 200)
    assert.ok(s.body.uri.startsWith(`otpauth://totp/vihko:${encodeURIComponent(member)}%40localhost?secret=`), s.body.uri)
    assert.equal((await send(h.app, 'POST', '/api/auth/2fa/enable', { pending: first.body.pending, code: '000000' })).body.error, 'invalid_code')
    const done = await send(h.app, 'POST', '/api/auth/2fa/enable', { pending: first.body.pending, code: totp(base32Decode(s.body.secret), h.clock.now.getTime()) })
    assert.equal(done.status, 200)
    assert.equal(done.body.recoveryCodes.length, 10)
    assert.ok(done.cookie, 'set up: now the session')
    assert.equal((await signIn(h, 'member')).body.step, 'code', 'and from now on, the code')

    // Required: one's own can't be turned off.
    const memberSession = (method: string, p: string, b?: unknown) => send(h.app, method, p, b, { cookie: done.cookie! })
    assert.equal((await memberSession('POST', '/api/account/2fa/disable', { code: done.body.recoveryCodes[0] })).body.error, 'two_factor_required')

    // Optional: it can, with a code (or a recovery code); a wrong one doesn't.
    await h.admin('PUT', '/api/admin/settings', { twoFactor: 'optional', confirm })
    assert.equal((await memberSession('POST', '/api/account/2fa/disable', { code: '000000' })).body.error, 'invalid_code')
    assert.equal((await memberSession('POST', '/api/account/2fa/disable', { code: done.body.recoveryCodes[0] })).status, 200)
    assert.equal((await signIn(h, 'member')).body.user.username, member)
    assert.equal((await memberSession('POST', '/api/account/2fa/disable', { code: '123456' })).body.error, 'two_factor_off')

    // Disabled: nobody new sets one up, and whoever has one is still asked for it.
    const { secret, recoveryCodes } = await enable(h, 'admin')
    const since = h.clock.now.toISOString()
    nextStep(h)
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'disabled', confirm })).body.error, 'invalid_code', 'with a second factor, its code confirms')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { twoFactor: 'disabled', confirm: totp(secret, h.clock.now.getTime()) })).body.twoFactor, 'disabled')
    assert.equal((await signIn(h, 'admin')).body.step, 'code', 'still asked for')
    assert.equal((await h.member('POST', '/api/account/2fa/setup', { password: h.users.member.password })).body.error, 'two_factor_disabled', 'not offered to anyone new')
    assert.equal((await signIn(h, 'member')).body.user.username, member)
    assert.deepEqual((await h.admin('GET', '/api/account/2fa')).body, { policy: 'disabled', enabled: true, enabledAt: since, recoveryCodesLeft: 10, confirmWith: 'code' })
    nextStep(h)
    assert.equal((await h.admin('POST', '/api/keys', { name: m.aKeyName(), confirm: totp(secret, h.clock.now.getTime()) })).status, 201, 'keys confirm with the code')
    // Who has one may change the app (with a code of it: here, a recovery code), and turn it off: then it isn't offered again.
    assert.equal((await h.admin('POST', '/api/account/2fa/setup', { code: recoveryCodes[0] })).status, 200)
    nextStep(h)
    assert.equal((await h.admin('POST', '/api/account/2fa/disable', { code: totp(secret, h.clock.now.getTime()) })).status, 200)
    assert.equal((await h.admin('POST', '/api/account/2fa/setup', { password: confirm })).body.error, 'two_factor_disabled')
    assert.equal((await signIn(h, 'admin')).body.user.username, h.users.admin.username)
  } finally { await h.close() }
})

test('links: an invitation under a required policy sets it up before the session; a reset never skips it', async () => {
  const h = await setup()
  try {
    const confirm = h.users.admin.password
    const newcomer = m.aUser({ role: 'member' })
    await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required', confirm })
    const { user, link } = (await h.admin('POST', '/api/admin/users', { username: newcomer.username, role: 'member' })).body
    const accepted = await send(h.app, 'POST', `/api/invite/${link.token}`, { password: newcomer.password })
    assert.deepEqual([accepted.status, accepted.body.step, accepted.cookie], [200, 'setup', null])
    const s = await send(h.app, 'POST', '/api/auth/2fa/setup', { pending: accepted.body.pending })
    const secret = base32Decode(s.body.secret)
    const done = await send(h.app, 'POST', '/api/auth/2fa/enable', { pending: accepted.body.pending, code: totp(secret, h.clock.now.getTime()) })
    assert.ok(done.cookie)
    assert.equal(done.body.user.username, newcomer.username)

    // A reset link for someone with a second factor: the new password, then their code.
    await h.admin('PUT', '/api/admin/settings', { twoFactor: 'optional', confirm })
    const reset = (await h.admin('POST', `/api/admin/users/${user.id}/link`, { confirm })).body.link
    const renewed = m.aPassword()
    const r = await send(h.app, 'POST', `/api/invite/${reset.token}`, { password: renewed })
    assert.deepEqual([r.body.step, r.cookie], ['code', null])
    nextStep(h)
    const ok = await send(h.app, 'POST', '/api/auth/login/code', { pending: r.body.pending, code: totp(secret, h.clock.now.getTime()) })
    assert.ok(ok.cookie)

    // The admin resets it (a member can't): the password alone again.
    assert.equal((await h.member('POST', `/api/admin/users/${user.id}/2fa/reset`)).status, 403)
    assert.equal((await h.admin('POST', '/api/admin/users/nobody/2fa/reset')).status, 404)
    assert.equal((await h.admin('POST', `/api/admin/users/${user.id}/2fa/reset`)).body.error, 'confirmation_required')
    const after = await h.admin('POST', `/api/admin/users/${user.id}/2fa/reset`, { confirm })
    assert.deepEqual(after.body.user.twoFactor, { enabled: false, enabledAt: null })
    assert.equal((await h.admin('POST', `/api/admin/users/${user.id}/2fa/reset`)).status, 200, 'none left to take away: nothing asked')
    assert.equal((await signIn(h, { username: newcomer.username, password: renewed })).body.user.username, newcomer.username)
  } finally { await h.close() }
})

test('confirming at the moment: creating or rotating a key and approving an OAuth client ask for the current code, or the password without one', async () => {
  const publicUrl = `https://${m.aHost()}`
  const h = await setup({ publicUrl })
  try {
    const [first, second, third] = [m.aKeyName(), m.aKeyName(), m.aKeyName()]
    const password = h.users.admin.password
    // Without a second factor: the password.
    const missing = await h.admin('POST', '/api/keys', { name: first })
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.deepEqual((await h.admin('POST', '/api/keys', { name: first, confirm: m.aPassword() })).body.error, 'wrong_password')
    const key = (await h.admin('POST', '/api/keys', { name: first, confirm: password })).body

    // With one: its current code, and never the password (a session left open could know it).
    const { secret } = await enable(h, 'admin')
    nextStep(h)
    const code = () => totp(secret, h.clock.now.getTime())
    assert.equal((await h.admin('POST', '/api/keys', { name: second })).body.with, 'code')
    assert.equal((await h.admin('POST', '/api/keys', { name: second, confirm: password })).body.error, 'invalid_code')
    assert.equal((await h.admin('POST', '/api/keys', { name: second, confirm: code() })).status, 201)
    assert.equal((await h.admin('POST', '/api/keys', { name: third, confirm: code() })).body.error, 'code_used', 'a code confirms once')
    assert.equal((await h.admin('POST', `/api/keys/${key.key.id}/rotate`)).body.error, 'confirmation_required')
    nextStep(h)
    const rotated = await h.admin('POST', `/api/keys/${key.key.id}/rotate`, { confirm: code() })
    assert.equal(rotated.status, 200)

    // Keys never ask for a second factor.
    await h.enableApi()
    assert.equal((await h.withKey(rotated.body.token)('GET', '/api/tree')).status, 200)

    // OAuth: saying yes needs the code; saying no never does.
    await h.enableMcp()
    await h.admin('PUT', '/api/admin/integrations', { oauthRegistration: true })
    const redirect = `https://${m.aHost()}/${m.aWord()}`
    const reg = await send(h.app, 'POST', '/oauth/register', { client_name: m.aKeyName(), redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: m.aWord(), resource: `${publicUrl}/mcp` }).toString()
    assert.equal((await h.admin('POST', '/api/oauth/authorize', { query, approve: true })).body.error, 'confirmation_required')
    assert.equal((await h.admin('POST', '/api/oauth/authorize', { query, approve: true, confirm: '000000' })).body.error, 'invalid_code')
    assert.equal((await h.admin('POST', '/api/oauth/authorize', { query, approve: false })).status, 200)
    nextStep(h)
    const approved = await h.admin('POST', '/api/oauth/authorize', { query, approve: true, confirm: code() })
    assert.equal(approved.status, 200)
    assert.ok(new URL(approved.body.redirect).searchParams.get('code'))
  } finally { await h.close() }
})

test('confirming counts in the login limits: guessing the code with a session left open soon waits', async () => {
  const h = await setup()
  try {
    await enable(h, 'admin')
    for (let i = 0; i < 5; i++) assert.equal((await h.admin('POST', '/api/keys', { name: m.aKeyName(), confirm: '000000' })).status, 403)
    assert.equal((await h.admin('POST', '/api/keys', { name: m.aKeyName(), confirm: '000000' })).status, 429)
  } finally { await h.close() }
})

test('setting it up counts wrong codes too: a session alone can\'t guess the first code of a secret its owner is setting up', async () => {
  const h = await setup()
  try {
    // The owner began it (with the password); someone with only the session guesses.
    const s = await h.member('POST', '/api/account/2fa/setup', { password: h.users.member.password })
    assert.equal(s.status, 200)
    const secret = base32Decode(s.body.secret)
    const t = h.clock.now.getTime()
    const right = new Set([-1, 0, 1].map((step) => totp(secret, t + step * 30_000)))
    /** A wrong code: any other six digits. */
    const wrong = () => {
      let c: string
      do c = String(m.faker.number.int({ max: 999_999 })).padStart(6, '0'); while (right.has(c))
      return c
    }
    const answers: number[] = []
    for (let i = 0; i < 6; i++) answers.push((await h.member('POST', '/api/account/2fa/enable', { code: wrong() })).status)
    assert.deepEqual(answers, [400, 400, 400, 400, 400, 429], 'five free failures, then a wait')
    assert.equal((await h.member('POST', '/api/account/2fa/enable', { code: totp(secret, t) })).status, 429, 'refused while waiting, even the right code')

    // The same on the sign-in's setup step (the policy requires it).
    await h.admin('PUT', '/api/admin/settings', { twoFactor: 'required', confirm: h.users.admin.password })
    const first = await signIn(h, 'admin')
    assert.equal(first.body.step, 'setup')
    const own = await send(h.app, 'POST', '/api/auth/2fa/setup', { pending: first.body.pending })
    assert.equal(own.status, 200)
    right.clear()
    for (const step of [-1, 0, 1]) right.add(totp(base32Decode(own.body.secret), t + step * 30_000))
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await send(h.app, 'POST', '/api/auth/2fa/enable', { pending: first.body.pending, code: wrong() })).status)
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429])
  } finally { await h.close() }
})

test('the CLI takes a second factor away (with reset-link, the way back for an admin who lost password and phone)', async () => {
  const h = await setup()
  try {
    const admin = h.users.admin.username
    await enable(h, 'admin')
    assert.equal((await signIn(h, 'admin')).body.step, 'code')
    const env = { ...process.env, VIHKO_STATE_DIR: h.dir, VIHKO_NOTES_DIR: h.notesDir }
    const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-2fa', admin], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes(`second factor removed for ${admin}`), r.stdout)
    assert.equal((await signIn(h, 'admin')).body.user.username, admin, 'a running vihko reads it at once')
    const again = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-2fa', admin], { env, encoding: 'utf8' })
    assert.ok(again.stdout.includes(`${admin} had no second factor`), again.stdout)
    const none = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'reset-2fa', m.aUsername()], { env, encoding: 'utf8' })
    assert.equal(none.status, 1)
    assert.match(none.stderr, /not_found/)
  } finally { await h.close() }
})

test('deleting a user takes their second factor with them', async () => {
  const h = await setup()
  try {
    await enable(h, 'member')
    await h.admin('POST', `/api/admin/users/${h.users.member.id}/disable`)
    await h.admin('DELETE', `/api/admin/users/${h.users.member.id}`)
    for (const t of ['two_factor', 'recovery_codes']) assert.equal((h.auth.state.prepare(`select count(*) n from ${t} where user_id = ?`).get(h.users.member.id) as { n: number }).n, 0, t)
  } finally { await h.close() }
})
