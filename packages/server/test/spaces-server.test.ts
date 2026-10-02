// Spaces and people on the server: each person's folder made with them,
// what `GET /api/spaces`
// gives each one, creating, renaming, deleting and leaving shared spaces,
// pins, the admin's directory, managers and joining, a deleted person's
// closed space (transferred, converted or deleted), and answers that never
// say whether something the person can't see exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { rulesInFile } from '@vihko/core'
import { Auth, openState } from '@vihko/server'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A shared space created through the API by `who`. */
async function newSpace(h: Spaces, who: Name, members?: Record<string, string>) {
  const name = m.aSpaceName()
  const r = await h.as(who)('POST', '/api/spaces', { name, ...(members ? { members } : {}) })
  assert.equal(r.status, 201, r.text)
  return { name, path: r.body.space.path as string }
}

/** The error part of an answer (what must not tell a hidden thing from a missing one). */
const errorOf = (r: { status: number; body: any }) => ({ status: r.status, error: r.body?.error, message: r.body?.message })

test('a new user gets their personal folder, and a name that would be a hidden folder or collide on the disk is refused', async () => {
  const h = await setup()
  try {
    for (const who of ['admin', 'member', 'other'] as Name[]) assert.ok(existsSync(join(h.notesDir, h.home(who))), who)
    assert.ok(existsSync(join(h.notesDir, 'spaces')))
    const name = m.aUsername()
    const r = await h.admin('POST', '/api/admin/users', { username: name, role: 'member' })
    assert.equal(r.status, 201, r.text)
    assert.ok(existsSync(join(h.notesDir, 'people', name)))
    // The values under test: a leading dot, and names only full case folding tells apart.
    for (const bad of ['..', '.hidden']) assert.equal((await h.admin('POST', '/api/admin/users', { username: bad, role: 'member' })).body.error, 'invalid_username', bad)
    assert.equal((await h.admin('POST', '/api/admin/users', { username: 'Straße', role: 'member' })).status, 201)
    assert.equal((await h.admin('POST', '/api/admin/users', { username: 'STRASSE', role: 'member' })).body.error, 'user_exists')
  } finally {
    h.close()
  }
})

test('a folder made outside vihko with something in it keeps its name from a new user; an empty one becomes theirs', async () => {
  const taken = m.aUsername()
  const empty = m.aUsername()
  const h = await setup({ files: { [`people/${taken}/${m.aTitle()}.md`]: m.aParagraph(), [`people/${empty}/`]: '' } })
  try {
    const r = await h.admin('POST', '/api/admin/users', { username: taken, role: 'member' })
    assert.deepEqual([r.status, r.body.error], [409, 'personal_folder_exists'])
    assert.ok(!(await h.admin('GET', '/api/admin/users')).body.users.some((u: { username: string }) => u.username === taken), 'not created')
    // Its content is left alone.
    assert.equal(readdirSync(join(h.notesDir, 'people', taken)).length, 1)
    assert.equal((await h.admin('POST', '/api/admin/users', { username: empty, role: 'member' })).status, 201)
  } finally {
    h.close()
  }
})

test('a fresh single-person install: the first admin gets their space at setup, and nothing else is written', async () => {
  const dir = tempDir('vihko-first-')
  const notesDir = join(dir, 'notes')
  mkdirSync(notesDir)
  const state = openState(join(dir, 'state.db'))
  try {
    const auth = new Auth(state, { notesDir })
    auth.personalFolders!.ensureLayout()
    const token = auth.setupToken()!
    const admin = m.aUser({ role: 'admin' })
    await auth.setup(token, admin.username, admin.password)
    assert.deepEqual(readdirSync(notesDir).sort(), ['people', 'spaces'])
    assert.deepEqual(readdirSync(join(notesDir, 'people')), [admin.username])
    assert.deepEqual(readdirSync(join(notesDir, 'spaces')), [])
    assert.ok(!existsSync(join(notesDir, 'vihko.yaml')), 'no vihko.yaml: a blank canvas')
  } finally {
    state.close()
  }
})

