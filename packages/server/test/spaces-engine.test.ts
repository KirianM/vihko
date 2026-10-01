// The permissions engine under the spaces model (D-056): levels, what each
// person reaches (spacesFor, sharedWith), the admin's directory of shared
// spaces, and who has access to a folder, over a directory of users and
// groups and what exists on the disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRule, Permissions } from '@vihko/core'
import { PermissionsEngine, diskSpaceFolders, type Directory, type DirectoryUser, type SpaceFolders } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The scenario of spec §2.3, with roles: an admin, two members, a group of both, and a deleted person. */
function scenario() {
  const admin: DirectoryUser = { id: m.anId(), username: m.aUsername(), role: 'admin' }
  const member: DirectoryUser = { id: m.anId(), username: m.aUsername(), role: 'member' }
  const other: DirectoryUser = { id: m.anId(), username: m.aUsername(), role: 'member' }
  const gone = m.aUsername()
  const group = m.aGroupName()
  const homeName = m.aSpaceName()
  const homeFolder = m.aSpaceFolder(homeName)
  const home = `spaces/${homeFolder}`
  const lonelyFolder = m.aSpaceFolder()
  const lonely = `spaces/${lonelyFolder}`
  const recipes = `${home}/${m.aFolder()}`
  const trips = `people/${admin.username}/${m.aFolder()}`
  const tripsInside = `${trips}/${m.aFolder()}`
  const goneShared = `people/${gone}/${m.aFolder()}`
  const missing = `people/${admin.username}/${m.aFolder()}`
  const rules: PermissionRule[] = [
    { folder: home, grants: { [`@${group}`]: 'edit', [admin.username]: 'manage' }, ai: null },
    { folder: recipes, grants: { [other.username]: 'read' }, ai: null },
    { folder: lonely, grants: { [admin.username]: 'manage' }, ai: false },
    { folder: trips, grants: { [member.username]: 'comment' }, ai: null },
    { folder: tripsInside, grants: { [member.username]: 'edit', [other.username]: 'read' }, ai: null },
    { folder: goneShared, grants: { [member.username]: 'edit' }, ai: null },
    { folder: missing, grants: { [member.username]: 'read' }, ai: null },
  ]
  const users = [admin, member, other]
  const groupsOf = new Map([[member.id, [group]], [other.id, [group]], [admin.id, []]])
  const directory: Directory = { users: () => users, groupsOf: (id) => groupsOf.get(id) ?? [], groups: () => [group] }
  // With a folder that isn't a space (a hidden one).
  const folders: SpaceFolders = { shared: () => [homeFolder, lonelyFolder, `.${m.aWord()}`], exists: (f) => f !== missing }
  let section: Permissions = { kind: 'rules', rules }
  const engine = new PermissionsEngine({ source: () => section, directory, folders, model: 'spaces' })
  return {
    admin, member, other, gone, group, home, homeName, homeFolder, lonely, recipes, trips, tripsInside, goneShared, missing, engine, groupsOf,
    set(p: Permissions) { section = p },
  }
}

test('spaces engine: levels as each person has them, the admin role changing nothing', () => {
  const s = scenario()
  const level = (u: DirectoryUser, f: string) => s.engine.levelFor(u, f)
  assert.equal(level(s.admin, `people/${s.admin.username}`), 'manage')
  assert.equal(level(s.admin, `people/${s.member.username}`), null)
  assert.equal(level(s.admin, `people/${s.member.username}/${m.aFolder()}`), null)
  assert.equal(level(s.member, `people/${s.member.username}/${m.aFolder()}`), 'manage')
  assert.equal(level(s.member, s.home), 'edit')
  assert.equal(level(s.other, s.recipes), 'edit')
  assert.equal(level(s.member, s.trips), 'comment')
  assert.equal(level(s.member, s.tripsInside), 'edit')
  assert.equal(level(s.member, `people/${s.admin.username}`), null)
  assert.equal(level(s.member, s.goneShared), null)
  for (const f of ['', 'people', 'spaces']) assert.equal(level(s.admin, f), null, f)
  // The viewer follows the model.
  const v = s.engine.viewer(s.member)
  assert.equal(v.level(s.trips), 'comment')
  assert.equal(v.level(''), null)
  assert.ok(v.aiClosed(`${s.lonely}/${m.aFolder()}`))
  assert.ok(!v.aiClosed(s.home))
})

test('spaces engine: a rejected or missing section leaves each person their own space and nothing else', () => {
  const s = scenario()
  for (const p of [{ kind: 'closed' }, { kind: 'none' }] as Permissions[]) {
    s.set(p)
    assert.equal(s.engine.levelFor(s.member, `people/${s.member.username}/${m.aFolder()}`), 'manage')
    assert.equal(s.engine.levelFor(s.member, s.home), null)
    assert.equal(s.engine.levelFor(s.admin, s.home), null)
    assert.deepEqual(s.engine.spacesFor(s.member).spaces, [])
    assert.deepEqual(s.engine.sharedWith(s.member), [])
  }
})

