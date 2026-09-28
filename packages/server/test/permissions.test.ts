// Per-folder permissions for people (M4, D-038): the scenario of the spec
// (§7) through the HTTP API, the permissions API, folders with their rules,
// the trash, the history at `edit`, and what fails closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ADMIN, DIR, FILES, GROUP, MEMBER, NAME, NOBODY, OTHER, PATH, RULES, TAG, WORD, home, setup, type Name } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const paths = (list: { path: string }[]) => list.map((n) => n.path).sort()
/** Sorted as vihko lists paths (SQLite's `order by path`, byte order: the same as JavaScript's for these). */
const sorted = (list: string[]) => [...list].sort()

// The scenario's people (_m4.ts): their usernames and personal folders.
const [A, M, O] = [ADMIN.username, MEMBER.username, OTHER.username]
const HOME = { admin: home(A), member: home(M), other: home(O), nobody: home(NOBODY) }
/** The member's recipes folder (where the cake is). */
const RECIPES = dirname(PATH.cake)
/** A link to a note by its name. */
const link = (name: string) => `[[${name}]]`

/** A key as vihko writes it in vihko.yaml (core's yamlKey): plain when it reads back the same, quoted otherwise. */
const written = (key: string, plain: RegExp) => (plain.test(key) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(key) && !/^[\d.+-]/.test(key) ? key : JSON.stringify(key))
/** A subject (user or group) as vihko writes it. */
const subject = (s: string) => written(s, /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u)
/** A folder key as vihko writes it. */
const folderKey = (f: string) => written(f, /^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*(?<! )$/u)
/** `text` for a regular expression that matches it literally (valid with the `u` flag). */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** The folder itself or anything under it. */
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
/** Whether `text` names `name` as a whole (not inside a longer name). */
const mentions = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}._-])${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u').test(text)
/** A rule line as vihko writes it: `folder:` and its grants in a flow map, in order. */
const ruleRe = (folder: string, grants: [string, string][]) =>
  `${literally(folderKey(folder))}:\\n {4}grants: \\{ ${grants.map(([s, l]) => `${literally(subject(s))}: ${l}`).join(', ')} \\}\\n`
/** A rule a test adds to vihko.yaml, written as vihko would. */
const rule = (folder: string, grants: [string, string][]) => `  ${folderKey(folder)}:\n    grants: { ${grants.map(([s, l]) => `${subject(s)}: ${l}`).join(', ')} }\n`
/** A note's text with a word to find it by. */
const noteText = (word = m.aUniqueWord()) => `# ${m.aHeading()}\n\n${m.aSentence()} ${word}.\n`

test('§7.1: each person sees their folders and the shared one; the admin doesn\'t read what isn\'t granted', async () => {
  const h = await setup({ files: FILES })
  try {
    const member = (await h.member('GET', '/api/tree')).body
    assert.deepEqual(paths(member.notes), sorted([PATH.list, PATH.diary, PATH.cake]))
    assert.deepEqual(member.folders, sorted([DIR.shared, DIR.people, HOME.member, PATH.diaryDir, RECIPES]))
    assert.deepEqual(member.pathOnly, [DIR.people], 'the folder above their own only as the way to it')
    const admin = (await h.admin('GET', '/api/tree')).body
    assert.deepEqual(paths(admin.notes), sorted([PATH.rootPlan, PATH.settings, PATH.list, PATH.adminPlanCased, PATH.adminPlan]))
    assert.ok(!admin.folders.some((f: string) => under(f, HOME.member) || under(f, HOME.other) || f === HOME.nobody), admin.folders.join(', '))
    const other = (await h.other('GET', '/api/tree')).body
    assert.deepEqual(paths(other.notes), sorted([PATH.list, PATH.otherNotes]))

    // Opening one directly: the same as a note that doesn't exist.
    for (const [who, path] of [['admin', PATH.cake], ['member', PATH.settings], ['other', PATH.diary], ['admin', PATH.nobodyNote]] as const) {
      const r = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${who} ${path}`)
      const absent = path.replace(/\.md$/, `-${m.aUniqueWord()}.md`)
      const missing = await h.as(who)('GET', h.url('/api/note', { path: absent }))
      assert.equal(missing.text.replaceAll(JSON.stringify(absent).slice(1, -1), JSON.stringify(path).slice(1, -1)), r.text, 'no access and no note answer alike')
    }

    // A link to a note one can't read: `no_access`, no path, no title, no candidates (D-024).
    const kLinks = (await h.admin('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const out = Object.fromEntries(kLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    const cake = out[link(NAME.cake)]
    assert.deepEqual([cake.status, cake.dst_path, cake.reason], ['no_access', null, undefined])
    assert.equal(out['[[2026-09-27]]'].status, 'no_access')
    assert.notEqual(out[link(NAME.plan)].status, 'no_access', 'the admin\'s own notes are candidates for them')
    assert.deepEqual(paths(kLinks.backlinks), sorted([PATH.settings, PATH.adminPlan]))
    const lLinks = (await h.member('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const lout = Object.fromEntries(lLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([lout[link(NAME.cake)].status, lout[link(NAME.cake)].dst_path], ['resolved', PATH.cake])
    assert.deepEqual([lout[link(NAME.plan)].status, lout[link(NAME.plan)].candidates], ['no_access', null])
    assert.deepEqual(paths(lLinks.backlinks), sorted([PATH.diary, PATH.cake]))

    // Search, tags and their counts: only what each one reads.
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: WORD.diary }))).body.results, [])
    assert.deepEqual(paths((await h.member('GET', h.url('/api/search', { q: WORD.diary }))).body.results), [PATH.diary])
    const tags = async (who: Name) => Object.fromEntries(((await h.as(who)('GET', '/api/tags')).body.tags as { tag: string; count: number }[]).map((t) => [t.tag, t.count]))
    assert.deepEqual(await tags('admin'), { [TAG.home]: 1 })
    assert.deepEqual(await tags('member'), { [TAG.home]: 2, [TAG.intimate]: 1 })

    // Images have their folder's permission.
    assert.equal((await h.other('GET', h.url('/api/file', { path: PATH.photo }))).status, 200)
    assert.equal((await h.admin('GET', h.url('/api/file', { path: PATH.memberPhoto }))).status, 404)
  } finally { await h.close() }
})

test('§7.2: the member shares a folder of theirs with the admin to comment; the admin reads, can\'t edit or see its history', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = RECIPES
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    assert.equal(before.own, null)
    assert.deepEqual(before.effective, { from: HOME.member, rule: `${DIR.people}/{user}`, grants: { [M]: 'manage' } })
    assert.equal(before.canEdit, true)
    assert.deepEqual(before.access.map((a: { username: string; level: string }) => [a.username, a.level]), [[M, 'manage']])
    // Someone who can't see it: it doesn't exist. The other member can't; the admin neither, admin as they are? They manage permissions anywhere (D-038.1).
    assert.equal((await h.other('GET', h.url('/api/permissions', { folder }))).status, 404)
    assert.equal((await h.admin('GET', h.url('/api/permissions', { folder }))).status, 200, 'the admin manages every folder\'s permissions')

    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [A]: 'comment' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual(put.body.own, { rule: folder, user: null, grants: { [M]: 'manage', [A]: 'comment' }, ai: false })
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES), 'the rest of the file stays as it was')
    assert.match(yaml.slice(RULES.length), new RegExp(`^ {2}${ruleRe(folder, [[M, 'manage'], [A, 'comment']])}$`, 'u'))
    // A stale ETag: 412, nothing written.
    const stale = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage' }, ifMatch: before.etag })
    assert.deepEqual([stale.status, stale.body.error], [412, 'precondition_failed'])

    const cake = h.url('/api/note', { path: PATH.cake })
    const read = await h.admin('GET', cake)
    assert.equal(read.status, 200)
    const write = await h.admin('PUT', cake, { text: m.aParagraph() }, { 'if-match': `"${read.body.etag}"` })
    assert.deepEqual([write.status, write.body.error], [403, 'forbidden'], 'they see it: forbidden, not not_found')
    const hist = await h.admin('GET', h.url('/api/history/versions', { path: PATH.cake }))
    assert.deepEqual([hist.status, hist.body.error], [403, 'forbidden'])
    assert.equal((await h.member('GET', h.url('/api/history/versions', { path: PATH.cake }))).status, 200)
    const access = h.policy.for({ kind: 'user', user: h.users.admin })
    assert.deepEqual([access.canRead(PATH.cake), access.canComment(PATH.cake), access.canWrite(PATH.cake)], [true, true, false])
    // Only what's shared: the rest of their folder isn't.
    assert.equal((await h.admin('GET', h.url('/api/note', { path: PATH.diary }))).status, 404)
    // The other member doesn't manage it: no grant lets them see or change its permissions (the admin does, as admin).
    assert.equal((await h.other('PUT', '/api/permissions', { folder, grants: {}, ifMatch: put.body.etag })).status, 404)
  } finally { await h.close() }
})

test('a personal folder ({user} rule) closed to agents or shared, then restored, never falls through to the root\'s grants', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = HOME.member
    const note = h.url('/api/note', { path: PATH.cake })
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    assert.deepEqual(before.userRule, { rule: `${DIR.people}/{user}`, user: M, grants: { [M]: 'manage' } })
    // Closed to agents: a literal rule with only `ai: false`; the {user} rule's grants stay.
    const closed = await h.member('PUT', '/api/permissions', { folder, ai: false, ifMatch: before.etag })
    assert.equal(closed.status, 200, closed.text)
    assert.deepEqual([closed.body.own, closed.body.ai], [{ rule: folder, user: null, grants: null, ai: true }, { closed: true, from: folder }])
    assert.deepEqual(closed.body.effective, { from: folder, rule: `${DIR.people}/{user}`, grants: { [M]: 'manage' } })
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
    // Moved from vihko, the folder takes the {user} rule's grants along as a literal copy.
    const to = `${HOME.member}/${m.aFolder()}`
    const moved = await h.member('POST', '/api/folder/move', { from: RECIPES, to })
    assert.equal(moved.status, 200, moved.text)
    assert.equal((await h.member('GET', h.url('/api/note', { path: `${to}/${basename(PATH.cake)}` }))).status, 200)
  } finally { await h.close() }
})

test('§7.3: moving a note says who loses or gains access before moving it', async () => {
  const h = await setup({ files: FILES })
  try {
    const to = `${HOME.admin}/${basename(PATH.list)}`
    const r = await h.admin('POST', '/api/note/move', { from: PATH.list, to, dryRun: true })
    assert.equal(r.status, 200, r.text)
    // audience.ts lists them by username, with localeCompare.
    assert.deepEqual(r.body.audience.users.lose.map((u: { username: string }) => u.username), [M, O].sort((a, b) => a.localeCompare(b)))
    assert.deepEqual(r.body.audience.users.gain, [])
    assert.deepEqual(r.body.audience.groups, { gain: [], lose: [GROUP] })
    // The report names no note they can't see (links in the member's notes are rewritten all the same, as the system).
    assert.equal(r.body.hidden, true)
    assert.ok(!r.text.includes(`${HOME.member}/`), r.text)
    // Keys are counted, never named.
    await h.enable()
    await h.newKey('member', { name: m.aKeyName() })
    const again = await h.admin('POST', '/api/note/move', { from: PATH.list, to, dryRun: true })
    assert.deepEqual(again.body.audience.keys, { gain: 0, lose: 1 })
  } finally { await h.close() }
})

test('§7.4: the member\'s key doesn\'t see their diary; the admin\'s sees nothing of the member\'s, and says why when named', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enable()
    const memberKey = h.withKey((await h.newKey('member', { name: m.aKeyName() })).token)
    const adminKey = h.withKey((await h.newKey('admin', { name: m.aKeyName() })).token)
    const lt = (await memberKey('GET', '/api/tree')).body
    assert.deepEqual(paths(lt.notes), sorted([PATH.list, PATH.cake]))
    assert.ok(!lt.folders.includes(PATH.diaryDir), 'a folder closed to agents doesn\'t show')
    const diary = await memberKey('GET', h.url('/api/note', { path: PATH.diary }))
    assert.deepEqual([diary.status, diary.body.error, diary.body.reason], [403, 'agent_denied', 'ai_false'])
    const theirs = await adminKey('GET', h.url('/api/note', { path: PATH.cake }))
    assert.deepEqual([theirs.status, theirs.body.error, theirs.body.reason], [403, 'agent_denied', 'user_no_access'])
    assert.deepEqual((await adminKey('GET', h.url('/api/search', { q: WORD.cake }))).body.results, [])
    const nothing = await adminKey('GET', h.url('/api/note', { path: m.aNotePath(HOME.member) }))
    assert.deepEqual([nothing.status, nothing.body.error], [404, 'not_found'], 'a note that isn\'t there is still not_found')
    // Its links to what its user can't see: `no_access`, with the reason.
    const links = (await adminKey('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const cake = links.outgoing.find((l: { raw: string }) => l.raw === link(NAME.cake))
    assert.deepEqual([cake.status, cake.reason], ['no_access', 'user_no_access'])
  } finally { await h.close() }
})

test('§7.6 (P\'s part): deleting a person removes their grants; their folder is nobody\'s, never the root\'s', async () => {
  const shared = `${DIR.shared}/${m.aFolder()}`
  const h = await setup({ files: FILES, config: RULES + rule(shared, [[O, 'edit'], [M, 'read']]) })
  try {
    await h.services.permissionsFile.removeSubjectGrants(O, { actor: { kind: 'user', id: h.users.admin.id } })
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.match(yaml, new RegExp(ruleRe(shared, [[M, 'read']]), 'u'))
    assert.ok(yaml.startsWith(RULES))
    // Piece U deletes the account: then the other member's personal folder matches nobody.
    h.index.prepare('select 1').get()
    const state = (h.auth as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    state.prepare('delete from users where id = ?').run(h.users.other.id)
    for (const who of ['admin', 'member'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: PATH.otherNotes }))).status, 404, who)
    }
  } finally { await h.close() }
})

test('§7.8: renaming a note linked from notes the renamer can\'t see: the report doesn\'t name them, the links are rewritten', async () => {
  const h = await setup({ files: FILES })
  try {
    const title = m.aTitle()
    const to = `${DIR.shared}/${title}.md`
    const preview = await h.admin('POST', '/api/note/move', { from: PATH.list, to, dryRun: true })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.hidden, true)
    assert.deepEqual(paths(preview.body.relinked), sorted([PATH.settings, PATH.adminPlan]))
    assert.ok(!mentions(preview.text, M), preview.text)
    const done = await h.admin('POST', '/api/note/move', { from: PATH.list, to })
    assert.equal(done.status, 200)
    assert.ok(!mentions(done.text, M), done.text)
    assert.ok(readFileSync(join(h.notesDir, PATH.cake), 'utf8').includes(link(title)), 'rewritten as the system (D-018)')
  } finally { await h.close() }
})

test('the permissions API: who sees and changes what, ai, the implicit section, {user} rules, and effective access', async () => {
  const templates = m.aFolder()
  const h = await setup({ files: FILES, config: `templates: ${JSON.stringify(templates)}   # kept\n` })
  try {
    // No section: the implicit one, every admin managing the root; the first change writes it.
    const root = (await h.admin('GET', h.url('/api/permissions', { folder: '' }))).body
    assert.equal(root.section, 'implicit')
    assert.deepEqual(root.effective.grants, { [A]: 'manage' })
    assert.equal((await h.member('GET', h.url('/api/permissions', { folder: DIR.shared }))).status, 404)
    const put = await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { [`@${GROUP}`]: 'edit' }, ifMatch: root.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), `templates: ${JSON.stringify(templates)}   # kept\npermissions:\n  "":\n    grants: { ${subject(A)}: manage }\n${rule(DIR.shared, [[`@${GROUP}`, 'edit']])}`)
    assert.equal(put.body.canEdit, true, 'the admin changes any folder\'s')
    // Now the member edits the shared folder but doesn't manage it: they see it, can't see or change its permissions.
    assert.deepEqual([(await h.member('GET', h.url('/api/permissions', { folder: DIR.shared }))).status], [403])
    assert.equal((await h.member('PUT', '/api/permissions', { folder: DIR.shared, grants: {}, ifMatch: put.body.etag })).status, 403)
    // Invalid subjects and levels, and the ETag is required.
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { [M]: 'owner' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { '{user}': 'read' }, ifMatch: put.body.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: {} })).status, 428)
    // A {user} rule, only the admin; a manager of a folder under it changes its own rule.
    const perUser = `${DIR.people}/{user}`
    const p1 = await h.admin('PUT', '/api/permissions', { folder: perUser, grants: { '{user}': 'manage' }, ifMatch: put.body.etag })
    assert.equal(p1.status, 200, p1.text)
    assert.equal((await h.member('GET', h.url('/api/permissions', { folder: perUser }))).status, 404)
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: HOME.member }))).body
    assert.deepEqual(mine.own, { rule: perUser, user: M, grants: { '{user}': 'manage' }, ai: false })
    // ai: false, by whoever manages it; inherited below, not undone there.
    const ai = await h.member('PUT', '/api/permissions', { folder: PATH.diaryDir, ai: false, ifMatch: mine.etag })
    assert.equal(ai.status, 200, ai.text)
    const below = (await h.member('GET', h.url('/api/permissions', { folder: `${PATH.diaryDir}/${m.aFolder()}` }))).body
    assert.deepEqual(below.ai, { closed: true, from: PATH.diaryDir })
    // Restore inheritance: grants null.
    const inherit = await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: null, ifMatch: ai.body.etag })
    assert.equal(inherit.body.own, null)
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 404, 'back to the root\'s: the admin\'s only')

    // Effective access: the admin sees anyone's (folder names only); a person, their own and their keys'.
    const memberAccess = (await h.admin('GET', h.url('/api/permissions/access', { user: h.users.member.id }))).body
    assert.deepEqual(memberAccess.folders.map((f: { folder: string }) => f.folder), sorted([HOME.member, PATH.diaryDir, RECIPES]))
    assert.equal((await h.member('GET', h.url('/api/permissions/access', { user: h.users.admin.id }))).status, 403)
    await h.enable()
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const keyAccess = (await h.member('GET', h.url('/api/permissions/access', { key: key.key.id }))).body
    assert.deepEqual(keyAccess.folders, sorted([HOME.member, RECIPES]).map((folder) => ({ folder, level: 'edit' })), 'not the folder closed to agents')
    assert.equal((await h.other('GET', h.url('/api/permissions/access', { key: key.key.id }))).status, 404)
    // Folders: the admin, every name; the member, those they see.
    const all = (await h.admin('GET', '/api/permissions/folders')).body.folders.map((f: { path: string }) => f.path)
    assert.ok(all.includes(PATH.diaryDir) && all.includes(HOME.nobody))
    const lf = (await h.member('GET', '/api/permissions/folders')).body.folders as { path: string; ownGrants: boolean; aiClosed: boolean }[]
    assert.deepEqual(lf.map((f) => f.path), sorted([HOME.member, PATH.diaryDir, RECIPES]))
    assert.deepEqual(lf.find((f) => f.path === PATH.diaryDir), { path: PATH.diaryDir, level: 'manage', ownGrants: false, aiClosed: true, canEdit: true })
  } finally { await h.close() }
})

