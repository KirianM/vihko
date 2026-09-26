import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES } from '@thoth/server'
import { PNG, setup } from './_agents.ts'

const FILES = {
  'proyectos/plan.md': '# Plan\n\nPaso uno.\n',
  'otros/nota.md': '# Otra nota\n\nTexto.\n',
}

test('switched off (the default), a key reaches nothing: 404 everywhere, as a route that doesn\'t exist; the UI is unchanged', async () => {
  const h = await setup({ files: FILES })
  try {
    const { token } = await h.newKey({ name: 'Claude Code' })
    const key = h.withKey(token)
    for (const [m, p] of [['GET', '/api/note?path=proyectos/plan.md'], ['GET', '/api/tree'], ['GET', '/api/health'], ['POST', '/api/auth/login'], ['GET', '/api/no-such-route'], ['GET', '/api/keys']]) {
      const r = await key(m!, p!)
      assert.deepEqual([r.status, r.body?.error], [404, 'not_found'], `${m} ${p}`)
    }
    // Not even a valid cookie gets a request with a key through.
    const both = await key('GET', '/api/tree', undefined, { cookie: h.cookies.noa! })
    assert.equal(both.status, 404)
    // From another origin too: off, there is nothing there (not even a CSRF 403).
    assert.equal((await key('POST', '/api/note', { path: 'x.md', text: 'x' }, { origin: 'https://elsewhere.example' })).status, 404)
    assert.equal((await h.noa('GET', '/api/tree')).status, 200, 'the cookie still works without a key')
    assert.equal((await h.noa('GET', '/api/health')).status, 200)
  } finally { await h.close() }
})

test('switched on: only the listed routes, by the key alone; a bad key is 401, a read-only key can\'t write', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const { key: info, token } = await h.newKey({ name: 'Claude Code' })
    const key = h.withKey(token)
    const note = await key('GET', h.url('/api/note', { path: 'proyectos/plan.md' }))
    assert.equal(note.status, 200)
    assert.equal(note.headers.get('etag'), `"${note.body.etag}"`)
    // Session routes don't exist for a key: administration, profile, keys, switches, alerts, trash, folders…
    for (const r of Object.entries(ROUTES).filter(([, c]) => c === 'session' || c === 'public')) {
      const [m, p] = r[0].split(' ') as [string, string]
      const res = await key(m, p.replace(':id', 'x'), m === 'GET' ? undefined : {})
      assert.deepEqual([res.status, res.body?.error], [404, 'not_found'], r[0])
    }
    assert.equal((await key('GET', '/api/no-such-route')).status, 404)
    // Bad keys: 401, and never the cookie instead.
    const cookie = { cookie: `thoth_session=whatever` }
    for (const bad of ['', 'nope', token.slice(0, -2) + 'xx', `${token}x`]) {
      const r = await h.withKey(bad)('GET', '/api/tree', undefined, cookie)
      assert.deepEqual([r.status, r.body?.error], [401, 'unauthorized'], bad)
    }
    // Read-only by default: 403 on a write route (never about a note).
    const w = await key('POST', '/api/note', { path: 'proyectos/nueva.md', text: 'x' })
    assert.deepEqual([w.status, w.body?.error], [403, 'forbidden'])
    // Revoked: 401 from then on.
    assert.equal((await h.noa('DELETE', `/api/keys/${info.id}`)).status, 200)
    assert.equal((await key('GET', '/api/tree')).status, 401)
    // Switched off again: 404.
    const { token: t2 } = await h.newKey({ name: 'otra' })
    await h.noa('PUT', '/api/admin/integrations', { api: false })
    assert.equal((await h.withKey(t2)('GET', '/api/tree')).status, 404)
  } finally { await h.close() }
})

