import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Auth, AuthError, Indexer, MAX_API_BODY, MAX_AUTH_BODY, MAX_PASSWORD, NoteService, Profiles, Workspace, SESSION_COOKIE, STATE_VERSION, createApp, ftsQuery, hashPassword, needsRehash, openIndex, openState, verifyPassword, type Runtime } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { SHARED, inShared, sharedSpace } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

/**
 * A copy of the test vault in the shared space (every note is in a
 * space), `members` its grants (subject → level) for people the test creates
 * afterwards; none by default.
 */
async function setup(opts: { webDir?: string; members?: Record<string, string> } = {}) {
  const dir = tempDir('vihko-http-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  cpSync(VAULT, join(notesDir, SHARED), { recursive: true })
  if (opts.members !== undefined) writeFileSync(join(notesDir, 'vihko.yaml'), sharedSpace(opts.members))
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

/** A hash as vihko made them before argon2id. */
function legacyScrypt(password: string): string {
  const salt = Buffer.alloc(16, 7)
  const hash = scryptSync(password.normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
}

test('passwords: argon2id with OWASP parameters, verification and rejection', async () => {
  const password = m.aPassword()
  const h = await hashPassword(password)
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
  assert.ok(await verifyPassword(password, h))
  assert.ok(!(await verifyPassword(m.aPassword(), h)))
  // The same text composed (NFC) and decomposed: the case under test.
  assert.ok(await verifyPassword('Reunio\u0301n larga', await hashPassword('Reunión larga')), 'NFC before hashing')
  const same = m.aPassword()
  assert.notEqual(await hashPassword(same), await hashPassword(same), 'random salt')
  assert.equal(needsRehash(h), false)
  assert.equal(needsRehash(h.replace('m=19456', 'm=4096')), true, 'weaker parameters')
  assert.ok(!(await verifyPassword(password, h.replace('v=19', 'v=16'))), 'an unknown Argon2 version never matches')
  assert.ok(!(await verifyPassword(password, 'md5$abc')), 'an unknown algorithm never matches')
})

test('passwords: scrypt hashes still verify and become argon2id on the next login', async () => {
  const admin = m.aUser({ role: 'admin' })
  const wrong = m.aPassword()
  const legacy = legacyScrypt(admin.password)
  assert.ok(await verifyPassword(admin.password, legacy))
  assert.ok(!(await verifyPassword(wrong, legacy)))
  assert.equal(needsRehash(legacy), true)

  const state = openState(join(tempDir('vihko-auth-'), 'state.db'))
  const auth = new Auth(state)
  const user = await auth.createUser(admin.username, admin.password, admin.role)
  const stored = () => (state.prepare('select password_hash from users where id = ?').get(user.id) as { password_hash: string }).password_hash
  assert.match(stored(), /^\$argon2id\$/, 'new users get argon2id')
  state.prepare('update users set password_hash = ? where id = ?').run(legacy, user.id)

  assert.equal(await auth.login(admin.username, wrong), null)
  assert.equal(stored(), legacy, 'a failed login changes nothing')

  assert.ok(await auth.login(admin.username, admin.password))
  assert.match(stored(), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/, 'rehashed on a successful login')
  assert.ok(await auth.login(admin.username, admin.password), 'and the new hash works')
  assert.equal(await auth.login(admin.username, wrong), null)
})

/** A random password exactly `length` characters long. */
const aPasswordOf = (length: number) => Array.from({ length: Math.ceil(length / 10) + 1 }, () => m.aPassword()).join('').slice(0, length)

test('passwords: one longer than MAX_PASSWORD is refused before any hashing', async () => {
  const atLimit = aPasswordOf(MAX_PASSWORD)
  assert.ok(await verifyPassword(atLimit, await hashPassword(atLimit)), 'the limit itself is a valid length')
  const over = aPasswordOf(MAX_PASSWORD + 1)
  await assert.rejects(hashPassword(over), (e) => e instanceof AuthError && e.code === 'weak_password')
  // Even against a hash made of it (by an older vihko, without the limit), it's never checked.
  assert.equal(await verifyPassword(over, legacyScrypt(over)), false)
})

test('request bodies: over the limit is 413, and nothing changes', async () => {
  const admin = m.aUser({ role: 'admin' })
  const { auth, req } = await setup({ members: { [admin.username]: 'manage' } })
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  const path = m.aNotePath(inShared(''))
  const text = m.aParagraph()
  const created = await req('POST', '/api/note', { path, text })
  assert.equal(created.status, 201)
  const current = async () => (await req('GET', `/api/note?path=${encodeURIComponent(path)}`)).body.text as string
  const before = await current()
  // Any route that reads a body: the whole text of a note, as big as the limit.
  const huge = 'x'.repeat(MAX_API_BODY)
  const put = await req('PUT', `/api/note?path=${encodeURIComponent(path)}`, { text: huge }, { 'if-match': `"${created.body.etag}"` })
  assert.equal(put.status, 413, 'PUT /api/note')
  const edit = await req('POST', '/api/note/edit', { path, ops: [{ op: 'append', text: huge }] })
  assert.equal(edit.status, 413, 'POST /api/note/edit')
  assert.equal(await current(), before)

  // A new password: its body is as small as a login's, and the password itself has a limit.
  const tooBig = await req('POST', '/api/auth/password', { current: admin.password, password: aPasswordOf(MAX_AUTH_BODY) })
  assert.equal(tooBig.status, 413, 'a body larger than a login\'s')
  const tooLong = await req('POST', '/api/auth/password', { current: admin.password, password: aPasswordOf(MAX_PASSWORD + 1) })
  assert.deepEqual(errorOf(tooLong), [400, 'weak_password'], 'a password longer than MAX_PASSWORD')
  assert.ok(await auth.login(admin.username, admin.password), 'the password is still the same')
})

test('first boot: one-time token to create the admin', async () => {
  const { auth, req } = await setup()
  const admin = m.aUser({ role: 'admin' })
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: true })
  const token = auth.setupToken()!
  const bad = await req('POST', '/api/setup', { token: m.aSecret(43), username: admin.username, password: admin.password })
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_token'])
  const weak = await req('POST', '/api/setup', { token, username: admin.username, password: m.aWeakPassword() })
  assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
  const ok = await req('POST', '/api/setup', { token, username: admin.username, password: admin.password })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.role, 'admin')
  const again = await req('POST', '/api/setup', { token, username: m.aUsername(), password: m.aPassword() })
  assert.deepEqual([again.status, again.body.error], [409, 'already_setup'], 'the token is consumed')
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: false })
})