test('D-040 3.5: a co-manager can\'t be locked out of a subfolder; the admin managing the root never gets into a personal folder', async () => {
  const trips = `${DIR.shared}/${m.aFolder()}`
  const folder = `${trips}/${m.aFolder()}`
  const gift = m.aNotePath(folder)
  const giftWord = m.aUniqueWord()
  const secret = `${RECIPES}/${m.aFolder()}`
  const bread = m.aNotePath(secret)
  const h = await setup({
    files: { ...FILES, [gift]: noteText(giftWord), [bread]: noteText() },
    config: RULES + rule(trips, [[M, 'manage'], [O, 'manage']]),
  })
  try {
    const giftUrl = h.url('/api/note', { path: gift })
    // The member closes a subfolder to everyone but them: the other, who manages the folder above with them, keeps managing it.
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal((await h.other('GET', giftUrl)).status, 200)
    const seen = await h.other('GET', h.url('/api/permissions', { folder }))
    assert.equal(seen.status, 200, seen.text)
    assert.equal(seen.body.canEdit, true)
    assert.equal(seen.body.personal, null)
    assert.deepEqual(seen.body.managedAbove, [{ subject: M, from: trips }, { subject: O, from: trips }, { subject: A, from: '' }])
    // Why: they manage the trips folder. And they can put themselves back.
    const other = seen.body.access.find((a: { username: string }) => a.username === O)
    assert.deepEqual(other, { id: h.users.other.id, username: O, level: 'manage', via: [{ subject: O, level: 'manage', from: trips, above: true }] })
    const back = await h.other('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [O]: 'edit' }, ifMatch: seen.body.etag })
    assert.equal(back.status, 200, back.text)
    // The admin manages the root: they read it too, lists and direct reads alike.
    assert.equal((await h.admin('GET', giftUrl)).status, 200)
    assert.ok((await h.admin('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === gift))
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: giftWord }))).body.results.map((r: { path: string }) => r.path), [gift])

    // A subfolder of a personal folder with grants of its own that leave its owner out: they still manage it.
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: RECIPES }))).body
    const shared = await h.member('PUT', '/api/permissions', { folder: RECIPES, grants: { [O]: 'read' }, ifMatch: mine.etag })
    assert.equal(shared.status, 200, shared.text)
    assert.equal(shared.body.canEdit, true, 'they manage their personal folder: not locked out')
    assert.equal(shared.body.personal, HOME.member)
    assert.deepEqual(shared.body.managedAbove, [{ subject: M, from: HOME.member, rule: `${DIR.people}/{user}` }])
    assert.equal((await h.member('GET', h.url('/api/note', { path: bread }))).status, 200)
    assert.equal(h.policy.for({ kind: 'user', user: h.users.member }).canManage(secret), true)
    assert.equal((await h.other('GET', h.url('/api/note', { path: PATH.cake }))).status, 200)

    // The admin with manage on the root reads nothing of the member's personal folder, nor under it, however its subfolders are set.
    for (const path of [PATH.cake, bread, PATH.diary]) {
      assert.equal((await h.admin('GET', h.url('/api/note', { path }))).status, 404, path)
    }
    assert.ok(!(await h.admin('GET', '/api/tree')).body.folders.some((f: string) => under(f, HOME.member)))
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: WORD.cake }))).body.results, [])
    const kAccess = h.policy.for({ kind: 'user', user: h.users.admin })
    assert.deepEqual([HOME.member, RECIPES, secret, HOME.nobody].map((f) => kAccess.level(f)), [null, null, null, null])
    // They still see and change its permissions as the admin (folder names, never contents), and a grant to themselves is explicit.
    const asAdmin = (await h.admin('GET', h.url('/api/permissions', { folder: RECIPES }))).body
    assert.equal(asAdmin.canEdit, true)
    assert.ok(!asAdmin.access.some((a: { username: string }) => a.username === A))
    const reached = (await h.admin('GET', h.url('/api/permissions/access', { user: h.users.admin.id }))).body.folders.map((f: { folder: string }) => f.folder)
    assert.ok(reached.includes(folder) && !reached.some((f: string) => under(f, HOME.member)), reached.join(', '))
  } finally { await h.close() }
})

