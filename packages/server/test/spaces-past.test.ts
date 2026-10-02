// What a shared space leaves behind when it's deleted or renamed: its trash
// and its history stay under its old name, so that name stays taken until
// the retention or a purge empties them; nobody reaches that past through a
// new space of the same name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A shared space created through the API by `who`. */
async function newSpace(h: Spaces, who: Name, members?: Record<string, string>, name = m.aSpaceName()) {
  const r = await h.as(who)('POST', '/api/spaces', { name, ...(members ? { members } : {}) })
  assert.equal(r.status, 201, r.text)
  return { name, path: r.body.space.path as string }
}

const q = encodeURIComponent

/** Another case of `name` (or the same, when it has none). */
const otherCase = (name: string) => (name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase())

test('a deleted space\'s name stays taken while its trash or its history holds anything, for everyone and every way to take it', async () => {
  const h = await setup({ history: true })
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const note = `${s.path}/${m.aTitle()}.md`
    h.write(note, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    await h.settle()
    assert.equal((await h.member('DELETE', `/api/spaces?path=${q(s.path)}&trash=true`)).status, 200)
    await h.settle()
    // Anyone, a member of it or not, in any case: the same answer as a space that exists.
    for (const [who, name] of [['admin', s.name], ['other', otherCase(s.name)], ['member', s.name.normalize('NFD')]] as [Name, string][]) {
      const r = await h.as(who)('POST', '/api/spaces', { name })
      assert.deepEqual([r.status, r.body.error, r.body.name], [409, 'space_name_taken', s.name], `${who} ${name}`)
      assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message', 'name'])
    }
    // Renaming another space to it, or moving a folder to a new space by that name, alike.
    const t = await newSpace(h, 'admin')
    assert.equal((await h.admin('POST', '/api/spaces/rename', { path: t.path, name: s.name })).body.error, 'space_name_taken')
    const folder = `${h.home('other')}/${m.aFolder()}`
    h.write(`${folder}/${m.aTitle()}.md`, m.aParagraph())
    for (const dryRun of [true, false]) assert.equal((await h.other('POST', '/api/spaces/from-folder', { path: folder, name: s.name, dryRun })).body.error, 'space_name_taken')
  } finally {
    await h.close()
  }
})

test('a renamed space\'s old name stays taken while its history is there; another case of its own name is still its own', async () => {
  const h = await setup({ history: true })
  try {
    const s = await newSpace(h, 'member')
    h.write(`${s.path}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
    await h.settle()
    const renamed = m.aSpaceName()
    const r = await h.member('POST', '/api/spaces/rename', { path: s.path, name: renamed })
    assert.equal(r.status, 200, r.text)
    await h.settle()
    const taken = await h.other('POST', '/api/spaces', { name: s.name })
    assert.deepEqual([taken.status, taken.body.error, taken.body.name], [409, 'space_name_taken', s.name])
    // Its own past under its new name never stops it from changing that name's case.
    const again = await h.member('POST', '/api/spaces/rename', { path: r.body.space.path, name: otherCase(renamed) })
    assert.equal(again.status, 200, again.text)
  } finally {
    await h.close()
  }
})

test('the name is free again once the retention empties the trash and a purge empties the history', async () => {
  const h = await setup({ history: true })
  try {
    const s = await newSpace(h, 'member')
    h.write(`${s.path}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
    await h.settle()
    await h.member('DELETE', `/api/spaces?path=${q(s.path)}&trash=true`)
    await h.settle()
    // The trash's retention, run past the entry's time.
    const confirm = h.created.admin.password
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 1, confirm })).status, 200)
    // (The trash dates its entries by the real clock.)
    h.clock.now = new Date(Date.now() + 3 * 86_400_000)
    assert.equal((await h.admin('POST', '/api/admin/retention/run', { confirm })).status, 200)
    // The history still holds it.
    assert.equal((await h.other('POST', '/api/spaces', { name: s.name })).body.error, 'space_name_taken')
    const purged = await h.admin('POST', '/api/history/purge', { path: s.path, confirm })
    assert.equal(purged.status, 200, JSON.stringify(purged.body))
    const fresh = await h.other('POST', '/api/spaces', { name: s.name })
    assert.equal(fresh.status, 201, fresh.text)
    // Nothing of the old one reaches the new one: its trash and history are empty.
    assert.deepEqual((await h.other('GET', '/api/trash')).body.entries ?? [], [])
    assert.deepEqual((await h.other('GET', '/api/history/changes')).body.changes.filter((c: any) => c.files.some((f: any) => f.path.startsWith(`${s.path}/`))), [])
  } finally {
    await h.close()
  }
})
