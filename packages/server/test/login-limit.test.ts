// Login limits (loginLimit.ts, http/clientIp.ts): the counters on their own,
// then over HTTP with the socket's address given as @hono/node-server would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  Auth, DEVICE_COOKIE, Indexer, LoginLimiter, NoteService, Profiles, SESSION_COOKIE, Workspace, clientIp, createApp, ipKey, openIndex, openState,
  trustedProxiesFrom, wideTrustedProxies, type LimitRules, type Runtime,
} from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

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
  const account = m.aUsername()
  const { fail, advance } = limiter()
  for (let i = 1; i <= 5; i++) assert.deepEqual(fail('1.1.1.1', account), { refused: false, wait: 0 }, `failure ${i} is free`)
  assert.deepEqual(fail('1.1.1.1', account), { refused: false, wait: 1 }, 'the sixth failure starts a wait of 1 s')
  assert.deepEqual(fail('1.1.1.1', account), { refused: true, wait: 1 }, 'refused during the wait, password not checked')
  assert.deepEqual(fail('1.1.1.1', account), { refused: true, wait: 1 }, 'and refusals do not lengthen it')
  const waits: number[] = []
  for (let i = 0; i < 12; i++) {
    advance(waits.at(-1) ?? 1)
    const r = fail('1.1.1.1', account)
    assert.equal(r.refused, false)
    waits.push(r.wait)
  }
  // The account's own counter (10 free, up to 1 min) runs alongside: the longer wait wins.
  assert.deepEqual(waits, [2, 4, 8, 16, 32, 64, 128, 256, 512, 900, 900, 900])
  assert.equal(fail('1.1.1.1', account.toUpperCase() + ' ').refused, true, 'names are counted case-insensitively and trimmed')
})

test('limits: a success clears the account, not the address; a counter is forgotten after an hour', () => {
  const account = m.aUsername()
  const { fail, pass, advance } = limiter()
  for (let i = 0; i < 4; i++) fail('1.1.1.1', account)
  pass('1.1.1.1', account)
  for (let i = 0; i < 5; i++) assert.equal(fail('1.1.1.1', account).wait, 0, 'five free failures again after a success')
  assert.equal(fail('1.1.1.1', account).wait, 1)

  // The address: 20 free across every name, and one's own success doesn't reset it.
  const b = limiter()
  const other = m.aUsername()
  for (let i = 0; i < 20; i++) assert.equal(b.fail('2.2.2.2', m.aUsername()).wait, 0)
  b.pass('2.2.2.2', m.aUsername())
  assert.equal(b.fail('2.2.2.2', other).wait, 1, 'the 21st failure from one address waits, success or not')
  assert.equal(b.fail('3.3.3.3', other).refused, false, 'another address is not held back by it')

  const c = limiter()
  for (let i = 0; i < 5; i++) c.fail('1.1.1.1', account)
  c.advance(61 * 60)
  assert.equal(c.fail('1.1.1.1', account).wait, 0, 'an hour later the failures are forgotten')
})

test('limits: from another address, the right password only waits the account part (a minute at most)', () => {
  const account = m.aUsername()
  const { fail, pass, advance } = limiter()
  // A guess spread over many addresses: after 10 failures, the account waits too.
  for (let i = 0; i < 10; i++) assert.equal(fail(`10.0.0.${i}`, account).wait, 0)
  assert.equal(fail('10.0.0.99', account).wait, 1, 'the 11th failure on the account, from anywhere')
  for (let i = 0; i < 10; i++) { advance(60); fail(`10.0.1.${i}`, account) }
  assert.equal(fail('10.0.2.1', account).wait, 60, 'the account part never passes one minute')
  // The owner, from an address of their own: refused only while the account waits.
  assert.deepEqual(pass('192.168.1.10', account), { refused: true, wait: 60 })
  advance(60)
  assert.deepEqual(pass('192.168.1.10', account), { refused: false, wait: 0 })
})

