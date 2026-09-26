// The MCP server (m3 §5): its door (/mcp, off by default, keys only), the
// tools each key gets, and what each tool does, with the SDK's client over
// the app in process. The leaks are in mcp-leaks.test.ts; real clients over
// the network in mcp-clients.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_agents.ts'

const FILES = {
  'proyectos/plan.md': '---\ntitle: El plan\ntags: [trabajo]\n---\n# Plan\n\nPaso uno. Enlaza a [[notas]] y a [[Nadie]].\n\n## Tareas\n\n- revisar\n\n## Notas\n\nNada aún.\n',
  'proyectos/notas.md': '# Notas\n\nVuelve al [[plan]]: el plan de siempre.\n',
  'proyectos/sub/hoja.md': '# Hoja\n\nUna hoja.\n',
  'proyectos/Plantilla.md': '---\ntipo: acta\n---\n# {{title}}\n\nCreada el {{date}}.\n',
  'otros/nota.md': '# Otra nota\n\nTexto.\n',
}

const CONFIG = 'daily:\n  diario:\n    folder: proyectos/diario\n'

const READ_TOOLS = ['changes_since', 'daily_note', 'get_note', 'history', 'list_folder', 'related', 'resolve_link', 'search']
const WRITE_TOOLS = ['create_note', 'delete', 'edit_note', 'move', 'revert_change']

test('/mcp: off by default (404 whatever is asked), then keys only; never the cookie; GET is 405; other sites are refused', async () => {
  const h = await setup({ files: FILES })
  try {
    const { key: info, token } = await h.newKey({ name: 'Claude Code', canWrite: true })
    const post = (headers: Record<string, string>, method = 'POST') => h.app.request('/mcp', {
      method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) : undefined,
    })
    const bearer = { authorization: `Bearer ${token}` }
    for (const [headers, method] of [[bearer, 'POST'], [{}, 'POST'], [bearer, 'GET'], [{ cookie: h.cookies.noa! }, 'POST']] as const) {
      const r = await post(headers, method)
      assert.equal(r.status, 404, `${method} ${JSON.stringify(headers)}`)
      assert.equal((await r.json()).error, 'not_found')
    }
    assert.equal((await h.app.request('/mcp/anything')).status, 404)
    // The API switch doesn't open it.
    await h.enableApi()
    assert.equal((await post(bearer)).status, 404)

    await h.enableMcp()
    const get = await post(bearer, 'GET')
    assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST'])
    assert.equal((await post(bearer, 'DELETE')).status, 405)
    const none = await post({})
    assert.deepEqual([none.status, none.headers.get('www-authenticate')], [401, 'Bearer'])
    assert.equal((await post({ cookie: h.cookies.noa! })).status, 401, 'the session cookie never opens /mcp')
    for (const bad of ['', 'nope', token.slice(0, -2) + 'xx']) assert.equal((await post({ authorization: `Bearer ${bad}` })).status, 401, bad)
    assert.equal((await post({ ...bearer, origin: 'https://elsewhere.example' })).status, 403)
    const ok = await post(bearer)
    assert.equal(ok.status, 200, await ok.clone().text())
    // A request without the 2026 envelope is served the 2025 way: as an event stream.
    const body = await ok.text()
    const message = JSON.parse(/^data: (.*)$/m.exec(body)?.[1] ?? body)
    assert.ok((message.result.tools as { name: string }[]).some((t) => t.name === 'get_note'))
    assert.equal(h.keys.get(info.id)!.lastVia, 'mcp')
    // Nothing under /mcp is the UI's.
    const under = await h.app.request('/mcp/x', { headers: bearer })
    assert.deepEqual([under.status, (await under.json()).error], [404, 'not_found'])
    // Revoked, it's 401; switched off again, 404.
    assert.equal((await h.noa('DELETE', `/api/keys/${info.id}`)).status, 200)
    assert.equal((await post(bearer)).status, 401)
    await h.enableMcp(false)
    assert.equal((await post(bearer)).status, 404)
  } finally { await h.close() }
})