test('permissions fail closed: rejected at start, nobody reads; rejected while running, the last valid stay; unknown subjects are ignored with a warning', async () => {
  const bad = RULES.replace(`grants: { ${yamlKey(A)}: manage }`, `grants: { ${yamlKey(A)}: owner }`)
  assert.notEqual(bad, RULES)
  // Subjects nobody is: a user and a group; and a folder that isn't there.
  const [nobody, noGroup] = [m.aUsername(), m.aGroupName()]
  const extra = `${DIR.shared}/${m.aFolder()}`
  const h = await setup({ files: FILES, config: bad })
  try {
    for (const who of ['admin', 'member'] as const) assert.deepEqual((await h.as(who)('GET', '/api/tree')).body.notes, [], who)
    const alerts = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.deepEqual(alerts.find((a) => a.code === 'permissions_rejected'), { code: 'permissions_rejected', fallback: 'closed', actions: [] })
    assert.ok(alerts.some((a) => a.code === 'config_warnings'))
    assert.deepEqual(((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).map((a) => a.code), [], 'the system\'s alerts are the admin\'s')
    // vihko doesn't write over a section it can't read.
    const etag = (await h.admin('GET', h.url('/api/permissions', { folder: '' }))).body.etag
    assert.deepEqual([(await h.admin('PUT', '/api/permissions', { folder: m.aFolder(), grants: {}, ifMatch: etag })).body.error], ['config_invalid'])

    // Fixed: it applies. Then broken again while running: the last valid stays.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), RULES + `  ${yamlKey(extra)}:\n    grants: { ${yamlKey(nobody)}: read, ${yamlKey(`@${noGroup}`)}: edit }\n`)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 200)
    const warnings = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[] }[]).find((a) => a.code === 'config_warnings')!.warnings!
    assert.deepEqual(warnings.filter((w) => w.code === 'unknown_subject').map((w) => w.detail), [nobody, `@${noGroup}`])
    assert.ok(warnings.some((w) => w.code === 'missing_folder' && w.detail === extra), 'a rule for a folder that doesn\'t exist')
    writeFileSync(join(h.notesDir, 'vihko.yaml'), bad)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 200)
    const now = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.equal(now.find((a) => a.code === 'permissions_rejected')?.fallback, 'last_good')
  } finally { await h.close() }
})