test('everything requires a session except health; login, session and logout', async () => {
  const { auth, req } = await setup()
  // Not even the version without a session.
  assert.deepEqual((await req('GET', '/api/health')).body, { ok: true })
  const admin = m.aUser({ role: 'admin' })
  await auth.createUser(admin.username, admin.password, admin.role)
  for (const p of ['/api/tree', `/api/note?path=${encodeURIComponent(inShared('Plan.md'))}`, '/api/search?q=plan', '/api/alerts', '/api/auth/me']) {
    assert.equal((await req('GET', p)).status, 401, p)
  }
  for (const bad of [{ username: admin.username, password: m.aPassword() }, { username: m.aUsername(), password: admin.password }]) {
    const r = await req('POST', '/api/auth/login', bad)
    assert.deepEqual([r.status, r.body.error], [401, 'invalid_credentials'], 'distinct from an expired session')
  }
  assert.equal((await req('GET', '/api/auth/me')).body.error, 'unauthorized')
  // Its ASCII letters in upper case: the case of the others is the test below.
  const login = await req('POST', '/api/auth/login', { username: admin.username.replace(/[a-z]/g, (c) => c.toUpperCase()), password: admin.password })
  assert.equal(login.status, 200, 'username is case-insensitive')
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/)
  assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/)
  assert.doesNotMatch(login.headers.get('set-cookie')!, /Secure/, "over HTTP on a LAN the cookie can't be Secure")
  assert.equal((await req('GET', '/api/auth/me')).body.user.username, admin.username)
  await req('POST', '/api/auth/logout')
  assert.equal((await req('GET', '/api/auth/me')).status, 401)
})

// Sign-in finds the name as the permissions compare it (subjectKey), not with
// state.db's `collate nocase`, which folds ASCII only. The name always has a
// non-ASCII letter: that is the case under test.
test('a username signs in in any case, in any script', async () => {
  const { auth, req } = await setup()
  const admin = { ...m.aUser({ role: 'admin' }), username: `${m.aUsername().slice(0, 60)}í` }
  await auth.createUser(admin.username, admin.password, admin.role)
  for (const username of [admin.username.toUpperCase(), admin.username.toLowerCase()]) {
    assert.equal((await req('POST', '/api/auth/login', { username, password: admin.password })).status, 200, username)
  }
})

