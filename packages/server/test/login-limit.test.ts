// Login limits (loginLimit.ts, http/clientIp.ts): the counters on their own,
// then over HTTP with the socket's address given as @hono/node-server would.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Auth, DEVICE_COOKIE, Indexer, LoginLimiter, NoteService, Profiles, SESSION_COOKIE, Workspace, clientIp, createApp, ipKey, openIndex, openState,
  trustedProxiesFrom, type LimitRules, type Runtime,
} from '@thoth/server'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A limiter on a clock the test moves. */
function limiter(rules: Partial<LimitRules> = {}) {
  const clock = { t: Date.parse('2026-09-26T10:00:00Z') }
  const l = new LoginLimiter({ now: () => clock.t, rules })
  /** One attempt from `ip` as `account`: 'refused' (with its wait), or how a failure/success leaves the counters. */
  const fail = (ip: string, account: string, device?: string | null) => {
    const a = l.begin({ ip, account, device })
    return a.ok ? { refused: false, wait: a.failed() } : { refused: true, wait: a.retryAfter }
  }
  const pass = (ip: string, account: string, device?: string | null) => {
    const a = l.begin({ ip, account, device })
    if (!a.ok) return { refused: true, wait: a.retryAfter }
    a.passed()
    return { refused: false, wait: 0 }
  }
  return { l, clock, fail, pass, advance: (s: number) => { clock.t += s * 1000 } }
}

test('limits: five free failures, then waits that double up to 15 minutes; refused attempts change nothing', () => {
  const { fail, advance } = limiter()
  for (let i = 1; i <= 5; i++) assert.deepEqual(fail('1.1.1.1', 'noa'), { refused: false, wait: 0 }, `failure ${i} is free`)
  assert.deepEqual(fail('1.1.1.1', 'noa'), { refused: false, wait: 1 }, 'the sixth failure starts a wait of 1 s')
  assert.deepEqual(fail('1.1.1.1', 'noa'), { refused: true, wait: 1 }, 'refused during the wait, password not checked')
  assert.deepEqual(fail('1.1.1.1', 'noa'), { refused: true, wait: 1 }, 'and refusals do not lengthen it')
  const waits: number[] = []
  for (let i = 0; i < 12; i++) {
    advance(waits.at(-1) ?? 1)
    const r = fail('1.1.1.1', 'noa')
    assert.equal(r.refused, false)
    waits.push(r.wait)
  }
  // The account's own counter (10 free, up to 1 min) runs alongside: the longer wait wins.
  assert.deepEqual(waits, [2, 4, 8, 16, 32, 64, 128, 256, 512, 900, 900, 900])
  assert.equal(fail('1.1.1.1', 'NOA ').refused, true, 'names are counted case-insensitively and trimmed')
})

test('limits: a success clears the account, not the address; a counter is forgotten after an hour', () => {
  const { fail, pass, advance } = limiter()
  for (let i = 0; i < 4; i++) fail('1.1.1.1', 'noa')
  pass('1.1.1.1', 'noa')
  for (let i = 0; i < 5; i++) assert.equal(fail('1.1.1.1', 'noa').wait, 0, 'five free failures again after a success')
  assert.equal(fail('1.1.1.1', 'noa').wait, 1)

  // The address: 20 free across every name, and one's own success doesn't reset it.
  const b = limiter()
  for (let i = 0; i < 20; i++) assert.equal(b.fail('2.2.2.2', `nobody${i}`).wait, 0)
  b.pass('2.2.2.2', 'me')
  assert.equal(b.fail('2.2.2.2', 'nobody-else').wait, 1, 'the 21st failure from one address waits, success or not')
  assert.equal(b.fail('3.3.3.3', 'nobody-else').refused, false, 'another address is not held back by it')

  const c = limiter()
  for (let i = 0; i < 5; i++) c.fail('1.1.1.1', 'noa')
  c.advance(61 * 60)
  assert.equal(c.fail('1.1.1.1', 'noa').wait, 0, 'an hour later the failures are forgotten')
})

test('limits: from another address, the right password only waits the account part (a minute at most)', () => {
  const { fail, pass, advance } = limiter()
  // A guess spread over many addresses: after 10 failures, the account waits too.
  for (let i = 0; i < 10; i++) assert.equal(fail(`10.0.0.${i}`, 'noa').wait, 0)
  assert.equal(fail('10.0.0.99', 'noa').wait, 1, 'the 11th failure on the account, from anywhere')
  for (let i = 0; i < 10; i++) { advance(60); fail(`10.0.1.${i}`, 'noa') }
  assert.equal(fail('10.0.2.1', 'noa').wait, 60, 'the account part never passes one minute')
  // The owner, from an address of their own: refused only while the account waits.
  assert.deepEqual(pass('192.168.1.10', 'noa'), { refused: true, wait: 60 })
  advance(60)
  assert.deepEqual(pass('192.168.1.10', 'noa'), { refused: false, wait: 0 })
})