test('folders: create with edit, move and delete with manage; their rules go with them, and a move says whose access changes', async () => {
  const tripsName = m.aFolder()
  const trips = `${DIR.shared}/${tripsName}`
  const rome = m.aNotePath(trips)
  const h = await setup({ files: { ...FILES, [rome]: noteText() }, config: RULES + rule(trips, [[M, 'manage'], [A, 'read']]) })
  try {
    assert.equal((await h.other('POST', '/api/folder', { path: `${DIR.shared}/${m.aFolder()}` })).status, 201)
    assert.equal((await h.other('POST', '/api/folder', { path: `${DIR.admin}/${m.aFolder()}` })).status, 404)
    // The admin only reads it by their own grants, but they manage the root, and managing keeps reaching under it (D-040 3.5).
    assert.equal((await h.admin('POST', '/api/folder', { path: `${trips}/${m.aFolder()}` })).status, 201, 'they manage it from above')
    assert.equal((await h.other('POST', '/api/folder', { path: `${trips}/${m.aFolder()}` })).status, 404, 'not granted there: they can\'t see it')
    // Moving the trips folder: the member manages it; they need edit where it goes.
    assert.equal((await h.other('POST', '/api/folder/move', { from: trips, to: `${DIR.shared}/${m.aFolder()}` })).status, 404, 'they can\'t see it')
    assert.equal((await h.member('POST', '/api/folder/move', { from: trips, to: `${DIR.admin}/${tripsName}` })).status, 404)
    const to = `${HOME.member}/${tripsName}`
    const dry = await h.member('POST', '/api/folder/move', { from: trips, to, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    assert.deepEqual(dry.body.audience.users, { gain: [], lose: [] }, 'its own rules go with it')
    const moved = await h.member('POST', '/api/folder/move', { from: trips, to })
    assert.equal(moved.status, 200, moved.text)
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES))
    assert.match(yaml, new RegExp(`${ruleRe(to, [[M, 'manage'], [A, 'read']])}$`, 'u'))
    assert.ok(!yaml.includes(trips), yaml)
    assert.equal((await h.admin('GET', h.url('/api/note', { path: `${to}/${basename(rome)}` }))).status, 200, 'the rules went with it')

    // A folder under a {user} rule, renamed: the rule stops matching it, so a literal copy goes with it.
    // (The member can't rename theirs: they have no `edit` in the people's folder, where it would go.)
    assert.equal((await h.member('POST', '/api/folder/move', { from: HOME.member, to: `${DIR.people}/${m.aFolder()}` })).status, 404)
    const renamed = `${DIR.people}/${m.aFolder()}`
    const r2 = await h.admin('POST', '/api/folder/move', { from: HOME.admin, to: renamed })
    assert.equal(r2.status, 200, r2.text)
    assert.equal((await h.admin('GET', h.url('/api/note', { path: `${renamed}/${basename(PATH.adminPlan)}` }))).status, 200)
    assert.match(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), new RegExp(ruleRe(renamed, [[A, 'manage']]), 'u'))

    // Deleting: manage, and empty; its rules go.
    const empty = `${DIR.admin}/${m.aFolder()}`
    assert.equal((await h.admin('POST', '/api/folder', { path: empty })).status, 201)
    assert.equal((await h.member('DELETE', h.url('/api/folder', { path: empty }))).status, 404)
    assert.equal((await h.admin('DELETE', h.url('/api/folder', { path: empty }))).status, 200)
  } finally { await h.close() }
})