test('spaces engine: what each person reaches', () => {
  const s = scenario()
  assert.deepEqual(s.engine.spacesFor(s.member), {
    personal: { path: `people/${s.member.username}` },
    spaces: [{ path: s.home, name: s.homeName, level: 'edit', managers: [s.admin.username], aiClosed: false }],
    // The topmost folder shared with them only; not a deleted person's, not one missing on the disk.
    shared: [{ path: s.trips, level: 'comment', owner: s.admin.username }],
  })
  const forAdmin = s.engine.spacesFor(s.admin)
  assert.deepEqual(forAdmin.spaces.map((e) => e.path).sort(), [s.home, s.lonely].sort())
  assert.equal(forAdmin.spaces.find((e) => e.path === s.lonely)!.aiClosed, true)
  assert.equal(forAdmin.spaces.find((e) => e.path === s.lonely)!.name, s.lonely.slice('spaces/'.length))
  // What is shared from one's own space is not "shared with me".
  assert.deepEqual(forAdmin.shared, [])
  // A subfolder of a space they don't belong to, with the space's name; and one inside a folder of someone's.
  s.groupsOf.set(s.other.id, [])
  assert.deepEqual(s.engine.sharedWith(s.other), [
    { path: s.recipes, level: 'read', space: { path: s.home, name: s.homeName } },
    { path: s.tripsInside, level: 'read', owner: s.admin.username },
  ].sort((a, b) => a.path.localeCompare(b.path)))
})

test('spaces engine: the admin’s directory names spaces, managers and how many members; nothing inside', () => {
  const s = scenario()
  const dir = s.engine.sharedSpaces()
  const home = dir.find((d) => d.path === s.home)!
  assert.deepEqual(home, { path: s.home, name: s.homeName, managers: [s.admin.username], members: 3, aiClosed: false })
  assert.equal(dir.find((d) => d.path === s.lonely)!.members, 1)
  // A hidden folder under spaces/ is no space.
  assert.equal(dir.length, 2)
  assert.equal(s.engine.spaceName(s.home), s.homeName)
  assert.equal(s.engine.spaceName(s.recipes), null)
  assert.equal(s.engine.spaceName(s.lonely), s.lonely.slice('spaces/'.length))
})

test('spaces engine: who has access to a folder, and why', () => {
  const s = scenario()
  const byName = (list: ReturnType<typeof s.engine.audience>) => Object.fromEntries(list.map((a) => [a.username, a]))
  const trips = byName(s.engine.audience(s.tripsInside))
  assert.deepEqual(Object.keys(trips).sort(), [s.admin.username, s.member.username, s.other.username].sort())
  assert.deepEqual(trips[s.admin.username]!.via, [{ subject: s.admin.username, level: 'manage', from: `people/${s.admin.username}`, owner: true }])
  assert.equal(trips[s.member.username]!.level, 'edit')
  assert.deepEqual(trips[s.member.username]!.via.map((v) => v.from), [s.trips, s.tripsInside])
  const recipes = byName(s.engine.audience(s.recipes))
  assert.equal(recipes[s.other.username]!.level, 'edit')
  assert.deepEqual(recipes[s.other.username]!.via.map((v) => [v.subject, v.from]), [[`@${s.group}`, s.home], [s.other.username, s.recipes]])
  assert.deepEqual(s.engine.audience(s.goneShared), [])
  assert.deepEqual(s.engine.audience(''), [])
})

test('spaces engine: the disk says which spaces and folders exist, never through a link', () => {
  const dir = tempDir('vihko-spaces-')
  const home = m.aSpaceFolder()
  const elsewhere = m.aSpaceFolder()
  const inside = m.aFolder()
  mkdirSync(join(dir, 'spaces', home, inside), { recursive: true })
  mkdirSync(join(dir, 'spaces', '.hidden'), { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  symlinkSync(join(dir, 'outside'), join(dir, 'spaces', elsewhere))
  const folders = diskSpaceFolders(dir)
  assert.deepEqual(folders.shared(), [home])
  assert.ok(folders.exists(`spaces/${home}/${inside}`))
  assert.ok(!folders.exists(`spaces/${home}/${m.aFolder()}`))
  assert.ok(!folders.exists(`spaces/${elsewhere}`))
  assert.deepEqual(diskSpaceFolders(join(dir, m.aFolder())).shared(), [])
})

test('spaces engine: the admin role gives nothing, and nothing outside the spaces is anyone’s', () => {
  const s = scenario()
  const engine = new PermissionsEngine({ source: () => ({ kind: 'none' }), directory: { users: () => [s.admin, s.member], groupsOf: () => [], groups: () => [] } })
  assert.equal(engine.model, 'spaces')
  for (const f of ['', 'people', 'spaces', m.aFolder(), s.home]) assert.equal(engine.viewer(s.admin).level(f), null, f)
  assert.equal(engine.viewer(s.admin).level(`people/${s.admin.username}/${m.aFolder()}`), 'manage')
  assert.equal(engine.viewer(s.admin).level(`people/${s.member.username}`), null)
  // Who manages, who reads: the readers of a folder, and its managers.
  assert.deepEqual(s.engine.managersOf(s.home), [s.admin.username])
  assert.deepEqual(s.engine.readers(s.home).map((r) => r.username).sort(), [s.admin.username, s.member.username, s.other.username].sort())
})
