import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES } from '@thoth/server'
import { PNG, setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** SQLite's `collate nocase` order, which thoth lists usernames in: ASCII letters folded, then bytes. */
const nocase = (a: string, b: string) => Buffer.compare(Buffer.from(a.replace(/[A-Z]/g, (c) => c.toLowerCase())), Buffer.from(b.replace(/[A-Z]/g, (c) => c.toLowerCase())))
/** A session cookie nobody was given. */
const NO_SESSION = `thoth_session=${m.aSecret(43)}`

/** The folder keys are limited to, a note in it; another folder and a note there. */
const DIR = m.aFolder()
const PLAN = m.aNotePath(DIR)
const OUT_DIR = m.aFolder()
const OUTSIDE = m.aNotePath(OUT_DIR)
const FILES = {
  [PLAN]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`,
  [OUTSIDE]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`,
}

test('switched off (the default), a key reaches nothing: 404 everywhere, as a route that doesn\'t exist; the UI is unchanged', async () => {
  const h = await setup({ files: FILES })
  try {
    const { token } = await h.newKey({ name: m.aKeyName() })
    const key = h.withKey(token)
    for (const [method, p] of [['GET', `/api/note?path=${encodeURIComponent(PLAN)}`], ['GET', '/api/tree'], ['GET', '/api/health'], ['POST', '/api/auth/login'], ['GET', '/api/no-such-route'], ['GET', '/api/keys']]) {
      const r = await key(method!, p!)
      assert.deepEqual([r.status, r.body?.error], [404, 'not_found'], `${method} ${p}`)
    }
    // Not even a valid cookie gets a request with a key through.
    const both = await key('GET', '/api/tree', undefined, { cookie: h.cookies.admin })
    assert.equal(both.status, 404)
    // From another origin too: off, there is nothing there (not even a CSRF 403).
    assert.equal((await key('POST', '/api/note', { path: m.aNotePath(), text: m.aSentence() }, { origin: 'https://elsewhere.example' })).status, 404)
    assert.equal((await h.admin('GET', '/api/tree')).status, 200, 'the cookie still works without a key')
    assert.equal((await h.admin('GET', '/api/health')).status, 200)
  } finally { await h.close() }
})

test('switched on: only the listed routes, by the key alone; a bad key is 401, a read-only key can\'t write', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const { key: info, token } = await h.newKey({ name: m.aKeyName() })
    const key = h.withKey(token)
    const note = await key('GET', h.url('/api/note', { path: PLAN }))
    assert.equal(note.status, 200)
    assert.equal(note.headers.get('etag'), `"${note.body.etag}"`)
    // Session routes don't exist for a key: administration, profile, keys, switches, alerts, trash, folders…
    for (const r of Object.entries(ROUTES).filter(([, c]) => c === 'session' || c === 'public')) {
      const [method, p] = r[0].split(' ') as [string, string]
      const res = await key(method, p.replace(':id', 'x'), method === 'GET' ? undefined : {})
      assert.deepEqual([res.status, res.body?.error], [404, 'not_found'], r[0])
    }
    assert.equal((await key('GET', '/api/no-such-route')).status, 404)
    // Bad keys: 401, and never the cookie instead.
    const cookie = { cookie: NO_SESSION }
    for (const bad of ['', m.aSecret(12), token.slice(0, -2) + 'xx', `${token}x`]) {
      const r = await h.withKey(bad)('GET', '/api/tree', undefined, cookie)
      assert.deepEqual([r.status, r.body?.error], [401, 'unauthorized'], bad)
    }
    // Read-only by default: 403 on a write route (never about a note).
    const w = await key('POST', '/api/note', { path: m.aNotePath(DIR), text: m.aSentence() })
    assert.deepEqual([w.status, w.body?.error], [403, 'forbidden'])
    // Revoked: 401 from then on.
    assert.equal((await h.admin('DELETE', `/api/keys/${info.id}`)).status, 200)
    assert.equal((await key('GET', '/api/tree')).status, 401)
    // Switched off again: 404.
    const { token: t2 } = await h.newKey({ name: m.aKeyName() })
    await h.admin('PUT', '/api/admin/integrations', { api: false })
    assert.equal((await h.withKey(t2)('GET', '/api/tree')).status, 404)
  } finally { await h.close() }
})

