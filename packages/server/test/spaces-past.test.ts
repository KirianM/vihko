// What a shared space leaves behind when it's deleted or renamed: its trash
// and its history stay under its old name, so that name stays taken until
// the retention or a purge empties them; nobody reaches that past through a
// new space of the same name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrantStarts } from '@vihko/server'
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

/** The ids of the versions `who` sees of a note (through the UI's routes). */
async function seen(h: Spaces, who: Name, path: string): Promise<string[]> {
  const r = await h.as(who)('GET', `/api/history/versions?path=${q(path)}`)
  assert.equal(r.status, 200, r.text)
  return r.body.versions.map((v: { id: string }) => v.id)
}

/** A note's versions, newest first, as its owner sees them. */
async function ids(h: Spaces, who: Name, path: string) { return seen(h, who, path) }

/** Writes a note as `who` (a new version: the history settles), at the clock's time. */
async function put(h: Spaces, who: Name, path: string, text: string) {
  const cur = await h.as(who)('GET', `/api/note?path=${q(path)}`)
  if (cur.status === 404) {
    const r = await h.as(who)('POST', '/api/note', { path, text })
    assert.equal(r.status, 201, r.text)
  } else {
    const r = await h.app.request(`/api/note?path=${q(path)}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: h.cookie(who), 'if-match': `"${cur.body.etag}"` }, body: JSON.stringify({ text }) })
    assert.equal(r.status, 200, await r.text())
  }
  await h.settle()
}

/** Moves the setup's clock (the app's and the history's) by `ms`. */
const later = (h: Spaces, ms = 60_000) => { h.clock.now = new Date(h.clock.now.getTime() + ms) }

test('sharing a folder doesn\'t share its past: who it\'s shared with sees versions and deletions only from then, by the UI, a key and MCP alike', async () => {
  const h = await setup({ history: true })
  try {
    await h.enable()
    // The trash dates entries by the real clock: the setup's starts an hour before it.
    h.clock.now = new Date(Date.now() - 3_600_000)
    const folder = `${h.home('member')}/${m.aFolder()}`
    const note = `${folder}/${m.aTitle()}.md`
    const gone = `${folder}/${m.aTitle()}.md`
    const secret = m.aUniqueWord()
    await put(h, 'member', note, `# ${m.aHeading()}\n\n${secret}\n`)
    later(h)
    await put(h, 'member', note, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    await put(h, 'member', gone, `# ${m.aHeading()}\n\n${secret}\n`)
    assert.equal((await h.member('DELETE', `/api/note?path=${q(gone)}`)).status, 200)
    await h.settle()
    const before = await ids(h, 'member', note)
    assert.equal(before.length, 2)
    // Shared an hour later (after the deletion, by the real clock too).
    h.clock.now = new Date(Date.now() + 3_600_000)
    await h.rule(folder, { grants: { [h.names.other]: 'edit' } })
    later(h)
    await put(h, 'member', note, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    const after = await ids(h, 'member', note)
    assert.equal(after.length, 3)
    // The other: only the version since; nothing of what was deleted before.
    assert.deepEqual(await seen(h, 'other', note), [after[0]])
    for (const id of before) {
      assert.equal((await h.other('GET', `/api/history/version?path=${q(note)}&id=${id}`)).status, 404)
      assert.equal((await h.other('GET', `/api/history/diff?path=${q(note)}&id=${id}&against=current`)).status, 404)
      assert.equal((await h.other('POST', '/api/history/restore', { path: note, id })).status, 404)
    }
    const changes = await h.other('GET', '/api/history/changes?limit=100')
    assert.ok(!changes.text.includes(gone) && !before.some((id) => changes.text.includes(id)), 'recent changes')
    const trash = await h.other('GET', '/api/trash')
    assert.ok(!trash.text.includes(gone) && !trash.text.includes(secret), 'the trash')
    assert.ok((await h.member('GET', '/api/trash')).text.includes(gone), 'its owner still has it')
    // A key of theirs, and MCP.
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false })
    const api = await h.withKey(key.token)('GET', `/api/history/versions?path=${q(note)}`)
    assert.deepEqual(api.body.versions.map((v: any) => v.id), [after[0]])
    assert.equal((await h.withKey(key.token)('GET', `/api/history/version?path=${q(note)}&id=${before[0]}`)).status, 404)
    const c = await h.mcp(key.token)
    try {
      const listed = await c.call('history', { path: note })
      assert.deepEqual(listed.data.versions.map((v: any) => v.version), [after[0]])
      const old = await c.call('history', { path: note, version: before[1] })
      assert.ok(old.error && !old.raw.includes(secret), old.raw)
    } finally { await c.close() }
  } finally {
    await h.close()
  }
})