test('notes over HTTP: read, create, write with If-Match, move and delete', async () => {
  const admin = m.aUser({ role: 'admin' })
  const { auth, req } = await setup({ members: { [admin.username]: 'manage' } })
  const [planPath, planQ] = [inShared('Plan.md'), `?path=${encodeURIComponent(inShared('Plan.md'))}`]
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })

  const tree = await req('GET', '/api/tree')
  assert.ok(tree.body.notes.some((n: { path: string }) => n.path === planPath))

  const plan = await req('GET', `/api/note${planQ}`)
  assert.equal(plan.status, 200)
  assert.equal(plan.headers.get('etag'), `"${plan.body.etag}"`)

  const noMatch = await req('PUT', `/api/note${planQ}`, { text: m.aSentence() })
  assert.deepEqual([noMatch.status, noMatch.body.error], [428, 'precondition_required'], "without If-Match, nothing is overwritten")
  const stale = await req('PUT', `/api/note${planQ}`, { text: m.aSentence() }, { 'if-match': '"sha256:old"' })
  assert.deepEqual([stale.status, stale.body.error], [412, 'precondition_failed'])
  assert.equal(stale.body.etag, plan.body.etag, 'the 412 returns the current ETag')
  const put = await req('PUT', `/api/note${planQ}`, { text: `# ${m.aHeading()}\n\n${m.aSentence()}\n` }, { 'if-match': `"${plan.body.etag}"` })
  assert.equal(put.status, 200)

  const fresh = m.aNotePath(inShared(''))
  assert.equal((await req('POST', '/api/note', { path: fresh, text: `# ${m.aHeading()}\n` })).status, 201)
  assert.deepEqual(errorOf(await req('POST', '/api/note', { path: fresh, text: `# ${m.aHeading()}\n` })), [409, 'exists'])
  assert.deepEqual(errorOf(await req('GET', `/api/note?path=${encodeURIComponent(`../${m.aNotePath()}`)}`)), [400, 'invalid_path'])
  assert.deepEqual(errorOf(await req('GET', `/api/note?path=${encodeURIComponent(m.aNotePath(inShared('')))}`)), [404, 'not_found'])
  // A name with a control character (a tab, the case under test) is refused with its own code; NUL can't name a file at all.
  const tabbed = m.aNotePath(inShared('')).replace(/\.md$/, `\t${m.aWord()}.md`)
  assert.deepEqual(errorOf(await req('POST', '/api/note', { path: tabbed, text: `# ${m.aHeading()}\n` })), [400, 'control_characters'])
  assert.deepEqual(errorOf(await req('POST', '/api/note/move', { from: fresh, to: tabbed })), [400, 'control_characters'])
  assert.deepEqual(errorOf(await req('POST', '/api/folder', { path: inShared(`${m.aFolder()}\t${m.aWord()}`) })), [400, 'control_characters'])
  assert.deepEqual(errorOf(await req('GET', `/api/note?path=${encodeURIComponent(inShared(`${m.aFolder()}/\u0000.md`))}`)), [400, 'invalid_path'])
  const notJson = await req('POST', '/api/note', '{no es json', {}, true)
  assert.deepEqual(errorOf(notJson), [400, 'invalid'], "a body that isn't JSON isn't an internal error")

  // A note of the vault that others link to, renamed.
  const renamed = m.aNotePath(inShared('hogar'))
  const dry = await req('POST', '/api/note/move', { from: inShared('hogar/Proxy.md'), to: renamed, dryRun: true })
  assert.ok(dry.body.relinked.length > 0)
  assert.equal((await req('POST', '/api/note/move', { from: inShared('hogar/Proxy.md'), to: renamed })).status, 200)

  const del = await req('DELETE', `/api/note?path=${encodeURIComponent(fresh)}`)
  assert.equal(del.status, 200)
  const trash = await req('GET', '/api/trash')
  assert.equal(trash.body.entries[0].path, fresh)
  assert.equal((await req('POST', `/api/trash/${del.body.id}/restore`, {})).status, 200)
})