test('THOTH_INTEGRATIONS=off: keys get 404 whatever state.db says, and the switches can\'t be turned on', async () => {
  const h = await setup({ files: FILES, locked: true })
  try {
    h.integrations.set({ api: false })
    const view = await h.admin('GET', '/api/integrations')
    assert.deepEqual(view.body, { api: false, mcp: false, membersCanCreateKeys: true, oauthRegistration: true, locked: true, canCreateKeys: true, publicUrl: null })
    const on = await h.admin('PUT', '/api/admin/integrations', { api: true })
    assert.deepEqual([on.status, on.body.error], [409, 'integrations_locked'])
    const { token } = await h.newKey({ name: m.aKeyName() })
    assert.equal((await h.withKey(token)('GET', '/api/tree')).status, 404)
  } finally { await h.close() }
})

test('keys over the UI: created once with their token, listed without it, changed and revoked by their owner; the admin sees and revokes all', async () => {
  const h = await setup({ files: FILES })
  try {
    const name = m.aKeyName()
    const created = await h.admin('POST', '/api/keys', { confirm: h.users.admin.password, name, canWrite: true, folders: [DIR], expiresAt: '2027-01-01T00:00:00Z' })
    assert.equal(created.status, 201)
    const { key, token } = created.body
    assert.match(token, /^thoth_[0-9A-Z]{26}_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual([key.name, key.canWrite, key.folders, key.expiresAt, key.status, key.last4], [name, true, [DIR], '2027-01-01T00:00:00.000Z', 'active', token.slice(-4)])
    const list = await h.admin('GET', '/api/keys')
    assert.deepEqual(list.body.keys.map((k: any) => k.id), [key.id])
    assert.ok(!list.text.includes(token.slice(33)), 'the token is shown once')
    assert.deepEqual((await h.admin('POST', '/api/keys', { confirm: h.users.admin.password, name: '' })).body.error, 'invalid')
    assert.deepEqual((await h.admin('POST', '/api/keys', { confirm: h.users.admin.password, name: m.aKeyName(), folders: [`../${OUT_DIR}`] })).body.error, 'invalid_path')
    const renamed = m.aKeyName()
    const changed = await h.admin('PATCH', `/api/keys/${key.id}`, { name: renamed, canWrite: false, folders: [] })
    assert.deepEqual([changed.body.key.name, changed.body.key.canWrite, changed.body.key.folders], [renamed, false, []])

    // The member's keys are theirs: the admin sees them with ?all=1 and may revoke, not change them.
    const botName = m.aKeyName()
    const theirs = (await h.member('POST', '/api/keys', { confirm: h.users.member.password, name: botName })).body.key
    assert.deepEqual((await h.member('GET', '/api/keys')).body.keys.map((k: any) => k.name), [botName])
    assert.equal((await h.member('GET', '/api/keys?all=1')).status, 403)
    const everyone = [[h.users.member.username, botName], [h.users.admin.username, renamed]].sort(([x], [y]) => nocase(x!, y!))
    assert.deepEqual((await h.admin('GET', '/api/keys?all=1')).body.keys.map((k: any) => [k.user.username, k.name]), everyone)
    assert.equal((await h.admin('PATCH', `/api/keys/${theirs.id}`, { name: m.aKeyName() })).status, 404)
    assert.equal((await h.member('PATCH', `/api/keys/${key.id}`, { name: m.aKeyName() })).status, 404)
    assert.equal((await h.member('DELETE', `/api/keys/${key.id}`)).status, 404)
    assert.equal((await h.admin('DELETE', `/api/keys/${theirs.id}`)).body.key.status, 'revoked')

    // «Members can create keys» off: the member can't create or change theirs; they still list and revoke them.
    const mine = (await h.member('POST', '/api/keys', { confirm: h.users.member.password, name: m.aKeyName() })).body.key
    assert.equal((await h.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: false })).body.membersCanCreateKeys, false)
    assert.equal((await h.member('GET', '/api/integrations')).body.canCreateKeys, false)
    assert.deepEqual([(await h.member('POST', '/api/keys', { confirm: h.users.member.password, name: m.aKeyName() })).status, (await h.member('PATCH', `/api/keys/${mine.id}`, { name: m.aKeyName() })).status], [403, 403])
    assert.equal((await h.member('GET', '/api/keys')).body.keys.length, 2)
    assert.equal((await h.member('DELETE', `/api/keys/${mine.id}`)).status, 200)
    assert.equal((await h.admin('POST', '/api/keys', { confirm: h.users.admin.password, name: m.aKeyName() })).status, 201)
    // Only the admin touches the switches.
    assert.equal((await h.member('PUT', '/api/admin/integrations', { api: true })).status, 403)
    assert.equal((await h.admin('PUT', '/api/admin/integrations', { api: 'yes' })).body.error, 'invalid')
  } finally { await h.close() }
})

