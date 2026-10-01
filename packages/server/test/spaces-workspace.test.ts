// vihko.yaml under the spaces model: templates as a list
// with `{user}`, series only where the person can write, paths outside
// `people/` and `spaces/` ignored and told to the admin, a fixed attachments
// folder per space; what state.db and the trash keep by path following a
// folder moved from vihko; and state.db's version for 0.1.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_VERSION, attachmentPath, movedPath } from '@vihko/server'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

async function newSpace(h: Spaces, who: Name, members?: Record<string, string>) {
  const name = m.aSpaceName()
  const r = await h.as(who)('POST', '/api/spaces', { name, ...(members ? { members } : {}) })
  assert.equal(r.status, 201, r.text)
  return { name, path: r.body.space.path as string }
}

test('state.db of 0.1.0 is version 11, with the pins and «On opening»', () => {
  assert.equal(STATE_VERSION, 11)
})

test('templates: one folder or a list, each with {user} made the person\'s, only those they can read', async () => {
  const mine = m.aFolder()
  const shared = m.aFolder()
  const outside = m.aFolder()
  const h = await setup()
  try {
    const space = await newSpace(h, 'member')
    writeFileSync(join(h.notesDir, 'vihko.yaml'), `templates: [${JSON.stringify(`people/{user}/${mine}`)}, ${JSON.stringify(`${space.path}/${shared}`)}, ${JSON.stringify(outside)}]\n`
      + readFileText(h))
    h.workspace.reload()
    assert.deepEqual((await h.member('GET', '/api/workspace')).body.templates, [`${h.home('member')}/${mine}`, `${space.path}/${shared}`])
    assert.deepEqual((await h.other('GET', '/api/workspace')).body.templates, [`${h.home('other')}/${mine}`])
    const warnings = (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'config_warnings')?.warnings ?? []
    assert.deepEqual(warnings.filter((w: any) => w.code === 'outside_spaces').map((w: any) => [w.at, w.detail]), [['templates.2', outside]])
  } finally {
    h.close()
  }
})