test('limits: a device cookie from an earlier sign-in is held back by its own failures only', () => {
  const { l, fail, pass } = limiter()
  const cookie = l.deviceToken('Noa')
  const device = l.deviceFor(cookie, 'noa')
  assert.ok(device, 'valid for the same account, whatever the case')
  assert.equal(l.deviceFor(cookie, 'ana'), null, 'not for another account')
  assert.equal(l.deviceFor(cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA'), 'noa'), null, 'not if tampered with')
  assert.equal(l.deviceFor(new LoginLimiter().deviceToken('noa'), 'noa'), null, 'not one made by another process (a restart)')
  assert.equal(l.deviceFor(undefined, 'noa'), null)

  // Someone guesses from many addresses, and from the owner's own address too.
  for (let i = 0; i < 30; i++) fail(`10.0.0.${i}`, 'noa')
  for (let i = 0; i < 25; i++) fail('192.168.1.10', `x${i}`)
  assert.equal(pass('192.168.1.10', 'noa').refused, true, 'a new browser waits')
  assert.deepEqual(pass('192.168.1.10', 'noa', device), { refused: false, wait: 0 }, 'the known browser goes in')
  for (let i = 0; i < 5; i++) assert.equal(fail('192.168.1.10', 'noa', device).wait, 0)
  assert.equal(fail('192.168.1.10', 'noa', device).wait, 1, 'its own failures still count')
})

test('limits: attempts at once count before they are checked', () => {
  const { l } = limiter()
  const started = Array.from({ length: 20 }, () => l.begin({ ip: '1.1.1.1', account: 'noa' }))
  assert.equal(started.filter((a) => a.ok).length, 6, 'five free and the one that starts the wait; the rest refused')
  for (const a of started) if (a.ok) a.failed()
})

test('limits: memory is capped; counters that are waiting are the last to go', () => {
  // Waits long enough to outlast the test's clock.
  const { l, fail, advance } = limiter({ maxEntries: 50, baseMs: 10_000_000, pair: { free: 5, capMs: 10_000_000 } })
  for (let i = 0; i < 6; i++) fail('1.1.1.1', 'noa')
  for (let i = 0; i < 2000; i++) { advance(1); fail(`10.${i >> 8}.${i & 255}.1`, `invented-${i}`) }
  assert.ok(l.size <= 50, `at most 50 counters (${l.size})`)
  assert.equal(fail('1.1.1.1', 'noa').refused, true, 'the wait survived thousands of invented names')
})

test('limits: the admin alert, from 20 failed or refused attempts until a day of quiet', () => {
  const { l, fail, advance } = limiter()
  for (let i = 0; i < 19; i++) fail(`10.0.0.${i}`, `x${i}`)
  assert.equal(l.summary(), null, '19 is not many')
  fail('10.0.0.200', 'x')
  const s = l.summary()
  assert.deepEqual(s, { attempts: 20, since: '2026-09-26T10:00:00.000Z' })
  advance(23 * 3600)
  assert.equal(l.summary()?.attempts, 20)
  advance(3600 + 1)
  assert.equal(l.summary(), null, 'gone after a day without failures')
})

test('client address: the socket, X-Forwarded-For only from trusted proxies', () => {
  assert.equal(clientIp('203.0.113.9', '1.2.3.4', null), '203.0.113.9', 'no trusted proxies: the header is ignored')
  assert.equal(clientIp('::ffff:203.0.113.9', undefined, null), '203.0.113.9', 'IPv4-mapped')
  assert.equal(clientIp(undefined, '1.2.3.4', null), 'unknown')
  const proxies = trustedProxiesFrom('10.0.0.5, 172.16.0.0/12 fd00::/8')!
  assert.equal(clientIp('203.0.113.9', '1.2.3.4', proxies), '203.0.113.9', 'a socket that is not a trusted proxy')
  assert.equal(clientIp('10.0.0.5', '1.2.3.4', proxies), '1.2.3.4')
  assert.equal(clientIp('::ffff:10.0.0.5', 'forged, 1.2.3.4, 172.20.0.2', proxies), '1.2.3.4', 'read from the right, skipping trusted proxies')
  assert.equal(clientIp('10.0.0.5', '9.9.9.9, 1.2.3.4', proxies), '1.2.3.4', 'what the client wrote in the header is never reached')
  assert.equal(clientIp('10.0.0.5', 'nonsense', proxies), '10.0.0.5', 'a malformed header: the proxy itself')
  assert.equal(clientIp('10.0.0.5', undefined, proxies), '10.0.0.5')
  assert.equal(clientIp('fd00::1', '2001:db8::7', proxies), '2001:db8::7')
  assert.equal(trustedProxiesFrom(''), null)
  assert.equal(trustedProxiesFrom(undefined), null)
  for (const bad of ['10.0.0.300', 'proxy.local', '10.0.0.0/33', '::/129', '10.0.0.0/8/1']) {
    assert.throws(() => trustedProxiesFrom(bad), /THOTH_TRUSTED_PROXIES/, bad)
  }
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9')
  assert.equal(ipKey('2001:db8:0:1:aaaa::1'), '2001:db8:0:1::/64', 'IPv6 by its /64')
  assert.equal(ipKey('2001:db8::1'), ipKey('2001:0db8:0000:0000:ffff::2'))
  assert.equal(ipKey('unknown'), 'unknown')
})

// --- Over HTTP ---------------------------------------------------------------

async function server(opts: { proxies?: string; rules?: Partial<LimitRules> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-login-limit-'))
  dirs.push(dir)
  const notesDir = join(dir, 'notes')
  mkdirSync(notesDir)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index })
  const clock = { t: Date.parse('2026-09-26T10:00:00Z') }
  const loginLimiter = new LoginLimiter({ now: () => clock.t, rules: opts.rules })
  // Counts the password checks, to see that a refused attempt doesn't reach them.
  let checks = 0
  const login = auth.login.bind(auth)
  auth.login = (u, p) => { checks++; return login(u, p) }
  const app = createApp({
    auth, profiles: new Profiles(state), workspace: new Workspace({ notesDir }), notes, index, indexer, notesDir, runtime,
    trustedProxies: trustedProxiesFrom(opts.proxies), loginLimiter,
  })
  /** A request from `ip` (the socket), with optional headers. */
  const send = async (ip: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    }, { incoming: { socket: { remoteAddress: ip } } })
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any }
  }
  const signIn = (ip: string, username: string, password: string, headers: Record<string, string> = {}) =>
    send(ip, 'POST', '/api/auth/login', { username, password }, headers)
  return { auth, send, signIn, clock, loginLimiter, checks: () => checks, advance: (s: number) => { clock.t += s * 1000 } }
}

