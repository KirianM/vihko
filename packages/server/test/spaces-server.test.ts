// Spaces and people on the server (D-056, spec §2.4, §2.6, §3.2, §6.1, §7.1;
// piece S): each person's folder made with them, what `GET /api/spaces`
// gives each one, creating, renaming, deleting and leaving shared spaces,
// pins, the admin's directory, managers and joining, a deleted person's
// closed space (transferred, converted or deleted), and answers that never
// say whether something the person can't see exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpaceFolder, readablePart, rulesInFile } from '@vihko/core'
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
  return { name, path: r.body.space.path as string, id: r.body.space.id as string }
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
    assert.deepEqual(other.spaces.map((s: any) => [s.path, s.name, s.id, s.level]), [[home.path, home.name, home.id, 'edit']])
    assert.deepEqual(other.shared, [{ path: trips, level: 'comment', owner: h.names.admin, pinned: false }])
    const member = (await h.member('GET', '/api/spaces')).body
    assert.deepEqual(member.spaces.map((s: any) => [s.path, s.level, s.managers]), [[home.path, 'manage', [h.names.member]]])
    assert.deepEqual(member.shared, [])
    // The admin: their own and the one they made; nothing of the members' (D-038.1).
    const admin = await h.admin('GET', '/api/spaces')
    assert.deepEqual(admin.body.spaces.map((s: any) => s.path), [lonely.path])
    assert.ok(!admin.text.includes(home.path) && !admin.text.includes(home.name))
    // The folder is the name's readable part and the id (D-056.14).
    const f = parseSpaceFolder(home.path.slice('spaces/'.length))!
    assert.deepEqual([f.readable, f.id], [readablePart(home.name), home.id])
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
    assert.deepEqual(written, { name: s.name, grants: { [h.names.member]: 'manage' }, ai: null })
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

test('renaming a space changes its name, never its folder; only its managers may, and others learn nothing', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const name = m.aSpaceName()
    const r = await h.member('POST', '/api/spaces/rename', { path: s.path, name })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.body.space.path, r.body.space.name], [s.path, name])
    assert.ok(existsSync(join(h.notesDir, s.path)))
    assert.equal((await h.other('POST', '/api/spaces/rename', { path: s.path, name: m.aSpaceName() })).status, 403, 'an editor sees it')
    // The admin isn't a member: the same answer as for a space that doesn't exist.
    const hidden = await h.admin('POST', '/api/spaces/rename', { path: s.path, name: m.aSpaceName() })
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
    // In the trash: its manager then sees it and restores it where they may write; its other members don't see it (spec §3.5).
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
    // Reading into the member's space: nothing, as for anyone else (D-038.1).
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

test('the admin joins a space as a member, visibly: its managers and the other admins are told (D-056.22)', async () => {
  const h = await setup()
  try {
    const second = m.aUser({ role: 'admin' })
    await h.auth.createUser(second.username, second.password, 'admin')
    const s = await newSpace(h, 'member')
    const r = await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'edit', confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await h.admin('GET', '/api/spaces')).body.spaces.map((x: any) => [x.path, x.level]), [[s.path, 'edit']])
    const told = (await h.member('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed')
    assert.deepEqual(told.map((a: any) => [a.change, a.by]), [['admin_joined', h.names.admin]])
    const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: second.username, password: second.password }) })
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const alerts = await (await h.app.request('/api/alerts', { headers: { cookie } })).json() as { alerts: any[] }
    assert.deepEqual(alerts.alerts.filter((a) => a.code === 'space_changed').map((a) => [a.change, a.by, a.space]), [['admin_joined', h.names.admin, { path: s.path, name: s.name }]])
    // Not whoever joined; nor the other member, who doesn't manage it.
    assert.equal((await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed').length, 0)
    assert.equal((await h.other('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'space_changed').length, 0)
    assert.equal((await h.admin('POST', '/api/admin/spaces/join', { path: s.path, level: 'own', confirm: h.created.admin.password })).status, 400)
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
  assert.deepEqual((await h.admin('GET', `/api/admin/users/${h.created.member.id}/space`)).body, { path: h.home('member'), exists: true, sharedFolders: 1, people: 1 })
  assert.equal((await h.other('POST', '/api/spaces/pin', { path: shared, pinned: true })).status, 200)
  assert.equal((await h.admin('POST', `/api/admin/users/${h.created.member.id}/disable`)).status, 200)
  // Disabled, what they shared is still there for the others.
  assert.equal((await h.other('GET', '/api/spaces')).body.shared.length, 1)
  assert.equal((await h.admin('DELETE', `/api/admin/users/${h.created.member.id}`)).status, 200)
  return { shared, note, own }
}

test('deleting a person closes their space for everyone, the admin included; it shows in the admin\'s directory as closed', async () => {
  const h = await setup()
  try {
    const before = h.rechecks.n
    const { shared, note } = await deletedMember(h)
    assert.ok(h.rechecks.n > before, 'open editors are checked again at once')
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared, [])
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 404)
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

test('the transfer\'s preview never looks into the recipient\'s space (D-056.28): the same plan whatever is there; a name taken there is found only when it moves, and a free one taken', async () => {
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
    assert.equal(r.body.plan.to, `${taken}-2`)
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
    // The person's own settings folder (D-056.16): theirs, not the shared space's (D-056.28).
    h.write(`${h.home('member')}/.vihko/${m.aTitle()}.md`, m.aParagraph())
    const name = m.aSpaceName()
    // Someone has to manage it (D-056.22): a dry run says so too.
    for (const members of [{}, { [h.names.admin]: 'edit', [`@${h.group}`]: 'read' }]) {
      for (const dryRun of [true, false]) {
        const bad = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'convert', name, members, dryRun, confirm: h.created.admin.password })
        assert.deepEqual([bad.status, bad.body.error], [400, 'space_needs_manager'], JSON.stringify({ members, dryRun }))
      }
    }
    const r = await h.admin('POST', `/api/admin/users/${h.created.member.id}/space`, { action: 'convert', name, members: { [h.names.admin]: 'manage', [`@${h.group}`]: 'read' }, confirm: h.created.admin.password })
    assert.equal(r.status, 200, r.text)
    const dest = r.body.plan.to as string
    assert.match(dest, /^spaces\/[^/]+-[a-z0-9]{6}$/)
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

test('a closed space transferred or converted: links into it from other spaces follow it, and its own links by name still lead where they did (D-018, D-056.4)', async () => {
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
      // From another space: rewritten to the new path (as the system), and it leads to the same note.
      assert.deepEqual((await out(mine)).map((l) => [l.status, l.dstPath]), [['resolved', moved(b)]], action)
      assert.ok(readFileSync(join(h.notesDir, theirs), 'utf8').includes(`[[${moved(b).slice(0, -3)}`), `${action}: also in notes whoever did it can't read`)
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

test('GET /api/spaces/members: whoever reads a space or a folder shared with them sees who has access; for anyone else it is as missing (D-056.27)', async () => {
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
    await h.services.permissionsFile.setRule(s.path, { name: s.name, grants: { [h.names.member]: 'manage', [h.names.other]: 'manage', [h.names.admin]: 'read' }, ai: null }, { actor })
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
    const text = (await h.other('GET', '/api/alerts')).text
    // As a value of its own (a short folder name may well be part of the space's name).
    assert.ok(!text.includes(JSON.stringify(folder)) && !text.includes(trips), text)
  } finally {
    h.close()
  }
})