test('GET /api/spaces: one\'s own space, the shared spaces one belongs to, and what others share, nothing else', async () => {
  const h = await setup()
  try {
    const home = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const lonely = await newSpace(h, 'admin')
    const trips = `${h.home('admin')}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, trips))
    await h.rule(trips, { grants: { [h.names.other]: 'comment' } })
    const other = (await h.other('GET', '/api/spaces')).body
    assert.deepEqual(other.personal, { path: h.home('other') })
    assert.deepEqual(other.spaces.map((s: any) => [s.path, s.name, s.level]), [[home.path, home.name, 'edit']])
    assert.deepEqual(other.shared, [{ path: trips, level: 'comment', owner: h.names.admin, pinned: false }])
    const member = (await h.member('GET', '/api/spaces')).body
    assert.deepEqual(member.spaces.map((s: any) => [s.path, s.level, s.managers]), [[home.path, 'manage', [h.names.member]]])
    assert.deepEqual(member.shared, [])
    // The admin: their own and the one they made; nothing of the members'.
    const admin = await h.admin('GET', '/api/spaces')
    assert.deepEqual(admin.body.spaces.map((s: any) => s.path), [lonely.path])
    assert.ok(!admin.text.includes(home.path) && !admin.text.includes(home.name))
    // The folder is the name.
    assert.equal(home.path, `spaces/${home.name}`)
  } finally {
    h.close()
  }
})

test('creating a shared space: anyone by default, only admins with the setting; its creator manages it', async () => {
  const h = await setup()
  try {
    assert.equal((await h.member('GET', '/api/spaces')).body.canCreate, true)
    const s = await newSpace(h, 'member')
    const written = rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')).get(s.path)
    assert.deepEqual(written, { grants: { [h.names.member]: 'manage' }, ai: null })
    // The creator stays a manager whatever `members` says of them.
    const t = await newSpace(h, 'other', { [h.names.other]: 'read', [h.names.member]: 'comment' })
    const levels = Object.fromEntries((await h.other('GET', '/api/spaces')).body.spaces.map((x: any) => [x.path, x.level]))
    assert.equal(levels[t.path], 'manage')
    assert.equal((await h.member('GET', '/api/spaces')).body.spaces.find((x: any) => x.path === t.path)?.level, 'comment')
    for (const bad of [{ name: '' }, { name: ` ${m.aSpaceName()}` }, { name: 7 }, { name: m.aSpaceName(), members: { [m.aUsername()]: 'edit' } }, { name: m.aSpaceName(), members: { [h.names.other]: 'own' } }]) {
      const r = await h.member('POST', '/api/spaces', bad)
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(bad))
    }
    assert.equal((await h.admin('PUT', '/api/admin/settings', { spacesCreation: 'admins' })).body.spacesCreation, 'admins')
    assert.deepEqual([(await h.member('GET', '/api/spaces')).body.canCreate, (await h.admin('GET', '/api/spaces')).body.canCreate], [false, true])
    const refused = await h.member('POST', '/api/spaces', { name: m.aSpaceName() })
    assert.deepEqual([refused.status, refused.body.error], [403, 'forbidden'])
    await newSpace(h, 'admin')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { spacesCreation: 'nobody' })).status, 400)
  } finally {
    h.close()
  }
})

test('«Move to a new space»: a folder becomes a shared space of its own, its mover managing it, with the move\'s audience and the links it leaves broken in the preview', async () => {
  const h = await setup()
  try {
    // A shared space of the member's and the other's, with a folder the other mustn't see any more.
    const casa = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const folderName = m.aFolder()
    const folder = `${casa.path}/${folderName}`
    const [inside, sub, linking] = [`${folder}/${m.aTitle()}.md`, `${folder}/${m.aFolder()}`, `${casa.path}/${m.aTitle()}.md`]
    h.write(inside, `# ${m.aHeading()}\n`)
    h.write(`${sub}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
    h.write(linking, `[[${inside.slice(casa.path.length + 1, -3)}]]\n`)
    // A grant of the folder's own (the admin) and one of a subfolder (the admin too): they come along.
    await h.rule(folder, { grants: { [h.names.admin]: 'read' } })
    const url = '/api/spaces/from-folder'
    const dry = await h.member('POST', url, { path: folder, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    assert.equal(dry.body.space, undefined)
    assert.deepEqual(dry.body.report.audience.users.lose.map((u: any) => u.username), [h.names.other])
    assert.deepEqual(dry.body.report.audience.owner.after, { kind: 'shared', path: dry.body.report.to, name: folderName })
    assert.ok(existsSync(join(h.notesDir, inside)), 'a dry run moves nothing')
    // The link from the space it leaves will be broken: links never cross spaces.
    assert.deepEqual(dry.body.report.brokenLinks, [{ path: linking, to: dry.body.report.to + inside.slice(folder.length) }])
    // Only whoever may move it: the other edits the space but doesn't manage the folder.
    assert.deepEqual((await h.other('POST', url, { path: folder })).body.error, 'forbidden')
    // A space's own root doesn't become another.
    assert.deepEqual((await h.member('POST', url, { path: casa.path, dryRun: true })).body.error, 'space_root')
    const r = await h.member('POST', url, { path: folder })
    assert.equal(r.status, 201, r.text)
    const root = r.body.space.path as string
    assert.equal(root, `spaces/${folderName}`)
    assert.equal(r.body.space.name, folderName)
    const moved = (p: string) => root + p.slice(folder.length)
    assert.ok(existsSync(join(h.notesDir, moved(inside))) && !existsSync(join(h.notesDir, folder)))
    const rules = rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
    assert.deepEqual(rules.get(root), { grants: { [h.names.admin]: 'read', [h.names.member]: 'manage' }, ai: null })
    assert.equal(rules.get(folder), undefined)
    // The other no longer reads it; the member manages it; the link from the space it left stays as written, broken.
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(moved(inside))}`)).status, 404)
    assert.equal((await h.member('GET', '/api/spaces')).body.spaces.find((s: any) => s.path === root)?.level, 'manage')
    assert.equal(readFileSync(join(h.notesDir, linking), 'utf8'), `[[${inside.slice(casa.path.length + 1, -3)}]]\n`)
    // With the setting `spacesCreation: admins`, a member can't.
    const other = `${h.home('member')}/${m.aFolder()}`
    h.write(`${other}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
    await h.admin('PUT', '/api/admin/settings', { spacesCreation: 'admins' })
    assert.deepEqual((await h.member('POST', url, { path: other, dryRun: true })).body.error, 'forbidden')
  } finally {
    h.close()
  }
})

test('names of shared spaces are unique in the installation, in any case, and must be a folder\'s', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member')
    // Another person, who isn't in it, is told the name is taken (names are no secret), with the name as it is written.
    for (const name of [s.name, s.name.toUpperCase(), s.name.toLowerCase(), s.name.normalize('NFD')]) {
      const r = await h.other('POST', '/api/spaces', { name })
      assert.deepEqual([r.status, r.body.error, r.body.name], [409, 'space_name_taken', s.name], name)
    }
    // Nothing else of it is said, and nothing is made.
    const r = await h.other('POST', '/api/spaces', { name: s.name })
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message', 'name'])
    assert.deepEqual(readdirSync(join(h.notesDir, 'spaces')), [s.name])
    // A folder made on the disk takes the name too; a hidden one doesn't.
    const onDisk = m.aSpaceName()
    mkdirSync(join(h.notesDir, 'spaces', onDisk))
    mkdirSync(join(h.notesDir, 'spaces', `.${m.aWord()}`))
    assert.equal((await h.member('POST', '/api/spaces', { name: onDisk })).body.error, 'space_name_taken')
    // What can't be a folder's name, each with its problem.
    const name = m.aSpaceName()
    for (const [bad, problem] of [[`${name}/${m.aWord()}`, 'invalid_characters'], [`${name}\\${m.aWord()}`, 'invalid_characters'], [`.${name}`, 'invalid_name'], [`~${name}`, 'invalid_name'], [`${name}.md`, 'invalid_name'], ['people', 'invalid_name']] as const) {
      const bad400 = await h.member('POST', '/api/spaces', { name: bad })
      assert.deepEqual([bad400.status, bad400.body.error, bad400.body.problem], [400, 'invalid', problem], bad)
    }
    // Moving a folder to a new space and converting a closed one ask the same.
    const folder = `${h.home('member')}/${m.aFolder()}`
    h.write(`${folder}/${m.aTitle()}.md`, m.aParagraph())
    for (const dryRun of [true, false]) assert.equal((await h.member('POST', '/api/spaces/from-folder', { path: folder, name: s.name.toUpperCase(), dryRun })).body.error, 'space_name_taken')
  } finally {
    h.close()
  }
})

test('renaming a space renames its folder, with its notes, rules, keys, pins and trash; only its managers may, and others learn nothing', async () => {
  const h = await setup()
  try {
    await h.enable()
    const s = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const sub = `${s.path}/${m.aFolder()}`
    const [a, b] = [`${s.path}/${m.aTitle()}.md`, `${sub}/${m.aTitle()}.md`]
    const bName = b.slice(b.lastIndexOf('/') + 1, -3)
    h.write(a, `# ${m.aHeading()}\n\n[[${bName}]]\n`)
    h.write(b, `---\nuid: ${m.anId()}\n---\n# ${m.aHeading()}\n`)
    await h.rule(sub, { ai: false })
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [sub] })
    h.state.prepare('insert or replace into pins (user_id, path, created_at) values (?, ?, ?)').run(h.created.other.id, sub, new Date().toISOString())
    const trashed = `${sub}/${m.aTitle()}.md`
    h.write(trashed, m.aParagraph())
    const entry = await h.notes.delete(trashed, { actor: { kind: 'user', id: h.created.member.id } })
    const name = m.aSpaceName()
    const to = `spaces/${name}`
    const moved = (p: string) => to + p.slice(s.path.length)
    const r = await h.member('POST', '/api/spaces/rename', { path: s.path, name })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.body.space.path, r.body.space.name], [to, name])
    assert.ok(!existsSync(join(h.notesDir, s.path)) && existsSync(join(h.notesDir, moved(a))) && existsSync(join(h.notesDir, moved(b))))
    // Its rules went with it, and nothing of it is left under the old name.
    const rules = rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
    assert.deepEqual(rules.get(to), { grants: { [h.names.member]: 'manage', [`@${h.group}`]: 'edit' }, ai: null })
    assert.deepEqual(rules.get(moved(sub)), { grants: null, ai: false })
    assert.ok(![...rules.keys()].some((k) => k === s.path || k.startsWith(`${s.path}/`)))
    // Links between its notes still lead where they did, as written.
    const out = (await h.member('GET', `/api/note/links?path=${encodeURIComponent(moved(a))}`)).body.outgoing as { status: string; dstPath: string | null }[]
    assert.deepEqual(out.map((l) => [l.status, l.dstPath]), [['resolved', moved(b)]])
    assert.ok(readFileSync(join(h.notesDir, moved(a)), 'utf8').includes(`[[${bName}]]`))
    // Keys, pins and the trash name the new folder.
    assert.deepEqual(h.state.prepare('select folders from api_keys where id = ?').get(key.key.id), { folders: JSON.stringify([moved(sub)]) })
    assert.deepEqual(h.state.prepare('select path from pins where user_id = ?').all(h.created.other.id), [{ path: moved(sub) }])
    assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'trash', entry.id, 'meta.json'), 'utf8')).path, moved(trashed))
    // Its members see it by its new name.
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.spaces.map((x: any) => [x.path, x.name]), [[to, name]])
    // Another case of its own name renames it too; another space's name doesn't.
    const again = await h.member('POST', '/api/spaces/rename', { path: to, name: name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase() })
    assert.equal(again.status, 200, again.text)
    const other = await newSpace(h, 'member')
    const clash = await h.member('POST', '/api/spaces/rename', { path: again.body.space.path, name: other.name.toLowerCase() })
    assert.deepEqual([clash.status, clash.body.error, clash.body.name], [409, 'space_name_taken', other.name])
    const s2 = { path: again.body.space.path as string }
    assert.equal((await h.other('POST', '/api/spaces/rename', { path: s2.path, name: m.aSpaceName() })).status, 403, 'an editor sees it')
    // The admin isn't a member: the same answer as for a space that doesn't exist.
    const hidden = await h.admin('POST', '/api/spaces/rename', { path: s2.path, name: m.aSpaceName() })
    const missing = await h.admin('POST', '/api/spaces/rename', { path: `spaces/${m.aSpaceFolder()}`, name: m.aSpaceName() })
    assert.deepEqual(errorOf(hidden), errorOf(missing))
    assert.equal(hidden.status, 404)
    assert.equal((await h.member('POST', '/api/spaces/rename', { path: h.home('member'), name: m.aSpaceName() })).body.error, 'invalid', 'a personal space has no name to change')
  } finally {
    h.close()
  }
})