/** `name=value` of a cookie set in a response. */
function cookieOf(headers: Headers, name: string): string | null {
  const c = headers.getSetCookie().find((s) => s.startsWith(name + '='))
  return c ? c.split(';')[0]! : null
}

test('HTTP: 429 too_many_attempts with Retry-After, without checking the password; a success clears', async () => {
  const s = await server()
  await s.auth.createUser('noa', 'a-long-password', 'admin')
  for (let i = 0; i < 5; i++) assert.equal((await s.signIn('203.0.113.9', 'noa', 'wrong-password')).status, 401)
  const sixth = await s.signIn('203.0.113.9', 'noa', 'wrong-password')
  assert.deepEqual([sixth.status, sixth.body.error, sixth.body.retryAfter, sixth.headers.get('retry-after')], [429, 'too_many_attempts', 1, '1'],
    'the failure that starts a wait says so')
  const checks = s.checks()
  const refused = await s.signIn('203.0.113.9', 'noa', 'a-long-password')
  assert.deepEqual([refused.status, refused.headers.get('retry-after')], [429, '1'], 'even with the right password')
  assert.equal(s.checks(), checks, 'the password was not checked')
  assert.equal(cookieOf(refused.headers, SESSION_COOKIE), null)

  s.advance(1)
  const ok = await s.signIn('203.0.113.9', 'noa', 'a-long-password')
  assert.equal(ok.status, 200)
  assert.ok(cookieOf(ok.headers, SESSION_COOKIE))
  const device = ok.headers.getSetCookie().find((c) => c.startsWith(DEVICE_COOKIE + '='))!
  assert.match(device, /HttpOnly/)
  assert.match(device, /Path=\/api\/auth/)
  for (let i = 0; i < 5; i++) assert.equal((await s.signIn('203.0.113.9', 'noa', 'wrong-password')).status, 401, 'cleared by the success')
})

