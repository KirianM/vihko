// Users and groups meet the permissions (D-038.8): deleting someone takes
// their grants out of vihko.yaml and leaves their `{user}` folder closed to
// everyone; renaming or deleting a group moves or removes its grants. The
// vihko.yaml writer keeps everything else as it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_agents.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The group the config grants, and its name after the rename. */
const [family, relatives] = [m.aGroupName(), m.aGroupName()]
/** Everyone's own folders (a `{user}` rule), and a shared one. */
const PEOPLE = m.aFolder()
const SHARED = m.aFolder()
/** The member's note in their own folder, the admin's in theirs, and one in the shared folder. */
const [DIARY, PLAN] = [m.aTitle(), m.aTitle()]
const LIST = m.aNotePath(SHARED)
/** Comments in vihko.yaml, which the writer keeps. */
const [HEADER, BY_NAME] = [m.aSentence(), m.aSentence()]
/** `text` for a regular expression that matches it literally (valid with the `u` flag). */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const note = () => `# ${m.aHeading()}\n\n${m.aSentence()}\n`

const config = ({ admin, member }: { admin: string; member: string }) => `# ${HEADER}
permissions:
  "":
    grants: { ${yamlKey(admin)}: manage }
  ${yamlKey(`${PEOPLE}/{user}`)}:
    grants: { "{user}": manage }
  ${yamlKey(SHARED)}:
    grants: { ${yamlKey(`@${family}`)}: edit, ${yamlKey(member)}: read }  # ${BY_NAME}
`

test('deleting a user takes their grants out and closes their folder; a group renamed or deleted takes its grants along', async () => {
  const s = await setup({
    config,
    files: ({ admin, member }) => ({ [`${PEOPLE}/${member}/${DIARY}.md`]: note(), [`${PEOPLE}/${admin}/${PLAN}.md`]: note(), [LIST]: note() }),
  })
  try {
    const member = s.users.member.username
    const diary = `${PEOPLE}/${member}/${DIARY}.md`
    const plan = `${PEOPLE}/${s.users.admin.username}/${PLAN}.md`
    const yaml = () => readFileSync(join(s.notesDir, 'vihko.yaml'), 'utf8')
    const group = await s.admin('POST', '/api/admin/groups', { name: family })
    assert.equal(group.status, 201)
    assert.equal((await s.admin('POST', `/api/admin/groups/${group.body.group.id}/members`, { userId: s.users.member.id })).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: LIST }))).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: diary }))).status, 200)
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404, 'the admin manages, never reads (D-038.1)')

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

    // The member deleted: their grants go, their folder is nobody's (never the root's).
    assert.equal((await s.admin('POST', `/api/admin/users/${s.users.member.id}/disable`)).status, 200)
    assert.equal((await s.admin('DELETE', `/api/admin/users/${s.users.member.id}`)).status, 200)
    assert.doesNotMatch(yaml(), new RegExp(`(?<![\\p{L}\\p{N}._-])"?${literally(member)}"?:`, 'u'))
    assert.match(yaml(), new RegExp(`${literally(yamlKey(SHARED))}:\\n    grants: \\{\\}  # ${literally(BY_NAME)}\\n`, 'u'), 'a folder left without grants stays closed, never inherits; its comment stays')
    assert.match(yaml(), /"\{user\}": manage/, 'the rule for everyone stays')
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404)
    const tree = (await s.admin('GET', '/api/tree')).body as { notes: { path: string }[] }
    assert.ok(!tree.notes.some((n) => n.path === diary), 'their notes appear to no one')
    assert.ok(tree.notes.some((n) => n.path === plan))
  } finally {
    await s.close()
  }
})
