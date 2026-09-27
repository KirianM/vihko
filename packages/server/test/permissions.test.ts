// Per-folder permissions for people (M4, D-038): the scenario of the spec
// (§7) through the HTTP API, the permissions API, folders with their rules,
// the trash, the history at `edit`, and what fails closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, FILES, GROUP, MEMBER, NOBODY, OTHER, RULES, setup, type Name } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const paths = (list: { path: string }[]) => list.map((n) => n.path).sort()

// The scenario's people (_m4.ts): their usernames, their personal folders and the notes in them.
const [A, M, O] = [ADMIN.username, MEMBER.username, OTHER.username]
const HOME = { admin: `personas/${A}`, member: `personas/${M}`, other: `personas/${O}`, nobody: `personas/${NOBODY}` }
const DIARY = `${HOME.member}/diario/2026-09-27.md`
const TARTA = `${HOME.member}/recetas/tarta.md`
const PHOTO = `${HOME.member}/foto-${M}.png`
const NOTES_OTHER = `${HOME.other}/notas.md`
const PLAN_LOWER = `${HOME.admin}/plan.md`
const PLAN_UPPER = `${HOME.admin}/Plan.md`

/** A key as thoth writes it in thoth.yaml (core's yamlKey): plain when it reads back the same, quoted otherwise. */
const written = (key: string, plain: RegExp) => (plain.test(key) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(key) && !/^[\d.+-]/.test(key) ? key : JSON.stringify(key))
/** A subject (user or group) as thoth writes it. */
const subject = (s: string) => written(s, /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u)
/** A folder key as thoth writes it. */
const folderKey = (f: string) => written(f, /^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*(?<! )$/u)
/** `text` for a regular expression that matches it literally (valid with the `u` flag). */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** The folder itself or anything under it. */
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
/** Whether `text` names `name` as a whole (not inside a longer name). */
const mentions = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}._-])${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u').test(text)
/** A rule line as thoth writes it: `folder:` and its grants in a flow map, in order. */
const ruleRe = (folder: string, grants: [string, string][]) =>
  `${literally(folderKey(folder))}:\\n {4}grants: \\{ ${grants.map(([s, l]) => `${literally(subject(s))}: ${l}`).join(', ')} \\}\\n`

test('§7.1: each person sees their folders and the shared one; the admin doesn\'t read what isn\'t granted', async () => {
  const h = await setup({ files: FILES })
  try {
    const member = (await h.member('GET', '/api/tree')).body
    assert.deepEqual(paths(member.notes), ['familia/compra.md', DIARY, TARTA].sort())
    assert.deepEqual(member.folders, ['familia', 'personas', HOME.member, `${HOME.member}/diario`, `${HOME.member}/recetas`])
    assert.deepEqual(member.pathOnly, ['personas'], 'the folder above their own only as the way to it')
    const admin = (await h.admin('GET', '/api/tree')).body
    assert.deepEqual(paths(admin.notes), ['Plan.md', 'admin/ajustes.md', 'familia/compra.md', PLAN_UPPER, PLAN_LOWER].sort())
    assert.ok(!admin.folders.some((f: string) => under(f, HOME.member) || under(f, HOME.other) || f === HOME.nobody), admin.folders.join(', '))
    const other = (await h.other('GET', '/api/tree')).body
    assert.deepEqual(paths(other.notes), ['familia/compra.md', NOTES_OTHER].sort())

    // Opening one directly: the same as a note that doesn't exist.
    for (const [who, path] of [['admin', TARTA], ['member', 'admin/ajustes.md'], ['other', DIARY], ['admin', `${HOME.nobody}/nota.md`]] as const) {
      const r = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${who} ${path}`)
      const missing = await h.as(who)('GET', h.url('/api/note', { path: path.replace(/\.md$/, '-no.md') }))
      assert.equal(missing.text.replace(/-no\.md/, '.md'), r.text, 'no access and no note answer alike')
    }

    // A link to a note one can't read: `no_access`, no path, no title, no candidates (D-024).
    const kLinks = (await h.admin('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const out = Object.fromEntries(kLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([out['[[tarta]]'].status, out['[[tarta]]'].dst_path, out['[[tarta]]'].reason], ['no_access', null, undefined])
    assert.equal(out['[[2026-09-27]]'].status, 'no_access')
    assert.notEqual(out['[[Plan]]'].status, 'no_access', 'the admin\'s own notes are candidates for them')
    assert.deepEqual(paths(kLinks.backlinks), ['admin/ajustes.md', PLAN_LOWER].sort())
    const lLinks = (await h.member('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const lout = Object.fromEntries(lLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([lout['[[tarta]]'].status, lout['[[tarta]]'].dst_path], ['resolved', TARTA])
    assert.deepEqual([lout['[[Plan]]'].status, lout['[[Plan]]'].candidates], ['no_access', null])
    assert.deepEqual(paths(lLinks.backlinks), [DIARY, TARTA].sort())

    // Search, tags and their counts: only what each one reads.
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: 'Turmalina' }))).body.results, [])
    assert.deepEqual(paths((await h.member('GET', h.url('/api/search', { q: 'Turmalina' }))).body.results), [DIARY])
    const tags = async (who: Name) => Object.fromEntries(((await h.as(who)('GET', '/api/tags')).body.tags as { tag: string; count: number }[]).map((t) => [t.tag, t.count]))
    assert.deepEqual(await tags('admin'), { casa: 1 })
    assert.deepEqual(await tags('member'), { casa: 2, intimo: 1 })

    // Images have their folder's permission.
    assert.equal((await h.other('GET', h.url('/api/file', { path: 'familia/foto.png' }))).status, 200)
    assert.equal((await h.admin('GET', h.url('/api/file', { path: PHOTO }))).status, 404)
  } finally { await h.close() }
})

test('§7.2: the member shares a folder of theirs with the admin to comment; the admin reads, can\'t edit or see its history', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = `${HOME.member}/recetas`
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    assert.equal(before.own, null)
    assert.deepEqual(before.effective, { from: HOME.member, rule: 'personas/{user}', grants: { [M]: 'manage' } })
    assert.equal(before.canEdit, true)
    assert.deepEqual(before.access.map((a: { username: string; level: string }) => [a.username, a.level]), [[M, 'manage']])
    // Someone who can't see it: it doesn't exist. The other member can't; the admin neither, admin as they are? They manage permissions anywhere (D-038.1).
    assert.equal((await h.other('GET', h.url('/api/permissions', { folder }))).status, 404)
    assert.equal((await h.admin('GET', h.url('/api/permissions', { folder }))).status, 200, 'the admin manages every folder\'s permissions')

    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [A]: 'comment' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual(put.body.own, { rule: folder, user: null, grants: { [M]: 'manage', [A]: 'comment' }, ai: false })
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES), 'the rest of the file stays as it was')
    assert.match(yaml.slice(RULES.length), new RegExp(`^ {2}${ruleRe(folder, [[M, 'manage'], [A, 'comment']])}$`, 'u'))
    // A stale ETag: 412, nothing written.
    const stale = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage' }, ifMatch: before.etag })
    assert.deepEqual([stale.status, stale.body.error], [412, 'precondition_failed'])

    const tarta = h.url('/api/note', { path: TARTA })
    const read = await h.admin('GET', tarta)
    assert.equal(read.status, 200)
    const write = await h.admin('PUT', tarta, { text: 'x' }, { 'if-match': `"${read.body.etag}"` })
    assert.deepEqual([write.status, write.body.error], [403, 'forbidden'], 'they see it: forbidden, not not_found')
    const hist = await h.admin('GET', h.url('/api/history/versions', { path: TARTA }))
    assert.deepEqual([hist.status, hist.body.error], [403, 'forbidden'])
    assert.equal((await h.member('GET', h.url('/api/history/versions', { path: TARTA }))).status, 200)
    const access = h.policy.for({ kind: 'user', user: h.users.admin })
    assert.deepEqual([access.canRead(TARTA), access.canComment(TARTA), access.canWrite(TARTA)], [true, true, false])
    // Only what's shared: the rest of their folder isn't.
    assert.equal((await h.admin('GET', h.url('/api/note', { path: DIARY }))).status, 404)
    // The other member doesn't manage it: no grant lets them see or change its permissions (the admin does, as admin).
    assert.equal((await h.other('PUT', '/api/permissions', { folder, grants: {}, ifMatch: put.body.etag })).status, 404)
  } finally { await h.close() }
})

test('a personal folder ({user} rule) closed to agents or shared, then restored, never falls through to the root\'s grants', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = HOME.member
    const note = h.url('/api/note', { path: TARTA })
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    assert.deepEqual(before.userRule, { rule: 'personas/{user}', user: M, grants: { [M]: 'manage' } })
    // Closed to agents: a literal rule with only `ai: false`; the {user} rule's grants stay.
    const closed = await h.member('PUT', '/api/permissions', { folder, ai: false, ifMatch: before.etag })
    assert.equal(closed.status, 200, closed.text)
    assert.deepEqual([closed.body.own, closed.body.ai], [{ rule: folder, user: null, grants: null, ai: true }, { closed: true, from: folder }])
    assert.deepEqual(closed.body.effective, { from: folder, rule: 'personas/{user}', grants: { [M]: 'manage' } })
    assert.equal((await h.admin('GET', note)).status, 404, 'the root\'s manager gains nothing')
    assert.equal((await h.member('GET', note)).status, 200)
    // Shared with the other member (own grants over the {user} rule), then back to the {user} rule.
    const shared = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [O]: 'read' }, ifMatch: closed.body.etag })
    assert.equal(shared.status, 200, shared.text)
    assert.equal((await h.other('GET', note)).status, 200)
    const restored = await h.member('PUT', '/api/permissions', { folder, grants: null, ifMatch: shared.body.etag })
    assert.equal(restored.status, 200, restored.text)
    assert.deepEqual(restored.body.effective.grants, { [M]: 'manage' })
    assert.equal((await h.other('GET', note)).status, 404)
    assert.equal((await h.admin('GET', note)).status, 404)
    assert.deepEqual(restored.body.ai, { closed: true, from: folder }, 'closing to agents stays')
    // Moved from thoth, the folder takes the {user} rule's grants along as a literal copy.
    const moved = await h.member('POST', '/api/folder/move', { from: `${HOME.member}/recetas`, to: `${HOME.member}/cocina` })
    assert.equal(moved.status, 200, moved.text)
    assert.equal((await h.member('GET', h.url('/api/note', { path: `${HOME.member}/cocina/tarta.md` }))).status, 200)
  } finally { await h.close() }
})

test('§7.3: moving a note says who loses or gains access before moving it', async () => {
  const h = await setup({ files: FILES })
  try {
    const r = await h.admin('POST', '/api/note/move', { from: 'familia/compra.md', to: `${HOME.admin}/compra.md`, dryRun: true })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.audience.users.lose.map((u: { username: string }) => u.username), [M, O].sort((a, b) => a.localeCompare(b)))
    assert.deepEqual(r.body.audience.users.gain, [])
    assert.deepEqual(r.body.audience.groups, { gain: [], lose: [GROUP] })
    // The report names no note they can't see (links in the member's notes are rewritten all the same, as the system).
    assert.equal(r.body.hidden, true)
    assert.ok(!r.text.includes(`${HOME.member}/`), r.text)
    // Keys are counted, never named.
    await h.enable()
    await h.newKey('member', { name: 'Llave' })
    const again = await h.admin('POST', '/api/note/move', { from: 'familia/compra.md', to: `${HOME.admin}/compra.md`, dryRun: true })
    assert.deepEqual(again.body.audience.keys, { gain: 0, lose: 1 })
  } finally { await h.close() }
})

test('§7.4: the member\'s key doesn\'t see their diary; the admin\'s sees nothing of the member\'s, and says why when named', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enable()
    const memberKey = h.withKey((await h.newKey('member', { name: 'L' })).token)
    const adminKey = h.withKey((await h.newKey('admin', { name: 'K' })).token)
    const lt = (await memberKey('GET', '/api/tree')).body
    assert.deepEqual(paths(lt.notes), ['familia/compra.md', TARTA].sort())
    assert.ok(!lt.folders.includes(`${HOME.member}/diario`), 'a folder closed to agents doesn\'t show')
    const diary = await memberKey('GET', h.url('/api/note', { path: DIARY }))
    assert.deepEqual([diary.status, diary.body.error, diary.body.reason], [403, 'agent_denied', 'ai_false'])
    const theirs = await adminKey('GET', h.url('/api/note', { path: TARTA }))
    assert.deepEqual([theirs.status, theirs.body.error, theirs.body.reason], [403, 'agent_denied', 'user_no_access'])
    assert.deepEqual((await adminKey('GET', h.url('/api/search', { q: 'Obsidiana' }))).body.results, [])
    const nothing = await adminKey('GET', h.url('/api/note', { path: `${HOME.member}/nada.md` }))
    assert.deepEqual([nothing.status, nothing.body.error], [404, 'not_found'], 'a note that isn\'t there is still not_found')
    // Its links to what its user can't see: `no_access`, with the reason.
    const links = (await adminKey('GET', h.url('/api/note/links', { path: 'familia/compra.md' }))).body
    const tarta = links.outgoing.find((l: { raw: string }) => l.raw === '[[tarta]]')
    assert.deepEqual([tarta.status, tarta.reason], ['no_access', 'user_no_access'])
  } finally { await h.close() }
})

test('§7.6 (P\'s part): deleting a person removes their grants; their folder is nobody\'s, never the root\'s', async () => {
  const shared = `familia/${O}`
  const h = await setup({ files: FILES, config: RULES + `  ${folderKey(shared)}:\n    grants: { ${subject(O)}: edit, ${subject(M)}: read }\n` })
  try {
    await h.services.permissionsFile.removeSubjectGrants(O, { actor: { kind: 'user', id: h.users.admin.id } })
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.match(yaml, new RegExp(ruleRe(shared, [[M, 'read']]), 'u'))
    assert.ok(yaml.startsWith(RULES))
    // Piece U deletes the account: then the other member's personal folder matches nobody.
    h.index.prepare('select 1').get()
    const state = (h.auth as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    state.prepare('delete from users where id = ?').run(h.users.other.id)
    for (const who of ['admin', 'member'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: NOTES_OTHER }))).status, 404, who)
    }
  } finally { await h.close() }
})

test('§7.8: renaming a note linked from notes the renamer can\'t see: the report doesn\'t name them, the links are rewritten', async () => {
  const h = await setup({ files: FILES })
  try {
    const preview = await h.admin('POST', '/api/note/move', { from: 'familia/compra.md', to: 'familia/lista.md', dryRun: true })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.hidden, true)
    assert.deepEqual(paths(preview.body.relinked), ['admin/ajustes.md', PLAN_LOWER].sort())
    assert.ok(!mentions(preview.text, M), preview.text)
    const done = await h.admin('POST', '/api/note/move', { from: 'familia/compra.md', to: 'familia/lista.md' })
    assert.equal(done.status, 200)
    assert.ok(!mentions(done.text, M), done.text)
    assert.match(readFileSync(join(h.notesDir, TARTA), 'utf8'), /\[\[lista\]\]/, 'rewritten as the system (D-018)')
  } finally { await h.close() }
})

test('the permissions API: who sees and changes what, ai, the implicit section, {user} rules, and effective access', async () => {
  const h = await setup({ files: FILES, config: 'templates: Plantillas   # kept\n' })
  try {
    // No section: the implicit one, every admin managing the root; the first change writes it.
    const root = (await h.admin('GET', h.url('/api/permissions', { folder: '' }))).body
    assert.equal(root.section, 'implicit')
    assert.deepEqual(root.effective.grants, { [A]: 'manage' })
    assert.equal((await h.member('GET', h.url('/api/permissions', { folder: 'familia' }))).status, 404)
    const put = await h.admin('PUT', '/api/permissions', { folder: 'familia', grants: { [`@${GROUP}`]: 'edit' }, ifMatch: root.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), `templates: Plantillas   # kept\npermissions:\n  "":\n    grants: { ${subject(A)}: manage }\n  familia:\n    grants: { ${subject(`@${GROUP}`)}: edit }\n`)
    assert.equal(put.body.canEdit, true, 'the admin changes any folder\'s')
    // Now the member edits familia/ but doesn't manage it: they see it, can't see or change its permissions.
    assert.deepEqual([(await h.member('GET', h.url('/api/permissions', { folder: 'familia' }))).status], [403])
    assert.equal((await h.member('PUT', '/api/permissions', { folder: 'familia', grants: {}, ifMatch: put.body.etag })).status, 403)
    // Invalid subjects and levels, and the ETag is required.
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: 'familia', grants: { [M]: 'owner' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: 'familia', grants: { '{user}': 'read' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: 'familia', grants: {} })).status, 428)
    // A {user} rule, only the admin; a manager of a folder under it changes its own rule.
    const p1 = await h.admin('PUT', '/api/permissions', { folder: 'personas/{user}', grants: { '{user}': 'manage' }, ifMatch: put.body.etag })
    assert.equal(p1.status, 200, p1.text)
    assert.equal((await h.member('GET', h.url('/api/permissions', { folder: 'personas/{user}' }))).status, 404)
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: HOME.member }))).body
    assert.deepEqual(mine.own, { rule: 'personas/{user}', user: M, grants: { '{user}': 'manage' }, ai: false })
    // ai: false, by whoever manages it; inherited below, not undone there.
    const ai = await h.member('PUT', '/api/permissions', { folder: `${HOME.member}/diario`, ai: false, ifMatch: mine.etag })
    assert.equal(ai.status, 200, ai.text)
    const below = (await h.member('GET', h.url('/api/permissions', { folder: `${HOME.member}/diario/2026` }))).body
    assert.deepEqual(below.ai, { closed: true, from: `${HOME.member}/diario` })
    // Restore inheritance: grants null.
    const inherit = await h.admin('PUT', '/api/permissions', { folder: 'familia', grants: null, ifMatch: ai.body.etag })
    assert.equal(inherit.body.own, null)
    assert.equal((await h.member('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 404, 'back to the root\'s: the admin\'s only')

    // Effective access: the admin sees anyone's (folder names only); a person, their own and their keys'.
    const memberAccess = (await h.admin('GET', h.url('/api/permissions/access', { user: h.users.member.id }))).body
    assert.deepEqual(memberAccess.folders.map((f: { folder: string }) => f.folder), [HOME.member, `${HOME.member}/diario`, `${HOME.member}/recetas`])
    assert.equal((await h.member('GET', h.url('/api/permissions/access', { user: h.users.admin.id }))).status, 403)
    await h.enable()
    const key = await h.newKey('member', { name: 'L', canWrite: true })
    const keyAccess = (await h.member('GET', h.url('/api/permissions/access', { key: key.key.id }))).body
    assert.deepEqual(keyAccess.folders, [{ folder: HOME.member, level: 'edit' }, { folder: `${HOME.member}/recetas`, level: 'edit' }], 'not the folder closed to agents')
    assert.equal((await h.other('GET', h.url('/api/permissions/access', { key: key.key.id }))).status, 404)
    // Folders: the admin, every name; the member, those they see.
    const all = (await h.admin('GET', '/api/permissions/folders')).body.folders.map((f: { path: string }) => f.path)
    assert.ok(all.includes(`${HOME.member}/diario`) && all.includes(HOME.nobody))
    const lf = (await h.member('GET', '/api/permissions/folders')).body.folders as { path: string; ownGrants: boolean; aiClosed: boolean }[]
    assert.deepEqual(lf.map((f) => f.path), [HOME.member, `${HOME.member}/diario`, `${HOME.member}/recetas`])
    assert.deepEqual(lf.find((f) => f.path === `${HOME.member}/diario`), { path: `${HOME.member}/diario`, level: 'manage', ownGrants: false, aiClosed: true, canEdit: true })
  } finally { await h.close() }
})