test('a move that fails leaves the rules as they were', async () => {
  const trips = `${DIR.shared}/${m.aFolder()}`
  const taken = `${DIR.shared}/${m.aFolder()}`
  const h = await setup({ files: { ...FILES, [m.aNotePath(trips)]: noteText(), [m.aNotePath(taken)]: noteText() }, config: RULES + rule(trips, [[M, 'manage']]) })
  try {
    const before = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    const r = await h.member('POST', '/api/folder/move', { from: trips, to: taken })
    assert.deepEqual([r.status, r.body.error], [409, 'exists'])
    assert.equal(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), before)
  } finally { await h.close() }
})

test('the trash: each person sees what was deleted where they\'d edit, and restores with edit where it goes', async () => {
  const h = await setup({ files: FILES })
  try {
    assert.equal((await h.member('DELETE', h.url('/api/note', { path: PATH.cake }))).status, 200)
    assert.equal((await h.other('DELETE', h.url('/api/note', { path: PATH.list }))).status, 200)
    const trash = async (who: Name) => ((await h.as(who)('GET', '/api/trash')).body.entries as { path: string; id: string }[])
    assert.deepEqual((await trash('member')).map((e) => e.path).sort(), sorted([PATH.list, PATH.cake]))
    assert.deepEqual((await trash('admin')).map((e) => e.path), [PATH.list])
    const theirs = (await trash('member')).find((e) => e.path === PATH.cake)!
    assert.equal((await h.admin('POST', `/api/trash/${theirs.id}/restore`, {})).status, 404)
    assert.equal((await h.member('POST', `/api/trash/${theirs.id}/restore`, { to: `${DIR.admin}/${basename(PATH.cake)}` })).status, 404, 'not where they can\'t write')
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
    await put('member', PATH.cake, `${m.aSentence()}\n`)
    await put('admin', PATH.settings, `${m.aSentence()}\n`)
    const files = async (who: Name) => ((await h.as(who)('GET', '/api/history/changes?limit=100')).body.changes as { files: { path: string }[] }[]).flatMap((c) => c.files.map((f) => f.path))
    const k = await files('admin')
    assert.ok(k.includes(PATH.settings) && !k.some((p) => under(p, HOME.member)) && !k.includes('vihko.yaml'), k.join(', '))
    const l = await files('member')
    assert.ok(l.includes(PATH.cake) && !l.includes(PATH.settings), l.join(', '))
    const authors = (await h.other('GET', '/api/history/changes')).body.authors.map((a: { kind: string }) => a.kind)
    assert.ok(authors.every((k: string) => k !== 'agent' && k !== 'git'))
    // A cursor goes on only with the note it was made for.
    const page = (await h.member('GET', h.url('/api/history/versions', { path: PATH.cake, limit: '1' }))).body
    assert.ok(page.next)
    const other = await h.member('GET', h.url('/api/history/versions', { path: PATH.list, cursor: page.next }))
    assert.deepEqual([other.status, other.body.error], [400, 'invalid'])
  } finally { await h.close() }
})

