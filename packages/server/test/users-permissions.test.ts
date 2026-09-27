// Users and groups meet the permissions (D-038.8): deleting someone takes
// their grants out of thoth.yaml and leaves their `{user}` folder closed to
// everyone; renaming or deleting a group moves or removes its grants. The
// thoth.yaml writer keeps everything else as it was.
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
/** `text` for a regular expression that matches it literally (valid with the `u` flag). */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const config = ({ admin, member }: { admin: string; member: string }) => `# The family's notes
permissions:
  "":
    grants: { ${yamlKey(admin)}: manage }
  "personas/{user}":
    grants: { "{user}": manage }
  familia:
    grants: { ${yamlKey(`@${family}`)}: edit, ${yamlKey(member)}: read }  # the member also by name
`

test('deleting a user takes their grants out and closes their folder; a group renamed or deleted takes its grants along', async () => {
  const s = await setup({
    config,
    files: ({ admin, member }) => ({ [`personas/${member}/diario.md`]: '# Diario\n', [`personas/${admin}/plan.md`]: '# Plan\n', 'familia/compra.md': '# Compra\n' }),
  })
  try {
    const member = s.users.member.username
    const diary = `personas/${member}/diario.md`
    const yaml = () => readFileSync(join(s.notesDir, 'thoth.yaml'), 'utf8')
    const group = await s.admin('POST', '/api/admin/groups', { name: family })
    assert.equal(group.status, 201)
    assert.equal((await s.admin('POST', `/api/admin/groups/${group.body.group.id}/members`, { userId: s.users.member.id })).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    assert.equal((await s.member('GET', s.url('/api/note', { path: diary }))).status, 200)
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404, 'the admin manages, never reads (D-038.1)')

    // Renamed: the grant follows, and the rest of the file stays as it was.
    assert.equal((await s.admin('PATCH', `/api/admin/groups/${group.body.group.id}`, { name: relatives })).status, 200)
    assert.ok(yaml().includes(`${JSON.stringify(`@${relatives}`)}: edit`), yaml())
    assert.ok(!yaml().includes(JSON.stringify(`@${family}`)), yaml())
    assert.match(yaml(), /^# The family's notes$/m)
    assert.match(yaml(), /# the member also by name/)
    assert.equal((await s.member('GET', s.url('/api/note', { path: 'familia/compra.md' }))).status, 200)

    // Deleted: its grant goes, the member still reads by name.
    assert.equal((await s.admin('DELETE', `/api/admin/groups/${group.body.group.id}`)).status, 200)
    assert.ok(!yaml().includes(JSON.stringify(`@${relatives}`)), yaml())
    const edit = await s.member('PUT', s.url('/api/note', { path: 'familia/compra.md' }), { text: '# Compra\nPan\n' }, { 'if-none-match': 'x' })
    assert.notEqual(edit.status, 200, 'without the group, only read')

    // The member deleted: their grants go, their folder is nobody's (never the root's).
    assert.equal((await s.admin('POST', `/api/admin/users/${s.users.member.id}/disable`)).status, 200)
    assert.equal((await s.admin('DELETE', `/api/admin/users/${s.users.member.id}`)).status, 200)
    assert.doesNotMatch(yaml(), new RegExp(`(?<![\\p{L}\\p{N}._-])"?${literally(member)}"?:`, 'u'))
    assert.match(yaml(), /familia:\n    grants: \{\}  # the member also by name\n/, 'a folder left without grants stays closed, never inherits; its comment stays')
    assert.match(yaml(), /"\{user\}": manage/, 'the rule for everyone stays')
    assert.equal((await s.admin('GET', s.url('/api/note', { path: diary }))).status, 404)
    const tree = JSON.stringify((await s.admin('GET', '/api/tree')).body)
    assert.ok(!tree.includes('diario'), 'their notes appear to no one')
    assert.ok(tree.includes('plan.md'))
  } finally {
    await s.close()
  }
})