test('D-040 3.5: a co-manager can\'t be locked out of a subfolder; the admin managing the root never gets into a personal folder', async () => {
  const h = await setup({
    files: { ...FILES, 'familia/viajes/sorpresa/regalo.md': '# Regalo\n\nPalabra Ámbar.\n', [`${HOME.member}/recetas/secreta/pan.md`]: '# Pan\n' },
    config: RULES + `  familia/viajes:\n    grants: { ${subject(M)}: manage, ${subject(O)}: manage }\n`,
  })
  try {
    const regalo = h.url('/api/note', { path: 'familia/viajes/sorpresa/regalo.md' })
    // The member closes a subfolder to everyone but them: the other, who manages the folder above with them, keeps managing it.
    const folder = 'familia/viajes/sorpresa'
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal((await h.other('GET', regalo)).status, 200)
    const seen = await h.other('GET', h.url('/api/permissions', { folder }))
    assert.equal(seen.status, 200, seen.text)
    assert.equal(seen.body.canEdit, true)
    assert.equal(seen.body.personal, null)
    assert.deepEqual(seen.body.managedAbove, [{ subject: M, from: 'familia/viajes' }, { subject: O, from: 'familia/viajes' }, { subject: A, from: '' }])
    // Why: they manage /familia/viajes. And they can put themselves back.
    const other = seen.body.access.find((a: { username: string }) => a.username === O)
    assert.deepEqual(other, { id: h.users.other.id, username: O, level: 'manage', via: [{ subject: O, level: 'manage', from: 'familia/viajes', above: true }] })
    const back = await h.other('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [O]: 'edit' }, ifMatch: seen.body.etag })
    assert.equal(back.status, 200, back.text)
    // The admin manages the root: they read it too, lists and direct reads alike.
    assert.equal((await h.admin('GET', regalo)).status, 200)
    assert.ok((await h.admin('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === 'familia/viajes/sorpresa/regalo.md'))
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: 'Ámbar' }))).body.results.map((r: { path: string }) => r.path), ['familia/viajes/sorpresa/regalo.md'])

    // A subfolder of a personal folder with grants of its own that leave its owner out: they still manage it.
    const recetas = `${HOME.member}/recetas`
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: recetas }))).body
    const shared = await h.member('PUT', '/api/permissions', { folder: recetas, grants: { [O]: 'read' }, ifMatch: mine.etag })
    assert.equal(shared.status, 200, shared.text)
    assert.equal(shared.body.canEdit, true, 'they manage their personal folder: not locked out')
    assert.equal(shared.body.personal, HOME.member)
    assert.deepEqual(shared.body.managedAbove, [{ subject: M, from: HOME.member, rule: 'personas/{user}' }])
    assert.equal((await h.member('GET', h.url('/api/note', { path: `${recetas}/secreta/pan.md` }))).status, 200)
    assert.equal(h.policy.for({ kind: 'user', user: h.users.member }).canManage(`${recetas}/secreta`), true)
    assert.equal((await h.other('GET', h.url('/api/note', { path: TARTA }))).status, 200)

    // The admin with manage on the root reads nothing of the member's personal folder, nor under it, however its subfolders are set.
    for (const path of [TARTA, `${recetas}/secreta/pan.md`, DIARY]) {
      assert.equal((await h.admin('GET', h.url('/api/note', { path }))).status, 404, path)
    }
    assert.ok(!(await h.admin('GET', '/api/tree')).body.folders.some((f: string) => under(f, HOME.member)))
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: 'Obsidiana' }))).body.results, [])
    const kAccess = h.policy.for({ kind: 'user', user: h.users.admin })
    assert.deepEqual([HOME.member, recetas, `${recetas}/secreta`, HOME.nobody].map((f) => kAccess.level(f)), [null, null, null, null])
    // They still see and change its permissions as the admin (folder names, never contents), and a grant to themselves is explicit.
    const asAdmin = (await h.admin('GET', h.url('/api/permissions', { folder: recetas }))).body
    assert.equal(asAdmin.canEdit, true)
    assert.ok(!asAdmin.access.some((a: { username: string }) => a.username === A))
    const reached = (await h.admin('GET', h.url('/api/permissions/access', { user: h.users.admin.id }))).body.folders.map((f: { folder: string }) => f.folder)
    assert.ok(reached.includes('familia/viajes/sorpresa') && !reached.some((f: string) => under(f, HOME.member)), reached.join(', '))
  } finally { await h.close() }
})