test('links, backlinks with context, search and alerts', async () => {
  // A member who manages the space: reading notes is the folders' permissions, never the role.
  const member = m.aUser({ role: 'member' })
  const { auth, req } = await setup({ members: { [member.username]: 'manage' } })
  await auth.createUser(member.username, member.password, member.role)
  await req('POST', '/api/auth/login', { username: member.username, password: member.password })

  const links = await req('GET', `/api/note/links?path=${encodeURIComponent(inShared('diario/2026-09-24.md'))}`)
  const tareas = links.body.outgoing.find((l: { raw: string }) => l.raw === '[[Tareas]]')
  assert.equal(tareas.status, 'ambiguous')
  assert.deepEqual(tareas.candidates, [inShared('proyectos/blog/Tareas.md'), inShared('proyectos/vihko/Tareas.md')])

  const back = await req('GET', `/api/note/links?path=${encodeURIComponent(inShared('hogar/Proxy.md'))}`)
  assert.ok(back.body.backlinks.some((b: { path: string; context: string }) => b.path === inShared('hogar/enlaces.md') && b.context.includes('[[Proxy#Red]]')))

  const alias = await req('GET', '/api/search?q=hipervisor')
  assert.equal(alias.body.results[0]?.path, inShared('hogar/Proxy.md'), 'aliases are searched too')
  const s = await req('GET', '/api/search?q=cafe')
  assert.ok(s.body.results.some((r: { path: string }) => r.path.normalize('NFC') === inShared('recetas/Café.md')))
  assert.ok(s.body.results[0].snippet.includes('\u0002'), 'highlighted with markers, not HTML')
  assert.deepEqual((await req('GET', '/api/search?q=' + encodeURIComponent('" OR * NEAR('))).body.results, [], "the user's FTS5 syntax breaks nothing")

  assert.deepEqual(errorOf(await req('POST', '/api/admin/rescan', {})), [403, 'forbidden'], "a member isn't an admin")
})

test('editor autocomplete data: aliases in the tree, tags with counts and a note\'s headings', async () => {
  const admin = m.aUser({ role: 'admin' })
  const { auth, req } = await setup({ members: { [admin.username]: 'manage' } })
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })

  const tree = await req('GET', '/api/tree')
  const gw = tree.body.notes.find((n: { path: string }) => n.path === inShared('hogar/Proxy.md'))
  assert.deepEqual(gw.aliases, ['gw', 'Hipervisor'])

  const tags = (await req('GET', '/api/tags')).body.tags as { tag: string; count: number }[]
  assert.ok(tags.length > 0)
  const hogar = tags.find((t) => t.tag === 'hogar')!
  assert.ok(hogar.count >= 1, 'counted by notes')
  assert.ok(!tags.some((t) => t.tag === 'Hogar'), 'tags are case-insensitive')
  assert.deepEqual(tags.map((t) => t.count), tags.map((t) => t.count).sort((a, b) => b - a), 'most used first')

  const headings = await req('GET', `/api/note/headings?path=${encodeURIComponent(inShared('hogar/Proxy.md'))}`)
  assert.ok(headings.body.headings.some((h: { text: string }) => h.text === 'Red'))
  assert.deepEqual(errorOf(await req('GET', `/api/note/headings?path=${encodeURIComponent(m.aNotePath(inShared('')))}`)), [404, 'not_found'])
})

test('comments inside a note stay out of backlink contexts and search', async () => {
  const admin = m.aUser({ role: 'admin' })
  const { auth, req, notesDir, runtime } = await setup({ members: { [admin.username]: 'manage' } })
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  // A note linking to one of the vault's, with a comment (vihko's format) after the link's sentence.
  const discussed = m.aNotePath(inShared('hogar'))
  const line = `${m.aSentence(3).slice(0, -1)} [[Proxy]] ${m.aWord()}.`
  const commented = m.aUniqueWord()
  writeFileSync(join(notesDir, discussed), `${line}<!-- @${m.aUsername()} 2026-09-24T08:12Z · ${m.aWord()} ${commented}? -->\n`)
  runtime.rescan({})
  const back = await req('GET', `/api/note/links?path=${encodeURIComponent(inShared('hogar/Proxy.md'))}`)
  const b = back.body.backlinks.find((x: { path: string }) => x.path === discussed)
  assert.equal(b.context, line)
  assert.deepEqual((await req('GET', `/api/search?q=${encodeURIComponent(commented)}`)).body.results, [])
})