test('a note moved outside vihko out of a folder with its own rules is held from everyone until someone decides', async () => {
  const h = await setup({ files: FILES })
  try {
    // With a shell: the member's recipe (with its uid) lands in the shared folder.
    const landed = `${DIR.shared}/${basename(PATH.cake)}`
    renameSync(join(h.notesDir, PATH.cake), join(h.notesDir, landed))
    h.runtime.rescan({})
    for (const who of ['admin', 'member', 'other'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: landed }))).status, 404, who)
      assert.ok(!(await h.as(who)('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === landed), who)
    }
    const held = ((await h.member('GET', '/api/alerts')).body.alerts as { code: string; id: string; folder: string; to: string | null; notes: number; actions: string[] }[]).find((a) => a.code === 'permissions_held')!
    assert.deepEqual({ ...held, id: '' }, { code: 'permissions_held', id: '', folder: HOME.member, to: null, notes: 1, actions: ['release'] })
    assert.equal(((await h.other('GET', '/api/alerts')).body.alerts as { code: string }[]).some((a) => a.code === 'permissions_held'), false, 'only the admin and whoever manages that folder')
    assert.equal((await h.other('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 404)
    assert.equal((await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 200)
    assert.equal((await h.other('GET', h.url('/api/note', { path: landed }))).status, 200, 'released: the folder it\'s in applies')
  } finally { await h.close() }
})

test('a folder with its own rules renamed outside vihko: its notes are held, and «move its permissions» takes the rules where it went', async () => {
  const trips = `${DIR.shared}/${m.aFolder()}`
  const routes = `${DIR.shared}/${m.aFolder()}`
  const title = m.aTitle()
  const h = await setup({ files: { ...FILES, [`${trips}/${title}.md`]: noteText() }, config: RULES + rule(trips, [[M, 'manage']]) })
  try {
    const note = h.url('/api/note', { path: `${routes}/${title}.md` })
    renameSync(join(h.notesDir, trips), join(h.notesDir, routes))
    h.runtime.rescan({})
    assert.equal((await h.other('GET', note)).status, 404, 'it would have inherited the shared folder\'s grants: held instead')
    assert.equal((await h.member('GET', note)).status, 404)
    const held = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; id: string; to: string | null; actions: string[] }[]).find((a) => a.code === 'permissions_held')!
    assert.deepEqual([held.to, held.actions], [routes, ['move_permissions', 'release']])
    const warnings = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[] }[]).find((a) => a.code === 'config_warnings')?.warnings ?? []
    assert.ok(warnings.some((w) => w.code === 'missing_folder' && w.detail === trips))
    const r = await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'move_permissions' })
    assert.equal(r.status, 200, r.text)
    assert.match(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), new RegExp(ruleRe(routes, [[M, 'manage']]), 'u'))
    assert.equal((await h.member('GET', note)).status, 200)
    assert.equal((await h.other('GET', note)).status, 404, 'the same audience as before')
  } finally { await h.close() }
})