test('limits: a second-factor code spread over many addresses waits up to an hour, and is remembered for a day', () => {
  const account = m.aUsername()
  const { l, advance } = limiter()
  const code = (ip: string) => {
    const a = l.begin({ ip, account, secondFactor: true })
    return a.ok ? { refused: false, wait: a.failed() } : { refused: true, wait: a.retryAfter }
  }
  for (let i = 0; i < 10; i++) assert.equal(code(`10.0.0.${i}`).wait, 0, `failure ${i + 1} is free`)
  assert.equal(code('10.0.0.99').wait, 1, 'the 11th, from anywhere, waits')
  // Each new address waits out the account's wait first, which doubles up to an hour (a password's stops at a minute).
  let wait = 1
  for (let i = 0; wait < 3600; i++) {
    advance(wait)
    wait = code(`10.0.1.${i}`).wait
  }
  assert.equal(wait, 3600)
  advance(3600)
  assert.equal(code('10.0.2.1').wait, 3600, 'it never passes an hour')
  // An hour and a half of quiet doesn't forget it (a password's would be); a day does.
  advance(3600 + 90 * 60)
  assert.equal(code('10.0.3.1').wait, 3600)
  advance(3600 + 25 * 3600)
  assert.equal(code('10.0.4.1').wait, 0, 'forgotten after a day without failures')
  // Guessing at most about one code an hour, from one day to the next.
  const b = limiter()
  let tries = 0
  const end = b.clock.t + 30 * 86_400_000
  while (b.clock.t < end) {
    const a = b.l.begin({ ip: `10.1.${tries % 250}.${tries % 7}`, account, secondFactor: true })
    if (a.ok) { tries++; b.advance(a.failed() || 1) } else b.advance(a.retryAfter)
  }
  assert.ok(tries < 30 * 26, `${tries} codes tried in 30 days`)
})