test('workspace alerts: codes with their data and actions based on role', async () => {
  const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }) }
  // The admin manages the space; the member has nothing in it.
  const { auth, notesDir, req } = await setup({ members: { [people.admin.username]: 'manage' } })
  for (const u of Object.values(people)) await auth.createUser(u.username, u.password, u.role)
  const as = (who: keyof typeof people) => req('POST', '/api/auth/login', { username: people[who].username, password: people[who].password })
  const alerts = async () => (await req('GET', '/api/alerts')).body.alerts as { code: string; [k: string]: unknown }[]

  await as('admin')
  const conflict = inShared('proyectos/vihko/Plan.sync-conflict-20260924-120000-ABCDEFG.md')
  assert.deepEqual(await alerts(), [
    { code: 'uid_conflict', uid: '01J8X4M2K9QZ', paths: [inShared('uid/copia.md'), inShared('uid/original.md')], actions: [] },
    { code: 'sync_conflict', path: conflict, note: inShared('proyectos/vihko/Plan.md'), actions: [] },
  ])
  const copy = await req('GET', `/api/conflict?path=${encodeURIComponent(conflict)}`)
  assert.equal(copy.status, 200)
  assert.match(copy.body.text, /\S/)
  for (const p of [inShared('Plan.md'), '../fuera.md', inShared(`proyectos/vihko/${m.aTitle()}.sync-conflict-20260924-120000-ABCDEFG.md`)]) {
    assert.deepEqual(errorOf(await req('GET', `/api/conflict?path=${encodeURIComponent(p)}`)), [404, 'not_found'], `only detected copies: ${p}`)
  }

  // Mass deletion (e.g. an unmounted network folder): the scan stops and raises an alert.
  for (const d of ['proyectos', 'hogar', 'recetas', 'frontmatter', 'diario', 'uid', 'privado']) rmSync(join(notesDir, SHARED, d), { recursive: true })
  const aborted = (await req('POST', '/api/admin/rescan', {})).body
  assert.equal(aborted.aborted, 'mass_delete')
  const [scan] = await alerts()
  assert.deepEqual(scan, { code: 'scan_aborted_mass_delete', ...aborted.massDelete, actions: ['rescan', 'confirm_removal'] })
  assert.ok((scan!.removing as number) > 10 && (scan!.total as number) > (scan!.removing as number))

  // A system alert is the admin's: a member (who reads nothing here) sees nothing, and the server denies them too.
  await as('member')
  assert.deepEqual(await alerts(), [])
  assert.deepEqual(errorOf(await req('POST', '/api/admin/rescan', { confirmRemoval: scan!.removing })), [403, 'forbidden'])

  // Confirming with a number that no longer matches the alert deletes nothing.
  await as('admin')
  const stale = (await req('POST', '/api/admin/rescan', { confirmRemoval: (scan!.removing as number) - 1 })).body
  assert.equal(stale.aborted, 'mass_delete')
  const done = (await req('POST', '/api/admin/rescan', { confirmRemoval: scan!.removing })).body
  assert.deepEqual([done.aborted, done.removed], [null, scan!.removing], 'how many, never which')
  assert.deepEqual(await alerts(), [], 'once confirmed, the alert disappears (and its conflicts along with the notes)')

  rmSync(notesDir, { recursive: true })
  await req('POST', '/api/admin/rescan', {})
  assert.deepEqual(await alerts(), [{ code: 'scan_aborted_root_unavailable', actions: ['rescan'] }])
})

test("UI: static files, app routes serve index.html, and the API doesn't fall through to the UI", async () => {
  const webDir = tempDir('vihko-web-')
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  const { auth, req, raw } = await setup({ webDir })
  const home = await raw('/')
  assert.equal(home.status, 200)
  assert.match(await home.text(), /id="root"/)
  assert.match(home.headers.get('content-security-policy')!, /default-src 'self'/)
  assert.equal(home.headers.get('cache-control'), 'no-cache')
  const deep = await raw(`/${encodeURIComponent(m.aWord())}/${encodeURIComponent(m.aWord())}?note=Plan.md`)
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /id="root"/, 'app routes serve index.html')
  const asset = await raw('/assets/app-abc123.js')
  assert.equal(await asset.text(), 'console.log(1)')
  assert.match(asset.headers.get('cache-control')!, /immutable/)
  const unknown = `/api/${m.aUniqueWord()}`
  assert.equal((await req('GET', unknown)).status, 401, 'the API still requires a session')
  const admin = m.aUser({ role: 'admin' })
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  const missing = await req('GET', unknown)
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found'], "an unknown API route doesn't return the UI")
})