test('rotating a key over the UI: its owner only, a new token once, both working meanwhile; never a key, never an OAuth authorization', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const name = m.aKeyName()
    const { key, token } = await h.newKey({ name, canWrite: true })
    const r = await h.admin('POST', `/api/keys/${key.id}/rotate`, { confirm: h.users.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.match(r.body.token, /^thoth_[0-9A-Z]{26}_[A-Za-z0-9_-]{43}$/)
    assert.notEqual(r.body.token, token)
    assert.deepEqual([r.body.key.id, r.body.key.name, r.body.key.last4, typeof r.body.key.previousUntil], [key.id, name, r.body.token.slice(-4), 'string'])
    assert.ok(!(await h.admin('GET', '/api/keys')).text.includes(r.body.token.slice(33)), 'the new token is shown once')
    // Both keys work while the old one's grace lasts (the grace itself: keys.test.ts).
    for (const t of [token, r.body.token]) assert.equal((await h.withKey(t)('GET', '/api/tree')).status, 200)
    // Someone else's key: not theirs to rotate, admin or not; a key can't rotate itself.
    const theirs = (await h.newKey({ name: m.aKeyName() }, 'member')).key
    assert.equal((await h.admin('POST', `/api/keys/${theirs.id}/rotate`)).status, 404)
    assert.equal((await h.member('POST', `/api/keys/${key.id}/rotate`)).status, 404)
    assert.equal((await h.withKey(r.body.token)('POST', `/api/keys/${key.id}/rotate`)).status, 404)
    // A member while members may not create keys: no.
    await h.admin('PUT', '/api/admin/integrations', { membersCanCreateKeys: false })
    assert.equal((await h.member('POST', `/api/keys/${theirs.id}/rotate`)).status, 403)
    // Revoked: invalid.
    await h.admin('DELETE', `/api/keys/${key.id}`)
    assert.deepEqual([(await h.admin('POST', `/api/keys/${key.id}/rotate`)).status, (await h.withKey(token)('GET', '/api/tree')).status], [400, 401])
  } finally { await h.close() }
})