test('deleting a space: its managers, its content to the trash and its rules out; the rest learn nothing', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const note = `${s.path}/${m.aTitle()}.md`
    h.write(note, m.aParagraph())
    assert.equal((await h.other('DELETE', `/api/spaces?path=${encodeURIComponent(s.path)}&trash=true`)).status, 403)
    const hidden = await h.admin('DELETE', `/api/spaces?path=${encodeURIComponent(s.path)}&trash=true`)
    const missing = await h.admin('DELETE', `/api/spaces?path=${encodeURIComponent(`spaces/${m.aSpaceFolder()}`)}&trash=true`)
    assert.deepEqual(errorOf(hidden), errorOf(missing))
    assert.equal(hidden.status, 404)
    assert.equal((await h.member('DELETE', `/api/spaces?path=${encodeURIComponent(s.path)}`)).body.error, 'not_empty')
    const r = await h.member('DELETE', `/api/spaces?path=${encodeURIComponent(s.path)}&trash=true`)
    assert.equal(r.status, 200, r.text)
    assert.ok(!existsSync(join(h.notesDir, s.path)))
    assert.ok(!readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8').includes(s.path))
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.spaces, [])
    // In the trash: its manager then sees it and restores it where they may write; its other members don't see it.
    const entries = async (who: Name) => (await h.as(who)('GET', '/api/trash')).body.entries as { id: string; path: string; space: string | null }[]
    const entry = (await entries('member')).find((e) => e.path === note)
    assert.ok(entry, 'its manager sees it')
    assert.equal(entry.space, s.path)
    assert.ok(!(await entries('other')).some((e) => e.path === note))
    const back = `${h.home('member')}/${m.aTitle()}.md`
    const restored = await h.member('POST', `/api/trash/${entry.id}/restore`, { to: back })
    assert.equal(restored.status, 200, restored.text)
    assert.ok(existsSync(join(h.notesDir, back)))
  } finally {
    h.close()
  }
})

test('leaving: one\'s own grants go and nothing is deleted; through a group, leave_via_group; what one can\'t see, as if missing', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit', [h.names.admin]: 'read' })
    const note = `${s.path}/${m.aTitle()}.md`
    h.write(note, m.aParagraph())
    const g = await newSpace(h, 'admin', { [`@${h.group}`]: 'edit' })
    const viaGroup = await h.other('POST', '/api/spaces/leave', { path: g.path })
    assert.deepEqual([viaGroup.status, viaGroup.body.error, viaGroup.body.group], [409, 'leave_via_group', h.group])
    // The admin takes them out of the group: they stop seeing it, and open editors are checked again at once.
    const group = (await h.admin('GET', '/api/admin/groups')).body.groups.find((x: any) => x.name === h.group)
    const before = h.rechecks.n
    assert.equal((await h.admin('DELETE', `/api/admin/groups/${group.id}/members/${h.created.other.id}`)).status, 200)
    assert.ok(h.rechecks.n > before)
    assert.ok(!(await h.other('GET', '/api/spaces')).body.spaces.some((x: any) => x.path === g.path))
    assert.equal((await h.admin('POST', '/api/spaces/leave', { path: s.path })).status, 200)
    assert.deepEqual((await h.admin('GET', '/api/spaces')).body.spaces.map((x: any) => x.path), [g.path])
    // Now the admin sees nothing of it: as for a space that doesn't exist.
    const again = await h.admin('POST', '/api/spaces/leave', { path: s.path })
    const missing = await h.admin('POST', '/api/spaces/leave', { path: `spaces/${m.aSpaceFolder()}` })
    assert.deepEqual(errorOf(again), errorOf(missing))
    assert.equal(again.status, 404)
    assert.equal((await h.member('POST', '/api/spaces/leave', { path: h.home('member') })).body.error, 'invalid', 'one\'s own space')
    // The last manager leaves: the space and its notes stay, with its members and no manager.
    const r = await h.member('POST', '/api/spaces/leave', { path: s.path })
    assert.equal(r.status, 200, r.text)
    assert.ok(existsSync(join(h.notesDir, note)))
    const dir = (await h.admin('GET', '/api/admin/spaces')).body.spaces.find((x: any) => x.path === s.path)
    assert.deepEqual([dir.managers, dir.members], [[], 1])
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.spaces.map((x: any) => [x.path, x.level]), [[s.path, 'edit']])
  } finally {
    h.close()
  }
})