test('permissions fail closed: rejected at start, nobody reads; rejected while running, the last valid stay; unknown subjects are ignored with a warning', async () => {
  const bad = RULES.replace(`grants: { ${yamlKey(A)}: manage }`, `grants: { ${yamlKey(A)}: owner }`)
  assert.notEqual(bad, RULES)
  // Subjects nobody is: a user and a group.
  const [nobody, noGroup] = [m.aUsername(), m.aGroupName()]
  const h = await setup({ files: FILES, config: bad })
  try {
    for (const who of ['admin', 'member'] as const) assert.deepEqual((await h.as(who)('GET', '/api/tree')).body.notes, [], who)
    const alerts = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.deepEqual(alerts.find((a) => a.code === 'permissions_rejected'), { code: 'permissions_rejected', fallback: 'closed', actions: [] })
    assert.ok(alerts.some((a) => a.code === 'config_warnings'))
    assert.deepEqual(((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).map((a) => a.code), [], 'the system\'s alerts are the admin\'s')
    // thoth doesn't write over a section it can't read.
    const etag = (await h.admin('GET', h.url('/api/permissions', { folder: '' }))).body.etag
    assert.deepEqual([(await h.admin('PUT', '/api/permissions', { folder: 'x', grants: {}, ifMatch: etag })).body.error], ['config_invalid'])

    // Fixed: it applies. Then broken again while running: the last valid stays.
    writeFileSync(join(h.notesDir, 'thoth.yaml'), RULES + `  familia/extra:\n    grants: { ${yamlKey(nobody)}: read, ${yamlKey(`@${noGroup}`)}: edit }\n`)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const warnings = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[] }[]).find((a) => a.code === 'config_warnings')!.warnings!
    assert.deepEqual(warnings.filter((w) => w.code === 'unknown_subject').map((w) => w.detail), [nobody, `@${noGroup}`])
    assert.ok(warnings.some((w) => w.code === 'missing_folder' && w.detail === 'familia/extra'), 'a rule for a folder that doesn\'t exist')
    writeFileSync(join(h.notesDir, 'thoth.yaml'), bad)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const now = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.equal(now.find((a) => a.code === 'permissions_rejected')?.fallback, 'last_good')
  } finally { await h.close() }
})