test('writing with a key: If-Match (412 with the current ETag), If-None-Match: *, edits that need the ETag, dry runs; the history says who, for whom and how', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const name = m.aKeyName()
    const { key: info, token } = await h.newKey({ name, canWrite: true, folders: [DIR] })
    const key = h.withKey(token)
    const path = PLAN
    const at = h.url('/api/note', { path })
    const cur = (await key('GET', at)).body
    // A line to replace one word of: the word (only this line has it) becomes a number, which shares no character with it.
    const [word, number] = [m.aUniqueWord(), String(m.anInt(2, 999))]
    const line = `${m.aWord()} ${word}.`

    assert.deepEqual((await key('PUT', at, { text: m.aSentence() })).body.error, 'precondition_required')
    const stale = await key('PUT', at, { text: m.aSentence() }, { 'if-match': '"sha256:old"' })
    assert.deepEqual([stale.status, stale.body.error, stale.body.etag, stale.headers.get('etag')], [412, 'precondition_failed', cur.etag, `"${cur.etag}"`])
    const put = await key('PUT', at, { text: cur.text + `${line}\n` }, { 'if-match': `"${cur.etag}"` })
    assert.equal(put.status, 200)

    const [newPath, firstTitle] = [m.aNotePath(DIR), m.aTitle()]
    const fresh = h.url('/api/note', { path: newPath })
    const created = await key('PUT', fresh, { text: `# ${firstTitle}\n` }, { 'if-none-match': '*' })
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('etag'), `"${created.body.etag}"`)
    const again = await key('PUT', fresh, { text: `# ${m.aTitle()}\n` }, { 'if-none-match': '*' })
    assert.deepEqual([again.status, again.body.error], [412, 'precondition_failed'])
    assert.ok(readFileSync(join(h.notesDir, newPath), 'utf8').includes(`# ${firstTitle}\n`), 'the first text stays')

    // Substitutions need the ETag; appends don't. dry_run writes nothing.
    const now = (await key('GET', at)).body
    const replace = { path, ops: [{ op: 'find_replace', find: line, replace: line.replace(word, number) }] }
    assert.deepEqual((await key('POST', '/api/note/edit', replace)).body.error, 'precondition_required')
    const dry = await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag, dryRun: true })
    assert.deepEqual(dry.body, { dryRun: true, etag: now.etag, changes: [{ at: now.text.indexOf(`${word}.`), removed: word, inserted: number }] })
    assert.equal((await key('GET', at)).body.etag, now.etag, 'a dry run writes nothing')
    const done = await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag })
    assert.equal(done.status, 200)
    assert.equal((await key('POST', '/api/note/edit', { path, ops: [{ op: 'append', text: `${m.aSentence()}\n` }] })).status, 200)
    assert.equal((await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag })).status, 412)
    // Outside its folders: where there's no note, nothing; a note it names, denied with the reason.
    assert.equal((await key('POST', '/api/note', { path: m.aNotePath(OUT_DIR), text: m.aSentence() })).status, 404)
    const outside = await key('GET', h.url('/api/note', { path: OUTSIDE }))
    assert.deepEqual([outside.status, outside.body.error, outside.body.reason], [403, 'agent_denied', 'outside_key_folders'])

    await h.settle()
    const versions = (await h.admin('GET', h.url('/api/history/versions', { path }))).body.versions
    const agent = versions[0].authors[0]
    assert.deepEqual(agent, { kind: 'agent', id: info.id, name, onBehalfOf: { id: h.users.admin.id, name: h.users.admin.username }, via: 'api', key: `agent:${info.id}` })
    // As the key sees it too.
    assert.deepEqual((await key('GET', h.url('/api/history/versions', { path }))).body.versions[0].authors[0], agent)
  } finally { await h.close() }
})

test('every /api route is classified for keys, and the registry names no route that doesn\'t exist', async () => {
  const h = await setup({ files: FILES })
  try {
    const routes = new Set<string>()
    for (const r of h.app.routes) {
      if (r.method === 'ALL' || !r.path.startsWith('/api/')) continue
      routes.add(`${r.method} ${r.path}`)
    }
    const unclassified = [...routes].filter((r) => !(r in ROUTES))
    assert.deepEqual(unclassified, [], 'a new route must be classified in http/routes.ts')
    const missing = Object.keys(ROUTES).filter((r) => !routes.has(r))
    assert.deepEqual(missing, [])
  } finally { await h.close() }
})

test('images: an agent stores them next to its notes, never outside its folders', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const { token } = await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })
    const key = h.withKey(token)
    const png = new Uint8Array(PNG)
    const ok = await key('POST', h.url('/api/attachments', { note: PLAN }), png)
    assert.equal(ok.status, 201, ok.text)
    assert.ok(ok.body.path.startsWith(`${DIR}/`), ok.body.path)
    assert.equal((await key('GET', h.url('/api/file', { path: ok.body.path }))).status, 404, 'no note uses it yet')
    // thoth.yaml sends images to a folder the key doesn't reach: refused, and it's the key's limit (403).
    const images = m.aUniqueWord()
    writeFileSync(join(h.notesDir, 'thoth.yaml'), `attachments:\n  folder: ${images}\n`)
    h.workspace.reload()
    const out = await key('POST', h.url('/api/attachments', { note: PLAN }), png)
    assert.deepEqual([out.status, out.body.error], [403, 'forbidden'])
    assert.ok(!out.text.includes(images))
  } finally { await h.close() }
})