test('limits: a device cookie from an earlier sign-in is held back by its own failures only', () => {
  const account = m.aUsername()
  const { l, fail, pass } = limiter()
  const cookie = l.deviceToken(account.toUpperCase())
  const device = l.deviceFor(cookie, account.toLowerCase())
  assert.ok(device, 'valid for the same account, whatever the case')
  assert.equal(l.deviceFor(cookie, m.aUsername()), null, 'not for another account')
  assert.equal(l.deviceFor(cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA'), account), null, 'not if tampered with')
  assert.equal(l.deviceFor(new LoginLimiter().deviceToken(account), account), null, 'not one made by another process (a restart)')
  assert.equal(l.deviceFor(undefined, account), null)

  // Someone guesses from many addresses, and from the owner's own address too.
  for (let i = 0; i < 30; i++) fail(`10.0.0.${i}`, account)
  for (let i = 0; i < 25; i++) fail('192.168.1.10', m.aUsername())
  assert.equal(pass('192.168.1.10', account).refused, true, 'a new browser waits')
  assert.deepEqual(pass('192.168.1.10', account, device), { refused: false, wait: 0 }, 'the known browser goes in')
  for (let i = 0; i < 5; i++) assert.equal(fail('192.168.1.10', account, device).wait, 0)
  assert.equal(fail('192.168.1.10', account, device).wait, 1, 'its own failures still count')
})

test('limits: attempts at once count before they are checked', () => {
  const account = m.aUsername()
  const { l } = limiter()
  const started = Array.from({ length: 20 }, () => l.begin({ ip: '1.1.1.1', account }))
  assert.equal(started.filter((a) => a.ok).length, 6, 'five free and the one that starts the wait; the rest refused')
  for (const a of started) if (a.ok) a.failed()
})

test('limits: memory is capped; counters that are waiting are the last to go', () => {
  const account = m.aUsername()
  // Waits long enough to outlast the test's clock.
  const { l, fail, advance } = limiter({ maxEntries: 50, baseMs: 10_000_000, pair: { free: 5, capMs: 10_000_000 } })
  for (let i = 0; i < 6; i++) fail('1.1.1.1', account)
  for (let i = 0; i < 2000; i++) { advance(1); fail(`10.${i >> 8}.${i & 255}.1`, m.aUsername()) }
  assert.ok(l.size <= 50, `at most 50 counters (${l.size})`)
  assert.equal(fail('1.1.1.1', account).refused, true, 'the wait survived thousands of invented names')
})

test('limits: the admin alert, from 20 failed or refused attempts until a day of quiet', () => {
  const { l, fail, advance } = limiter()
  for (let i = 0; i < 19; i++) fail(`10.0.0.${i}`, m.aUsername())
  assert.equal(l.summary(), null, '19 is not many')
  fail('10.0.0.200', m.aUsername())
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
    assert.throws(() => trustedProxiesFrom(bad), /VIHKO_TRUSTED_PROXIES/, bad)
  }
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9')
  assert.equal(ipKey('2001:db8:0:1:aaaa::1'), '2001:db8:0:1::/64', 'IPv6 by its /64')
  assert.equal(ipKey('2001:db8::1'), ipKey('2001:0db8:0000:0000:ffff::2'))
  assert.equal(ipKey('unknown'), 'unknown')
})

// The literals are the case: where a trusted range is too wide to be a proxy's.
test('trusted proxies wider than /12 (IPv4) or /48 (IPv6) are named, to warn on startup', () => {
  assert.deepEqual(wideTrustedProxies('10.0.0.50/8'), ['10.0.0.50/8'], 'meant as one address, it is all of 10.0.0.0/8')
  assert.deepEqual(wideTrustedProxies('172.16.0.0/12, 10.0.0.50, 10.0.0.50/32, 192.168.1.0/24'), [], 'a Docker network on the same host, and addresses')
  assert.deepEqual(wideTrustedProxies('2001:db8:1:2::/64 fd00::7 2001:db8::/48'), [], 'an IPv6 /64, an address and a /48')
  assert.deepEqual(wideTrustedProxies('2001:db8::/32, 10.0.0.5, 0.0.0.0/0'), ['2001:db8::/32', '0.0.0.0/0'])
  assert.deepEqual(wideTrustedProxies(undefined), [])
  assert.throws(() => wideTrustedProxies('10.0.0.0/33'), /VIHKO_TRUSTED_PROXIES/)
})

// --- Over HTTP ---------------------------------------------------------------

async function server(opts: { proxies?: string; rules?: Partial<LimitRules> } = {}) {
  const dir = tempDir('vihko-login-limit-')
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
  const verify = auth.verifyLogin.bind(auth)
  auth.verifyLogin = (u, p) => { checks++; return verify(u, p) }
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
  const admin = m.aUser({ role: 'admin' })
  const wrong = m.aPassword()
  await s.auth.createUser(admin.username, admin.password, admin.role)
  for (let i = 0; i < 5; i++) assert.equal((await s.signIn('203.0.113.9', admin.username, wrong)).status, 401)
  const sixth = await s.signIn('203.0.113.9', admin.username, wrong)
  assert.deepEqual([sixth.status, sixth.body.error, sixth.body.retryAfter, sixth.headers.get('retry-after')], [429, 'too_many_attempts', 1, '1'],
    'the failure that starts a wait says so')
  const checks = s.checks()
  const refused = await s.signIn('203.0.113.9', admin.username, admin.password)
  assert.deepEqual([refused.status, refused.headers.get('retry-after')], [429, '1'], 'even with the right password')
  assert.equal(s.checks(), checks, 'the password was not checked')
  assert.equal(cookieOf(refused.headers, SESSION_COOKIE), null)

  s.advance(1)
  const ok = await s.signIn('203.0.113.9', admin.username, admin.password)
  assert.equal(ok.status, 200)
  assert.ok(cookieOf(ok.headers, SESSION_COOKIE))
  const device = ok.headers.getSetCookie().find((c) => c.startsWith(DEVICE_COOKIE + '='))!
  assert.match(device, /HttpOnly/)
  assert.match(device, /Path=\/api(;|$)/)
  for (let i = 0; i < 5; i++) assert.equal((await s.signIn('203.0.113.9', admin.username, wrong)).status, 401, 'cleared by the success')
})

test('HTTP: without trusted proxies X-Forwarded-For changes nothing; with them, it is the client', async () => {
  const s = await server()
  const account = m.aUsername()
  const wrong = m.aPassword()
  for (let i = 0; i < 6; i++) await s.signIn('203.0.113.9', account, wrong, { 'x-forwarded-for': `198.51.100.${i}` })
  const r = await s.signIn('203.0.113.9', account, wrong, { 'x-forwarded-for': '198.51.100.77' })
  assert.equal(r.status, 429, 'a forged header does not make a new client')

  const p = await server({ proxies: '10.0.0.5' })
  for (let i = 0; i < 6; i++) await p.signIn('10.0.0.5', account, wrong, { 'x-forwarded-for': '198.51.100.1' })
  assert.equal((await p.signIn('10.0.0.5', account, wrong, { 'x-forwarded-for': '198.51.100.1' })).status, 429, 'that client waits')
  assert.equal((await p.signIn('10.0.0.5', account, wrong, { 'x-forwarded-for': '198.51.100.2' })).status, 401,
    'another client behind the same proxy does not')
  assert.equal((await p.signIn('10.0.0.5', account, wrong, { 'x-forwarded-for': '198.51.100.2, 198.51.100.1' })).status, 429,
    'and the client cannot hide behind a forged entry on the left')
})