test('pins: only what others share with one, in the sidebar; what one can\'t see answers as missing', async () => {
  const h = await setup()
  try {
    const trips = `${h.home('member')}/${m.aFolder()}`
    const kept = `${h.home('member')}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, trips))
    mkdirSync(join(h.notesDir, kept))
    await h.rule(trips, { grants: { [h.names.other]: 'comment' } })
    assert.deepEqual((await h.other('POST', '/api/spaces/pin', { path: trips, pinned: true })).body, { path: trips, pinned: true })
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [{ path: trips, level: 'comment', owner: h.names.member, pinned: true }])
    assert.equal((await h.other('POST', '/api/spaces/pin', { path: h.home('other'), pinned: true })).body.error, 'invalid', 'one\'s own isn\'t received')
    const hidden = await h.other('POST', '/api/spaces/pin', { path: kept, pinned: true })
    const missing = await h.other('POST', '/api/spaces/pin', { path: `${h.home('member')}/${m.aFolder()}`, pinned: true })
    assert.deepEqual(errorOf(hidden), errorOf(missing))
    assert.equal(hidden.status, 404)
    assert.equal((await h.other('POST', '/api/spaces/pin', { path: trips, pinned: false })).body.pinned, false)
    assert.equal((await h.other('GET', '/api/spaces')).body.shared[0].pinned, false)
  } finally {
    h.close()
  }
})

test('the admin\'s directory names spaces, their managers and how many members, never a folder inside one', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const inner = `${s.path}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, inner))
    const r = await h.admin('GET', '/api/admin/spaces')
    assert.deepEqual(r.body.spaces.map((x: any) => [x.path, x.name, x.managers, x.members]), [[s.path, s.name, [h.names.member], 2]])
    assert.ok(!r.text.includes(inner))
    assert.deepEqual(r.body.closed, [])
    for (const route of ['/api/admin/spaces', `/api/admin/users/${h.created.other.id}/space`]) assert.equal((await h.member('GET', route)).status, 403, route)
    // Reading into the member's space: nothing, as for anyone else.
    const note = `${h.home('member')}/${m.aTitle()}.md`
    h.write(note, m.aParagraph())
    assert.equal((await h.admin('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 404)
  } finally {
    h.close()
  }
})

test('the admin assigns a manager only to a space without one, confirmed, and the person and the other admins are told', async () => {
  const h = await setup()
  try {
    const second = m.aUser({ role: 'admin' })
    await h.auth.createUser(second.username, second.password, 'admin')
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const busy = await h.admin('POST', '/api/admin/spaces/managers', { path: s.path, userId: h.created.other.id, confirm: h.created.admin.password })
    assert.deepEqual([busy.status, busy.body.error], [409, 'space_has_managers'])
    assert.equal((await h.member('POST', '/api/spaces/leave', { path: s.path })).status, 200)
    assert.equal((await h.admin('POST', '/api/admin/spaces/managers', { path: s.path, userId: h.created.other.id })).body.error, 'confirmation_required')
    const r = await h.admin('POST', '/api/admin/spaces/managers', { path: s.path, userId: h.created.other.id, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.space.managers, [h.names.other])
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed')
    assert.deepEqual(told.map((a: any) => [a.change, a.by, a.user, a.space]), [['manager_assigned', h.names.admin, h.names.other, { path: s.path, name: s.name }]])
    await h.login('admin')
    const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: second.username, password: second.password }) })
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const alerts = await (await h.app.request('/api/alerts', { headers: { cookie } })).json() as { alerts: any[] }
    assert.equal(alerts.alerts.filter((a) => a.code === 'space_changed' && a.change === 'manager_assigned').length, 1)
    assert.equal((await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed').length, 0, 'not whoever did it')
    const unknown = await h.admin('POST', '/api/admin/spaces/managers', { path: `spaces/${m.aSpaceFolder()}`, userId: h.created.other.id, confirm: h.created.admin.password })
    assert.equal(unknown.status, 404)
  } finally {
    h.close()
  }
})

test('a disabled manager manages nothing meanwhile: the space shows without managers and the admin may name another', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const space = async () => ((await h.admin('GET', '/api/admin/spaces')).body.spaces as { path: string; managers: string[] }[]).find((x) => x.path === s.path)!
    assert.deepEqual((await space()).managers, [h.names.member])
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/disable`, { confirm: h.created.admin.password })).status, 200)
    assert.deepEqual((await space()).managers, [])
    const alerts = (await h.admin('GET', '/api/alerts')).body.alerts as { code: string; path?: string }[]
    assert.ok(alerts.some((a) => a.code === 'space_without_managers' && a.path === s.path), JSON.stringify(alerts))
    const r = await h.admin('POST', '/api/admin/spaces/managers', { path: s.path, userId: h.created.other.id, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.space.managers, [h.names.other])
    // Enabled again, they manage it as before, next to the new one.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/enable`, {})).status, 200)
    assert.deepEqual((await space()).managers, [h.names.member, h.names.other].sort())
  } finally {
    h.close()
  }
})

test('the admin never joins a space that has managers; one whose managers are all disabled, to rescue it, visibly', async () => {
  const h = await setup()
  try {
    const second = m.aUser({ role: 'admin' })
    await h.auth.createUser(second.username, second.password, 'admin')
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    // Its manager adds people, the admin too: the admin can't add themselves.
    const refused = await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'edit', confirm: h.created.admin.password })
    assert.deepEqual([refused.status, refused.body.error], [409, 'space_has_managers'])
    assert.deepEqual((await h.admin('GET', '/api/spaces')).body.spaces, [])
    // Its only manager disabled: nobody can add anyone, and the admin may join to rescue it.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/disable`, { confirm: h.created.admin.password })).status, 200)
    const r = await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'manage', confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await h.admin('GET', '/api/spaces')).body.spaces.map((x: any) => [x.path, x.level]), [[s.path, 'manage']])
    // With no manager to tell, its members are, and the other admins.
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed')
    assert.deepEqual(told.map((a: any) => [a.change, a.by]), [['admin_joined', h.names.admin]])
    const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: second.username, password: second.password }) })
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const alerts = await (await h.app.request('/api/alerts', { headers: { cookie } })).json() as { alerts: any[] }
    assert.deepEqual(alerts.alerts.filter((a) => a.code === 'space_changed').map((a) => [a.change, a.by, a.space]), [['admin_joined', h.names.admin, { path: s.path, name: s.name }]])
    assert.equal((await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed').length, 0, 'not whoever joined')
    // Now it has a manager again: no more joining.
    assert.equal((await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'own', confirm: h.created.admin.password })).status, 400)
    assert.equal((await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'read', confirm: h.created.admin.password })).body.error, 'space_has_managers')
  } finally {
    h.close()
  }
})