/** The rest of vihko.yaml as it is (its permissions), to write other settings above it. */
function readFileText(h: Spaces): string {
  try { return readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8') } catch { return '' }
}

test('«Today» offers only the series where the person can write; a series or guide outside the spaces is ignored and told', async () => {
  const own = { id: m.anId(), folder: m.aFolder() }
  const team = { id: m.anId(), folder: m.aFolder() }
  const lost = { id: m.anId(), folder: m.aFolder() }
  const guide = `${m.aFolder()}/${m.aTitle()}.md`
  const h = await setup()
  try {
    const space = await newSpace(h, 'member')
    writeFileSync(join(h.notesDir, 'vihko.yaml'), [
      'daily:',
      `  ${team.id}:`, `    folder: ${JSON.stringify(`${space.path}/${team.folder}`)}`,
      `  ${own.id}:`, `    folder: ${JSON.stringify(`people/{user}/${own.folder}`)}`,
      `  ${lost.id}:`, `    folder: ${JSON.stringify(lost.folder)}`,
      'mcp:', `  instructions: ${JSON.stringify(guide)}`,
      '',
    ].join('\n') + readFileText(h))
    h.workspace.reload()
    assert.deepEqual((await h.member('GET', '/api/workspace')).body.daily.map((s: any) => s.id), [team.id, own.id])
    assert.deepEqual((await h.other('GET', '/api/workspace')).body.daily.map((s: any) => s.id), [own.id])
    // Their «Today» is the first they can write; one they can't, asked for by id, doesn't exist for them.
    assert.equal((await h.other('GET', '/api/daily')).body.series, own.id)
    assert.ok((await h.other('GET', '/api/daily')).body.path.startsWith(`${h.home('other')}/${own.folder}/`))
    assert.equal((await h.member('GET', '/api/daily')).body.series, team.id)
    const hidden = await h.other('GET', `/api/daily?series=${team.id}`)
    const missing = await h.other('GET', `/api/daily?series=${m.anId()}`)
    assert.deepEqual([hidden.status, hidden.body.error, missing.status, missing.body.error], [404, 'not_found', 404, 'not_found'])
    const warnings = (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'config_warnings')?.warnings ?? []
    assert.deepEqual(warnings.filter((w: any) => w.code === 'outside_spaces').map((w: any) => [w.at, w.detail]), [[`daily.${lost.id}.folder`, lost.folder], ['mcp.instructions', guide]])
  } finally {
    h.close()
  }
})

test('a fixed attachments folder is each space\'s own: an image goes under the space of its note', async () => {
  const folder = m.aFolder()
  const h = await setup({ config: `attachments:\n  folder: ${JSON.stringify(folder)}\n` })
  try {
    const space = await newSpace(h, 'member')
    const note = `${space.path}/${m.aTitle()}.md`
    const own = `${h.home('member')}/${m.aTitle()}.md`
    h.write(note, m.aParagraph())
    h.write(own, m.aParagraph())
    const cookie = await cookieOf(h, 'member')
    for (const [n, root] of [[note, space.path], [own, h.home('member')]]) {
      const res = await h.app.request(`/api/attachments?note=${encodeURIComponent(n!)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: PNG })
      const body = await res.json() as { path: string }
      assert.equal(res.status, 201, JSON.stringify(body))
      assert.ok(body.path.startsWith(`${root}/${folder}/`), body.path)
      assert.ok(existsSync(join(h.notesDir, body.path)))
    }
    // A note in no space (the 1.0 layout) keeps the folder from the notes root.
    const loose = `${m.aFolder()}/${m.aTitle()}.md`
    assert.ok(attachmentPath(loose, 'png', new Date(), 1, { folder }).startsWith(`${folder}/`))
    // No alert about a folder shared by every note: there is none.
    assert.ok(!(await h.admin('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'attachments_shared_folder'))
  } finally {
    h.close()
  }
})

async function cookieOf(h: Spaces, who: Name): Promise<string> {
  const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: h.created[who].username, password: h.created[who].password }) })
  return res.headers.get('set-cookie')!.split(';')[0]!
}

test('a folder moved from vihko: keys, pins and trash entries that named it follow it', async () => {
  const h = await setup()
  try {
    await h.enable()
    const from = `${h.home('member')}/${m.aFolder()}`
    const to = `${h.home('member')}/${m.aFolder()}`
    const kept = `${from}/${m.aTitle()}.md`
    const gone = `${from}/${m.aTitle()}.md`
    h.write(kept, m.aParagraph())
    h.write(gone, m.aParagraph())
    await h.rule(from, { grants: { [h.names.other]: 'edit' } })
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [from] })
    assert.equal((await h.other('POST', '/api/spaces/pin', { path: from, pinned: true })).status, 200)
    const entry = await h.notes.delete(gone, { actor: { kind: 'user', id: h.created.member.id } })
    const r = await h.member('POST', '/api/folder/move', { from, to })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(h.state.prepare('select folders from api_keys where id = ?').get(key.key.id), { folders: JSON.stringify([to]) })
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.shared.map((s: any) => [s.path, s.pinned]), [[to, true]])
    assert.equal(h.notes.trash().find((e) => e.id === entry.id)?.path, `${to}${gone.slice(from.length)}`)
    assert.ok(existsSync(join(h.notesDir, `${to}${kept.slice(from.length)}`)))
  } finally {
    h.close()
  }
})

test('movedPath: a folder itself and what is under it, nothing that only starts like it', () => {
  const from = m.aFolderPath(2)
  const to = m.aFolderPath(2)
  const inside = `${from}/${m.aTitle()}.md`
  assert.equal(movedPath(from, from, to), to)
  assert.equal(movedPath(inside, from, to), `${to}${inside.slice(from.length)}`)
  assert.equal(movedPath(`${from}${m.aFolder()}`, from, to), null)
  assert.equal(movedPath(m.aFolderPath(2), from, to), null)
})
