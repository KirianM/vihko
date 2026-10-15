// vihko.yaml under the spaces model: no templates folders any more,
// series only where the person can write, paths outside
// `people/` and `spaces/` ignored and told to the admin, a fixed attachments
// folder per space; what state.db and the trash keep by path following a
// folder moved from vihko; and state.db's version for 0.1.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('state.db of 0.1.0 is version 13, with the pins, «On opening» (each device\'s last note too), when grants began and deleted spaces', () => {
  assert.equal(STATE_VERSION, 13)
})

test('vihko.yaml as a symbolic link: sharing writes through it, to the file it leads to, and the link stays', async () => {
  const comment = `# ${m.aSentence()}\n`
  const h = await setup({ config: `${comment}version: 1\n` })
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'vihko-yaml-elsewhere-')), 'vihko.yaml')
  try {
    const file = join(h.notesDir, 'vihko.yaml')
    renameSync(file, elsewhere)
    symlinkSync(elsewhere, file)
    const space = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    assert.ok(lstatSync(file).isSymbolicLink(), 'still a link')
    assert.equal(readlinkSync(file), elsewhere)
    const text = readFileSync(elsewhere, 'utf8')
    assert.ok(text.startsWith(comment) && text.includes(space.name) && text.includes(h.names.other), text)
    // And what it says is in force: the other member reads the space.
    assert.equal((await h.other('GET', '/api/spaces')).body.spaces.some((s: { path: string }) => s.path === space.path), true)
  } finally {
    h.close()
    rmSync(dirname(elsewhere), { recursive: true, force: true })
  }
})

test('creating where vihko.yaml still has the rules of a folder gone, while vihko.yaml can\'t be used: config_invalid, the same over HTTP and MCP, and nothing written', async () => {
  const h = await setup()
  try {
    await h.enable()
    const space = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    // Rules for a folder that isn't on the disk (gone outside vihko): a note created there would clear them first.
    const ghost = `${space.path}/${m.aFolder()}`
    await h.rule(ghost, { grants: { [h.names.admin]: 'edit' } })
    // The file broken by hand: what is in force stays, and vihko writes nothing over it.
    const file = join(h.notesDir, 'vihko.yaml')
    const broken = `${readFileSync(file, 'utf8')}permissions: [\n`
    writeFileSync(file, broken)
    h.workspace.reload()
    assert.notEqual(h.workspace.permissionsFallback, null)
    const note = () => `${ghost}/${m.aTitle()}.md`
    const http = await h.member('POST', '/api/note', { path: note(), text: m.aSentence() })
    assert.deepEqual([http.status, http.body.error], [409, 'config_invalid'], http.text)
    const c = await h.mcp((await h.newKey('member', { name: m.aKeyName(), canWrite: true })).token)
    try {
      const r = await c.call('create_note', { path: note(), text: m.aSentence() })
      assert.deepEqual([r.error, r.data?.error], [true, 'config_invalid'], r.raw)
    } finally { await c.close() }
    assert.equal(readFileSync(file, 'utf8'), broken)
    assert.ok(!existsSync(join(h.notesDir, ghost)))
  } finally {
    h.close()
  }
})

test('vihko.yaml without its permissions: nothing is shared, the admin is told, and «Restore previous permissions» writes them back', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const note = `${s.path}/${m.aTitle()}.md`
    h.write(note, m.aParagraph())
    const file = join(h.notesDir, 'vihko.yaml')
    const missing = async () => (await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'permissions_missing')
    assert.deepEqual(await missing(), [])
    // When each member's access began, which giving the permissions back keeps.
    const starts = () => h.state.prepare('select folder, subject, since from grant_starts where folder = ? order by subject').all(s.path)
    const began = starts()
    assert.equal(began.length, 2)
    // The section pasted over: the file applies, and the space is nobody's.
    const other = `# ${m.aSentence()}\nhistory:\n  mode: managed\n`
    writeFileSync(file, other)
    h.workspace.reload()
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 404)
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    assert.deepEqual(await missing(), [{ code: 'permissions_missing', file: 'vihko.yaml', folders: 1, actions: ['restore_permissions', 'dismiss'] }])
    // Only the admin, confirmed at the moment.
    assert.equal((await h.member('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'permissions_missing'), false)
    assert.equal((await h.member('POST', '/api/admin/permissions/restore', {})).status, 403)
    assert.equal((await h.admin('POST', '/api/admin/permissions/restore', {})).body.error, 'confirmation_required')
    const r = await h.admin('POST', '/api/admin/permissions/restore', { confirm: h.created.admin.password })
    assert.deepEqual([r.status, r.body.folders], [200, 1])
    // Written back under what the file says, which stays.
    const now = readFileSync(file, 'utf8')
    assert.ok(now.startsWith(other), now)
    assert.equal((await h.other('GET', `/api/note?path=${encodeURIComponent(note)}`)).status, 200)
    assert.deepEqual(starts(), began, 'nobody\'s past starts anew')
    assert.deepEqual(await missing(), [])
    assert.equal((await h.admin('POST', '/api/admin/permissions/restore', { confirm: h.created.admin.password })).status, 404, 'nothing left to restore')
    // Gone again and dismissed: forgotten. An empty section on purpose isn't missing.
    writeFileSync(file, other)
    h.workspace.reload()
    assert.equal((await missing()).length, 1)
    assert.equal((await h.admin('DELETE', '/api/admin/permissions/restore')).status, 200)
    assert.deepEqual(await missing(), [])
    assert.deepEqual(starts(), [], 'dismissed: those grants are gone')
    await newSpace(h, 'member')
    writeFileSync(file, `${other}permissions: {}\n`)
    h.workspace.reload()
    assert.deepEqual(await missing(), [])
  } finally {
    h.close()
  }
})

