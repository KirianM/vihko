import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Auth, Indexer, NoteService, Profiles, Workspace, SESSION_COOKIE, STATE_VERSION, createApp, ftsQuery, hashPassword, needsRehash, openIndex, openState, verifyPassword, type Runtime } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

async function setup(opts: { webDir?: string; config?: string } = {}) {
  const dir = tempDir('thoth-http-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  cpSync(VAULT, notesDir, { recursive: true })
  if (opts.config !== undefined) writeFileSync(join(notesDir, 'thoth.yaml'), opts.config)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(opts) { return (this.lastScan = indexer.scan(opts)) } }
  runtime.rescan({})
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index })
  const app = createApp({ auth, profiles: new Profiles(state), workspace: new Workspace({ notesDir }), notes, index, indexer, notesDir, runtime, webDir: opts.webDir })
  let cookie = ''
  const raw = (path: string) => app.request(path, { headers: { cookie } })
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody = false) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : rawBody ? String(body) : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set?.startsWith(SESSION_COOKIE + '=')) cookie = set.split(';')[0]!
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any }
  }
  return { dir, notesDir, auth, req, raw, runtime }
}

/** Status and code of an error response: the UI only needs the code. */
const errorOf = (r: { status: number; body: { error?: string } | null }) => [r.status, r.body?.error]

/** A hash as thoth made them before argon2id. */
function legacyScrypt(password: string): string {
  const salt = Buffer.alloc(16, 7)
  const hash = scryptSync(password.normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
}

test('passwords: argon2id with OWASP parameters, verification and rejection', async () => {
  const h = await hashPassword('a long password')
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
  assert.ok(await verifyPassword('a long password', h))
  assert.ok(!(await verifyPassword('otra', h)))
  assert.ok(await verifyPassword('Reunio\u0301n larga', await hashPassword('Reunión larga')), 'NFC before hashing')
  assert.notEqual(await hashPassword('x'.repeat(12)), await hashPassword('x'.repeat(12)), 'random salt')
  assert.equal(needsRehash(h), false)
  assert.equal(needsRehash(h.replace('m=19456', 'm=4096')), true, 'weaker parameters')
  assert.ok(!(await verifyPassword('a long password', h.replace('v=19', 'v=16'))), 'an unknown Argon2 version never matches')
  assert.ok(!(await verifyPassword('a long password', 'md5$abc')), 'an unknown algorithm never matches')
})

test('passwords: scrypt hashes still verify and become argon2id on the next login', async () => {
  const legacy = legacyScrypt('a long password')
  assert.ok(await verifyPassword('a long password', legacy))
  assert.ok(!(await verifyPassword('otra', legacy)))
  assert.equal(needsRehash(legacy), true)

  const state = openState(join(tempDir('thoth-auth-'), 'state.db'))
  const auth = new Auth(state)
  const user = await auth.createUser('noa', 'a long password', 'admin')
  const stored = () => (state.prepare('select password_hash from users where id = ?').get(user.id) as { password_hash: string }).password_hash
  assert.match(stored(), /^\$argon2id\$/, 'new users get argon2id')
  state.prepare('update users set password_hash = ? where id = ?').run(legacy, user.id)

  assert.equal(await auth.login('noa', 'wrong password'), null)
  assert.equal(stored(), legacy, 'a failed login changes nothing')

  assert.ok(await auth.login('noa', 'a long password'))
  assert.match(stored(), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/, 'rehashed on a successful login')
  assert.ok(await auth.login('noa', 'a long password'), 'and the new hash works')
  assert.equal(await auth.login('noa', 'wrong password'), null)
})

test('first boot: one-time token to create the admin', async () => {
  const { auth, req } = await setup()
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: true })
  const token = auth.setupToken()!
  const bad = await req('POST', '/api/setup', { token: 'bad', username: 'noa', password: 'a-long-password' })
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_token'])
  const weak = await req('POST', '/api/setup', { token, username: 'noa', password: 'short' })
  assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
  const ok = await req('POST', '/api/setup', { token, username: 'noa', password: 'a-long-password' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.role, 'admin')
  const again = await req('POST', '/api/setup', { token, username: 'otro', password: 'a-long-password' })
  assert.deepEqual([again.status, again.body.error], [409, 'already_setup'], 'the token is consumed')
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: false })
})