test('folders: create with edit, move and delete with manage; their rules go with them, and a move says whose access changes', async () => {
  const h = await setup({ files: { ...FILES, 'familia/viajes/roma.md': '# Roma\n' }, config: RULES + `  familia/viajes:\n    grants: { ${subject(M)}: manage, ${subject(A)}: read }\n` })
  try {
    assert.equal((await h.other('POST', '/api/folder', { path: 'familia/nueva' })).status, 201)
    assert.equal((await h.other('POST', '/api/folder', { path: 'admin/nueva' })).status, 404)
    // The admin only reads it by their own grants, but they manage the root, and managing keeps reaching under it (D-040 3.5).
    assert.equal((await h.admin('POST', '/api/folder', { path: 'familia/viajes/x' })).status, 201, 'they manage it from above')
    assert.equal((await h.other('POST', '/api/folder', { path: 'familia/viajes/y' })).status, 404, 'not granted there: they can\'t see it')
    // Moving familia/viajes: the member manages it; they need edit where it goes.
    assert.equal((await h.other('POST', '/api/folder/move', { from: 'familia/viajes', to: 'familia/v2' })).status, 404, 'they can\'t see it')
    assert.equal((await h.member('POST', '/api/folder/move', { from: 'familia/viajes', to: 'admin/viajes' })).status, 404)
    const dry = await h.member('POST', '/api/folder/move', { from: 'familia/viajes', to: `${HOME.member}/viajes`, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    assert.deepEqual(dry.body.audience.users, { gain: [], lose: [] }, 'its own rules go with it')
    const moved = await h.member('POST', '/api/folder/move', { from: 'familia/viajes', to: `${HOME.member}/viajes` })
    assert.equal(moved.status, 200, moved.text)
    const yaml = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES))
    assert.match(yaml, new RegExp(`${ruleRe(`${HOME.member}/viajes`, [[M, 'manage'], [A, 'read']])}$`, 'u'))
    assert.doesNotMatch(yaml, /familia\/viajes/)
    assert.equal((await h.admin('GET', h.url('/api/note', { path: `${HOME.member}/viajes/roma.md` }))).status, 200, 'the rules went with it')

    // A folder under a {user} rule, renamed: the rule stops matching it, so a literal copy goes with it.
    // (The member can't rename theirs: they have no `edit` in personas/, where it would go.)
    assert.equal((await h.member('POST', '/api/folder/move', { from: HOME.member, to: `${HOME.member}-old` })).status, 404)
    const r2 = await h.admin('POST', '/api/folder/move', { from: HOME.admin, to: `${HOME.admin}-old` })
    assert.equal(r2.status, 200, r2.text)
    assert.equal((await h.admin('GET', h.url('/api/note', { path: `${HOME.admin}-old/plan.md` }))).status, 200)
    assert.match(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), new RegExp(ruleRe(`${HOME.admin}-old`, [[A, 'manage']]), 'u'))

    // Deleting: manage, and empty; its rules go.
    assert.equal((await h.admin('POST', '/api/folder', { path: 'admin/vacia' })).status, 201)
    assert.equal((await h.member('DELETE', h.url('/api/folder', { path: 'admin/vacia' }))).status, 404)
    assert.equal((await h.admin('DELETE', h.url('/api/folder', { path: 'admin/vacia' }))).status, 200)
  } finally { await h.close() }
})