test('headers: every answer is nosniff, and one that is not the UI can run nothing', async () => {
  const webDir = tempDir('vihko-web-')
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  const { auth, req, raw } = await setup({ webDir })
  const admin = m.aUser({ role: 'admin' })
  await auth.createUser(admin.username, admin.password, admin.role)
  const api = {
    health: await raw('/api/health'),
    unauthorized: await raw('/api/notes'),
    tooLarge: (await req('POST', '/api/auth/login', m.aPassword().repeat(MAX_AUTH_BODY), {}, true)).headers,
  }
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  const signedIn = { notes: await raw('/api/notes'), missing: await raw(`/api/${m.aUniqueWord()}`) }
  for (const [what, headers] of Object.entries({ ...api, ...signedIn }).map(([k, v]) => [k, v instanceof Response ? v.headers : v] as const)) {
    assert.equal(headers.get('x-content-type-options'), 'nosniff', what)
    assert.equal(headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'", what)
  }
  // The UI keeps its own policy.
  const home = await raw('/')
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff')
  assert.match(home.headers.get('content-security-policy')!, /default-src 'self'/)
})

test('headers: no cache keeps what the API answers, the UI and files keep their own rules', async () => {
  const webDir = tempDir('vihko-web-')
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  const admin = m.aUser({ role: 'admin' })
  const { auth, notesDir, req, raw } = await setup({ webDir, members: { [admin.username]: 'manage' } })
  await auth.createUser(admin.username, admin.password, admin.role)
  const unauthorized = await raw('/api/tree')
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  const path = m.aNotePath(inShared(''))
  const created = await req('POST', '/api/note', { path, text: m.aParagraph() })
  assert.equal(created.status, 201)
  const image = inShared(`${m.aUniqueWord()}.png`)
  writeFileSync(join(notesDir, image), Buffer.from('89504e470d0a1a0a', 'hex'))
  const answers = {
    unauthorized,
    health: await raw('/api/health'),
    tree: await raw('/api/tree'),
    note: await raw(`/api/note?path=${encodeURIComponent(path)}`),
    search: await raw(`/api/search?q=${encodeURIComponent(m.aWord())}`),
    me: await raw('/api/auth/me'),
    missing: await raw(`/api/${m.aUniqueWord()}`),
  }
  for (const [what, res] of Object.entries(answers)) assert.equal(res.headers.get('cache-control'), 'no-store', what)
  assert.equal(answers.note.status, 200, 'the note is read')
  assert.equal(created.headers.get('cache-control'), 'no-store', 'a write')
  // An image from the notes folder is revalidated (304 when unchanged), never shared.
  assert.equal((await raw(`/api/file?path=${encodeURIComponent(image)}`)).headers.get('cache-control'), 'private, no-cache')
  assert.equal((await raw('/')).headers.get('cache-control'), 'no-cache')
  assert.match((await raw('/assets/app-abc123.js')).headers.get('cache-control')!, /immutable/)
})

test('CSRF: a write from another origin is rejected', async () => {
  const admin = m.aUser({ role: 'admin' })
  const { auth, req } = await setup({ members: { [admin.username]: 'manage' } })
  await auth.createUser(admin.username, admin.password, admin.role)
  await req('POST', '/api/auth/login', { username: admin.username, password: admin.password })
  const path = m.aNotePath(inShared(''))
  const r = await req('POST', '/api/note', { path, text: m.aSentence() }, { origin: 'https://malicious.example' })
  assert.equal(r.status, 403)
  // An opaque origin (a sandboxed frame, a file) or one that isn't a URL is another origin too, not an error.
  for (const origin of ['null', '://']) {
    assert.deepEqual(errorOf(await req('POST', '/api/note', { path, text: m.aSentence() }, { origin })), [403, 'forbidden'], `Origin: ${origin}`)
  }
  const same = await req('POST', '/api/note', { path, text: m.aSentence() }, { origin: 'http://localhost' })
  assert.equal(same.status, 201)
})

test('ftsQuery: quoted terms and a prefix on the last one', () => {
  assert.equal(ftsQuery('café con leche'), '"café" "con" "leche"*')
  assert.equal(ftsQuery('" OR *'), '"OR"*')
  assert.equal(ftsQuery('   '), null)
})

test('state.db: migrations, a copy before migrating, and rejecting future versions', () => {
  const dir = tempDir('vihko-state-')
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
  r.exec('drop table pins; drop table notices; drop table recovery_codes; drop table two_factor; drop table user_links; drop table group_members; drop table user_groups; drop table oauth_tokens; drop table oauth_codes; drop table oauth_clients; drop table api_keys; drop table settings; drop table profiles; drop table sessions; drop table users')
  r.pragma('user_version = 0')
  r.close()
  openState(old).close()
  assert.ok(!existsSync(old + '.bak-v0'), "an empty database (v0) doesn't need a copy")
})