test('everything requires a session except health; login, session and logout', async () => {
  const { auth, req } = await setup()
  assert.deepEqual((await req('GET', '/api/health')).body, { ok: true })
  await auth.createUser('noa', 'a-long-password', 'admin')
  for (const p of ['/api/tree', '/api/note?path=Plan.md', '/api/search?q=plan', '/api/alerts', '/api/auth/me']) {
    assert.equal((await req('GET', p)).status, 401, p)
  }
  for (const bad of [{ username: 'noa', password: 'wrong-password' }, { username: 'nadie', password: 'a-long-password' }]) {
    const r = await req('POST', '/api/auth/login', bad)
    assert.deepEqual([r.status, r.body.error], [401, 'invalid_credentials'], 'distinct from an expired session')
  }
  assert.equal((await req('GET', '/api/auth/me')).body.error, 'unauthorized')
  const login = await req('POST', '/api/auth/login', { username: 'NOA', password: 'a-long-password' })
  assert.equal(login.status, 200, 'username is case-insensitive')
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/)
  assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/)
  assert.doesNotMatch(login.headers.get('set-cookie')!, /Secure/, "over HTTP on a LAN the cookie can't be Secure")
  assert.equal((await req('GET', '/api/auth/me')).body.user.username, 'noa')
  await req('POST', '/api/auth/logout')
  assert.equal((await req('GET', '/api/auth/me')).status, 401)
})

test('notes over HTTP: read, create, write with If-Match, move and delete', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'a-long-password', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })

  const tree = await req('GET', '/api/tree')
  assert.ok(tree.body.notes.some((n: { path: string }) => n.path === 'Plan.md'))

  const plan = await req('GET', '/api/note?path=Plan.md')
  assert.equal(plan.status, 200)
  assert.equal(plan.headers.get('etag'), `"${plan.body.etag}"`)

  const noMatch = await req('PUT', '/api/note?path=Plan.md', { text: 'x' })
  assert.deepEqual([noMatch.status, noMatch.body.error], [428, 'precondition_required'], "without If-Match, nothing is overwritten")
  const stale = await req('PUT', '/api/note?path=Plan.md', { text: 'x' }, { 'if-match': '"sha256:old"' })
  assert.deepEqual([stale.status, stale.body.error], [412, 'precondition_failed'])
  assert.equal(stale.body.etag, plan.body.etag, 'the 412 returns the current ETag')
  const put = await req('PUT', '/api/note?path=Plan.md', { text: '# Plan general\n\nNuevo.\n' }, { 'if-match': `"${plan.body.etag}"` })
  assert.equal(put.status, 200)

  assert.equal((await req('POST', '/api/note', { path: 'nueva.md', text: '# Nueva\n' })).status, 201)
  assert.deepEqual(errorOf(await req('POST', '/api/note', { path: 'nueva.md', text: '# Otra\n' })), [409, 'exists'])
  assert.deepEqual(errorOf(await req('GET', '/api/note?path=../fuera.md')), [400, 'invalid_path'])
  assert.deepEqual(errorOf(await req('GET', '/api/note?path=no-existe.md')), [404, 'not_found'])
  const notJson = await req('POST', '/api/note', '{no es json', {}, true)
  assert.deepEqual(errorOf(notJson), [400, 'invalid'], "a body that isn't JSON isn't an internal error")

  const dry = await req('POST', '/api/note/move', { from: 'hogar/Proxy.md', to: 'hogar/GW.md', dryRun: true })
  assert.ok(dry.body.relinked.length > 0)
  assert.equal((await req('POST', '/api/note/move', { from: 'hogar/Proxy.md', to: 'hogar/GW.md' })).status, 200)

  const del = await req('DELETE', '/api/note?path=nueva.md')
  assert.equal(del.status, 200)
  const trash = await req('GET', '/api/trash')
  assert.equal(trash.body.entries[0].path, 'nueva.md')
  assert.equal((await req('POST', `/api/trash/${del.body.id}/restore`, {})).status, 200)
})