test('a grant to a group reaches the past only from when each person joined it; a grant written by hand, from when vihko saw it', async () => {
  const h = await setup({ history: true, group: false })
  try {
    const s = await newSpace(h, 'member')
    const group = m.aGroupName()
    const g = (await h.admin('POST', '/api/admin/groups', { name: group })).body.group
    assert.equal((await h.admin('POST', `/api/admin/groups/${g.id}/members`, { userId: h.created.member.id })).status, 200)
    await h.rule(s.path, { grants: { [h.names.member]: 'manage', [`@${group}`]: 'edit' } })
    const note = `${s.path}/${m.aTitle()}.md`
    later(h)
    await put(h, 'member', note, `# ${m.aHeading()}\n`)
    later(h)
    assert.equal((await h.admin('POST', `/api/admin/groups/${g.id}/members`, { userId: h.created.other.id })).status, 200)
    later(h)
    await put(h, 'member', note, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    const all = await ids(h, 'member', note)
    assert.equal(all.length, 2)
    assert.deepEqual(await seen(h, 'other', note), [all[0]])

    // By hand: written in vihko.yaml, read again, counted from then.
    const own = `${h.home('admin')}/${m.aFolder()}`
    const mine = `${own}/${m.aTitle()}.md`
    later(h)
    await put(h, 'admin', mine, `# ${m.aHeading()}\n`)
    later(h)
    const yaml = join(h.notesDir, 'vihko.yaml')
    writeFileSync(yaml, readFileSync(yaml, 'utf8') + `  ${JSON.stringify(own)}:\n    grants: { ${JSON.stringify(h.names.other)}: edit }\n`)
    h.workspace.reload()
    later(h)
    await put(h, 'admin', mine, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    const theirs = await ids(h, 'admin', mine)
    assert.deepEqual(await seen(h, 'other', mine), [theirs[0]])
  } finally {
    await h.close()
  }
})

test('a folder renamed keeps when its grants began; the grants in force when vihko first looks count from the start', async () => {
  const h = await setup({ history: true })
  try {
    const folder = `${h.home('member')}/${m.aFolder()}`
    const note = `${folder}/${m.aTitle()}.md`
    await put(h, 'member', note, `# ${m.aHeading()}\n`)
    later(h)
    await h.rule(folder, { grants: { [h.names.other]: 'edit' } })
    later(h)
    await put(h, 'member', note, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    later(h)
    const to = `${h.home('member')}/${m.aFolder()}`
    assert.equal((await h.member('POST', '/api/folder/move', { from: folder, to })).status, 200)
    await h.settle()
    const now = to + note.slice(folder.length)
    const all = await ids(h, 'member', now)
    assert.equal(all.length, 3)
    // The rename and the version since the grant: not the first.
    assert.deepEqual(await seen(h, 'other', now), all.slice(0, 2))
  } finally {
    await h.close()
  }
  // An installation upgraded with grants in vihko.yaml: they count from the start.
  const shared = `spaces/${m.aSpaceFolder()}`
  const g = await setup({ files: { [`${shared}/`]: '' }, config: (n) => `permissions:\n  ${JSON.stringify(shared)}:\n    grants: { ${JSON.stringify(n.member)}: manage, ${JSON.stringify(n.other)}: read }\n` })
  try {
    const rows = g.state.prepare('select subject, since from grant_starts where folder = ? order by subject').all(shared) as { subject: string; since: string | null }[]
    assert.deepEqual(rows.map((r) => r.since), [null, null])
    assert.equal(rows.length, 2)
    // From then on, a grant vihko hasn't seen starts when it sees it.
    const starts = new GrantStarts(g.state, { now: () => g.clock.now })
    starts.sync([{ folder: shared, grants: { [g.names.admin]: 'read' }, ai: null }])
    assert.deepEqual(g.state.prepare('select since from grant_starts where folder = ?').all(shared), [{ since: g.clock.now.toISOString() }])
  } finally {
    await g.close()
  }
})

test('the same path with another uid has a history of its own; restoring a version of the note it was is offered as a new note', async () => {
  const h = await setup({ history: true })
  try {
    const path = `${h.home('member')}/${m.aTitle()}.md`
    const first = m.aUniqueWord()
    await put(h, 'member', path, `---\nuid: ${m.anId()}\n---\n# ${m.aHeading()}\n\n${first}\n`)
    later(h)
    assert.equal((await h.member('DELETE', `/api/note?path=${q(path)}`)).status, 200)
    await h.settle()
    later(h)
    await put(h, 'member', path, `---\nuid: ${m.anId()}\n---\n# ${m.aHeading()}\n`)
    const listed = await h.member('GET', `/api/history/versions?path=${q(path)}`)
    assert.equal(listed.body.versions.length, 1, 'only the note that is there now')
    // The earlier note's version, found in «Recent changes», still opens by its id.
    const changes = (await h.member('GET', '/api/history/changes?limit=100')).body.changes as { id: string; files: { path: string; change: string }[] }[]
    const old = changes.find((c) => c.files.some((f) => f.path === path && f.change === 'created') && c.id !== listed.body.versions[0].id)!
    const v = await h.member('GET', `/api/history/version?path=${q(path)}&id=${old.id}`)
    assert.equal(v.status, 200)
    assert.ok(v.body.text.includes(first))
    // Over the note there now: refused, and nothing changes.
    const over = await h.member('POST', '/api/history/restore', { path, id: old.id })
    assert.deepEqual([over.status, over.body.error], [409, 'uid_mismatch'])
    assert.ok(!readFileSync(join(h.notesDir, path), 'utf8').includes(first))
    // As a new note, next to it.
    const to = `${h.home('member')}/${m.aTitle()}.md`
    const asNew = await h.member('POST', '/api/history/restore', { path, id: old.id, to })
    assert.equal(asNew.status, 200, asNew.text)
    assert.equal(asNew.body.path, to)
    assert.ok(readFileSync(join(h.notesDir, to), 'utf8').includes(first))
    // Never over a note, nor where the person can't write.
    assert.equal((await h.member('POST', '/api/history/restore', { path, id: old.id, to: path })).body.error, 'exists')
    assert.equal((await h.member('POST', '/api/history/restore', { path, id: old.id, to: `${h.home('other')}/${m.aTitle()}.md` })).status, 404)
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
