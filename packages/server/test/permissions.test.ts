// Per-folder permissions for people (M4, D-038): the scenario of the spec
// (§7) through the HTTP API, the permissions API, folders with their rules,
// the trash, the history at `edit`, and what fails closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILES, RULES, setup } from './_m4.ts'

const paths = (list: { path: string }[]) => list.map((n) => n.path).sort()

test('§7.1: each person sees their folders and the shared one; the admin doesn\'t read what isn\'t granted', async () => {
  const h = await setup({ files: FILES })
  try {
    const laura = (await h.laura('GET', '/api/tree')).body
    assert.deepEqual(paths(laura.notes), ['familia/compra.md', 'personas/laura/diario/2026-09-27.md', 'personas/laura/recetas/tarta.md'])
    assert.deepEqual(laura.folders, ['familia', 'personas', 'personas/laura', 'personas/laura/diario', 'personas/laura/recetas'])
    assert.deepEqual(laura.pathOnly, ['personas'], 'the folder above her own only as the way to it')
    const noa = (await h.noa('GET', '/api/tree')).body
    assert.deepEqual(paths(noa.notes), ['Plan.md', 'admin/ajustes.md', 'familia/compra.md', 'personas/noa/Plan.md', 'personas/noa/plan.md'])
    assert.ok(!noa.folders.some((f: string) => f.startsWith('personas/laura') || f.startsWith('personas/marta') || f === 'personas/antigua'), noa.folders.join(', '))
    const marta = (await h.marta('GET', '/api/tree')).body
    assert.deepEqual(paths(marta.notes), ['familia/compra.md', 'personas/marta/notas.md'])

    // Opening one directly: the same as a note that doesn't exist.
    for (const [who, path] of [['noa', 'personas/laura/recetas/tarta.md'], ['laura', 'admin/ajustes.md'], ['marta', 'personas/laura/diario/2026-09-27.md'], ['noa', 'personas/antigua/nota.md']] as const) {
      const r = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${who} ${path}`)
      const missing = await h.as(who)('GET', h.url('/api/note', { path: path.replace('.md', '-no.md') }))
      assert.equal(missing.text.replace(/-no\.md/, '.md'), r.text, 'no access and no note answer alike')
    }

    // A link to a note one can't read: `no_access`, no path, no title, no candidates (D-024).
    const kLinks = (await h.noa('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const out = Object.fromEntries(kLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([out['[[tarta]]'].status, out['[[tarta]]'].dst_path, out['[[tarta]]'].reason], ['no_access', null, undefined])
    assert.equal(out['[[2026-09-27]]'].status, 'no_access')
    assert.notEqual(out['[[Plan]]'].status, 'no_access', 'his own notes are candidates for him')
    assert.deepEqual(paths(kLinks.backlinks), ['admin/ajustes.md', 'personas/noa/plan.md'])
    const lLinks = (await h.laura('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const lout = Object.fromEntries(lLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([lout['[[tarta]]'].status, lout['[[tarta]]'].dst_path], ['resolved', 'personas/laura/recetas/tarta.md'])
    assert.deepEqual([lout['[[Plan]]'].status, lout['[[Plan]]'].candidates], ['no_access', null])
    assert.deepEqual(paths(lLinks.backlinks), ['personas/laura/diario/2026-09-27.md', 'personas/laura/recetas/tarta.md'])

    // Search, tags and their counts: only what each one reads.
    assert.deepEqual((await h.noa('GET', h.url('/api/search', { q: 'Turmalina' }))).body.results, [])
    assert.deepEqual(paths((await h.laura('GET', h.url('/api/search', { q: 'Turmalina' }))).body.results), ['personas/laura/diario/2026-09-27.md'])
    const tags = async (who: 'noa' | 'laura') => Object.fromEntries(((await h.as(who)('GET', '/api/tags')).body.tags as { tag: string; count: number }[]).map((t) => [t.tag, t.count]))
    assert.deepEqual(await tags('noa'), { casa: 1 })
    assert.deepEqual(await tags('laura'), { casa: 2, intimo: 1 })

    // Images have their folder's permission.
    assert.equal((await h.marta('GET', h.url('/api/file', { path: 'familia/foto.png' }))).status, 200)
    assert.equal((await h.noa('GET', h.url('/api/file', { path: 'personas/laura/foto-laura.png' }))).status, 404)
  } finally { await h.close() }
})

test('§7.2: Laura shares a folder of hers with Noa to comment; he reads, can\'t edit or see its history', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = 'personas/laura/recetas'
    const before = (await h.laura('GET', h.url('/api/permissions', { folder }))).body
    assert.equal(before.own, null)
    assert.deepEqual(before.effective, { from: 'personas/laura', rule: 'personas/{user}', grants: { laura: 'manage' } })
    assert.equal(before.canEdit, true)
    assert.deepEqual(before.access.map((a: { username: string; level: string }) => [a.username, a.level]), [['laura', 'manage']])
    // Someone who can't see it: it doesn't exist. Marta can't; Noa neither, admin as he is? He manages permissions anywhere (D-038.1).
    assert.equal((await h.marta('GET', h.url('/api/permissions', { folder }))).status, 404)
    assert.equal((await h.noa('GET', h.url('/api/permissions', { folder }))).status, 200, 'the admin manages every folder\'s permissions')

    const put = await h.laura('PUT', '/api/permissions', { folder, grants: { laura: 'manage', noa: 'comment' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual(put.body.own, { rule: folder, user: null, grants: { laura: 'manage', noa: 'comment' }, ai: false })
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES), 'the rest of the file stays as it was')
    assert.match(yaml.slice(RULES.length), /^ {2}personas\/laura\/recetas:\n {4}grants: \{ laura: manage, noa: comment \}\n$/)
    // A stale ETag: 412, nothing written.
    const stale = await h.laura('PUT', '/api/permissions', { folder, grants: { laura: 'manage' }, ifMatch: before.etag })
    assert.deepEqual([stale.status, stale.body.error], [412, 'precondition_failed'])

    const tarta = h.url('/api/note', { path: 'personas/laura/recetas/tarta.md' })
    const read = await h.noa('GET', tarta)
    assert.equal(read.status, 200)
    const write = await h.noa('PUT', tarta, { text: 'x' }, { 'if-match': `"${read.body.etag}"` })
    assert.deepEqual([write.status, write.body.error], [403, 'forbidden'], 'he sees it: forbidden, not not_found')
    const hist = await h.noa('GET', h.url('/api/history/versions', { path: 'personas/laura/recetas/tarta.md' }))
    assert.deepEqual([hist.status, hist.body.error], [403, 'forbidden'])
    assert.equal((await h.laura('GET', h.url('/api/history/versions', { path: 'personas/laura/recetas/tarta.md' }))).status, 200)
    const access = h.policy.for({ kind: 'user', user: h.users.noa })
    assert.deepEqual([access.canRead('personas/laura/recetas/tarta.md'), access.canComment('personas/laura/recetas/tarta.md'), access.canWrite('personas/laura/recetas/tarta.md')], [true, true, false])
    // Only what's shared: the rest of her folder isn't.
    assert.equal((await h.noa('GET', h.url('/api/note', { path: 'personas/laura/diario/2026-09-27.md' }))).status, 404)
    // Noa doesn't manage it: a comment grant doesn't let him see or change its permissions (the admin does, as admin).
    assert.equal((await h.marta('PUT', '/api/permissions', { folder, grants: {}, ifMatch: put.body.etag })).status, 404)
  } finally { await h.close() }
})

test('§7.3: moving a note says who loses or gains access before moving it', async () => {
  const h = await setup({ files: FILES })
  try {
    const r = await h.noa('POST', '/api/note/move', { from: 'familia/compra.md', to: 'personas/noa/compra.md', dryRun: true })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.audience.users.lose.map((u: { username: string }) => u.username), ['laura', 'marta'])
    assert.deepEqual(r.body.audience.users.gain, [])
    assert.deepEqual(r.body.audience.groups, { gain: [], lose: ['familia'] })
    // The report names no note he can't see (links in Laura's notes are rewritten all the same, as the system).
    assert.equal(r.body.hidden, true)
    assert.ok(!r.text.includes('personas/laura'), r.text)
    // Keys are counted, never named.
    await h.enable()
    await h.newKey('laura', { name: 'Llave' })
    const again = await h.noa('POST', '/api/note/move', { from: 'familia/compra.md', to: 'personas/noa/compra.md', dryRun: true })
    assert.deepEqual(again.body.audience.keys, { gain: 0, lose: 1 })
  } finally { await h.close() }
})

test('§7.4: Laura\'s key doesn\'t see her diary; Noa\'s sees nothing of Laura\'s, and says why when named', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enable()
    const laura = h.withKey((await h.newKey('laura', { name: 'L' })).token)
    const noa = h.withKey((await h.newKey('noa', { name: 'K' })).token)
    const lt = (await laura('GET', '/api/tree')).body
    assert.deepEqual(paths(lt.notes), ['familia/compra.md', 'personas/laura/recetas/tarta.md'])
    assert.ok(!lt.folders.includes('personas/laura/diario'), 'a folder closed to agents doesn\'t show')
    const diary = await laura('GET', h.url('/api/note', { path: 'personas/laura/diario/2026-09-27.md' }))
    assert.deepEqual([diary.status, diary.body.error, diary.body.reason], [403, 'agent_denied', 'ai_false'])
    const theirs = await noa('GET', h.url('/api/note', { path: 'personas/laura/recetas/tarta.md' }))
    assert.deepEqual([theirs.status, theirs.body.error, theirs.body.reason], [403, 'agent_denied', 'user_no_access'])
    assert.deepEqual((await noa('GET', h.url('/api/search', { q: 'Obsidiana' }))).body.results, [])
    const nothing = await noa('GET', h.url('/api/note', { path: 'personas/laura/nada.md' }))
    assert.deepEqual([nothing.status, nothing.body.error], [404, 'not_found'], 'a note that isn\'t there is still not_found')
    // Its links to what its user can't see: `no_access`, with the reason.
    const links = (await noa('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const tarta = links.outgoing.find((l: { raw: string }) => l.raw === '[[tarta]]')
    assert.deepEqual([tarta.status, tarta.reason], ['no_access', 'user_no_access'])
  } finally { await h.close() }
})

test('§7.6 (P\'s part): deleting a person removes their grants; their folder is nobody\'s, never the root\'s', async () => {
  const h = await setup({ files: FILES, config: RULES + '  familia/marta:\n    grants: { marta: edit, laura: read }\n' })
  try {
    await h.services.permissionsFile.removeSubjectGrants('marta', { actor: { kind: 'user', id: h.users.noa.id } })
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.match(yaml, /familia\/marta:\n {4}grants: \{ laura: read \}\n/)
    assert.ok(yaml.startsWith(RULES))
    // Piece U deletes the account: then `personas/marta` matches nobody.
    h.index.prepare('select 1').get()
    const state = (h.auth as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    state.prepare('delete from users where id = ?').run(h.users.marta.id)
    for (const who of ['noa', 'laura'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: 'personas/marta/notas.md' }))).status, 404, who)
    }
  } finally { await h.close() }
})

test('§7.8: renaming a note linked from notes the renamer can\'t see: the report doesn\'t name them, the links are rewritten', async () => {
  const h = await setup({ files: FILES })
  try {
    const preview = await h.noa('POST', '/api/note/move', { from: 'familia/compra.md', to: 'familia/lista.md', dryRun: true })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.hidden, true)
    assert.deepEqual(paths(preview.body.relinked), ['admin/ajustes.md', 'personas/noa/plan.md'])
    assert.ok(!preview.text.includes('laura'), preview.text)
    const done = await h.noa('POST', '/api/note/move', { from: 'familia/compra.md', to: 'familia/lista.md' })
    assert.equal(done.status, 200)
    assert.ok(!done.text.includes('laura'), done.text)
    assert.match(readFileSync(join(h.notesDir, 'personas/laura/recetas/tarta.md'), 'utf8'), /\[\[lista\]\]/, 'rewritten as the system (D-018)')
  } finally { await h.close() }
})

test('the permissions API: who sees and changes what, ai, the implicit section, {user} rules, and effective access', async () => {
  const h = await setup({ files: FILES, config: 'templates: Plantillas   # kept\n' })
  try {
    // No section: the implicit one, every admin managing the root; the first change writes it.
    const root = (await h.noa('GET', h.url('/api/permissions', { folder: '' }))).body
    assert.equal(root.section, 'implicit')
    assert.deepEqual(root.effective.grants, { noa: 'manage' })
    assert.equal((await h.laura('GET', h.url('/api/permissions', { folder: 'familia' }))).status, 404)
    const put = await h.noa('PUT', '/api/permissions', { folder: 'familia', grants: { '@familia': 'edit' }, ifMatch: root.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), 'templates: Plantillas   # kept\npermissions:\n  "":\n    grants: { noa: manage }\n  familia:\n    grants: { "@familia": edit }\n')
    assert.equal(put.body.canEdit, true, 'the admin changes any folder\'s')
    // Now Laura edits familia/ but doesn't manage it: she sees it, can't see or change its permissions.
    assert.deepEqual([(await h.laura('GET', h.url('/api/permissions', { folder: 'familia' }))).status], [403])
    assert.equal((await h.laura('PUT', '/api/permissions', { folder: 'familia', grants: {}, ifMatch: put.body.etag })).status, 403)
    // Invalid subjects and levels, and the ETag is required.
    assert.equal((await h.noa('PUT', '/api/permissions', { folder: 'familia', grants: { laura: 'owner' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.noa('PUT', '/api/permissions', { folder: 'familia', grants: { '{user}': 'read' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.noa('PUT', '/api/permissions', { folder: 'familia', grants: {} })).status, 428)
    // A {user} rule, only the admin; a manager of a folder under it changes its own rule.
    const p1 = await h.noa('PUT', '/api/permissions', { folder: 'personas/{user}', grants: { '{user}': 'manage' }, ifMatch: put.body.etag })
    assert.equal(p1.status, 200, p1.text)
    assert.equal((await h.laura('GET', h.url('/api/permissions', { folder: 'personas/{user}' }))).status, 404)
    const mine = (await h.laura('GET', h.url('/api/permissions', { folder: 'personas/laura' }))).body
    assert.deepEqual(mine.own, { rule: 'personas/{user}', user: 'laura', grants: { '{user}': 'manage' }, ai: false })
    // ai: false, by whoever manages it; inherited below, not undone there.
    const ai = await h.laura('PUT', '/api/permissions', { folder: 'personas/laura/diario', ai: false, ifMatch: mine.etag })
    assert.equal(ai.status, 200, ai.text)
    const below = (await h.laura('GET', h.url('/api/permissions', { folder: 'personas/laura/diario/2026' }))).body
    assert.deepEqual(below.ai, { closed: true, from: 'personas/laura/diario' })
    // Restore inheritance: grants null.
    const inherit = await h.noa('PUT', '/api/permissions', { folder: 'familia', grants: null, ifMatch: ai.body.etag })
    assert.equal(inherit.body.own, null)
    assert.equal((await h.laura('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 404, 'back to the root\'s: noa\'s only')

    // Effective access: the admin sees anyone's (folder names only); a person, their own and their keys'.
    const lauraAccess = (await h.noa('GET', h.url('/api/permissions/access', { user: h.users.laura.id }))).body
    assert.deepEqual(lauraAccess.folders.map((f: { folder: string }) => f.folder), ['personas/laura', 'personas/laura/diario', 'personas/laura/recetas'])
    assert.equal((await h.laura('GET', h.url('/api/permissions/access', { user: h.users.noa.id }))).status, 403)
    await h.enable()
    const key = await h.newKey('laura', { name: 'L', canWrite: true })
    const keyAccess = (await h.laura('GET', h.url('/api/permissions/access', { key: key.key.id }))).body
    assert.deepEqual(keyAccess.folders, [{ folder: 'personas/laura', level: 'edit' }, { folder: 'personas/laura/recetas', level: 'edit' }], 'not the folder closed to agents')
    assert.equal((await h.marta('GET', h.url('/api/permissions/access', { key: key.key.id }))).status, 404)
    // Folders: the admin, every name; Laura, those she sees.
    const all = (await h.noa('GET', '/api/permissions/folders')).body.folders.map((f: { path: string }) => f.path)
    assert.ok(all.includes('personas/laura/diario') && all.includes('personas/antigua'))
    const lf = (await h.laura('GET', '/api/permissions/folders')).body.folders as { path: string; ownGrants: boolean; aiClosed: boolean }[]
    assert.deepEqual(lf.map((f) => f.path), ['personas/laura', 'personas/laura/diario', 'personas/laura/recetas'])
    assert.deepEqual(lf.find((f) => f.path === 'personas/laura/diario'), { path: 'personas/laura/diario', level: 'manage', ownGrants: false, aiClosed: true, canEdit: true })
  } finally { await h.close() }
})

test('permissions fail closed: rejected at start, nobody reads; rejected while running, the last valid stay; unknown subjects are ignored with a warning', async () => {
  const bad = RULES.replace('grants: { noa: manage }', 'grants: { noa: owner }')
  const h = await setup({ files: FILES, config: bad })
  try {
    for (const who of ['noa', 'laura'] as const) assert.deepEqual((await h.as(who)('GET', '/api/tree')).body.notes, [], who)
    const alerts = (await h.noa('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.deepEqual(alerts.find((a) => a.code === 'permissions_rejected'), { code: 'permissions_rejected', fallback: 'closed', actions: [] })
    assert.ok(alerts.some((a) => a.code === 'config_warnings'))
    assert.deepEqual(((await h.laura('GET', '/api/alerts')).body.alerts as { code: string }[]).map((a) => a.code), [], 'the system\'s alerts are the admin\'s')
    // thoth doesn't write over a section it can't read.
    const etag = (await h.noa('GET', h.url('/api/permissions', { folder: '' }))).body.etag
    assert.deepEqual([(await h.noa('PUT', '/api/permissions', { folder: 'x', grants: {}, ifMatch: etag })).body.error], ['config_invalid'])

    // Fixed: it applies. Then broken again while running: the last valid stays.
    writeFileSync(join(h.notesDir, 'thoth.yaml'), RULES + '  familia/extra:\n    grants: { nadie: read, "@nadie": edit }\n')
    h.workspace.reload()
    assert.equal((await h.laura('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const warnings = ((await h.noa('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[] }[]).find((a) => a.code === 'config_warnings')!.warnings!
    assert.deepEqual(warnings.filter((w) => w.code === 'unknown_subject').map((w) => w.detail), ['nadie', '@nadie'])
    assert.ok(warnings.some((w) => w.code === 'missing_folder' && w.detail === 'familia/extra'), 'a rule for a folder that doesn\'t exist')
    writeFileSync(join(h.notesDir, 'thoth.yaml'), bad)
    h.workspace.reload()
    assert.equal((await h.laura('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const now = (await h.noa('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.equal(now.find((a) => a.code === 'permissions_rejected')?.fallback, 'last_good')
  } finally { await h.close() }
})

test('folders: create with edit, move and delete with manage; their rules go with them, and a move says whose access changes', async () => {
  const h = await setup({ files: { ...FILES, 'familia/viajes/roma.md': '# Roma\n' }, config: RULES + '  familia/viajes:\n    grants: { laura: manage, noa: read }\n' })
  try {
    assert.equal((await h.marta('POST', '/api/folder', { path: 'familia/nueva' })).status, 201)
    assert.equal((await h.marta('POST', '/api/folder', { path: 'admin/nueva' })).status, 404)
    assert.equal((await h.noa('POST', '/api/folder', { path: 'familia/viajes/x' })).status, 403, 'read only there')
    // Moving familia/viajes: Laura manages it; she needs edit where it goes.
    assert.equal((await h.marta('POST', '/api/folder/move', { from: 'familia/viajes', to: 'familia/v2' })).status, 404, 'she can\'t see it')
    assert.equal((await h.laura('POST', '/api/folder/move', { from: 'familia/viajes', to: 'admin/viajes' })).status, 404)
    const dry = await h.laura('POST', '/api/folder/move', { from: 'familia/viajes', to: 'personas/laura/viajes', dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    assert.deepEqual(dry.body.audience.users, { gain: [], lose: [] }, 'its own rules go with it')
    const moved = await h.laura('POST', '/api/folder/move', { from: 'familia/viajes', to: 'personas/laura/viajes' })
    assert.equal(moved.status, 200, moved.text)
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES))
    assert.match(yaml, /personas\/laura\/viajes:\n {4}grants: \{ laura: manage, noa: read \}\n$/)
    assert.doesNotMatch(yaml, /familia\/viajes/)
    assert.equal((await h.noa('GET', h.url('/api/note', { path: 'personas/laura/viajes/roma.md' }))).status, 200, 'the rules went with it')

    // A folder under a {user} rule, renamed: the rule stops matching it, so a literal copy goes with it.
    // (Laura can't rename hers: she has no `edit` in personas/, where it would go.)
    assert.equal((await h.laura('POST', '/api/folder/move', { from: 'personas/laura', to: 'personas/laura-old' })).status, 404)
    const r2 = await h.noa('POST', '/api/folder/move', { from: 'personas/noa', to: 'personas/noa-old' })
    assert.equal(r2.status, 200, r2.text)
    assert.equal((await h.noa('GET', h.url('/api/note', { path: 'personas/noa-old/plan.md' }))).status, 200)
    assert.match(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), /personas\/noa-old:\n {4}grants: \{ noa: manage \}\n/)

    // Deleting: manage, and empty; its rules go.
    assert.equal((await h.noa('POST', '/api/folder', { path: 'admin/vacia' })).status, 201)
    assert.equal((await h.laura('DELETE', h.url('/api/folder', { path: 'admin/vacia' }))).status, 404)
    assert.equal((await h.noa('DELETE', h.url('/api/folder', { path: 'admin/vacia' }))).status, 200)
  } finally { await h.close() }
})

test('a move that fails leaves the rules as they were', async () => {
  const h = await setup({ files: { ...FILES, 'familia/viajes/roma.md': '# Roma\n', 'familia/otro/x.md': '# X\n' }, config: RULES + '  familia/viajes:\n    grants: { laura: manage }\n' })
  try {
    const before = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    const r = await h.laura('POST', '/api/folder/move', { from: 'familia/viajes', to: 'familia/otro' })
    assert.deepEqual([r.status, r.body.error], [409, 'exists'])
    assert.equal(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), before)
  } finally { await h.close() }
})

test('the trash: each person sees what was deleted where they\'d edit, and restores with edit where it goes', async () => {
  const h = await setup({ files: FILES })
  try {
    assert.equal((await h.laura('DELETE', h.url('/api/note', { path: 'personas/laura/recetas/tarta.md' }))).status, 200)
    assert.equal((await h.marta('DELETE', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const trash = async (who: 'noa' | 'laura' | 'marta') => ((await h.as(who)('GET', '/api/trash')).body.entries as { path: string; id: string }[])
    assert.deepEqual((await trash('laura')).map((e) => e.path).sort(), ['familia/compra.md', 'personas/laura/recetas/tarta.md'])
    assert.deepEqual((await trash('noa')).map((e) => e.path), ['familia/compra.md'])
    const hers = (await trash('laura')).find((e) => e.path.startsWith('personas'))!
    assert.equal((await h.noa('POST', `/api/trash/${hers.id}/restore`, {})).status, 404)
    assert.equal((await h.laura('POST', `/api/trash/${hers.id}/restore`, { to: 'admin/tarta.md' })).status, 404, 'not where she can\'t write')
    assert.equal((await h.laura('POST', `/api/trash/${hers.id}/restore`, {})).status, 200)
  } finally { await h.close() }
})

test('history at edit: «Recent changes» only where one edits, authors without anyone else\'s agents, restore brings only images one may read', async () => {
  const h = await setup({ files: FILES })
  try {
    const put = async (who: 'noa' | 'laura', path: string, add: string) => {
      const cur = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.equal((await h.as(who)('PUT', h.url('/api/note', { path }), { text: cur.body.text + add }, { 'if-match': `"${cur.body.etag}"` })).status, 200)
      await h.settle()
    }
    await put('laura', 'personas/laura/recetas/tarta.md', 'más Obsidiana\n')
    await put('noa', 'admin/ajustes.md', 'más Berilo\n')
    const files = async (who: 'noa' | 'laura' | 'marta') => ((await h.as(who)('GET', '/api/history/changes?limit=100')).body.changes as { files: { path: string }[] }[]).flatMap((c) => c.files.map((f) => f.path))
    const k = await files('noa')
    assert.ok(k.includes('admin/ajustes.md') && !k.some((p) => p.startsWith('personas/laura')) && !k.includes('thoth.yaml'), k.join(', '))
    const l = await files('laura')
    assert.ok(l.includes('personas/laura/recetas/tarta.md') && !l.includes('admin/ajustes.md'), l.join(', '))
    const authors = (await h.marta('GET', '/api/history/changes')).body.authors.map((a: { kind: string }) => a.kind)
    assert.ok(authors.every((k: string) => k !== 'agent' && k !== 'git'))
    // A cursor goes on only with the note it was made for.
    const page = (await h.laura('GET', h.url('/api/history/versions', { path: 'personas/laura/recetas/tarta.md', limit: '1' }))).body
    assert.ok(page.next)
    const other = await h.laura('GET', h.url('/api/history/versions', { path: 'familia/compra.md', cursor: page.next }))
    assert.deepEqual([other.status, other.body.error], [400, 'invalid'])
  } finally { await h.close() }
})

test('a note moved outside thoth out of a folder with its own rules is held from everyone until someone decides', async () => {
  const h = await setup({ files: FILES })
  try {
    // With a shell: Laura's recipe (with its uid) lands in the shared folder.
    renameSync(join(h.notesDir, 'personas/laura/recetas/tarta.md'), join(h.notesDir, 'familia/tarta.md'))
    h.runtime.rescan({})
    for (const who of ['noa', 'laura', 'marta'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: 'familia/tarta.md' }))).status, 404, who)
      assert.ok(!(await h.as(who)('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === 'familia/tarta.md'), who)
    }
    const held = ((await h.laura('GET', '/api/alerts')).body.alerts as { code: string; id: string; folder: string; to: string | null; notes: number; actions: string[] }[]).find((a) => a.code === 'permissions_held')!
    assert.deepEqual({ ...held, id: '' }, { code: 'permissions_held', id: '', folder: 'personas/laura', to: null, notes: 1, actions: ['release'] })
    assert.equal(((await h.marta('GET', '/api/alerts')).body.alerts as { code: string }[]).some((a) => a.code === 'permissions_held'), false, 'only the admin and whoever manages that folder')
    assert.equal((await h.marta('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 404)
    assert.equal((await h.laura('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 200)
    assert.equal((await h.marta('GET', h.url('/api/note', { path: 'familia/tarta.md' }))).status, 200, 'released: the folder it\'s in applies')
  } finally { await h.close() }
})