test('an alert while the API or MCP is on and the history is not managed: what agents write has no version of its own', async () => {
  const h = await setup({ files: FILES, config: 'history:\n  mode: off\n' })
  try {
    const ours = async () => ((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a) => a.code === 'integrations_unversioned')
    assert.deepEqual(await ours(), [], 'off: nothing to warn about')
    await h.admin('PUT', '/api/admin/integrations', { mcp: true })
    assert.deepEqual(await ours(), [{ code: 'integrations_unversioned', mode: 'off', api: false, mcp: true, actions: [] }])
    await h.enableApi()
    assert.deepEqual(await ours(), [{ code: 'integrations_unversioned', mode: 'off', api: true, mcp: true, actions: [] }])
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'history:\n  mode: managed\n')
    h.workspace.reload()
    assert.deepEqual(await ours(), [], 'managed: every agent write is a version')
  } finally { await h.close() }
})

test('restoring and reverting with a key: as the agent on its user\'s behalf, with how it came; a read-only key can\'t', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const name = m.aKeyName()
    const { key: info, token } = await h.newKey({ name, canWrite: true, folders: [DIR] })
    const key = h.withKey(token)
    const path = PLAN
    const at = h.url('/api/note', { path })
    // A line of the admin's, and the agent's change to it (with a word only it has).
    const [line, byTheAgent] = [m.aSentence(), m.aUniqueWord()]
    const put = async (text: (t: string) => string, who = h.admin) => {
      const cur = (await who('GET', at)).body
      const r = await who('PUT', at, { text: text(cur.text) }, { 'if-match': `"${cur.etag}"` })
      assert.equal(r.status, 200, r.text)
      await h.settle()
    }
    await put((t) => t + `${line}\n`)
    await put((t) => t.replace(line, `${line} ${byTheAgent}.`), key)
    const versions = async () => (await h.admin('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string; authors: { kind: string; via?: string; name: string }[]; reason: { code: string } | null }[]
    const byAgent = (await versions())[0]!
    assert.equal(byAgent.authors[0]!.kind, 'agent')

    // Revert the agent's own change, as the agent.
    const reverted = await key('POST', '/api/history/revert', { path, id: byAgent.id })
    assert.equal(reverted.status, 200, reverted.text)
    assert.ok(!(await key('GET', at)).body.text.includes(byTheAgent))
    await h.settle()
    const rv = (await versions())[0]!
    assert.deepEqual([rv.reason?.code, rv.authors[0]!.kind, rv.authors[0]!.name, rv.authors[0]!.via], ['reverted', 'agent', name, 'api'])

    // Restore the first version, as the agent.
    const first = (await versions()).at(-1)!
    const restored = await key('POST', '/api/history/restore', { path, id: first.id })
    assert.equal(restored.status, 200, restored.text)
    await h.settle()
    const rs = (await versions())[0]!
    assert.deepEqual([rs.reason?.code, rs.authors[0]!.kind, rs.authors[0]!.via], ['restored', 'agent', 'api'])
    assert.equal((await h.admin('GET', h.url('/api/history/versions', { path }))).body.versions[0].authors[0].id, info.id)

    // A read-only key: 403 on both (the key's limit), and nothing written.
    const { token: ro } = await h.newKey({ name: m.aKeyName(), folders: [DIR] })
    const etag = (await key('GET', at)).body.etag
    for (const route of ['/api/history/revert', '/api/history/restore']) {
      const r = await h.withKey(ro)('POST', route, { path, id: first.id })
      assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], route)
    }
    assert.equal((await key('GET', at)).body.etag, etag)
    // Outside the key's folders: denied, with the reason.
    const outside = await key('POST', '/api/history/revert', { path: OUTSIDE, id: first.id })
    assert.deepEqual([outside.status, outside.body.error, outside.body.reason], [403, 'agent_denied', 'outside_key_folders'])
  } finally { await h.close() }
})