test('HTTP: the owner signs in from a known browser while someone else guesses their name', async () => {
  const s = await server()
  const admin = m.aUser({ role: 'admin' })
  await s.auth.createUser(admin.username, admin.password, admin.role)
  const first = await s.signIn('192.168.1.10', admin.username, admin.password)
  const device = cookieOf(first.headers, DEVICE_COOKIE)!
  for (let i = 0; i < 40; i++) await s.signIn(`10.0.${i}.1`, admin.username, m.aPassword())
  assert.equal((await s.signIn('192.168.1.20', admin.username, admin.password)).status, 429, 'a new browser waits the account part')
  const known = await s.signIn('192.168.1.20', admin.username, admin.password, { cookie: device })
  assert.equal(known.status, 200, 'the known browser does not')
  assert.equal((await s.signIn('192.168.1.20', admin.username, admin.password, { cookie: `${DEVICE_COOKIE}=${m.aSecret(20)}.${m.aSecret(20)}` })).status, 429)
})

/**
 * The cookies a browser keeps from some responses, and sends back as it
 * would: each only to the paths its Path covers (RFC 6265 §5.1.4).
 */
function browser() {
  const jar = new Map<string, { value: string; path: string }>()
  return {
    keep(headers: Headers) {
      for (const c of headers.getSetCookie()) {
        const [pair = '', ...attrs] = c.split(/;\s*/)
        const [name = '', value = ''] = pair.split('=')
        const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? '/'
        if (/max-age=0/i.test(c)) jar.delete(`${name} ${path}`)
        else jar.set(`${name} ${path}`, { value, path })
      }
    },
    cookie(to: string): string {
      return [...jar].filter(([, c]) => to === c.path || to.startsWith(c.path.endsWith('/') ? c.path : c.path + '/'))
        .map(([k, c]) => `${k.split(' ')[0]}=${c.value}`).join('; ')
    },
  }
}

test('HTTP: the known browser confirms at the moment (a new key) while someone else guesses the name', async () => {
  const s = await server()
  const admin = m.aUser({ role: 'admin' })
  await s.auth.createUser(admin.username, admin.password, admin.role)
  const b = browser()
  b.keep((await s.signIn('192.168.1.10', admin.username, admin.password)).headers)
  for (let i = 0; i < 40; i++) await s.signIn(`10.0.${i}.1`, admin.username, m.aPassword())
  const key = await s.send('192.168.1.20', 'POST', '/api/keys', { name: m.aKeyName(), confirm: admin.password }, { cookie: b.cookie('/api/keys') })
  assert.equal(key.status, 201, 'the device cookie reaches the confirmation too')
})

test('HTTP: invented names cannot fill memory', async () => {
  const s = await server({ rules: { maxEntries: 100 } })
  for (let i = 0; i < 300; i++) {
    s.advance(1)
    assert.notEqual((await s.signIn(`10.${i >> 8}.${i & 255}.1`, `${m.aUsername()}-${'x'.repeat(500)}`, m.aPassword())).status, 500)
  }
  assert.ok(s.loginLimiter.size <= 100, `${s.loginLimiter.size} counters`)
  const huge = await s.send('10.9.9.9', 'POST', '/api/auth/login', { username: 'x'.repeat(20_000), password: 'y' })
  assert.equal(huge.status, 413, 'a login body is small')
})