test('links, backlinks with context, search and alerts', async () => {
  // A member who manages everything (D-038): reading notes is the folders' permissions, never the role.
  const { auth, req } = await setup({ config: 'permissions:\n  "": { grants: { noa: manage } }\n' })
  await auth.createUser('noa', 'a-long-password', 'member')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })

  const links = await req('GET', '/api/note/links?path=diario/2026-09-24.md')
  const tareas = links.body.outgoing.find((l: { raw: string }) => l.raw === '[[Tareas]]')
  assert.equal(tareas.status, 'ambiguous')
  assert.deepEqual(tareas.candidates, ['proyectos/blog/Tareas.md', 'proyectos/thoth/Tareas.md'])

  const back = await req('GET', '/api/note/links?path=hogar/Proxy.md')
  assert.ok(back.body.backlinks.some((b: { path: string; context: string }) => b.path === 'hogar/enlaces.md' && b.context.includes('[[Proxy#Red]]')))

  const alias = await req('GET', '/api/search?q=hipervisor')
  assert.equal(alias.body.results[0]?.path, 'hogar/Proxy.md', 'aliases are searched too')
  const s = await req('GET', '/api/search?q=cafe')
  assert.ok(s.body.results.some((r: { path: string }) => r.path.normalize('NFC') === 'recetas/Café.md'))
  assert.ok(s.body.results[0].snippet.includes('\u0002'), 'highlighted with markers, not HTML')
  assert.deepEqual((await req('GET', '/api/search?q=' + encodeURIComponent('" OR * NEAR('))).body.results, [], "the user's FTS5 syntax breaks nothing")

  assert.deepEqual(errorOf(await req('POST', '/api/admin/rescan', {})), [403, 'forbidden'], "a member isn't an admin")
})

test('editor autocomplete data: aliases in the tree, tags with counts and a note\'s headings', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'a-long-password', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })

  const tree = await req('GET', '/api/tree')
  const gw = tree.body.notes.find((n: { path: string }) => n.path === 'hogar/Proxy.md')
  assert.deepEqual(gw.aliases, ['gw', 'Hipervisor'])

  const tags = (await req('GET', '/api/tags')).body.tags as { tag: string; count: number }[]
  assert.ok(tags.length > 0)
  const hogar = tags.find((t) => t.tag === 'hogar')!
  assert.ok(hogar.count >= 1, 'counted by notes')
  assert.ok(!tags.some((t) => t.tag === 'Hogar'), 'tags are case-insensitive')
  assert.deepEqual(tags.map((t) => t.count), tags.map((t) => t.count).sort((a, b) => b - a), 'most used first')

  const headings = await req('GET', '/api/note/headings?path=hogar/Proxy.md')
  assert.ok(headings.body.headings.some((h: { text: string }) => h.text === 'Red'))
  assert.deepEqual(errorOf(await req('GET', '/api/note/headings?path=no-existe.md')), [404, 'not_found'])
})

test('comments inside a note stay out of backlink contexts and search', async () => {
  const { auth, req, notesDir, runtime } = await setup()
  await auth.createUser('noa', 'a-long-password', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })
  writeFileSync(join(notesDir, 'hogar/discussed.md'),
    'Move the VMs to [[Proxy]] this week.<!-- @ana 2026-09-24T08:12Z · which zanahoria host? -->\n')
  runtime.rescan({})
  const back = await req('GET', '/api/note/links?path=hogar/Proxy.md')
  const b = back.body.backlinks.find((x: { path: string }) => x.path === 'hogar/discussed.md')
  assert.equal(b.context, 'Move the VMs to [[Proxy]] this week.')
  assert.deepEqual((await req('GET', '/api/search?q=zanahoria')).body.results, [])
})

