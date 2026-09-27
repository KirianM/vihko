// Users and groups meet the permissions (D-038.8): deleting someone takes
// their grants out of thoth.yaml and leaves their `{user}` folder closed to
// everyone; renaming or deleting a group moves or removes its grants. The
// thoth.yaml writer keeps everything else as it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_agents.ts'

const CONFIG = `# The family's notes
permissions:
  "":
    grants: { noa: manage }
  "personas/{user}":
    grants: { "{user}": manage }
  familia:
    grants: { "@familia": edit, ana: read }  # ana also by name
`

test('deleting a user takes their grants out and closes their folder; a group renamed or deleted takes its grants along', async () => {
  const s = await setup({
    config: CONFIG,
    files: { 'personas/ana/diario.md': '# Diario\n', 'personas/noa/plan.md': '# Plan\n', 'familia/compra.md': '# Compra\n' },
  })
  try {
    const yaml = () => readFileSync(join(s.notesDir, 'thoth.yaml'), 'utf8')
    const group = await s.noa('POST', '/api/admin/groups', { name: 'familia' })
    assert.equal(group.status, 201)
    assert.equal((await s.noa('POST', `/api/admin/groups/${group.body.group.id}/members`, { userId: s.users.ana.id })).status, 200)
    assert.equal((await s.ana('GET', s.url('/api/note', { path: 'familia/compra.md' }))).status, 200)
    assert.equal((await s.ana('GET', s.url('/api/note', { path: 'personas/ana/diario.md' }))).status, 200)
    assert.equal((await s.noa('GET', s.url('/api/note', { path: 'personas/ana/diario.md' }))).status, 404, 'the admin manages, never reads (D-038.1)')

    // Renamed: the grant follows, and the rest of the file stays as it was.
    assert.equal((await s.noa('PATCH', `/api/admin/groups/${group.body.group.id}`, { name: 'parientes' })).status, 200)
    assert.match(yaml(), /"@parientes": edit/)
    assert.doesNotMatch(yaml(), /@familia/)
    assert.match(yaml(), /^# The family's notes$/m)
    assert.match(yaml(), /# ana also by name/)
    assert.equal((await s.ana('GET', s.url('/api/note', { path: 'familia/compra.md' }))).status, 200)

    // Deleted: its grant goes, ana still reads by name.
    assert.equal((await s.noa('DELETE', `/api/admin/groups/${group.body.group.id}`)).status, 200)
    assert.doesNotMatch(yaml(), /@parientes/)
    const edit = await s.ana('PUT', s.url('/api/note', { path: 'familia/compra.md' }), { text: '# Compra\nPan\n' }, { 'if-none-match': 'x' })
    assert.notEqual(edit.status, 200, 'without the group, only read')

    // ana deleted: her grants go, her folder is nobody's (never the root's).
    assert.equal((await s.noa('POST', `/api/admin/users/${s.users.ana.id}/disable`)).status, 200)
    assert.equal((await s.noa('DELETE', `/api/admin/users/${s.users.ana.id}`)).status, 200)
    assert.doesNotMatch(yaml(), /\bana:/)
    assert.match(yaml(), /familia:\n    grants: \{\}  # ana also by name\n/, 'a folder left without grants stays closed, never inherits; its comment stays')
    assert.match(yaml(), /"\{user\}": manage/, 'the rule for everyone stays')
    assert.equal((await s.noa('GET', s.url('/api/note', { path: 'personas/ana/diario.md' }))).status, 404)
    const tree = JSON.stringify((await s.noa('GET', '/api/tree')).body)
    assert.ok(!tree.includes('diario'), 'her notes appear to no one')
    assert.ok(tree.includes('plan.md'))
  } finally {
    await s.close()
  }
})