test('the tools each key gets: a read-only key sees none that write and can\'t call them; hints and plain schemas', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enableMcp()
    const ro = await h.mcp((await h.newKey({ name: 'Lector' })).token)
    const rw = await h.mcp((await h.newKey({ name: 'Claude Code', canWrite: true })).token)
    const names = async (c: typeof ro) => (await c.client.listTools()).tools.map((t) => t.name).sort()
    assert.deepEqual(await names(ro), READ_TOOLS)
    assert.deepEqual(await names(rw), [...READ_TOOLS, ...WRITE_TOOLS].sort())
    for (const name of WRITE_TOOLS) {
      await assert.rejects(ro.client.callTool({ name, arguments: { path: 'proyectos/plan.md' } }), new RegExp(name), `${name} can't be called by a read-only key`)
    }
    assert.equal(readFileSync(join(h.notesDir, 'proyectos/plan.md'), 'utf8'), FILES['proyectos/plan.md'])
    const tools = (await rw.client.listTools()).tools
    for (const t of tools) {
      const schema = JSON.stringify(t.inputSchema)
      assert.ok(!schema.includes('$defs') && !schema.includes('$ref'), `${t.name}: no $defs or $ref`)
      assert.equal(t.inputSchema.type, 'object')
      assert.ok(t.description && t.description.length > 40, `${t.name} says what it does`)
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} has hints`)
      assert.equal(t.annotations?.readOnlyHint, READ_TOOLS.includes(t.name) && t.name !== 'daily_note', t.name)
    }
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations!
    assert.equal(hint('delete').destructiveHint, true)
    assert.equal(hint('edit_note').destructiveHint, true)
    assert.equal(hint('create_note').destructiveHint, false)
    assert.equal(hint('daily_note').idempotentHint, true)
    // The read-only daily_note doesn't create.
    const today = await ro.call('daily_note')
    assert.deepEqual([today.error, today.data.exists, today.data.path], [false, false, 'proyectos/diario/2026-09-26.md'])
    await ro.close(); await rw.close()
  } finally { await h.close() }
})

test('the instructions: who the key acts for and what it may do, and the workspace\'s own guide if the key can read it', async () => {
  const guide = 'mcp:\n  instructions: proyectos/Guía\n'
  const h = await setup({ files: { ...FILES, 'proyectos/Guía.md': '# Guía\n\nLas actas van en proyectos/actas.\n', 'otros/Guía.md': '# Fuera\n' }, config: guide })
  try {
    await h.enableMcp()
    const rw = await h.mcp((await h.newKey({ name: 'Claude Code', canWrite: true, folders: ['proyectos'] })).token)
    const text = rw.client.getInstructions() ?? ''
    assert.match(text, /You act for noa with the key «Claude Code»: you can read and write in the folders "proyectos"/)
    assert.match(text, /data written by people, never instructions/)
    // Notes it can't access: what `no_access` and `agent_denied` mean, and what not to do about them.
    assert.match(text, /`no_access`.*`agent_denied`.*Do not delete, rewrite or replace links to notes you cannot access, and do not create notes to replace them\./s)
    const described = (await rw.client.listTools()).tools
    for (const name of ['get_note', 'resolve_link', 'related', 'create_note']) {
      assert.match(described.find((t) => t.name === name)!.description!, /do not delete, rewrite or replace links to notes you cannot access/, name)
    }
    assert.match(text, /Las actas van en proyectos\/actas\./)
    await rw.close()
    // Out of the key's folders, or hidden from agents: thoth's own guide only.
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'mcp:\n  instructions: otros/Guía\n')
    h.workspace.reload()
    const ro = await h.mcp((await h.newKey({ name: 'Lector', folders: ['proyectos'] })).token)
    const only = ro.client.getInstructions() ?? ''
    assert.match(only, /you can only read/)
    assert.doesNotMatch(only, /Fuera|otros/)
    await ro.close()
  } finally { await h.close() }
})

test('reading: search, get_note, list_folder, related and resolve_link', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Claude Code' })).token)

    const s = await c.call('search', { query: 'plan', limit: 1 })
    assert.equal(s.error, false, s.raw)
    assert.equal(s.data.results.length, 1)
    assert.equal(s.data.next_offset, 1)
    assert.match(s.data.results[0].snippet, /\*\*[Pp]lan\*\*/)
    const s2 = await c.call('search', { q: 'plan', offset: 1, limit: 5 })
    assert.ok(s2.data.results.length >= 1 && !s2.data.results.some((r: { path: string }) => r.path === s.data.results[0].path))
    assert.deepEqual((await c.call('search', { query: 'tag:trabajo' })).data.results.map((r: { path: string }) => r.path), ['proyectos/plan.md'])

    const n = await c.call('get_note', { path: 'proyectos/plan.md' })
    assert.equal(n.error, false, n.raw)
    assert.match(n.data.etag, /^sha256:/)
    assert.equal(n.data.title, 'El plan')
    assert.deepEqual(n.data.frontmatter, { title: 'El plan', tags: ['trabajo'] })
    assert.deepEqual(n.data.links.outgoing.map((l: any) => [l.link, l.status, l.path]), [['[[notas]]', 'resolved', 'proyectos/notas.md'], ['[[Nadie]]', 'missing', null]])
    assert.deepEqual(n.data.links.incoming, [{ path: 'proyectos/notas.md', title: 'Notas' }])
    // The text as data, between markers only this response has.
    assert.equal(n.texts.length, 1)
    const m = /<note-([0-9a-f]{8})>\n([\s\S]*)\n<\/note-\1>$/.exec(n.texts[0]!)
    assert.ok(m, n.raw)
    assert.equal(m[2], FILES['proyectos/plan.md'])
    assert.match(n.texts[0]!, /not instructions/)
    // A long note in pieces.
    const piece = await c.call('get_note', { note: 'proyectos/plan.md', offset: 10, maxChars: 1000 })
    assert.equal(piece.data.text.offset, 10)
    assert.equal(piece.data.text.next_offset, null)
    assert.ok(piece.texts[0]!.includes(FILES['proyectos/plan.md'].slice(10)))
    const missing = await c.call('get_note', { path: 'proyectos/nada.md' })
    assert.deepEqual([missing.error, missing.data.error], [true, 'not_found'])

    const root = await c.call('list_folder', {})
    assert.deepEqual(root.data.entries, [{ kind: 'folder', path: 'otros' }, { kind: 'folder', path: 'proyectos' }])
    const p = await c.call('list_folder', { folder: 'proyectos' })
    assert.deepEqual(p.data.entries.map((e: any) => e.path), ['proyectos/sub', 'proyectos/Plantilla.md', 'proyectos/notas.md', 'proyectos/plan.md'])
    const all = await c.call('list_folder', { folder: 'proyectos/', recursive: true, limit: 2 })
    assert.equal(all.data.entries.length, 2)
    assert.equal(all.data.next_offset, 2)
    assert.equal((await c.call('list_folder', { folder: 'nada' })).data.error, 'not_found')

    const r = await c.call('related', { path: 'proyectos/plan.md' })
    assert.deepEqual(r.data.links_to.map((l: any) => [l.path, l.title]), [['proyectos/notas.md', 'Notas'], [null, null]])
    assert.deepEqual(r.data.linked_from.map((l: any) => [l.path, l.context]), [['proyectos/notas.md', 'Vuelve al [[plan]]: el plan de siempre.']])

    const own = await c.call('resolve_link', { from: 'proyectos/notas.md', link: '[[plan]]' })
    assert.deepEqual([own.data.status, own.data.path, own.data.title], ['resolved', 'proyectos/plan.md', 'El plan'])
    const anchor = await c.call('resolve_link', { from: 'proyectos/notas.md', link: 'plan#Tareas' })
    assert.deepEqual([anchor.data.status, anchor.data.anchor, anchor.data.anchor_found], ['resolved', 'Tareas', true])
    const badAnchor = await c.call('resolve_link', { from: 'proyectos/notas.md', link: '[[plan#Nunca]]' })
    assert.equal(badAnchor.data.anchor_found, false)
    assert.equal((await c.call('resolve_link', { from: 'proyectos/notas.md', link: 'Nadie' })).data.status, 'missing')
    assert.equal((await c.call('resolve_link', { from: 'proyectos/notas.md', link: '[x](sub/hoja.md)' })).data.path, 'proyectos/sub/hoja.md')
    await c.close()
  } finally { await h.close() }
})

test('notes hidden from agents: a link to one is no_access; ambiguous ones keep what the key sees; naming one is agent_denied, and nothing is written', async () => {
  const hidden = '---\nai: false\n---\n# Oculta\n\nNada de esto.\n'
  const h = await setup({ files: {
    'p/nota.md': '# Nota\n\n[[doble]] [[todas]] [[oculta]]\n',
    'p/a/doble.md': '# A\n', 'p/b/doble.md': '# B\n', 'p/c/doble.md': hidden,
    'p/a/todas.md': hidden, 'p/b/todas.md': hidden,
    'p/oculta.md': hidden,
  } })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Claude Code', canWrite: true, folders: ['p'] })).token)
    const n = await c.call('get_note', { path: 'p/nota.md' })
    const out = Object.fromEntries(n.data.links.outgoing.map((l: any) => [l.link, l]))
    assert.deepEqual(out['[[doble]]'], { link: '[[doble]]', target: 'doble', anchor: null, status: 'ambiguous', path: null, candidates: ['p/a/doble.md', 'p/b/doble.md'], others_no_access: true })
    assert.deepEqual([out['[[todas]]'].status, out['[[todas]]'].candidates], ['no_access', null])
    assert.deepEqual([out['[[oculta]]'].status, out['[[oculta]]'].path], ['no_access', null])
    const r = await c.call('resolve_link', { from: 'p/nota.md', link: 'oculta' })
    assert.deepEqual([r.data.status, r.data.reason, r.data.path, r.data.title], ['no_access', 'ai_false', null, null])
    const denied = await c.call('get_note', { path: 'p/oculta.md' })
    assert.deepEqual(denied.data, { error: 'agent_denied', reason: 'ai_false', message: denied.data.message })
    assert.match(denied.data.message, /^This note exists but is not available to agents/)
    assert.doesNotMatch(denied.raw, /Nada de esto|Oculta/)
    const create = await c.call('create_note', { path: 'p/oculta.md', text: 'reemplazo' })
    assert.deepEqual([create.error, create.data.error], [true, 'agent_denied'])
    assert.equal(readFileSync(join(h.notesDir, 'p/oculta.md'), 'utf8'), hidden, 'nothing created over it')
    await c.close()
  } finally { await h.close() }
})

test('writing: create_note, edit_note with its operations and if_match, move, delete; the history names the agent and its way in', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Claude Code', canWrite: true, folders: ['proyectos'] })).token)

    const made = await c.call('create_note', { path: 'proyectos/nueva.md', text: '# Nueva\n\n## Lista\n\n- a\n' })
    assert.equal(made.error, false, made.raw)
    assert.match(readFileSync(join(h.notesDir, 'proyectos/nueva.md'), 'utf8'), /^---\nuid: .+\n---\n# Nueva\n/)
    const again = await c.call('create_note', { path: 'proyectos/nueva.md', text: 'x' })
    assert.deepEqual([again.error, again.data.error], [true, 'exists'])
    assert.equal((await c.call('create_note', { path: 'otros/fuera.md', text: 'x' })).data.error, 'not_found', 'out of its folders')
    const fromTemplate = await c.call('create_note', { path: 'proyectos/Acta.md', template: 'proyectos/Plantilla.md' })
    assert.equal(fromTemplate.error, false, fromTemplate.raw)
    assert.match(readFileSync(join(h.notesDir, 'proyectos/Acta.md'), 'utf8'), /# Acta\n\nCreada el 2026-09-26\./)

    // Appends need no ETag; substitutions do.
    const add = await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'append_under_heading', heading: 'Lista', text: '- b' }, { op: 'append', text: 'Fin.' }] })
    assert.equal(add.error, false, add.raw)
    const sub = await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'replace_section', heading: 'Lista', text: '- c' }] })
    assert.deepEqual([sub.error, sub.data.error], [true, 'precondition_required'])
    const stale = await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'find_replace', find: '- a', replace: '- A' }], if_match: made.data.etag })
    assert.deepEqual([stale.error, stale.data.error, stale.data.etag], [true, 'precondition_failed', add.data.etag])
    assert.match(stale.data.hint, /read it again/)
    const preview = await c.call('edit_note', { path: 'proyectos/nueva.md', ops: [{ op: 'find_replace', find: '- a', replace: '- A', expectedCount: 1 }], ifMatch: add.data.etag, dryRun: true })
    assert.deepEqual(preview.data, { dry_run: true, etag: add.data.etag, changes: [{ at: preview.data.changes[0].at, removed: 'a', inserted: 'A' }] })
    const done = await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [
      { op: 'find_replace', find: '- a', replace: '- A' },
      { op: 'set_frontmatter', key: 'estado', value: 'borrador' },
      { op: 'set_frontmatter', key: 'tags', value: ['uno', 'dos'] },
    ], etag: add.data.etag })
    assert.equal(done.error, false, done.raw)
    const text = readFileSync(join(h.notesDir, 'proyectos/nueva.md'), 'utf8')
    assert.match(text, /^---\nuid: .+\nestado: borrador\ntags: \[uno, dos\]\n---\n# Nueva\n\n## Lista\n\n- A\n- b\nFin\.$/)
    assert.equal((await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'find_replace', find: 'zzz' }] })).data.error, 'invalid')
    assert.equal((await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'set_frontmatter', key: 'uid', value: 'x' }], if_match: done.data.etag })).data.error, 'invalid')
    const mismatch = await c.call('edit_note', { path: 'proyectos/nueva.md', operations: [{ op: 'find_replace', find: 'no está', replace: 'x' }], if_match: done.data.etag })
    assert.equal(mismatch.data.error, 'edit_mismatch')

    const mv = await c.call('move', { from: 'proyectos/notas.md', to: 'proyectos/sub/notas.md', dry_run: true })
    assert.equal(mv.error, false, mv.raw)
    // [[notas]] still leads there by name: kept, not rewritten.
    assert.deepEqual([mv.data.dryRun, mv.data.relinked, mv.data.kept.map((r: any) => r.path)], [true, [], ['proyectos/plan.md']])
    assert.equal((await c.call('move', { from: 'proyectos/notas.md', to: 'otros/notas.md' })).data.error, 'not_found')
    const moved = await c.call('move', { from: 'proyectos/notas.md', to: 'proyectos/archivo/notas.md' })
    assert.equal(moved.error, false, moved.raw)
    assert.match(readFileSync(join(h.notesDir, 'proyectos/plan.md'), 'utf8'), /\[\[notas\]\]/)

    const del = await c.call('delete', { path: 'proyectos/Acta.md' })
    assert.deepEqual([del.error, del.data.trashed], [false, true])
    assert.equal((await c.call('get_note', { path: 'proyectos/Acta.md' })).data.error, 'not_found')

    // The history: the agent by its key's name, on behalf of its user, through MCP.
    await h.settle()
    const hist = await c.call('history', { path: 'proyectos/nueva.md' })
    assert.equal(hist.error, false, hist.raw)
    assert.deepEqual(hist.data.versions[0].authors, [{ kind: 'agent', name: 'Claude Code', on_behalf_of: 'noa', via: 'mcp' }])
    const v = await c.call('history', { path: 'proyectos/nueva.md', version: hist.data.versions.at(-1).version, include_text: true })
    assert.equal(v.data.change, 'created')
    assert.match(v.texts[0]!, /# Nueva/)
    await c.close()
  } finally { await h.close() }
})

test('changes_since: from an ETag it was given or a version, waiting for a change if asked; revert_change undoes one version', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Claude Code', canWrite: true })).token)
    const first = await c.call('get_note', { path: 'proyectos/plan.md' })
    const etag = first.data.etag as string
    assert.deepEqual((await c.call('changes_since', { path: 'proyectos/plan.md', since: etag })).data, { path: 'proyectos/plan.md', etag, changed: false })

    // A person edits it while the agent waits.
    const person = async () => {
      await new Promise((r) => setTimeout(r, 150))
      const cur = await h.noa('GET', h.url('/api/note', { path: 'proyectos/plan.md' }))
      await h.noa('PUT', h.url('/api/note', { path: 'proyectos/plan.md' }), { text: cur.body.text.replace('- revisar\n', '- revisar\n- PERSONA: añadir fechas\n') }, { 'if-match': `"${cur.body.etag}"` })
    }
    const t0 = Date.now()
    const [waited] = await Promise.all([c.call('changes_since', { path: 'proyectos/plan.md', since: etag, wait_seconds: 20 }), person()])
    assert.ok(Date.now() - t0 < 5000, 'it returns as soon as the note changes')
    assert.equal(waited.error, false, waited.raw)
    assert.equal(waited.data.changed, true)
    assert.notEqual(waited.data.etag, etag)
    // The person's line, and the uid thoth gave the note on its first write.
    assert.deepEqual(waited.data.changes.map((x: any) => [x.line, x.removed, x.added.replace(/uid: \w+/, 'uid: X')]), [[4, '', 'uid: X\n'], [13, '', '- PERSONA: añadir fechas\n']])
    assert.deepEqual([waited.data.changes[1].before, waited.data.changes[1].after], ['', ''])
    // Nothing more since then: after waiting a little, unchanged.
    const quiet = await c.call('changes_since', { path: 'proyectos/plan.md', since: waited.data.etag, wait_seconds: 0.2 })
    assert.deepEqual([quiet.data.changed, quiet.data.etag], [false, waited.data.etag])

    // The agent integrates it: its ETag is the one it was given.
    const edit = await c.call('edit_note', { path: 'proyectos/plan.md', operations: [{ op: 'find_replace', find: '- PERSONA: añadir fechas', replace: '- PERSONA: añadir fechas (hecho: 1 de octubre)' }], if_match: waited.data.etag })
    assert.equal(edit.error, false, edit.raw)
    const own = await c.call('changes_since', { path: 'proyectos/plan.md', since: waited.data.etag, include_text: true })
    assert.deepEqual(own.data.changes.map((x: any) => x.added), [' (hecho: 1 de octubre)'])
    assert.match(own.texts[0]!, /PERSONA: añadir fechas \(hecho/)
    // An ETag it was never given: the whole text.
    const unknown = await c.call('changes_since', { path: 'proyectos/plan.md', since: 'sha256:0000' })
    assert.deepEqual([unknown.data.changed, unknown.data.base_known], [true, false])
    assert.match(unknown.texts[0]!, /PERSONA/)

    // From a version: what changed since then, by anyone.
    await h.settle()
    const versions = (await c.call('history', { path: 'proyectos/plan.md' })).data.versions as any[]
    // The agent's, the person's, and what was there when the history started (nobody's).
    assert.deepEqual(versions.map((v) => v.authors.map((a: any) => a.name).join()), ['Claude Code', 'noa', ''])
    assert.deepEqual(versions.at(-1).reason, { code: 'history_enabled' })
    const since = await c.call('changes_since', { path: 'proyectos/plan.md', since: versions.at(-1).version })
    assert.deepEqual(since.data.changes.map((x: any) => x.added).filter((a: string) => !a.startsWith('uid:')), ['- PERSONA: añadir fechas (hecho: 1 de octubre)\n'])

    // Revert the agent's own change: the person's line stays as they wrote it.
    const dry = await c.call('revert_change', { path: 'proyectos/plan.md', version: versions[0].version, dry_run: true })
    assert.deepEqual([dry.error, dry.data.dryRun, dry.data.counts.reverted], [false, true, 1])
    const rev = await c.call('revert_change', { path: 'proyectos/plan.md', version: versions[0].version })
    assert.equal(rev.error, false, rev.raw)
    assert.match(readFileSync(join(h.notesDir, 'proyectos/plan.md'), 'utf8'), /- PERSONA: añadir fechas\n/)
    assert.equal((await c.call('revert_change', { path: 'proyectos/plan.md', version: versions.at(-1).version })).data.error, 'not_revertible')
    assert.equal((await c.call('changes_since', { path: 'proyectos/plan.md', since: 'not a version' })).data.error, 'invalid')
    await c.close()
  } finally { await h.close() }
})

test('daily_note: the person\'s note for today, created from its template if needed; both protocol eras serve the same', async () => {
  const h = await setup({ files: { ...FILES, 'proyectos/PlantillaDía.md': '# {{date}}\n\n## Registro\n' }, config: 'daily:\n  diario:\n    folder: proyectos/diario\n    template: proyectos/PlantillaDía\n' })
  try {
    await h.enableMcp()
    const { token } = await h.newKey({ name: 'Claude Code', canWrite: true })
    for (const mode of ['legacy', 'auto'] as const) {
      const c = await h.mcp(token, mode)
      const d = await c.call('daily_note')
      assert.equal(d.error, false, d.raw)
      assert.deepEqual([d.data.path, d.data.created], ['proyectos/diario/2026-09-26.md', mode === 'legacy'])
      assert.match(d.texts[0]!, /# 2026-09-26\n\n## Registro\n/)
      await c.close()
    }
    const c = await h.mcp(token)
    const d = await c.call('daily_note')
    assert.equal((await c.call('edit_note', { path: d.data.path, operations: [{ op: 'append_under_heading', heading: 'Registro', text: '- 10:00 algo' }] })).error, false)
    assert.match(readFileSync(join(h.notesDir, d.data.path), 'utf8'), /## Registro\n- 10:00 algo\n$/)
    assert.equal((await c.call('daily_note', { series: 'nada' })).data.error, 'not_found')
    await c.close()
  } finally { await h.close() }
})