test('a note over notes.maxSize: indexed by its name alone, shown as too large, the admin told; the API and MCP never make one larger', async () => {
  const h = await setup()
  try {
    await h.enable()
    const file = join(h.notesDir, 'vihko.yaml')
    // 4 KB here (the default is 5 MB): what the value is matters, so it's written.
    writeFileSync(file, `notes:\n  maxSize: 0.00390625\n`)
    h.workspace.reload()
    const word = m.aUniqueWord()
    const big = `${h.home('member')}/${m.aTitle()}.md`
    h.write(big, `# ${m.aHeading()}\n\n${word} ${'x'.repeat(5000)}\n`)
    // In the tree by its name, but nothing of its text in the index.
    assert.ok((await h.member('GET', '/api/tree')).body.notes.some((n: any) => n.path === big))
    assert.deepEqual((await h.member('GET', `/api/search?q=${word}`)).body.results, [])
    const read = await h.member('GET', `/api/note?path=${encodeURIComponent(big)}`)
    assert.deepEqual([read.status, read.body.tooLarge], [200, true])
    // The admin is told, by its space (they don't read it).
    const [alert] = (await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'notes_too_large')
    assert.deepEqual([alert.paths, alert.elsewhere, alert.limitMb], [[], [h.home('member')], 0.00390625])
    assert.equal((await h.member('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'notes_too_large'), false)
    // Writes that would make a note larger: refused, by HTTP and MCP alike; one that keeps it within, fine.
    const small = `${h.home('member')}/${m.aTitle()}.md`
    assert.deepEqual([(await h.member('POST', '/api/note', { path: small, text: 'y'.repeat(5000) })).status, (await h.member('POST', '/api/note', { path: small, text: 'y'.repeat(5000) })).body.error], [413, 'note_too_large'])
    assert.equal((await h.member('POST', '/api/note', { path: small, text: `# ${m.aHeading()}\n` })).status, 201)
    const appended = await h.member('POST', '/api/note/edit', { path: small, ops: [{ op: 'append', text: 'z'.repeat(5000) }] })
    assert.deepEqual([appended.status, appended.body.error], [413, 'note_too_large'])
    // Larger counts in bytes: as many characters, one of them wider, is larger.
    const wider = await h.member('POST', '/api/note/edit', { path: big, ops: [{ op: 'find_replace', find: `${word} x`, replace: `${word} é` }] })
    assert.deepEqual([wider.status, wider.body.error], [413, 'note_too_large'])
    // Trimming a note over the limit always goes through, though it stays over.
    assert.equal((await h.member('POST', '/api/note/edit', { path: big, ops: [{ op: 'find_replace', find: `${word} x`, replace: `${word} ` }] })).status, 200)
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const c = await h.mcp(key.token)
    try {
      const r = await c.call('create_note', { path: `${h.home('member')}/${m.aTitle()}.md`, text: 'w'.repeat(5000) })
      assert.ok(r.error && r.raw.includes('note_too_large'), r.raw)
    } finally { await c.close() }
    // Back under the limit (a larger one): indexed whole again.
    writeFileSync(file, `notes:\n  maxSize: 1\n`)
    h.workspace.reload()
    h.runtime.rescan({})
    assert.equal((await h.member('GET', `/api/search?q=${word}`)).body.results.length, 1)
    assert.equal((await h.member('GET', `/api/note?path=${encodeURIComponent(big)}`)).body.tooLarge, undefined)
  } finally {
    h.close()
  }
})

test('templates are no longer folders: an old templates key is ignored with a warning, and nothing names one', async () => {
  const mine = m.aFolder()
  const h = await setup()
  try {
    writeFileSync(join(h.notesDir, 'vihko.yaml'), `templates: [${JSON.stringify(`people/{user}/${mine}`)}]\n` + readFileText(h))
    h.workspace.reload()
    assert.ok(!('templates' in (await h.member('GET', '/api/workspace')).body))
    const warnings = (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'config_warnings')?.warnings ?? []
    assert.deepEqual(warnings.map((w: any) => [w.code, w.at]), [['unknown_key', 'templates']])
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
    // The member writes in the space too, listed first: never picked by itself, the one in their own space is.
    assert.equal((await h.member('GET', '/api/daily')).body.series, own.id)
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