test('a move that fails leaves the rules as they were', async () => {
  const h = await setup({ files: { ...FILES, 'familia/viajes/roma.md': '# Roma\n', 'familia/otro/x.md': '# X\n' }, config: RULES + `  familia/viajes:\n    grants: { ${subject(M)}: manage }\n` })
  try {
    const before = readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8')
    const r = await h.member('POST', '/api/folder/move', { from: 'familia/viajes', to: 'familia/otro' })
    assert.deepEqual([r.status, r.body.error], [409, 'exists'])
    assert.equal(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), before)
  } finally { await h.close() }
})

test('the trash: each person sees what was deleted where they\'d edit, and restores with edit where it goes', async () => {
  const h = await setup({ files: FILES })
  try {
    assert.equal((await h.member('DELETE', h.url('/api/note', { path: TARTA }))).status, 200)
    assert.equal((await h.other('DELETE', h.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    const trash = async (who: Name) => ((await h.as(who)('GET', '/api/trash')).body.entries as { path: string; id: string }[])
    assert.deepEqual((await trash('member')).map((e) => e.path).sort(), ['familia/compra.md', TARTA].sort())
    assert.deepEqual((await trash('admin')).map((e) => e.path), ['familia/compra.md'])
    const theirs = (await trash('member')).find((e) => e.path.startsWith('personas'))!
    assert.equal((await h.admin('POST', `/api/trash/${theirs.id}/restore`, {})).status, 404)
    assert.equal((await h.member('POST', `/api/trash/${theirs.id}/restore`, { to: 'admin/tarta.md' })).status, 404, 'not where they can\'t write')
    assert.equal((await h.member('POST', `/api/trash/${theirs.id}/restore`, {})).status, 200)
  } finally { await h.close() }
})

test('history at edit: «Recent changes» only where one edits, authors without anyone else\'s agents, restore brings only images one may read', async () => {
  const h = await setup({ files: FILES })
  try {
    const put = async (who: Name, path: string, add: string) => {
      const cur = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.equal((await h.as(who)('PUT', h.url('/api/note', { path }), { text: cur.body.text + add }, { 'if-match': `"${cur.body.etag}"` })).status, 200)
      await h.settle()
    }
    await put('member', TARTA, 'más Obsidiana\n')
    await put('admin', 'admin/ajustes.md', 'más Berilo\n')
    const files = async (who: Name) => ((await h.as(who)('GET', '/api/history/changes?limit=100')).body.changes as { files: { path: string }[] }[]).flatMap((c) => c.files.map((f) => f.path))
    const k = await files('admin')
    assert.ok(k.includes('admin/ajustes.md') && !k.some((p) => under(p, HOME.member)) && !k.includes('thoth.yaml'), k.join(', '))
    const l = await files('member')
    assert.ok(l.includes(TARTA) && !l.includes('admin/ajustes.md'), l.join(', '))
    const authors = (await h.other('GET', '/api/history/changes')).body.authors.map((a: { kind: string }) => a.kind)
    assert.ok(authors.every((k: string) => k !== 'agent' && k !== 'git'))
    // A cursor goes on only with the note it was made for.
    const page = (await h.member('GET', h.url('/api/history/versions', { path: TARTA, limit: '1' }))).body
    assert.ok(page.next)
    const other = await h.member('GET', h.url('/api/history/versions', { path: 'familia/compra.md', cursor: page.next }))
    assert.deepEqual([other.status, other.body.error], [400, 'invalid'])
  } finally { await h.close() }
})

test('a note moved outside thoth out of a folder with its own rules is held from everyone until someone decides', async () => {
  const h = await setup({ files: FILES })
  try {
    // With a shell: the member's recipe (with its uid) lands in the shared folder.
    renameSync(join(h.notesDir, TARTA), join(h.notesDir, 'familia/tarta.md'))
    h.runtime.rescan({})
    for (const who of ['admin', 'member', 'other'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: 'familia/tarta.md' }))).status, 404, who)
      assert.ok(!(await h.as(who)('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === 'familia/tarta.md'), who)
    }
    const held = ((await h.member('GET', '/api/alerts')).body.alerts as { code: string; id: string; folder: string; to: string | null; notes: number; actions: string[] }[]).find((a) => a.code === 'permissions_held')!
    assert.deepEqual({ ...held, id: '' }, { code: 'permissions_held', id: '', folder: HOME.member, to: null, notes: 1, actions: ['release'] })
    assert.equal(((await h.other('GET', '/api/alerts')).body.alerts as { code: string }[]).some((a) => a.code === 'permissions_held'), false, 'only the admin and whoever manages that folder')
    assert.equal((await h.other('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 404)
    assert.equal((await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 200)
    assert.equal((await h.other('GET', h.url('/api/note', { path: 'familia/tarta.md' }))).status, 200, 'released: the folder it\'s in applies')
  } finally { await h.close() }
})

test('a folder with its own rules renamed outside thoth: its notes are held, and «move its permissions» takes the rules where it went', async () => {
  const h = await setup({ files: { ...FILES, 'familia/viajes/roma.md': '# Roma\n\nPalabra Coliseo.\n' }, config: RULES + `  familia/viajes:\n    grants: { ${subject(M)}: manage }\n` })
  try {
    renameSync(join(h.notesDir, 'familia/viajes'), join(h.notesDir, 'familia/rutas'))
    h.runtime.rescan({})
    assert.equal((await h.other('GET', h.url('/api/note', { path: 'familia/rutas/roma.md' }))).status, 404, 'it would have inherited familia/: held instead')
    assert.equal((await h.member('GET', h.url('/api/note', { path: 'familia/rutas/roma.md' }))).status, 404)
    const held = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; id: string; to: string | null; actions: string[] }[]).find((a) => a.code === 'permissions_held')!
    assert.deepEqual([held.to, held.actions], ['familia/rutas', ['move_permissions', 'release']])
    const warnings = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[] }[]).find((a) => a.code === 'config_warnings')?.warnings ?? []
    assert.ok(warnings.some((w) => w.code === 'missing_folder' && w.detail === 'familia/viajes'))
    const r = await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'move_permissions' })
    assert.equal(r.status, 200, r.text)
    assert.match(readFileSync(join(h.notesDir, 'thoth.yaml'), 'utf8'), new RegExp(ruleRe('familia/rutas', [[M, 'manage']]), 'u'))
    assert.equal((await h.member('GET', h.url('/api/note', { path: 'familia/rutas/roma.md' }))).status, 200)
    assert.equal((await h.other('GET', h.url('/api/note', { path: 'familia/rutas/roma.md' }))).status, 404, 'the same audience as before')
  } finally { await h.close() }
})