/** The member's space with a folder shared with the other, and the member deleted (disabled first). */
async function deletedMember(h: Spaces) {
  const shared = `${h.home('member')}/${m.aFolder()}`
  const note = `${shared}/${m.aTitle()}.md`
  const own = `${h.home('member')}/${m.aTitle()}.md`
  h.write(note, m.aParagraph())
  h.write(own, m.aParagraph())
  await h.rule(shared, { grants: { [h.names.other]: 'edit' } })
  // Who has access to what: the folder's path only where the admin reads it (here, nowhere).
  assert.deepEqual((await h.admin('GET', `/api/admin/users/${h.created.member.id}/space`)).body,
    { path: h.home('member'), exists: true, sharedFolders: 1, people: 1, shared: [{ path: null, people: [{ username: h.names.other, level: 'edit' }] }] })
  assert.equal((await h.other('POST', '/api/spaces/pin', { path: shared, pinned: true })).status, 200)
  assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/disable`, { confirm: h.created.admin.password })).status, 200)
  // Disabled, what they shared is still there for the others.
  assert.equal((await h.other('GET', '/api/spaces')).body.shared.length, 1)
  assert.equal((await h.admin('DELETE', `/api/admin/users/${h.created.member.id}`, { confirm: h.created.admin.password })).status, 200)
  return { shared, note, own }
}

test('deleting a person closes their space for everyone, the admin included, but for what they shared, until the admin decides; it shows in the admin\'s directory as closed', async () => {
  const h = await setup()
  try {
    const before = h.rechecks.n
    const { shared, note, own } = await deletedMember(h)
    assert.ok(h.rechecks.n > before, 'open editors are checked again at once')
    // What they shared stays shared, as it was (pinned, with the same level).
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [{ path: shared, level: 'edit', owner: h.names.member, pinned: true }])
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 200)
    // The rest of their space is nobody's.
    for (const who of ['other', 'admin'] as Name[]) assert.equal((await h.as(who)('GET', `/api/note?path=${encodeURIComponent(own)}`)).status, 404, who)
    assert.equal((await h.admin('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 404)
    assert.ok(existsSync(join(h.notesDir, shared)), 'nothing is deleted')
    assert.deepEqual((await h.admin('GET', '/api/admin/spaces')).body.closed, [{ userId: h.created.member.id, username: h.names.member, path: h.home('member') }])
  } finally {
    h.close()
  }
})

test('a closed space transferred: into the recipient\'s, with what was shared still shared, and keys, pins and trash following', async () => {
  const h = await setup()
  try {
    await h.enable()
    const { shared, note, own } = await deletedMember(h)
    // What names paths under it: another person's key, a pin, a trash entry.
    h.write(`${shared}/${m.aTitle()}.md`, m.aParagraph())
    await h.rule(shared, { grants: { [h.names.other]: 'edit' } })
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [shared] })
    h.state.prepare('insert or replace into pins (user_id, path, created_at) values (?, ?, ?)').run(h.created.other.id, shared, new Date().toISOString())
    const trashed = `${shared}/${m.aTitle()}.md`
    h.write(trashed, m.aParagraph())
    const entry = await h.notes.delete(trashed, { actor: { kind: 'user', id: h.created.other.id } })
    const dry = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'transfer', to: h.created.admin.id, dryRun: true })
    const dest = `${h.home('admin')}/${h.names.member}`
    assert.deepEqual(dry.body.plan, { action: 'transfer', from: h.home('member'), to: dest, notes: 3, files: 0, sharedFolders: 1, people: 1 })
    assert.ok(existsSync(join(h.notesDir, h.home('member'))), 'a dry run moves nothing')
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'transfer', to: h.created.admin.id })).body.error, 'confirmation_required')
    const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'transfer', to: h.created.admin.id, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    const moved = (p: string) => dest + p.slice(h.home('member').length)
    assert.ok(existsSync(join(h.notesDir, moved(note))) && existsSync(join(h.notesDir, moved(own))))
    assert.ok(!existsSync(join(h.notesDir, h.home('member'))))
    // The recipient owns it; what was shared is shared again, and pinned where it was.
    assert.equal((await h.admin('GET', `/api/note?path=${encodeURIComponent(moved(own))}`)).status, 200)
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [{ path: moved(shared), level: 'edit', owner: h.names.admin, pinned: true }])
    assert.deepEqual(h.state.prepare('select folders from api_keys where id = ?').get(key.key.id), { folders: JSON.stringify([moved(shared)]) })
    assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'trash', entry.id, 'meta.json'), 'utf8')).path, moved(trashed))
    const told = (await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed')
    assert.deepEqual(told, [], 'whoever did it isn\'t told')
    assert.deepEqual((await h.admin('GET', '/api/admin/spaces')).body.closed, [])
  } finally {
    h.close()
  }
})

test('deleting a person can settle their space at once: what is asked is checked, and confirmed, before anyone is deleted', async () => {
  const h = await setup()
  try {
    const shared = `${h.home('member')}/${m.aFolder()}`
    h.write(`${shared}/${m.aTitle()}.md`, m.aParagraph())
    h.write(`${h.home('member')}/${m.aTitle()}.md`, m.aParagraph())
    await h.rule(shared, { grants: { [h.names.other]: 'edit' } })
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/disable`, { confirm: h.created.admin.password })).status, 200)
    const url = `/api/admin/users/${h.created.member.id}/space`
    const alive = async () => (await h.admin('GET', '/api/admin/users')).body.users.some((u: { id: string }) => u.id === h.created.member.id)
    // Its preview: the same counts as in «Spaces», nothing deleted.
    const dry = await h.admin('POST', url, { action: 'transfer', to: h.created.other.id, deleteUser: true, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    assert.deepEqual(dry.body.plan, { action: 'transfer', from: h.home('member'), to: `${h.home('other')}/${h.names.member}`, notes: 2, files: 0, sharedFolders: 1, people: 1 })
    // What can't be done, or isn't confirmed, deletes nobody.
    for (const bad of [
      { action: 'transfer', to: h.created.member.id, confirm: h.created.admin.password },
      { action: 'convert', name: m.aSpaceName(), members: { [h.names.other]: 'edit' }, confirm: h.created.admin.password },
      { action: 'delete', confirm: h.created.admin.password },
      { action: 'transfer', to: h.created.other.id },
    ]) {
      const r = await h.admin('POST', url, { ...bad, deleteUser: true })
      assert.notEqual(r.status, 200, JSON.stringify(bad))
      assert.ok(await alive(), JSON.stringify(bad))
    }
    const r = await h.admin('POST', url, { action: 'transfer', to: h.created.other.id, deleteUser: true, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.equal(await alive(), false)
    assert.ok(existsSync(join(h.notesDir, h.home('other'), h.names.member)))
    assert.ok(!existsSync(join(h.notesDir, h.home('member'))))
    assert.deepEqual((await h.admin('GET', '/api/admin/spaces')).body.closed, [])
  } finally {
    h.close()
  }
})

test('the transfer\'s preview never looks into the recipient\'s space: the same plan whatever is there; a name taken there is found only when it moves, and a free one taken', async () => {
  const h = await setup()
  try {
    await h.enable()
    const { note } = await deletedMember(h)
    const plan = async (to: Name) => {
      const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'transfer', to: h.created[to].id, dryRun: true })
      assert.equal(r.status, 200, r.text)
      return r.body.plan
    }
    // The other person has, at the top of their space, something with the deleted person's name; the admin doesn't.
    const taken = `${h.home('other')}/${h.names.member}`
    h.write(`${taken}/${m.aTitle()}.md`, m.aParagraph())
    const toOther = await plan('other')
    const toAdmin = await plan('admin')
    assert.deepEqual({ ...toOther, to: null }, { ...toAdmin, to: null })
    assert.equal(toOther.to, taken)
    // Moving it, the name is taken: it goes under the first free one, and nothing of theirs is touched.
    const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'transfer', to: h.created.other.id, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    // The admin doesn't read the recipient's space: where it went there isn't said (`-2` would say what they had).
    assert.equal(r.body.plan.to, null)
    assert.ok(existsSync(join(h.notesDir, `${taken}-2`, note.slice(h.home('member').length + 1))))
    assert.equal(readdirSync(join(h.notesDir, taken)).length, 1)
  } finally {
    h.close()
  }
})