test('HTTP: the first-boot token is limited too', async () => {
  const s = await server()
  const admin = m.aUser({ role: 'admin' })
  const token = s.auth.setupToken()!
  for (let i = 0; i < 5; i++) {
    const r = await s.send('203.0.113.9', 'POST', '/api/setup', { token: m.aSecret(43), username: admin.username, password: admin.password })
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_token'])
  }
  const sixth = await s.send('203.0.113.9', 'POST', '/api/setup', { token: m.aSecret(43), username: admin.username, password: admin.password })
  assert.deepEqual([sixth.status, sixth.body.error, sixth.headers.get('retry-after')], [429, 'too_many_attempts', '1'])
  const refused = await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: admin.username, password: admin.password })
  assert.equal(refused.status, 429, 'not even the right token during the wait')
  assert.equal(s.auth.userCount(), 0)
  s.advance(1)
  const weak = await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: admin.username, password: m.aWeakPassword() })
  assert.equal(weak.body.error, 'weak_password', 'a weak password with the right token is not a guess')
  assert.equal((await s.send('203.0.113.9', 'POST', '/api/setup', { token, username: admin.username, password: admin.password })).status, 200)
})

// A link or the first-boot token is 256 random bits: a guess spread over many
// addresses gets nowhere, so there is no shared counter for it that a guesser
// could run up to hold back the person who has the real one. Each address
// still waits after its own few failures.
test('HTTP: guessing links elsewhere does not hold back the person with a real one', async () => {
  const s = await server()
  const admin = m.aUser({ role: 'admin' })
  const newcomer = m.aUser({ role: 'member' })
  await s.auth.createUser(admin.username, admin.password, admin.role)
  const cookie = cookieOf((await s.signIn('192.0.2.10', admin.username, admin.password)).headers, SESSION_COOKIE)!
  const created = await s.send('192.0.2.10', 'POST', '/api/admin/users', { username: newcomer.username, role: newcomer.role }, { cookie })
  assert.equal(created.status, 201)
  const token: string = created.body.link.token

  for (let i = 0; i < 40; i++) await s.send(`10.0.${i}.1`, 'GET', `/api/invite/${m.aSecret(43)}`)
  const seen = await s.send('192.0.2.20', 'GET', `/api/invite/${token}`)
  assert.deepEqual([seen.status, seen.body.username], [200, newcomer.username], 'the invited person opens their link')
  const accepted = await s.send('192.0.2.20', 'POST', `/api/invite/${token}`, { password: newcomer.password })
  assert.equal(accepted.status, 200, 'and chooses their password')

  // One address guessing: five free failures, then it waits.
  for (let i = 0; i < 5; i++) assert.equal((await s.send('203.0.113.9', 'GET', `/api/invite/${m.aSecret(43)}`)).status, 404)
  assert.equal((await s.send('203.0.113.9', 'GET', `/api/invite/${m.aSecret(43)}`)).status, 429)
  assert.equal((await s.send('203.0.113.9', 'POST', `/api/invite/${m.aSecret(43)}`, { password: m.aPassword() })).status, 429)
})

test('HTTP: guessing the first-boot token elsewhere does not hold back whoever has it', async () => {
  const s = await server()
  const admin = m.aUser({ role: 'admin' })
  const token = s.auth.setupToken()!
  for (let i = 0; i < 40; i++) await s.send(`10.0.${i}.1`, 'POST', '/api/setup', { token: m.aSecret(43), username: m.aUsername(), password: m.aPassword() })
  const r = await s.send('192.0.2.20', 'POST', '/api/setup', { token, username: admin.username, password: admin.password })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(s.auth.userCount(), 1)
})

test('HTTP: many failures show in the admin’s alerts', async () => {
  const s = await server()
  const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }) }
  for (const u of Object.values(people)) await s.auth.createUser(u.username, u.password, u.role)
  const cookie = async (u: { username: string; password: string }) => cookieOf((await s.signIn('192.168.1.10', u.username, u.password)).headers, SESSION_COOKIE)!
  const admin = await cookie(people.admin)
  const member = await cookie(people.member)
  const alerts = async (c: string) => (await s.send('192.168.1.10', 'GET', '/api/alerts', undefined, { cookie: c })).body.alerts
    .filter((a: { code: string }) => a.code === 'login_attempts_blocked')
  assert.deepEqual(await alerts(admin), [])
  for (let i = 0; i < 25; i++) await s.signIn(`10.0.${i}.1`, people.admin.username, m.aPassword())
  assert.deepEqual(await alerts(admin), [{ code: 'login_attempts_blocked', attempts: 25, since: '2026-09-26T10:00:00.000Z', actions: [] }])
  assert.deepEqual(await alerts(member), [], 'only admins')
})