test('workspace alerts: codes with their data and actions based on role', async () => {
  const { auth, notesDir, req } = await setup()
  await auth.createUser('noa', 'a-long-password', 'admin')
  await auth.createUser('ana', 'a-long-password', 'member')
  const as = (username: string) => req('POST', '/api/auth/login', { username, password: 'a-long-password' })
  const alerts = async () => (await req('GET', '/api/alerts')).body.alerts as { code: string; [k: string]: unknown }[]

  await as('noa')
  const conflict = 'proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md'
  assert.deepEqual(await alerts(), [
    { code: 'uid_conflict', uid: '01J8X4M2K9QZ', paths: ['uid/copia.md', 'uid/original.md'], actions: [] },
    { code: 'sync_conflict', path: conflict, note: 'proyectos/thoth/Plan.md', actions: [] },
  ])
  const copy = await req('GET', `/api/conflict?path=${encodeURIComponent(conflict)}`)
  assert.equal(copy.status, 200)
  assert.match(copy.body.text, /\S/)
  for (const p of ['Plan.md', '../fuera.md', 'proyectos/thoth/Otro.sync-conflict-20260924-120000-ABCDEFG.md']) {
    assert.deepEqual(errorOf(await req('GET', `/api/conflict?path=${encodeURIComponent(p)}`)), [404, 'not_found'], `only detected copies: ${p}`)
  }

  // Mass deletion (e.g. an unmounted network folder): the scan stops and raises an alert.
  for (const d of ['proyectos', 'hogar', 'recetas', 'frontmatter', 'diario', 'uid', 'privado']) rmSync(join(notesDir, d), { recursive: true })
  const aborted = (await req('POST', '/api/admin/rescan', {})).body
  assert.equal(aborted.aborted, 'mass_delete')
  const [scan] = await alerts()
  assert.deepEqual(scan, { code: 'scan_aborted_mass_delete', ...aborted.massDelete, actions: ['rescan', 'confirm_removal'] })
  assert.ok((scan!.removing as number) > 10 && (scan!.total as number) > (scan!.removing as number))

  // A system alert is the admin's (D-038): a member (who reads nothing here) sees nothing, and the server denies them too.
  await as('ana')
  assert.deepEqual(await alerts(), [])
  assert.deepEqual(errorOf(await req('POST', '/api/admin/rescan', { confirmRemoval: scan!.removing })), [403, 'forbidden'])

  // Confirming with a number that no longer matches the alert deletes nothing.
  await as('noa')
  const stale = (await req('POST', '/api/admin/rescan', { confirmRemoval: (scan!.removing as number) - 1 })).body
  assert.equal(stale.aborted, 'mass_delete')
  const done = (await req('POST', '/api/admin/rescan', { confirmRemoval: scan!.removing })).body
  assert.deepEqual([done.aborted, done.removed.length], [null, scan!.removing])
  assert.deepEqual(await alerts(), [], 'once confirmed, the alert disappears (and its conflicts along with the notes)')

  rmSync(notesDir, { recursive: true })
  await req('POST', '/api/admin/rescan', {})
  assert.deepEqual(await alerts(), [{ code: 'scan_aborted_root_unavailable', actions: ['rescan'] }])
})

test("UI: static files, app routes serve index.html, and the API doesn't fall through to the UI", async () => {
  const webDir = tempDir('thoth-web-')
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  const { auth, req, raw } = await setup({ webDir })
  const home = await raw('/')
  assert.equal(home.status, 200)
  assert.match(await home.text(), /id="root"/)
  assert.match(home.headers.get('content-security-policy')!, /default-src 'self'/)
  assert.equal(home.headers.get('cache-control'), 'no-cache')
  const deep = await raw('/cualquier/ruta?note=Plan.md')
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /id="root"/, 'app routes serve index.html')
  const asset = await raw('/assets/app-abc123.js')
  assert.equal(await asset.text(), 'console.log(1)')
  assert.match(asset.headers.get('cache-control')!, /immutable/)
  assert.equal((await req('GET', '/api/no-existe')).status, 401, 'the API still requires a session')
  await auth.createUser('noa', 'a-long-password', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })
  const missing = await req('GET', '/api/no-existe')
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found'], "an unknown API route doesn't return the UI")
})

test('CSRF: a write from another origin is rejected', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'a-long-password', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })
  const r = await req('POST', '/api/note', { path: 'x.md', text: 'x' }, { origin: 'https://malicious.example' })
  assert.equal(r.status, 403)
  const same = await req('POST', '/api/note', { path: 'x.md', text: 'x' }, { origin: 'http://localhost' })
  assert.equal(same.status, 201)
})

test('ftsQuery: quoted terms and a prefix on the last one', () => {
  assert.equal(ftsQuery('café con leche'), '"café" "con" "leche"*')
  assert.equal(ftsQuery('" OR *'), '"OR"*')
  assert.equal(ftsQuery('   '), null)
})

test('state.db: migrations, a copy before migrating, and rejecting future versions', () => {
  const dir = tempDir('thoth-state-')
  const file = join(dir, 'state.db')
  openState(file).close()
  const raw = new Database(file)
  assert.equal(raw.pragma('user_version', { simple: true }), STATE_VERSION)
  raw.pragma(`user_version = ${STATE_VERSION + 1}`)
  raw.close()
  assert.throws(() => openState(file), /newer than/)
  // Simulates a database from an older version with data: it must be copied before migrating.
  const old = join(dir, 'old.db')
  copyFileSync(file, old)
  const r = new Database(old)
  r.exec('drop table oauth_tokens; drop table oauth_codes; drop table oauth_clients; drop table api_keys; drop table settings; drop table profiles; drop table sessions; drop table users')
  r.pragma('user_version = 0')
  r.close()
  openState(old).close()
  assert.ok(!existsSync(old + '.bak-v0'), "an empty database (v0) doesn't need a copy")
})
