// Per-folder permissions for people (M4, D-038): the scenario of the spec
// (§7) through the HTTP API, the permissions API, folders with their rules,
// the trash, the history at `edit`, and what fails closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ADMIN, DIR, FILES, GROUP, LINK, MEMBER, NAME, NOBODY, OTHER, PATH, RULES, TAG, WORD, home, setup, type Name } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { PermissionHolds } from '@vihko/server'
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

/** FILES with the shared list linking the member's cake by its path (D-056.4): a link into a personal space. */
const LINKED = { ...FILES, [PATH.list]: (FILES[PATH.list] as string).replace(link(NAME.cake), LINK.cake) }

test('§7.1: each person sees their space and the shared one; the admin doesn\'t read what isn\'t granted, nor anything outside the spaces', async () => {
  const h = await setup({ files: LINKED })
  try {
    const member = (await h.member('GET', '/api/tree')).body
    assert.deepEqual(paths(member.notes), sorted([PATH.list, PATH.diary, PATH.cake]))
    assert.deepEqual(member.folders, sorted(['spaces', DIR.shared, DIR.people, HOME.member, PATH.diaryDir, RECIPES]))
    assert.deepEqual(member.pathOnly, sorted([DIR.people, 'spaces']), 'the folders above their spaces only as the way to them')
    const admin = (await h.admin('GET', '/api/tree')).body
    assert.deepEqual(paths(admin.notes), sorted([PATH.settings, PATH.list, PATH.adminPlanCased, PATH.adminPlan]), 'nothing outside the spaces, not even for the admin')
    assert.ok(!admin.folders.some((f: string) => under(f, HOME.member) || under(f, HOME.other) || f === HOME.nobody), admin.folders.join(', '))
    const other = (await h.other('GET', '/api/tree')).body
    assert.deepEqual(paths(other.notes), sorted([PATH.list, PATH.otherNotes]))

    // Opening one directly: the same as a note that doesn't exist.
    for (const [who, path] of [['admin', PATH.cake], ['member', PATH.settings], ['other', PATH.diary], ['admin', PATH.nobodyNote], ['admin', PATH.rootPlan]] as const) {
      const r = await h.as(who)('GET', h.url('/api/note', { path }))
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${who} ${path}`)
      const absent = path.replace(/\.md$/, `-${m.aUniqueWord()}.md`)
      const missing = await h.as(who)('GET', h.url('/api/note', { path: absent }))
      assert.equal(missing.text.replaceAll(JSON.stringify(absent).slice(1, -1), JSON.stringify(path).slice(1, -1)), r.text, 'no access and no note answer alike')
    }

    // A link to a note one can't read is broken for them, as one to a note that doesn't exist: no path, no title, no candidates (D-056.15).
    const kLinks = (await h.admin('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const out = Object.fromEntries(kLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    const cake = out[LINK.cake]
    assert.deepEqual(cake, { raw: cake.raw, kind: 'wiki', target: LINK.cake.slice(2, -2), anchor: null, status: 'missing', dstPath: null, anchorOk: null, candidates: null, posFrom: cake.posFrom })
    assert.equal(out['[[2026-09-27]]'].status, 'missing')
    // A name never reaches another space: not even the admin's own notes are candidates (D-056.4).
    assert.deepEqual([out[link(NAME.plan)].status, out[link(NAME.plan)].candidates], ['missing', null])
    // Links from other spaces never lead here (D-056.30): the admin's notes link the list by path, and it has no backlinks.
    assert.deepEqual(paths(kLinks.backlinks), [])
    const lLinks = (await h.member('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const lout = Object.fromEntries(lLinks.outgoing.map((l: { raw: string }) => [l.raw, l]))
    // The member reads the cake, but a link never leaves its space: from the shared list, broken for them too.
    assert.deepEqual([lout[LINK.cake].status, lout[LINK.cake].dstPath], ['missing', null])
    assert.deepEqual([lout[link(NAME.plan)].status, lout[link(NAME.plan)].candidates], ['missing', null])
    assert.deepEqual(paths(lLinks.backlinks), [])

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
    assert.deepEqual([before.own, before.inherited, before.owner, before.space], [{ grants: null }, [], M, null])
    assert.equal(before.canEdit, true)
    assert.deepEqual(before.access.map((a: { username: string; level: string; via: { owner?: true }[] }) => [a.username, a.level, a.via[0]!.owner]), [[M, 'manage', true]])
    // Someone who can't see it: it doesn't exist. The other member can't; nor the admin, whose role gives nothing here (D-038.1, D-056).
    assert.equal((await h.other('GET', h.url('/api/permissions', { folder }))).status, 404)
    assert.equal((await h.admin('GET', h.url('/api/permissions', { folder }))).status, 404)

    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [A]: 'comment' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual(put.body.own, { grants: { [A]: 'comment' } })
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES), 'the rest of the file stays as it was')
    assert.match(yaml.slice(RULES.length), new RegExp(`^ {2}${ruleRe(folder, [[A, 'comment']])}$`, 'u'))
    // A stale ETag: 412, nothing written.
    const stale = await h.member('PUT', '/api/permissions', { folder, grants: {}, ifMatch: before.etag })
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
    // The other member doesn't manage it: no grant lets them see or change its permissions, nor does the admin.
    assert.equal((await h.other('PUT', '/api/permissions', { folder, grants: {}, ifMatch: put.body.etag })).status, 404)
    // The admin, who comments there, sees the folder but doesn't manage it: forbidden.
    assert.equal((await h.admin('GET', h.url('/api/permissions', { folder }))).status, 403)
    // Taken back: the admin doesn't read it any more.
    assert.equal((await h.member('PUT', '/api/permissions', { folder, grants: null, ifMatch: put.body.etag })).status, 200)
    assert.equal((await h.admin('GET', cake)).status, 404)
  } finally { await h.close() }
})

test('a personal space: its owner manages it whatever is written; closed to agents whole, never shared whole', async () => {
  const h = await setup({ files: FILES })
  try {
    const folder = HOME.member
    const note = h.url('/api/note', { path: PATH.cake })
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    assert.deepEqual([before.own, before.owner, before.canEdit], [{ grants: null }, M, true])
    // Closed to agents: only `ai: false` at its root.
    const closed = await h.member('PUT', '/api/permissions', { folder, ai: false, ifMatch: before.etag })
    assert.equal(closed.status, 200, closed.text)
    assert.deepEqual([closed.body.own, closed.body.ai], [{ grants: null }, { closed: true, from: folder }])
    assert.equal((await h.admin('GET', note)).status, 404, 'the admin gains nothing')
    assert.equal((await h.member('GET', note)).status, 200)
    // Shared whole: refused (that's a shared space, spec §1.2); a folder in it, fine.
    const whole = await h.member('PUT', '/api/permissions', { folder, grants: { [O]: 'read' }, ifMatch: closed.body.etag })
    assert.deepEqual([whole.status, whole.body.error], [400, 'invalid'])
    assert.equal((await h.other('GET', note)).status, 404)
    const recipes = await h.member('PUT', '/api/permissions', { folder: RECIPES, grants: { [O]: 'read' }, ifMatch: closed.body.etag })
    assert.equal(recipes.status, 200, recipes.text)
    assert.deepEqual(recipes.body.ai, { closed: true, from: folder }, 'closed above: it stays so')
    assert.equal((await h.other('GET', note)).status, 200)
    // Written by hand, a grant at a personal root rejects the section (the last valid one stays in force).
    writeFileSync(join(h.notesDir, 'vihko.yaml'), RULES + rule(HOME.member, [[O, 'read']]))
    h.workspace.reload()
    assert.equal(h.workspace.permissionsFallback, 'last_good')
    assert.equal((await h.member('GET', note)).status, 200)
    // Moved from vihko, a folder takes its grants along.
    const to = `${HOME.member}/${m.aFolder()}`
    writeFileSync(join(h.notesDir, 'vihko.yaml'), RULES + rule(RECIPES, [[O, 'read']]))
    h.workspace.reload()
    const moved = await h.member('POST', '/api/folder/move', { from: RECIPES, to })
    assert.equal(moved.status, 200, moved.text)
    assert.equal((await h.other('GET', h.url('/api/note', { path: `${to}/${basename(PATH.cake)}` }))).status, 200)
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
    // Out of a shared space into someone's own: whose it is changes too.
    assert.deepEqual(r.body.audience.owner.after, { kind: 'personal', owner: A })
    assert.equal(r.body.audience.owner.before.kind, 'shared')
    assert.equal(r.body.audience.owner.before.path, DIR.shared)
    // The report names no note they can't see; the member's links to the list come from another space, so they never
    // led to it and the move has nothing of theirs to rewrite or report (D-056.30).
    assert.equal(r.body.hidden, false)
    assert.deepEqual(r.body.brokenLinks, [])
    assert.ok(!r.text.includes(`${HOME.member}/`), r.text)
    // Keys are counted, never named.
    await h.enable()
    await h.newKey('member', { name: m.aKeyName() })
    const again = await h.admin('POST', '/api/note/move', { from: PATH.list, to, dryRun: true })
    assert.deepEqual(again.body.audience.keys, { gain: 0, lose: 1 })
  } finally { await h.close() }
})

test('§7.4: the member\'s key doesn\'t see their diary; the admin\'s sees nothing of the member\'s, not even that it exists (D-056.15)', async () => {
  const h = await setup({ files: LINKED })
  try {
    await h.enable()
    const memberKey = h.withKey((await h.newKey('member', { name: m.aKeyName() })).token)
    const adminKey = h.withKey((await h.newKey('admin', { name: m.aKeyName() })).token)
    const lt = (await memberKey('GET', '/api/tree')).body
    assert.deepEqual(paths(lt.notes), sorted([PATH.list, PATH.cake]))
    assert.ok(!lt.folders.includes(PATH.diaryDir), 'a folder closed to agents doesn\'t show')
    const diary = await memberKey('GET', h.url('/api/note', { path: PATH.diary }))
    assert.deepEqual([diary.status, diary.body.error, diary.body.reason], [403, 'agent_denied', 'ai_false'])
    // What its person can't read doesn't exist for it either (D-056.15).
    const theirs = await adminKey('GET', h.url('/api/note', { path: PATH.cake }))
    assert.deepEqual([theirs.status, theirs.body.error, theirs.body.reason], [404, 'not_found', undefined])
    assert.deepEqual((await adminKey('GET', h.url('/api/search', { q: WORD.cake }))).body.results, [])
    const nothing = await adminKey('GET', h.url('/api/note', { path: m.aNotePath(HOME.member) }))
    assert.deepEqual([nothing.status, nothing.body.error], [404, 'not_found'], 'a note that isn\'t there is still not_found')
    // Its links to what its user can't see: broken, as for its user.
    const links = (await adminKey('GET', h.url('/api/note/links', { path: PATH.list }))).body
    const cake = links.outgoing.find((l: { raw: string }) => l.raw === LINK.cake)
    assert.deepEqual([cake.status, cake.reason, cake.dstPath], ['missing', undefined, null])
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

test('§7.8 (D-056.30): renaming a note that other spaces link by path: those links never led to it, so nothing of theirs is rewritten or named', async () => {
  const h = await setup({ files: FILES })
  try {
    const before = [PATH.cake, PATH.settings, PATH.adminPlan].map((p) => readFileSync(join(h.notesDir, p), 'utf8'))
    const title = m.aTitle()
    const to = `${DIR.shared}/${title}.md`
    const preview = await h.admin('POST', '/api/note/move', { from: PATH.list, to, dryRun: true })
    assert.equal(preview.status, 200)
    assert.deepEqual([preview.body.hidden, preview.body.relinked], [false, []])
    assert.ok(!mentions(preview.text, M), preview.text)
    const done = await h.admin('POST', '/api/note/move', { from: PATH.list, to })
    assert.equal(done.status, 200)
    assert.ok(!mentions(done.text, M), done.text)
    assert.deepEqual([PATH.cake, PATH.settings, PATH.adminPlan].map((p) => readFileSync(join(h.notesDir, p), 'utf8')), before, 'nothing rewritten across spaces')
  } finally { await h.close() }
})

test('the permissions API: who sees and changes what, what reaches a folder from above, ai, a legacy space name kept, and effective access', async () => {
  const name = m.aSpaceName()
  const config = RULES.replace(`  ${yamlKey(DIR.shared)}:\n`, `  ${yamlKey(DIR.shared)}:\n    name: ${JSON.stringify(name)}\n`)
  assert.notEqual(config, RULES)
  const h = await setup({ files: FILES, config })
  try {
    const root = (await h.admin('GET', h.url('/api/permissions', { folder: DIR.shared }))).body
    assert.deepEqual([root.section, root.own, root.inherited, root.owner, root.space, root.canEdit], ['rules', { grants: { [`@${GROUP}`]: 'edit', [A]: 'manage' } }, [], null, { path: DIR.shared, name: DIR.shared.slice('spaces/'.length) }, true])
    assert.deepEqual(root.access.map((a: { username: string; level: string }) => [a.username, a.level]).sort(), [[A, 'manage'], [M, 'edit'], [O, 'edit']].sort())
    // The member edits the shared space but doesn't manage it: they see it, can't see or change who it's shared with.
    assert.deepEqual([(await h.member('GET', h.url('/api/permissions', { folder: DIR.shared }))).status], [403])
    assert.equal((await h.member('PUT', '/api/permissions', { folder: DIR.shared, grants: {}, ifMatch: root.etag })).status, 403)
    // Nobody's: outside the spaces, the root, a person folder of nobody.
    for (const folder of ['', 'people', 'spaces', HOME.nobody]) assert.equal((await h.admin('GET', h.url('/api/permissions', { folder }))).status, 404, folder)
    // Invalid subjects and levels, and the ETag is required.
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { [M]: 'owner' }, ifMatch: root.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { '{user}': 'read' }, ifMatch: root.etag })).status, 400)
    assert.equal((await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: {} })).status, 428)
    // A subfolder: what reaches it from above is listed, and stays whatever it says (grants only add).
    const sub = `${DIR.shared}/${m.aFolder()}`
    const shared = await h.admin('PUT', '/api/permissions', { folder: sub, grants: { [M]: 'manage' }, ifMatch: root.etag })
    assert.equal(shared.status, 200, shared.text)
    assert.deepEqual(shared.body.inherited, [{ from: DIR.shared, grants: { [`@${GROUP}`]: 'edit', [A]: 'manage' } }])
    assert.equal((await h.member('GET', h.url('/api/permissions', { folder: sub }))).body.canEdit, true, 'the member manages it now')
    // Changing the space's members keeps the name rc.1 or rc.2 wrote (for the start that renames its folder to it, D-056.33); the space's name is its folder's.
    const again = await h.admin('PUT', '/api/permissions', { folder: DIR.shared, grants: { [`@${GROUP}`]: 'comment', [A]: 'manage' }, ifMatch: shared.body.etag })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.body.space.name, DIR.shared.slice('spaces/'.length))
    assert.ok(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8').includes(name))
    // ai: false, by whoever manages it; inherited below, not undone there.
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: PATH.diaryDir }))).body
    const below = (await h.member('GET', h.url('/api/permissions', { folder: `${PATH.diaryDir}/${m.aFolder()}` }))).body
    assert.deepEqual([mine.ai, below.ai], [{ closed: true, from: PATH.diaryDir }, { closed: true, from: PATH.diaryDir }])
    const open = await h.member('PUT', '/api/permissions', { folder: PATH.diaryDir, ai: null, ifMatch: again.body.etag })
    assert.deepEqual(open.body.ai, { closed: false, from: null })
    // Grants null: the folder has none of its own; what reaches it from above stays.
    const none = await h.admin('PUT', '/api/permissions', { folder: sub, grants: null, ifMatch: open.body.etag })
    assert.deepEqual(none.body.own, { grants: null })
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 200)

    // Effective access: the admin sees anyone's, but only among the folders they read too; a person, their own and their keys'.
    const memberAccess = (await h.admin('GET', h.url('/api/permissions/access', { user: h.users.member.id }))).body
    assert.deepEqual(memberAccess.folders.map((f: { folder: string }) => f.folder), [DIR.shared])
    assert.equal((await h.member('GET', h.url('/api/permissions/access', { user: h.users.admin.id }))).status, 403)
    await h.enable()
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const keyAccess = (await h.member('GET', h.url('/api/permissions/access', { key: key.key.id }))).body
    assert.deepEqual(keyAccess.folders.map((f: { folder: string }) => f.folder), sorted([HOME.member, PATH.diaryDir, RECIPES, DIR.shared]))
    assert.equal((await h.other('GET', h.url('/api/permissions/access', { key: key.key.id }))).status, 404)
    // Folders: each person, those they see; the admin too (D-056: the admin doesn't see the names of folders in others' spaces).
    const all = (await h.admin('GET', '/api/permissions/folders')).body.folders.map((f: { path: string }) => f.path)
    assert.ok(!all.includes(PATH.diaryDir) && !all.includes(HOME.nobody) && !all.includes(HOME.member), all.join(', '))
    const lf = (await h.member('GET', '/api/permissions/folders')).body.folders as { path: string; ownGrants: boolean; aiClosed: boolean }[]
    assert.deepEqual(lf.map((f) => f.path), sorted([HOME.member, PATH.diaryDir, RECIPES, DIR.shared]))
    assert.deepEqual(lf.find((f) => f.path === PATH.diaryDir), { path: PATH.diaryDir, level: 'manage', ownGrants: false, aiClosed: false, canEdit: true })
    assert.equal(lf.find((f) => f.path === DIR.shared)!.ownGrants, true)
  } finally { await h.close() }
})

test('sharing only adds (D-056.7): nobody is taken out of a subfolder they reach from above, and a lower grant there changes nothing', async () => {
  const trips = `${DIR.shared}/${m.aFolder()}`
  const folder = `${trips}/${m.aFolder()}`
  const gift = m.aNotePath(folder)
  const h = await setup({ files: { ...FILES, [gift]: noteText() }, config: RULES + rule(trips, [[M, 'manage'], [O, 'manage']]) })
  try {
    const giftUrl = h.url('/api/note', { path: gift })
    // The member writes the subfolder's grants leaving the other out: the other still manages it, from the folder above.
    const before = (await h.member('GET', h.url('/api/permissions', { folder }))).body
    const put = await h.member('PUT', '/api/permissions', { folder, grants: { [M]: 'manage', [O]: 'read' }, ifMatch: before.etag })
    assert.equal(put.status, 200, put.text)
    assert.equal((await h.other('GET', giftUrl)).status, 200)
    const seen = (await h.other('GET', h.url('/api/permissions', { folder }))).body
    assert.equal(seen.canEdit, true)
    const other = seen.access.find((a: { username: string }) => a.username === O)
    assert.equal(other.level, 'manage')
    assert.deepEqual(other.via.map((v: { from: string; level: string }) => [v.from, v.level]), [[DIR.shared, 'edit'], [trips, 'manage'], [folder, 'read']])
    // Whoever manages the space manages everything in it.
    assert.equal(h.policy.for({ kind: 'user', user: h.users.admin }).canManage(folder), true)
    // A grant in someone's own space never locks its owner out.
    const mine = (await h.member('GET', h.url('/api/permissions', { folder: RECIPES }))).body
    const shared = await h.member('PUT', '/api/permissions', { folder: RECIPES, grants: { [O]: 'read' }, ifMatch: mine.etag })
    assert.equal(shared.body.canEdit, true)
    assert.equal(h.policy.for({ kind: 'user', user: h.users.member }).canManage(`${RECIPES}/${m.aFolder()}`), true)
    // The admin reads nothing of the member's space, whatever is shared in it with others.
    for (const path of [PATH.cake, PATH.diary]) assert.equal((await h.admin('GET', h.url('/api/note', { path }))).status, 404, path)
    assert.deepEqual((await h.admin('GET', h.url('/api/search', { q: WORD.cake }))).body.results, [])
    assert.deepEqual([HOME.member, RECIPES, HOME.nobody].map((f) => h.policy.for({ kind: 'user', user: h.users.admin }).level(f)), [null, null, null])
  } finally { await h.close() }
})

test('permissions fail closed: rejected at start, nothing is shared (each keeps their own space); rejected while running, the last valid stay; unknown subjects are ignored with a warning', async () => {
  const bad = RULES.replace(`grants: { ${yamlKey(A)}: manage }`, `grants: { ${yamlKey(A)}: owner }`)
  assert.notEqual(bad, RULES)
  // Subjects nobody is: a user and a group; and a folder that isn't there.
  const [nobody, noGroup] = [m.aUsername(), m.aGroupName()]
  const extra = `${DIR.shared}/${m.aFolder()}`
  const h = await setup({ files: FILES, config: bad })
  try {
    assert.deepEqual(paths((await h.admin('GET', '/api/tree')).body.notes), sorted([PATH.adminPlan, PATH.adminPlanCased]), 'the admin: their own space, nothing shared')
    assert.deepEqual(paths((await h.member('GET', '/api/tree')).body.notes), sorted([PATH.diary, PATH.cake]))
    const alerts = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.deepEqual(alerts.find((a) => a.code === 'permissions_rejected'), { code: 'permissions_rejected', fallback: 'closed', actions: [] })
    assert.ok(alerts.some((a) => a.code === 'config_warnings'))
    assert.deepEqual(((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).map((a) => a.code), [], 'the system\'s alerts are the admin\'s')
    // vihko doesn't write over a section it can't read.
    const folder = `${HOME.admin}/${m.aFolder()}`
    const etag = (await h.admin('GET', h.url('/api/permissions', { folder }))).body.etag
    assert.deepEqual([(await h.admin('PUT', '/api/permissions', { folder, grants: {}, ifMatch: etag })).body.error], ['config_invalid'])

    // Fixed: it applies. Then broken again while running: the last valid stays.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), RULES + `  ${yamlKey(extra)}:\n    grants: { ${yamlKey(nobody)}: read, ${yamlKey(`@${noGroup}`)}: edit }\n`)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 200)
    const now1 = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; warnings?: { code: string; detail: string }[]; folders?: string[] }[]
    const warnings = now1.find((a) => a.code === 'config_warnings')!.warnings!
    assert.deepEqual(warnings.filter((w) => w.code === 'unknown_subject').map((w) => w.detail), [nobody, `@${noGroup}`])
    // A rule for a folder that doesn't exist: told to whoever manages its space (the admin here, as its manager).
    assert.deepEqual(now1.find((a) => a.code === 'missing_folder')?.folders, [extra])
    assert.ok(!((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).some((a) => a.code === 'missing_folder'), 'the member doesn\'t manage it')
    writeFileSync(join(h.notesDir, 'vihko.yaml'), bad)
    h.workspace.reload()
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.list }))).status, 200)
    const now = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; fallback?: string }[]
    assert.equal(now.find((a) => a.code === 'permissions_rejected')?.fallback, 'last_good')
  } finally { await h.close() }
})

test('the workspace settings name no template or templates folder the person can\'t read', async () => {
  const templates = `${DIR.admin}/${m.aFolder()}`
  const template = m.aNotePath(templates)
  const series = m.anId()
  const config = `templates: ${JSON.stringify(templates)}\ndaily:\n  ${series}:\n    folder: ${JSON.stringify(`${DIR.shared}/${m.aFolder()}`)}\n    template: ${JSON.stringify(template.replace(/\.md$/, ''))}\n` + RULES
  const h = await setup({ files: { ...FILES, [template]: noteText() }, config })
  try {
    const admin = (await h.admin('GET', '/api/workspace')).body
    assert.deepEqual([admin.templates, admin.daily[0].template], [[templates], template], 'the admin reads that folder')
    const member = await h.member('GET', '/api/workspace')
    assert.deepEqual([member.body.templates, member.body.daily[0].template], [[], null])
    assert.ok(!member.text.includes(DIR.admin), member.text)
    assert.equal(member.body.daily[0].id, series, 'the series itself is there')
  } finally { await h.close() }
})

test('vihko.yaml emptied or deleted while running: shared spaces go only once it stays so, never for a half-saved file', async () => {
  const h = await setup({ files: FILES })
  try {
    const file = join(h.notesDir, 'vihko.yaml')
    const memberReads = async () => (await h.member('GET', h.url('/api/note', { path: PATH.list }))).status
    assert.equal(await memberReads(), 200)
    // An editor that truncates the file and writes it again: for a moment it's empty, then whole again.
    writeFileSync(file, '')
    h.workspace.reload()
    assert.equal(await memberReads(), 200, 'an empty file for a moment closes nothing')
    writeFileSync(file, RULES)
    h.workspace.reload()
    assert.equal(await memberReads(), 200)
    // Deleted, and it stays deleted: nothing is shared after a moment; each keeps their own space.
    rmSync(file)
    h.workspace.reload()
    assert.equal(await memberReads(), 200, 'not at once')
    const kind = () => h.workspace.permissions.kind
    assert.equal(kind(), 'rules')
    const until = Date.now() + 10_000
    while (kind() !== 'none' && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    assert.equal(kind(), 'none', 'once it stayed so')
    assert.equal(await memberReads(), 404)
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.cake }))).status, 200)
  } finally { await h.close() }
})

test('folders: create with edit, move and delete with manage; their rules go with them, and a move says whose access changes', async () => {
  const tripsName = m.aFolder()
  const trips = `${DIR.shared}/${tripsName}`
  const rome = m.aNotePath(trips)
  const h = await setup({ files: { ...FILES, [rome]: noteText() }, config: RULES + rule(trips, [[M, 'manage'], [O, 'read']]) })
  try {
    assert.equal((await h.other('POST', '/api/folder', { path: `${DIR.shared}/${m.aFolder()}` })).status, 201)
    assert.equal((await h.other('POST', '/api/folder', { path: `${DIR.admin}/${m.aFolder()}` })).status, 404)
    // The admin manages the space, and so everything in it.
    assert.equal((await h.admin('POST', '/api/folder', { path: `${trips}/${m.aFolder()}` })).status, 201)
    // The other edits the space: a grant of `read` below gives them no less.
    assert.equal((await h.other('POST', '/api/folder', { path: `${trips}/${m.aFolder()}` })).status, 201)
    // Moving the trips folder: the member manages it; they need edit where it goes.
    assert.equal((await h.other('POST', '/api/folder/move', { from: trips, to: `${DIR.shared}/${m.aFolder()}` })).status, 403, 'they see it, and don\'t manage it')
    assert.equal((await h.member('POST', '/api/folder/move', { from: trips, to: `${DIR.admin}/${tripsName}` })).status, 404)
    const to = `${HOME.member}/${tripsName}`
    const dry = await h.member('POST', '/api/folder/move', { from: trips, to, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    // Its own grants go with it; what reached it from the space doesn't: the admin loses it, the other keeps it by their own grant.
    assert.deepEqual(dry.body.audience.users, { gain: [], lose: [{ id: h.users.admin.id, username: A }] })
    assert.deepEqual(dry.body.audience.owner.after, { kind: 'personal', owner: M })
    const moved = await h.member('POST', '/api/folder/move', { from: trips, to })
    assert.equal(moved.status, 200, moved.text)
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(yaml.startsWith(RULES))
    assert.match(yaml, new RegExp(`${ruleRe(to, [[M, 'manage'], [O, 'read']])}$`, 'u'))
    assert.ok(!yaml.includes(trips), yaml)
    assert.equal((await h.other('GET', h.url('/api/note', { path: `${to}/${basename(rome)}` }))).status, 200, 'the rules went with it')
    assert.equal((await h.admin('GET', h.url('/api/note', { path: `${to}/${basename(rome)}` }))).status, 404)

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

type HeldAlert = { code: 'permissions_held'; id: string; folder: string; to: string | null; notes: number; personal: boolean; actions: string[] }
/** The holds someone is told of, as alerts. */
const heldAlerts = async (who: Name, h: Awaited<ReturnType<typeof setup>>) =>
  ((await h.as(who)('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a): a is HeldAlert => a.code === 'permissions_held')

test('a note moved outside vihko to where more people would read it is held from everyone; whoever could have made the move releases it', async () => {
  const h = await setup({ files: FILES })
  try {
    // With a shell: the member's recipe (with its uid) lands in the shared space, which the other reads.
    const landed = `${DIR.shared}/${basename(PATH.cake)}`
    renameSync(join(h.notesDir, PATH.cake), join(h.notesDir, landed))
    h.runtime.rescan({})
    for (const who of ['admin', 'member', 'other'] as const) {
      assert.equal((await h.as(who)('GET', h.url('/api/note', { path: landed }))).status, 404, who)
      assert.ok(!(await h.as(who)('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === landed), who)
    }
    // The member edits where it was and where it is: they could have moved it from vihko, so they decide.
    const held = (await heldAlerts('member', h))[0]!
    assert.deepEqual({ ...held, id: '' }, { code: 'permissions_held', id: '', folder: RECIPES, notes: 1, actions: ['release'] })
    // The other and the admin can't write where it was: not told, and it doesn't exist for them.
    assert.deepEqual(await heldAlerts('other', h), [])
    assert.deepEqual(await heldAlerts('admin', h), [])
    for (const who of ['admin', 'other'] as const) assert.equal((await h.as(who)('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 404, who)
    assert.equal((await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'move_permissions' })).status, 400, 'there are no rules to move')
    assert.equal((await h.member('POST', `/api/permissions/holds/${held.id}`, { action: 'release' })).status, 200)
    assert.equal((await h.other('GET', h.url('/api/note', { path: landed }))).status, 200, 'released: the folder it\'s in applies')
  } finally { await h.close() }
})

test('a held note is let go by itself once it goes back, or once nobody would read it who didn\'t before; a move that narrows is never held', async () => {
  const h = await setup({ files: FILES })
  try {
    const landed = `${DIR.shared}/${basename(PATH.cake)}`
    renameSync(join(h.notesDir, PATH.cake), join(h.notesDir, landed))
    h.runtime.rescan({})
    assert.ok(h.holds.held(landed))
    renameSync(join(h.notesDir, landed), join(h.notesDir, PATH.cake))
    h.runtime.rescan({})
    assert.equal((await h.member('GET', h.url('/api/note', { path: PATH.cake }))).status, 200, 'back where it was')
    assert.deepEqual(await heldAlerts('member', h), [])
    // Out of the shared space into the member's own: fewer people read it there. Not held.
    const mine = `${HOME.member}/${basename(PATH.list)}`
    renameSync(join(h.notesDir, PATH.list), join(h.notesDir, mine))
    h.runtime.rescan({})
    assert.ok(!h.holds.held(mine))
    assert.equal((await h.member('GET', h.url('/api/note', { path: mine }))).status, 200)
  } finally { await h.close() }
})

test('holds saved by 1.0 (with no readers recorded) are not read: 0.1.0 starts clean', async () => {
  const h = await setup({ files: FILES })
  try {
    const saved = [{ id: m.anId(), folder: HOME.member, to: null, notes: [`${DIR.shared}/${basename(PATH.cake)}`], was: '', at: new Date().toISOString() }]
    const dir = join(h.dir, 'old-state')
    mkdirSync(dir)
    writeFileSync(join(dir, 'permission-holds.json'), JSON.stringify({ holds: saved }))
    const holds = new PermissionHolds({ stateDir: dir, engine: h.permissions })
    assert.equal(holds.get(saved[0]!.id), null)
  } finally { await h.close() }
})