test('THOTH_INTEGRATIONS=off: keys get 404 whatever state.db says, and the switches can\'t be turned on', async () => {
  const h = await setup({ files: FILES, locked: true })
  try {
    h.integrations.set({ api: false })
    const view = await h.noa('GET', '/api/integrations')
    assert.deepEqual(view.body, { api: false, mcp: false, membersCanCreateKeys: true, locked: true, canCreateKeys: true })
    const on = await h.noa('PUT', '/api/admin/integrations', { api: true })
    assert.deepEqual([on.status, on.body.error], [409, 'integrations_locked'])
    const { token } = await h.newKey({ name: 'x' })
    assert.equal((await h.withKey(token)('GET', '/api/tree')).status, 404)
  } finally { await h.close() }
})

test('keys over the UI: created once with their token, listed without it, changed and revoked by their owner; the admin sees and revokes all', async () => {
  const h = await setup({ files: FILES })
  try {
    const created = await h.noa('POST', '/api/keys', { name: 'Claude Code', canWrite: true, folders: ['proyectos'], expiresAt: '2027-01-01T00:00:00Z' })
    assert.equal(created.status, 201)
    const { key, token } = created.body
    assert.match(token, /^thoth_[0-9A-Z]{26}_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual([key.name, key.canWrite, key.folders, key.expiresAt, key.status, key.last4], ['Claude Code', true, ['proyectos'], '2027-01-01T00:00:00.000Z', 'active', token.slice(-4)])
    const list = await h.noa('GET', '/api/keys')
    assert.deepEqual(list.body.keys.map((k: any) => k.id), [key.id])
    assert.ok(!list.text.includes(token.slice(33)), 'the token is shown once')
    assert.deepEqual((await h.noa('POST', '/api/keys', { name: '' })).body.error, 'invalid')
    assert.deepEqual((await h.noa('POST', '/api/keys', { name: 'x', folders: ['../fuera'] })).body.error, 'invalid_path')
    const changed = await h.noa('PATCH', `/api/keys/${key.id}`, { name: 'Claude', canWrite: false, folders: [] })
    assert.deepEqual([changed.body.key.name, changed.body.key.canWrite, changed.body.key.folders], ['Claude', false, []])

    // Ana's keys are hers: noa (admin) sees them with ?all=1 and may revoke, not change them.
    const anas = (await h.ana('POST', '/api/keys', { name: 'Ana bot' })).body.key
    assert.deepEqual((await h.ana('GET', '/api/keys')).body.keys.map((k: any) => k.name), ['Ana bot'])
    assert.equal((await h.ana('GET', '/api/keys?all=1')).status, 403)
    assert.deepEqual((await h.noa('GET', '/api/keys?all=1')).body.keys.map((k: any) => [k.user.username, k.name]), [['ana', 'Ana bot'], ['noa', 'Claude']])
    assert.equal((await h.noa('PATCH', `/api/keys/${anas.id}`, { name: 'mine' })).status, 404)
    assert.equal((await h.ana('PATCH', `/api/keys/${key.id}`, { name: 'mine' })).status, 404)
    assert.equal((await h.ana('DELETE', `/api/keys/${key.id}`)).status, 404)
    assert.equal((await h.noa('DELETE', `/api/keys/${anas.id}`)).body.key.status, 'revoked')

    // «Members can create keys» off: ana can't create or change hers; she still lists and revokes them.
    const mine = (await h.ana('POST', '/api/keys', { name: 'second' })).body.key
    assert.equal((await h.noa('PUT', '/api/admin/integrations', { membersCanCreateKeys: false })).body.membersCanCreateKeys, false)
    assert.equal((await h.ana('GET', '/api/integrations')).body.canCreateKeys, false)
    assert.deepEqual([(await h.ana('POST', '/api/keys', { name: 'third' })).status, (await h.ana('PATCH', `/api/keys/${mine.id}`, { name: 'x' })).status], [403, 403])
    assert.equal((await h.ana('GET', '/api/keys')).body.keys.length, 2)
    assert.equal((await h.ana('DELETE', `/api/keys/${mine.id}`)).status, 200)
    assert.equal((await h.noa('POST', '/api/keys', { name: 'admin can' })).status, 201)
    // Only the admin touches the switches.
    assert.equal((await h.ana('PUT', '/api/admin/integrations', { api: true })).status, 403)
    assert.equal((await h.noa('PUT', '/api/admin/integrations', { api: 'yes' })).body.error, 'invalid')
  } finally { await h.close() }
})

test('writing with a key: If-Match (412 with the current ETag), If-None-Match: *, edits that need the ETag, dry runs; the history says who, for whom and how', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const { key: info, token } = await h.newKey({ name: 'Claude Code', canWrite: true, folders: ['proyectos'] })
    const key = h.withKey(token)
    const path = 'proyectos/plan.md'
    const at = h.url('/api/note', { path })
    const cur = (await key('GET', at)).body

    assert.deepEqual((await key('PUT', at, { text: 'x' })).body.error, 'precondition_required')
    const stale = await key('PUT', at, { text: 'x' }, { 'if-match': '"sha256:old"' })
    assert.deepEqual([stale.status, stale.body.error, stale.body.etag, stale.headers.get('etag')], [412, 'precondition_failed', cur.etag, `"${cur.etag}"`])
    const put = await key('PUT', at, { text: cur.text + 'Paso dos.\n' }, { 'if-match': `"${cur.etag}"` })
    assert.equal(put.status, 200)

    const fresh = h.url('/api/note', { path: 'proyectos/nueva.md' })
    const created = await key('PUT', fresh, { text: '# Nueva\n' }, { 'if-none-match': '*' })
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('etag'), `"${created.body.etag}"`)
    const again = await key('PUT', fresh, { text: '# Otra\n' }, { 'if-none-match': '*' })
    assert.deepEqual([again.status, again.body.error], [412, 'precondition_failed'])
    assert.match(readFileSync(join(h.notesDir, 'proyectos/nueva.md'), 'utf8'), /# Nueva/)

    // Substitutions need the ETag; appends don't. dry_run writes nothing.
    const now = (await key('GET', at)).body
    const replace = { path, ops: [{ op: 'find_replace', find: 'Paso dos.', replace: 'Paso 2.' }] }
    assert.deepEqual((await key('POST', '/api/note/edit', replace)).body.error, 'precondition_required')
    const dry = await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag, dryRun: true })
    assert.deepEqual(dry.body, { dryRun: true, etag: now.etag, changes: [{ at: now.text.indexOf('dos.'), removed: 'dos', inserted: '2' }] })
    assert.equal((await key('GET', at)).body.etag, now.etag, 'a dry run writes nothing')
    const done = await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag })
    assert.equal(done.status, 200)
    assert.equal((await key('POST', '/api/note/edit', { path, ops: [{ op: 'append', text: 'Tres.\n' }] })).status, 200)
    assert.equal((await key('POST', '/api/note/edit', { ...replace, ifMatch: now.etag })).status, 412)
    // Outside its folders: where there's no note, nothing; a note it names, denied with the reason.
    assert.equal((await key('POST', '/api/note', { path: 'otros/x.md', text: 'x' })).status, 404)
    const outside = await key('GET', h.url('/api/note', { path: 'otros/nota.md' }))
    assert.deepEqual([outside.status, outside.body.error, outside.body.reason], [403, 'agent_denied', 'outside_key_folders'])

    await h.settle()
    const versions = (await h.noa('GET', h.url('/api/history/versions', { path }))).body.versions
    const agent = versions[0].authors[0]
    assert.deepEqual(agent, { kind: 'agent', id: info.id, name: 'Claude Code', onBehalfOf: { id: h.users.noa.id, name: 'noa' }, via: 'api', key: `agent:${info.id}` })
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
    const { token } = await h.newKey({ name: 'x', canWrite: true, folders: ['proyectos'] })
    const key = h.withKey(token)
    const png = new Uint8Array(PNG)
    const ok = await key('POST', h.url('/api/attachments', { note: 'proyectos/plan.md' }), png)
    assert.equal(ok.status, 201, ok.text)
    assert.match(ok.body.path, /^proyectos\//)
    assert.equal((await key('GET', h.url('/api/file', { path: ok.body.path }))).status, 404, 'no note uses it yet')
    // thoth.yaml sends images to a folder the key doesn't reach: refused, and it's the key's limit (403).
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'attachments:\n  folder: Adjuntos\n')
    h.workspace.reload()
    const out = await key('POST', h.url('/api/attachments', { note: 'proyectos/plan.md' }), png)
    assert.deepEqual([out.status, out.body.error], [403, 'forbidden'])
    assert.ok(!out.text.includes('Adjuntos'))
  } finally { await h.close() }
})