test('HTTP: without trusted proxies X-Forwarded-For changes nothing; with them, it is the client', async () => {
  const s = await server()
  for (let i = 0; i < 6; i++) await s.signIn('203.0.113.9', 'noa', 'wrong-password', { 'x-forwarded-for': `198.51.100.${i}` })
  const r = await s.signIn('203.0.113.9', 'noa', 'wrong-password', { 'x-forwarded-for': '198.51.100.77' })
  assert.equal(r.status, 429, 'a forged header does not make a new client')

  const p = await server({ proxies: '10.0.0.5' })
  for (let i = 0; i < 6; i++) await p.signIn('10.0.0.5', 'noa', 'wrong-password', { 'x-forwarded-for': '198.51.100.1' })
  assert.equal((await p.signIn('10.0.0.5', 'noa', 'wrong-password', { 'x-forwarded-for': '198.51.100.1' })).status, 429, 'that client waits')
  assert.equal((await p.signIn('10.0.0.5', 'noa', 'wrong-password', { 'x-forwarded-for': '198.51.100.2' })).status, 401,
    'another client behind the same proxy does not')
  assert.equal((await p.signIn('10.0.0.5', 'noa', 'wrong-password', { 'x-forwarded-for': '198.51.100.2, 198.51.100.1' })).status, 429,
    'and the client cannot hide behind a forged entry on the left')
})

test('HTTP: the owner signs in from a known browser while someone else guesses their name', async () => {
  const s = await server()
  await s.auth.createUser('noa', 'a-long-password', 'admin')
  const first = await s.signIn('192.168.1.10', 'noa', 'a-long-password')
  const device = cookieOf(first.headers, DEVICE_COOKIE)!
  for (let i = 0; i < 40; i++) await s.signIn(`10.0.${i}.1`, 'noa', 'guess')
  assert.equal((await s.signIn('192.168.1.20', 'noa', 'a-long-password')).status, 429, 'a new browser waits the account part')
  const known = await s.signIn('192.168.1.20', 'noa', 'a-long-password', { cookie: device })
  assert.equal(known.status, 200, 'the known browser does not')
  assert.equal((await s.signIn('192.168.1.20', 'noa', 'a-long-password', { cookie: `${DEVICE_COOKIE}=forged.cookie` })).status, 429)
})

test('HTTP: invented names cannot fill memory', async () => {
  const s = await server({ rules: { maxEntries: 100 } })
  for (let i = 0; i < 300; i++) {
    s.advance(1)
    assert.notEqual((await s.signIn(`10.${i >> 8}.${i & 255}.1`, `invented-${i}-${'x'.repeat(500)}`, 'guess')).status, 500)
  }
  assert.ok(s.loginLimiter.size <= 100, `${s.loginLimiter.size} counters`)
  const huge = await s.send('10.9.9.9', 'POST', '/api/auth/login', { username: 'x'.repeat(20_000), password: 'y' })
  assert.equal(huge.status, 413, 'a login body is small')
})

test('HTTP: the first-boot token is limited too', async () => {
  const s = await server()
  const token = s.auth.setupToken()!
  for (let i = 0; i < 5; i++) {
    const r = await s.send('203.0.113.9', 'POST', '/api/setup', { token: `wrong-${i}`, username: 'noa', password: 'a-long-password' })
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_token'])
  }
  const sixth = await s.send('203.0.113.9', 'POST', '/api/setup', { token: 'wrong', username: 'noa', password: 'a-long-password' })
  assert.deepEqual([sixth.status, sixth.body.error, sixth.headers.get('retry-after')], [429, 'too_many_attempts', '1'])
  const refused = await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: 'noa', password: 'a-long-password' })
  assert.equal(refused.status, 429, 'not even the right token during the wait')
  assert.equal(s.auth.userCount(), 0)
  s.advance(1)
  const weak = await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: 'noa', password: 'short' })
  assert.equal(weak.body.error, 'weak_password', 'a weak password with the right token is not a guess')
  assert.equal((await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: 'noa', password: 'a-long-password' })).status, 200)
})

test('HTTP: many failures show in the admin’s alerts', async () => {
  const s = await server()
  await s.auth.createUser('noa', 'a-long-password', 'admin')
  await s.auth.createUser('ana', 'a-long-password', 'member')
  const cookie = async (name: string) => cookieOf((await s.signIn('192.168.1.10', name, 'a-long-password')).headers, SESSION_COOKIE)!
  const admin = await cookie('noa')
  const member = await cookie('ana')
  const alerts = async (c: string) => (await s.send('192.168.1.10', 'GET', '/api/alerts', undefined, { cookie: c })).body.alerts
    .filter((a: { code: string }) => a.code === 'login_attempts_blocked')
  assert.deepEqual(await alerts(admin), [])
  for (let i = 0; i < 25; i++) await s.signIn(`10.0.${i}.1`, 'noa', 'guess')
  assert.deepEqual(await alerts(admin), [{ code: 'login_attempts_blocked', attempts: 25, since: '2026-09-26T10:00:00.000Z', actions: [] }])
  assert.deepEqual(await alerts(member), [], 'only admins')
})