test('a closed space converted into a shared space: its members see all of it, what was shared stays shared', async () => {
  const h = await setup()
  try {
    const { shared, note, own } = await deletedMember(h)
    // The person's own settings folder: theirs, not the shared space's.
    h.write(`${h.home('member')}/.vihko/${m.aTitle()}.md`, m.aParagraph())
    const name = m.aSpaceName()
    // Someone has to manage it: a dry run says so too.
    for (const members of [{}, { [h.names.admin]: 'edit', [`@${h.group}`]: 'read' }]) {
      for (const dryRun of [true, false]) {
        const bad = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'convert', name, members, dryRun, confirm: h.created.admin.password })
        assert.deepEqual([bad.status, bad.body.error], [400, 'space_needs_manager'], JSON.stringify({ members, dryRun }))
      }
    }
    const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'convert', name, members: { [h.names.admin]: 'manage', [`@${h.group}`]: 'read' }, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    const dest = r.body.plan.to as string
    assert.equal(dest, `spaces/${name}`)
    assert.ok(!existsSync(join(h.notesDir, dest, '.vihko')), 'their settings don\'t come along')
    const admin = (await h.admin('GET', '/api/spaces')).body.spaces
    assert.deepEqual(admin.map((s: any) => [s.path, s.name, s.level]), [[dest, name, 'manage']])
    assert.equal((await h.admin('GET', `/api/note?path=${encodeURIComponent(dest + own.slice(h.home('member').length))}`)).status, 200, 'all of it, also what was never shared')
    // The other is a member now (through the group), and edits what was shared with them.
    const other = (await h.other('GET', '/api/spaces')).body
    assert.deepEqual(other.spaces.map((s: any) => [s.path, s.level]), [[dest, 'read']])
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(dest + note.slice(h.home('member').length))}`)).status, 200)
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed')
    assert.deepEqual(told.map((a: any) => [a.change, a.by, a.user, a.space]), [['personal_converted', h.names.admin, h.names.member, { path: dest, name }]])
    assert.ok(existsSync(join(h.notesDir, dest + note.slice(h.home('member').length))))
  } finally {
    h.close()
  }
})

test('a closed space transferred or converted: links into it from other spaces are left as they are, and its own links by name still lead where they did', async () => {
  for (const action of ['transfer', 'convert'] as const) {
    const h = await setup()
    try {
      // In the member's space, a note linking another by name; the admin's and the other's notes link to it by path.
      const [a, b] = [`${h.home('member')}/${m.aTitle()}.md`, `${h.home('member')}/${m.aFolder()}/${m.aTitle()}.md`]
      const name = b.slice(b.lastIndexOf('/') + 1, -3)
      const across = `[[${b.slice(0, -3)}]]`
      const [mine, theirs] = [`${h.home('admin')}/${m.aTitle()}.md`, `${h.home('other')}/${m.aTitle()}.md`]
      h.write(a, `# ${m.aHeading()}\n\n${m.aSentence()} [[${name}]]\n`)
      h.write(b, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
      h.write(mine, `# ${m.aHeading()}\n\n${m.aSentence()} ${across}\n`)
      h.write(theirs, `# ${m.aHeading()}\n\n${m.aSentence()} ${across}\n`)
      await deletedMember(h)
      const input = action === 'transfer' ? { action, to: h.created.admin.id } : { action, name: m.aSpaceName(), members: { [h.names.admin]: 'manage' } }
      const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { ...input, confirm: h.created.admin.password })
      assert.equal(r.status, 200, r.text)
      const dest = r.body.plan.to as string
      const moved = (p: string) => dest + p.slice(h.home('member').length)
      const out = async (path: string) => ((await h.admin('GET', `/api/note/links?path=${encodeURIComponent(path)}`)).body.outgoing as { status: string; dstPath: string | null }[])
      // From another space: never rewritten, and broken, as it always was (a link never leaves its space).
      assert.deepEqual((await out(mine)).map((l) => [l.status, l.dstPath]), [['missing', null]], action)
      for (const p of [mine, theirs]) assert.ok(readFileSync(join(h.notesDir, p), 'utf8').includes(across), `${action}: ${p} as it was`)
      // Inside it, by name: the same note.
      assert.deepEqual((await out(moved(a))).map((l) => [l.status, l.dstPath]), [['resolved', moved(b)]], action)
    } finally {
      h.close()
    }
  }
})

test('a closed space deleted: gone from the disk and vihko.yaml, without the trash, its older trash entries too', async () => {
  const h = await setup()
  try {
    // Something the member deleted from their space before, and something the other deleted elsewhere.
    const old = `${h.home('member')}/${m.aTitle()}.md`
    const elsewhere = `${h.home('other')}/${m.aTitle()}.md`
    h.write(old, m.aParagraph())
    h.write(elsewhere, m.aParagraph())
    await h.notes.delete(old, { actor: { kind: 'user', id: h.created.member.id } })
    const kept = await h.notes.delete(elsewhere, { actor: { kind: 'user', id: h.created.other.id } })
    const { shared } = await deletedMember(h)
    const dry = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'delete', dryRun: true })
    assert.deepEqual(dry.body.plan, { action: 'delete', from: h.home('member'), to: null, notes: 2, files: 0, sharedFolders: 1, people: 1 })
    const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'delete', confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.ok(!existsSync(join(h.notesDir, h.home('member'))))
    assert.ok(!readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8').includes(shared))
    assert.deepEqual((await h.admin('GET', '/api/trash')).body.entries, [])
    assert.deepEqual(h.notes.trash().map((e) => e.id), [kept.id], 'only what was deleted elsewhere is left in the trash')
    assert.equal((h.index.prepare("select count(*) n from notes where path like 'people/%'").get() as { n: number }).n, 0)
    // Who still had what they shared until now is told, with the folder's name and whose it was.
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'removed_from')
    assert.deepEqual(told.map((a: any) => [a.kind, a.by, a.name, a.owner]), [['folder', h.names.admin, shared.slice(shared.lastIndexOf('/') + 1), h.names.member]])
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [])
    // No closed space left for that person.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'delete', confirm: h.created.admin.password })).status, 404)
    // Someone active has no closed space.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.created.other.id}/space`, { action: 'delete', dryRun: true })).status, 404)
  } finally {
    h.close()
  }
})

test('the spaces routes are for people: a key reads GET /api/spaces within its folders, and nothing else', async () => {
  const h = await setup()
  try {
    await h.enable()
    const s = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const all = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const limited = await h.newKey('member', { name: m.aKeyName(), canWrite: true, folders: [s.path] })
    const everything = (await h.withKey(all.token)('GET', '/api/spaces')).body
    assert.deepEqual([everything.personal, everything.spaces.map((x: any) => x.path)], [{ path: h.home('member') }, [s.path]])
    const within = (await h.withKey(limited.token)('GET', '/api/spaces')).body
    assert.deepEqual([within.personal, within.spaces.map((x: any) => x.path)], [null, [s.path]])
    const routes: [string, string][] = [['POST', '/api/spaces'], ['POST', '/api/spaces/leave'], ['POST', '/api/spaces/pin'], ['POST', '/api/spaces/rename'], ['GET', '/api/admin/spaces']]
    for (const [method, route] of routes) assert.equal((await h.withKey(all.token)(method, route, method === 'GET' ? undefined : {})).status, 404, route)
  } finally {
    h.close()
  }
})

test('GET /api/spaces/members: whoever reads a space or a folder shared with them sees who has access; for anyone else it is as missing', async () => {
  const h = await setup()
  try {
    await h.enable()
    const s = await newSpace(h, 'member', { [h.names.other]: 'comment' })
    const members = (who: Name, path: string) => h.as(who)('GET', `/api/spaces/members?path=${encodeURIComponent(path)}`)
    const brief = (r: { body: any }) => Object.fromEntries(r.body.members.map((u: any) => [u.username, [u.level, u.via.map((v: any) => v.from)]]))
    // A member who only comments sees the members of the space, with where each grant is written.
    const seen = await members('other', s.path)
    assert.equal(seen.status, 200, seen.text)
    assert.deepEqual([seen.body.space, seen.body.owner], [{ path: s.path, name: s.name }, null])
    assert.deepEqual(brief(seen), { [h.names.member]: ['manage', [s.path]], [h.names.other]: ['comment', [s.path]] })
    // The admin isn't a member: the same answer as for a space that doesn't exist.
    const missing = `spaces/${m.aSpaceFolder()}`
    assert.deepEqual(errorOf(await members('admin', s.path)), errorOf(await members('admin', missing)))
    assert.equal((await members('admin', s.path)).status, 404)

    // A folder of the member's own space, inside one shared with the admin, shared with the other.
    const outer = `${h.home('member')}/${m.aFolder()}`
    const inner = `${outer}/${m.aFolder()}`
    for (const f of [outer, inner]) assert.equal((await h.member('POST', '/api/folder', { path: f })).status, 201)
    await h.rule(outer, { grants: { [h.names.admin]: 'read' } })
    await h.rule(inner, { grants: { [h.names.other]: 'read' } })
    const received = await members('other', inner)
    assert.equal(received.status, 200, received.text)
    assert.equal(received.body.owner, h.names.member)
    // Who reaches it and why, but never the name of a folder above it the other doesn't read.
    assert.deepEqual(brief(received), { [h.names.member]: ['manage', [null]], [h.names.admin]: ['read', [null]], [h.names.other]: ['read', [inner]] })
    assert.ok(!received.text.includes(`"${outer}"`), received.text)
    // Above it, or anywhere else in that space, as missing.
    assert.deepEqual(errorOf(await members('other', outer)), errorOf(await members('other', `${h.home('member')}/${m.aFolder()}`)))
    assert.deepEqual(errorOf(await members('other', h.home('member'))), errorOf(await members('other', `${h.home('member')}/${m.aFolder()}`)))
    // A note isn't a folder.
    assert.equal((await members('member', `${s.path}/${m.aTitle()}.md`)).status, 404)

    // A key: within its folders, as its person; outside them, as missing.
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [s.path] })
    const viaKey = await h.withKey(key.token)('GET', `/api/spaces/members?path=${encodeURIComponent(s.path)}`)
    assert.equal(viaKey.status, 200, viaKey.text)
    assert.deepEqual(brief(viaKey), brief(seen))
    const out = await h.withKey(key.token)('GET', `/api/spaces/members?path=${encodeURIComponent(inner)}`)
    assert.deepEqual(errorOf(out), errorOf(await h.withKey(key.token)('GET', `/api/spaces/members?path=${encodeURIComponent(missing)}`)))
    assert.equal(out.status, 404)
  } finally {
    h.close()
  }
})

