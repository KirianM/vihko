// Users and groups meet the permissions: deleting someone
// takes their grants out of vihko.yaml and closes their personal space to
// everyone, but what they shared from it, until the admin decides; renaming or deleting a group
// moves or removes its grants. The vihko.yaml writer keeps everything else as
// it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rulesInFile } from '@vihko/core'
import { setup } from './_agents.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The group the config grants, and its name after the rename. */
const [family, relatives] = [m.aGroupName(), m.aGroupName()]
/** A shared space, and a folder of the member's own they share with the admin. */
const SHARED = `spaces/${m.aSpaceFolder()}`
const TRIPS = m.aFolder()
/** The member's note in their own space, one in the folder they share, the admin's in theirs, and one in the shared space. */
const [DIARY, ROME, PLAN] = [m.aTitle(), m.aTitle(), m.aTitle()]
const LIST = m.aNotePath(SHARED)
/** Comments in vihko.yaml, which the writer keeps. */
const [HEADER, BY_NAME] = [m.aSentence(), m.aSentence()]
/** `text` for a regular expression that matches it literally (valid with the `u` flag). */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const note = () => `# ${m.aHeading()}\n\n${m.aSentence()}\n`

const config = ({ admin, member }: { admin: string; member: string }) => `# ${HEADER}
permissions:
  ${yamlKey(SHARED)}:
    grants: { ${yamlKey(admin)}: manage, ${yamlKey(`@${family}`)}: edit, ${yamlKey(member)}: read }  # ${BY_NAME}
  ${yamlKey(`people/${member}/${TRIPS}`)}:
    grants: { ${yamlKey(admin)}: read }
`

test('deleting a user takes their grants out and closes their space, what they shared too; a group renamed or deleted takes its grants along', async () => {
  const s = await setup({
    config,
    files: ({ admin, member }) => ({
      [`people/${member}/${DIARY}.md`]: note(), [`people/${member}/${TRIPS}/${ROME}.md`]: note(), [`people/${admin}/${PLAN}.md`]: note(), [LIST]: note(),
    }),
  })
  try {
    const member = s.users.member.username
    const diary = `people/${member}/${DIARY}.md`
    const rome = `people/${member}/${TRIPS}/${ROME}.md`
    const plan = `people/${s.users.admin.username}/${PLAN}.md`
    const yaml = () => readFileSync(join(s.notesDir, 'vihko.yaml'), 'utf8')
    const group = await s.admin('POST', '/api/admin/groups', { name: family })
    assert.equal(group.status, 201)
    assert.equal((await s.admin('POST', `/api/admin/groups/${group.body.group.id}/members`, { userId: s.users.member.id })).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: LIST }))).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: diary }))).status, 200)
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404, 'the admin manages, never reads')
    assert.equal((await s.admin('GET', s.url('/api/note', { path: rome }))).status, 200, 'what the member shares with them')

    // Renamed: the grant follows, and the rest of the file stays as it was.
    assert.equal((await s.admin('PATCH', `/api/admin/groups/${group.body.group.id}`, { name: relatives })).status, 200)
    assert.ok(yaml().includes(`${JSON.stringify(`@${relatives}`)}: edit`), yaml())
    assert.ok(!yaml().includes(JSON.stringify(`@${family}`)), yaml())
    assert.ok(yaml().startsWith(`# ${HEADER}\n`), yaml())
    assert.ok(yaml().includes(`# ${BY_NAME}\n`), yaml())
    assert.equal((await s.member('GET', s.url('/api/note', { path: LIST }))).status, 200)

    // Deleted: its grant goes, the member still reads by name.
    assert.equal((await s.admin('DELETE', `/api/admin/groups/${group.body.group.id}`)).status, 200)
    assert.ok(!yaml().includes(JSON.stringify(`@${relatives}`)), yaml())
    const edit = await s.member('PUT', s.url('/api/note', { path: LIST }), { text: note() }, { 'if-none-match': 'x' })
    assert.notEqual(edit.status, 200, 'without the group, only read')

    // The member deleted: their grants go; their space is nobody's, but what they shared stays shared until the admin decides.
    assert.equal((await s.admin('POST', `/api/admin/users/${s.users.member.id}/disable`, { confirm: s.users.admin.password })).status, 200)
    assert.equal((await s.admin('GET', s.url('/api/note', { path: rome }))).status, 200, 'disabled: what they shared stays shared')
    assert.equal((await s.admin('DELETE', `/api/admin/users/${s.users.member.id}`, { confirm: s.users.admin.password })).status, 200)
    assert.doesNotMatch(yaml(), new RegExp(`(?<![\\p{L}\\p{N}._-])"?${literally(member)}"?:`, 'u'))
    assert.deepEqual(rulesInFile(yaml()).get(SHARED)?.grants, { [s.users.admin.username]: 'manage' })
    assert.ok(yaml().includes(`  # ${BY_NAME}\n`), 'the comment stays')
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404)
    assert.equal((await s.admin('GET', s.url('/api/note', { path: rome }))).status, 200, 'deleted: what they shared still is, until the admin decides')
    const tree = (await s.admin('GET', '/api/tree')).body as { notes: { path: string }[] }
    assert.ok(!tree.notes.some((n) => n.path === diary), 'what they kept to themselves appears to no one')
    assert.ok(tree.notes.some((n) => n.path === plan) && tree.notes.some((n) => n.path === rome))
  } finally {
    await s.close()
  }
})