test('an alert while the API or MCP is on and the history is not managed: what agents write has no version of its own', async () => {
  const h = await setup({ files: FILES, config: 'history:\n  mode: off\n' })
  try {
    const ours = async () => ((await h.ana('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a) => a.code === 'integrations_unversioned')
    assert.deepEqual(await ours(), [], 'off: nothing to warn about')
    await h.noa('PUT', '/api/admin/integrations', { mcp: true })
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
    const { key: info, token } = await h.newKey({ name: 'Claude Code', canWrite: true, folders: ['proyectos'] })
    const key = h.withKey(token)
    const path = 'proyectos/plan.md'
    const at = h.url('/api/note', { path })
    const put = async (text: (t: string) => string, who = h.noa) => {
      const cur = (await who('GET', at)).body
      const r = await who('PUT', at, { text: text(cur.text) }, { 'if-match': `"${cur.etag}"` })
      assert.equal(r.status, 200, r.text)
      await h.settle()
    }
    await put((t) => t + 'Paso dos.\n')
    await put((t) => t.replace('Paso dos.', 'Paso dos, del agente.'), key)
    const versions = async () => (await h.noa('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string; authors: { kind: string; via?: string; name: string }[]; reason: { code: string } | null }[]
    const byAgent = (await versions())[0]!
    assert.equal(byAgent.authors[0]!.kind, 'agent')

    // Revert the agent's own change, as the agent.
    const reverted = await key('POST', '/api/history/revert', { path, id: byAgent.id })
    assert.equal(reverted.status, 200, reverted.text)
    assert.doesNotMatch((await key('GET', at)).body.text, /del agente/)
    await h.settle()
    const rv = (await versions())[0]!
    assert.deepEqual([rv.reason?.code, rv.authors[0]!.kind, rv.authors[0]!.name, rv.authors[0]!.via], ['reverted', 'agent', 'Claude Code', 'api'])

    // Restore the first version, as the agent.
    const first = (await versions()).at(-1)!
    const restored = await key('POST', '/api/history/restore', { path, id: first.id })
    assert.equal(restored.status, 200, restored.text)
    await h.settle()
    const rs = (await versions())[0]!
    assert.deepEqual([rs.reason?.code, rs.authors[0]!.kind, rs.authors[0]!.via], ['restored', 'agent', 'api'])
    assert.equal((await h.noa('GET', h.url('/api/history/versions', { path }))).body.versions[0].authors[0].id, info.id)

    // A read-only key: 403 on both (the key's limit), and nothing written.
    const { token: ro } = await h.newKey({ name: 'solo lectura', folders: ['proyectos'] })
    const etag = (await key('GET', at)).body.etag
    for (const route of ['/api/history/revert', '/api/history/restore']) {
      const r = await h.withKey(ro)('POST', route, { path, id: first.id })
      assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], route)
    }
    assert.equal((await key('GET', at)).body.etag, etag)
    // Outside the key's folders: denied, with the reason.
    const outside = await key('POST', '/api/history/revert', { path: 'otros/nota.md', id: first.id })
    assert.deepEqual([outside.status, outside.body.error, outside.body.reason], [403, 'agent_denied', 'outside_key_folders'])
  } finally { await h.close() }
})