test('whoever is added to a shared space or receives a folder is told, only while they can see it, never the one who did it', async () => {
  const h = await setup()
  try {
    const noticesOf = async (who: Name) => (await h.as(who)('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'shared_with_you')
    const brief = (a: any) => ({ kind: a.kind, by: a.by, path: a.path, name: a.name, owner: a.owner, space: a.space })
    // Added when the space is made.
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    assert.deepEqual((await noticesOf('other')).map(brief), [{ kind: 'space', by: h.names.member, path: s.path, name: s.name, owner: null, space: null }])
    assert.deepEqual(await noticesOf('member'), [], 'not whoever did it')
    assert.deepEqual(await noticesOf('admin'), [])
    // A new member through the members of its root (a group: each person in it); a raised level is no news.
    const actor = { kind: 'user' as const, id: h.created.member.id }
    await h.services.permissionsFile.setRule(s.path, { grants: { [h.names.member]: 'manage', [h.names.other]: 'manage', [h.names.admin]: 'read' }, ai: null }, { actor })
    assert.equal((await noticesOf('other')).length, 1)
    assert.deepEqual((await noticesOf('admin')).map(brief), [{ kind: 'space', by: h.names.member, path: s.path, name: s.name, owner: null, space: null }])
    // A folder of one's own shared: its name and owner.
    const folder = m.aFolder()
    const trips = `${h.home('member')}/${folder}`
    mkdirSync(join(h.notesDir, trips))
    await h.services.permissionsFile.setRule(trips, { grants: { [`@${h.group}`]: 'comment' }, ai: null }, { actor })
    const got = (await noticesOf('other')).map(brief)
    assert.deepEqual(got.at(-1), { kind: 'folder', by: h.names.member, path: trips, name: folder, owner: h.names.member, space: null })
    assert.equal((await noticesOf('member')).length, 0, 'the owner, in the group too, isn\'t told of their own share')
    // No longer shared: nothing of it is shown any more.
    await h.services.permissionsFile.setRule(trips, { grants: null, ai: null }, { actor })
    assert.deepEqual((await noticesOf('other')).map(brief).at(-1), { kind: 'folder', by: h.names.member, path: null, name: null, owner: null, space: null })
    const text = JSON.stringify(await noticesOf('other'))
    // As a value of its own (a short folder name may well be part of the space's name).
    assert.ok(!text.includes(JSON.stringify(folder)) && !text.includes(trips), text)
    // What they're told of it going: its name and whose, as they saw them; never where it is, nor what it's called later.
    await h.member('POST', '/api/folder/move', { from: trips, to: `${h.home('member')}/${m.aFolder()}` })
    const gone = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'removed_from')
    assert.deepEqual(gone.map((a: any) => [a.kind, a.name, a.owner]), [['folder', folder, h.names.member]])
    assert.ok(!JSON.stringify(gone).includes(trips))
  } finally {
    h.close()
  }
})

test('the notice of a space or a folder shared follows it when it\'s renamed or moved from vihko', async () => {
  const h = await setup()
  try {
    const noticesOf = async (who: Name) => (await h.as(who)('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'shared_with_you')
    const brief = (a: any) => ({ kind: a.kind, path: a.path, name: a.name, owner: a.owner })
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    // The space renamed: «added you to» names it as it is now, not something no longer seen.
    const name = m.aSpaceName()
    const renamed = await h.member('POST', '/api/spaces/rename', { path: s.path, name })
    assert.equal(renamed.status, 200, renamed.text)
    assert.deepEqual((await noticesOf('other')).map(brief), [{ kind: 'space', path: `spaces/${name}`, name, owner: null }])
    // A folder of one's own shared, then renamed: the notice names it by its new name.
    const actor = { kind: 'user' as const, id: h.created.member.id }
    const [before, after] = [m.aFolder(), m.aFolder()]
    mkdirSync(join(h.notesDir, h.home('member'), before))
    await h.services.permissionsFile.setRule(`${h.home('member')}/${before}`, { grants: { [h.names.other]: 'read' }, ai: null }, { actor })
    const moved = await h.member('POST', '/api/folder/move', { from: `${h.home('member')}/${before}`, to: `${h.home('member')}/${after}` })
    assert.equal(moved.status, 200, moved.text)
    assert.deepEqual((await noticesOf('other')).map(brief).at(-1), { kind: 'folder', path: `${h.home('member')}/${after}`, name: after, owner: h.names.member })
  } finally {
    h.close()
  }
})

test('a deleted space is restored whole by whoever managed it, or the admin: folders, notes, members and when they joined; its members are told', async () => {
  const h = await setup()
  try {
    const alertsOf = async (who: Name, code: string) => (await h.as(who)('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === code)
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const sub = `${s.path}/${m.aFolder()}`
    const empty = `${s.path}/${m.aFolder()}`
    const [top, inner] = [`${s.path}/${m.aTitle()}.md`, `${sub}/${m.aTitle()}.md`]
    h.write(top, m.aParagraph())
    h.write(inner, m.aParagraph())
    mkdirSync(join(h.notesDir, empty))
    await h.rule(sub, { grants: { [h.names.admin]: 'comment' } })
    const rulesBefore = rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
    const startsBefore = h.state.prepare("select folder, subject, since from grant_starts where folder like 'spaces/%' order by folder, subject").all()
    const del = await h.member('DELETE', `/api/spaces?path=${encodeURIComponent(s.path)}&trash=true`)
    assert.equal(del.status, 200, del.text)
    const id = del.body.deleted as string
    assert.equal(typeof id, 'string')
    // Its members are told; who managed it may restore it from there, an editor may not.
    const [toOther] = await alertsOf('other', 'space_deleted')
    assert.deepEqual([toOther.by, toOther.name, toOther.deleted, toOther.actions], [h.names.member, s.name, null, ['dismiss']])
    const [toMember] = await alertsOf('member', 'space_deleted')
    assert.deepEqual([toMember.deleted, toMember.actions], [id, ['restore_space', 'dismiss']])
    assert.deepEqual((await h.member('GET', '/api/spaces/deleted')).body.spaces.map((x: any) => [x.id, x.path, x.name, x.by, x.entries]), [[id, s.path, s.name, h.names.member, 2]])
    assert.deepEqual((await h.other('GET', '/api/spaces/deleted')).body.spaces, [])
    assert.deepEqual((await h.admin('GET', '/api/spaces/deleted')).body.spaces.map((x: any) => x.id), [id])
    assert.equal((await h.other('POST', '/api/spaces/restore', { id })).status, 404, 'the same answer as for one that doesn\'t exist')
    // Restored: everything where it was, with its rules and when its grants began.
    const r = await h.member('POST', '/api/spaces/restore', { id })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.body.space, r.body.restored, r.body.missing], [{ path: s.path, name: s.name }, 2, 0])
    for (const p of [top, inner, empty]) assert.ok(existsSync(join(h.notesDir, p)), p)
    const rulesAfter = rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
    assert.deepEqual([rulesAfter.get(s.path), rulesAfter.get(sub)], [rulesBefore.get(s.path), rulesBefore.get(sub)])
    assert.deepEqual(h.state.prepare("select folder, subject, since from grant_starts where folder like 'spaces/%' order by folder, subject").all(), startsBefore)
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(inner)}`)).status, 200)
    const [back] = await alertsOf('other', 'space_restored')
    assert.deepEqual([back.by, back.path, back.name], [h.names.member, s.path, s.name])
    assert.deepEqual((await h.member('GET', '/api/spaces/deleted')).body.spaces, [])
    assert.equal((await h.member('POST', '/api/spaces/restore', { id })).status, 404)
    // The admin restores one they weren't in, without reading it.
    const t = await newSpace(h, 'other')
    h.write(`${t.path}/${m.aTitle()}.md`, m.aParagraph())
    const id2 = (await h.other('DELETE', `/api/spaces?path=${encodeURIComponent(t.path)}&trash=true`)).body.deleted
    assert.equal((await h.admin('POST', '/api/spaces/restore', { id: id2 })).status, 200)
    assert.equal((await h.admin('GET', '/api/spaces')).body.spaces.some((x: any) => x.path === t.path), false)
    assert.equal((await h.other('GET', '/api/spaces')).body.spaces.find((x: any) => x.path === t.path)?.level, 'manage')
  } finally {
    h.close()
  }
})

test('taking someone out of a space takes their grants below it too, and tells them; raising a member drops grants below that no longer raise them', async () => {
  const h = await setup({ group: false })
  try {
    const yaml = () => rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
    const put = async (folder: string, grants: Record<string, string>) => {
      const etag = (await h.member('GET', `/api/permissions?folder=${encodeURIComponent(folder)}`)).body.etag
      return h.member('PUT', '/api/permissions', { folder, grants, ifMatch: etag })
    }
    const s = await newSpace(h, 'member', { [h.names.other]: 'read' })
    const sub = `${s.path}/${m.aFolder()}`
    h.write(`${sub}/${m.aTitle()}.md`, m.aParagraph())
    // Above their level in the space: fine; to someone who isn't in it: as ever.
    assert.equal((await put(sub, { [h.names.other]: 'manage', [h.names.admin]: 'read' })).status, 200)
    // Out of the space: their grant below goes with it, the non-member's stays; they're told.
    assert.equal((await put(s.path, { [h.names.member]: 'manage' })).status, 200)
    assert.deepEqual(yaml().get(sub)?.grants, { [h.names.admin]: 'read' })
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'removed_from')
    assert.deepEqual(told.map((a: any) => [a.kind, a.by, a.name]), [['space', h.names.member, s.name]])
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [])
    // Back at read, a grant to comment below; raised to edit in the space, that grant adds nothing and goes.
    assert.equal((await put(s.path, { [h.names.member]: 'manage', [h.names.other]: 'read' })).status, 200)
    assert.equal((await put(sub, { [h.names.other]: 'comment', [h.names.admin]: 'read' })).status, 200)
    assert.equal((await put(s.path, { [h.names.member]: 'manage', [h.names.other]: 'edit' })).status, 200)
    assert.deepEqual(yaml().get(sub)?.grants, { [h.names.admin]: 'read' })
    // A folder of one's own no longer shared: the other is told, with its name and whose it is.
    const mine = `${h.home('member')}/${m.aFolder()}`
    h.write(`${mine}/${m.aTitle()}.md`, m.aParagraph())
    assert.equal((await put(mine, { [h.names.other]: 'read' })).status, 200)
    assert.equal((await put(mine, {})).status, 200)
    const last = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'removed_from').at(-1)
    assert.deepEqual([last.kind, last.name, last.owner], ['folder', mine.slice(mine.lastIndexOf('/') + 1), h.names.member])
  } finally {
    h.close()
  }
})

test('renaming a space tells its members its old and new names', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'read' })
    const name = m.aSpaceName()
    assert.equal((await h.member('POST', '/api/spaces/rename', { path: s.path, name })).status, 200)
    const told = (await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_renamed')
    assert.deepEqual(told.map((a: any) => [a.by, a.from, a.name, a.path]), [[h.names.member, s.name, name, `spaces/${name}`]])
    assert.deepEqual((await h.member('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_renamed'), [], 'not whoever did it')
    assert.deepEqual((await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_renamed'), [], 'nor anyone outside it')
  } finally {
    h.close()
  }
})

test('whoever manages a folder shared from someone\'s own space may take it to another space, and its owner is told; their own moves tell nobody', async () => {
  const h = await setup()
  try {
    const movedOut = async (who: Name) => (await h.as(who)('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'moved_out')
    // The member shares a project to edit, and a part of it to manage, with the other.
    const proj = `${h.home('member')}/${m.aFolder()}`
    const sub = `${proj}/${m.aFolder()}`
    h.write(`${sub}/${m.aTitle()}.md`, m.aParagraph())
    const loose = `${proj}/${m.aTitle()}.md`
    h.write(loose, m.aParagraph())
    await h.rule(proj, { grants: { [h.names.other]: 'edit' } })
    await h.rule(sub, { grants: { [h.names.other]: 'manage' } })
    // The other takes the folder they manage to their own space.
    const to = `${h.home('other')}/${m.aFolder()}`
    const r = await h.other('POST', '/api/folder/move', { from: sub, to })
    assert.equal(r.status, 200, r.text)
    const [folder] = await movedOut('member')
    assert.deepEqual({ kind: folder.kind, by: folder.by, from: folder.from, to: folder.to, owner: folder.owner, space: folder.space },
      { kind: 'folder', by: h.names.other, from: sub, to: null, owner: h.names.other, space: null }, 'where it went is theirs to read, not the owner\'s')
    // A note they edit, to a shared space of theirs: its name is no secret, and where it is too once the owner reads there.
    const s = await newSpace(h, 'other', { [h.names.member]: 'read' })
    const note = `${s.path}/${m.aTitle()}.md`
    assert.equal((await h.other('POST', '/api/note/move', { from: loose, to: note })).status, 200)
    const told = (await movedOut('member')).find((a: any) => a.kind === 'note')
    assert.deepEqual([told.from, told.to, told.space], [loose, note, { path: s.path, name: s.name }])
    // The owner's own moves, and moves within their space, tell nobody.
    const mine = `${h.home('member')}/${m.aTitle()}.md`
    h.write(mine, m.aParagraph())
    assert.equal((await h.member('POST', '/api/note/move', { from: mine, to: `${h.home('member')}/${m.aTitle()}.md` })).status, 200)
    assert.equal((await movedOut('member')).length, 2)
    assert.deepEqual(await movedOut('other'), [])
  } finally {
    h.close()
  }
})
