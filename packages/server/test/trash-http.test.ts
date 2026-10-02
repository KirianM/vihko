// Through the API: a note deleted with its images is one version and one
// trash entry; a folder that holds more than notes says what it holds, its
// hidden folders too (capped, relative to it: whoever manages it sees all of
// it), and can go to the trash whole, hidden folders included, and come
// back; only a link stops it; an agent's deletion takes only the images it
// may write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { FOLDER_LIST_CAP } from '@vihko/server'
import { PNG, setup } from './_agents.ts'
import { inShared, sharedSpace } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const token = () => m.aUniqueWord()
const q = (path: string, extra = '') => `?path=${encodeURIComponent(path)}${extra}`

test('a note and the images only it uses are deleted in one version, and restored together', async () => {
  const [NOTE, OWN, SHARED, OTHER] = [token(), token(), token(), token()]
  const DIR = inShared(token())
  const note = `${DIR}/${NOTE}.md`
  const h = await setup({ files: {
    [note]: `# ${m.aHeading()}\n\n![](${OWN}.png) ![](${SHARED}.png)\n`,
    [`${DIR}/${OTHER}.md`]: `![](${SHARED}.png)\n`,
    [`${DIR}/${OWN}.png`]: PNG, [`${DIR}/${SHARED}.png`]: PNG,
  } })
  try {
    const del = await h.admin('DELETE', `/api/note${q(note)}`)
    assert.equal(del.status, 200, del.text)
    assert.deepEqual(del.body.files.map((f: { path: string }) => f.path), [`${DIR}/${OWN}.png`])
    assert.ok(!existsSync(join(h.notesDir, DIR, `${OWN}.png`)) && existsSync(join(h.notesDir, DIR, `${SHARED}.png`)))
    const listed = (await h.admin('GET', '/api/trash')).body.entries
    assert.deepEqual(listed.map((e: { id: string; files: unknown }) => [e.id, e.files]), [[del.body.id, del.body.files]])

    await h.settle()
    const changes = (await h.admin('GET', '/api/history/changes')).body.changes as { files: { path: string; change: string }[] }[]
    const deletion = changes.find((ch) => ch.files.some((f) => f.path === note && f.change === 'deleted'))
    assert.deepEqual(deletion?.files.map((f) => [f.path, f.change]).sort(), [[`${DIR}/${OWN}.png`, 'deleted'], [note, 'deleted']].sort())

    const back = await h.admin('POST', `/api/trash/${del.body.id}/restore`, {})
    assert.equal(back.status, 200, back.text)
    assert.deepEqual([back.body.path, back.body.files, back.body.left], [note, [{ from: `${DIR}/${OWN}.png`, to: `${DIR}/${OWN}.png` }], []])
    assert.ok(readFileSync(join(h.notesDir, DIR, `${OWN}.png`)).equals(PNG))
  } finally { await h.close() }
})

test('deleting a folder with files in it says what they are, its hidden folders too; with trash=true all of it goes to the trash, and comes back', async () => {
  const [SUB, NOTE, LINK] = [token(), token(), token()]
  const DIR = inShared(token())
  const images = Array.from({ length: FOLDER_LIST_CAP + 3 }, () => `${SUB}/${token()}.png`)
  // Literals: other tools' folders (Git's, Obsidian's, one inside a subfolder), which vihko doesn't show, are the case under test.
  const hidden = { '.git/HEAD': m.aSentence(), '.git/refs/heads/main': m.aSentence(), '.obsidian/app.json': `{"x":"${m.aWord()}"}`, [`${SUB}/.trash/${token()}.md`]: m.aSentence() }
  const h = await setup({ files: {
    [`${DIR}/${NOTE}.md`]: `# ${m.aHeading()}\n`,
    ...Object.fromEntries(images.map((p) => [`${DIR}/${p}`, PNG])),
    ...Object.fromEntries(Object.entries(hidden).map(([p, text]) => [`${DIR}/${p}`, text])),
  } })
  try {
    const plain = await h.admin('DELETE', `/api/folder${q(DIR)}`)
    assert.equal(plain.status, 409)
    assert.equal(plain.body.error, 'not_empty')
    const c = plain.body.contents
    assert.deepEqual(c.notes, { total: 1, paths: [`${NOTE}.md`] })
    assert.equal(c.files.total, images.length)
    assert.deepEqual(c.files.paths, [...images].sort().slice(0, FOLDER_LIST_CAP), 'capped, relative to the folder')
    assert.deepEqual(c.hidden, { total: 3, paths: ['.git/', '.obsidian/', `${SUB}/.trash/`].sort(), files: 4 })
    assert.deepEqual(c.kept, { total: 0, paths: [] })
    assert.ok(!('locked' in c), 'whoever deletes a folder manages it and sees all of it: nothing is only counted')

    // A link vihko never follows stops it: nothing moves.
    symlinkSync(join(h.notesDir, DIR, `${NOTE}.md`), join(h.notesDir, DIR, '.obsidian', LINK))
    const refused = await h.admin('DELETE', `/api/folder${q(DIR, '&trash=true')}`)
    assert.deepEqual([refused.status, refused.body.error, refused.body.contents.kept], [409, 'not_empty', { total: 1, paths: [`.obsidian/${LINK}`] }])
    assert.ok(existsSync(join(h.notesDir, DIR, `${NOTE}.md`)))
    assert.deepEqual((await h.admin('GET', '/api/trash')).body.entries, [])
    rmSync(join(h.notesDir, DIR, '.obsidian', LINK))

    // Only whoever manages the folder deletes it: the member edits it.
    assert.equal((await h.member('DELETE', `/api/folder${q(DIR, '&trash=true')}`)).status, 403)
    const done = await h.admin('DELETE', `/api/folder${q(DIR, '&trash=true')}`)
    assert.equal(done.status, 200, done.text)
    assert.ok(!existsSync(join(h.notesDir, DIR)), 'hidden folders went with it')
    const ids = (done.body.trashed as { id: string }[]).map((e) => e.id)
    assert.deepEqual((await h.admin('GET', '/api/trash')).body.entries.map((e: { id: string }) => e.id).sort(), [...ids].sort())
    assert.ok(!(await h.admin('GET', '/api/tree')).body.folders.includes(DIR))

    for (const id of ids) assert.equal((await h.admin('POST', `/api/trash/${id}/restore`, {})).status, 200)
    assert.ok(existsSync(join(h.notesDir, DIR, `${NOTE}.md`)))
    for (const p of images) assert.ok(readFileSync(join(h.notesDir, DIR, p)).equals(PNG), p)
    for (const [p, text] of Object.entries(hidden)) assert.equal(readFileSync(join(h.notesDir, DIR, p), 'utf8'), text, p)
    assert.deepEqual((await h.admin('GET', '/api/trash')).body.entries, [], 'nothing left behind')
  } finally { await h.close() }
})

test('whoever deletes a folder is told all of it, whatever a subfolder shares with others (grants only add)', async () => {
  const [NOTE, SUB, THEIRS, IMG] = [token(), token(), token(), token()]
  const DIR = inShared(token())
  const h = await setup({
    // The member manages a subfolder of the folder: it gives the admin, who manages the space, nothing less.
    config: (n) => `${sharedSpace({ [n.admin]: 'manage', [n.member]: 'edit' })}  ${JSON.stringify(`${DIR}/${SUB}`)}:\n    grants: { ${JSON.stringify(n.member)}: manage }\n`,
    files: { [`${DIR}/${NOTE}.md`]: m.aSentence(), [`${DIR}/${IMG}.png`]: PNG, [`${DIR}/${SUB}/${THEIRS}.md`]: m.aSentence() },
  })
  try {
    const r = await h.admin('DELETE', `/api/folder${q(DIR)}`)
    assert.equal(r.status, 409)
    assert.deepEqual(r.body.contents.notes, { total: 2, paths: [`${NOTE}.md`, `${SUB}/${THEIRS}.md`].sort() })
    assert.deepEqual(r.body.contents.files, { total: 1, paths: [`${IMG}.png`] })
    assert.ok(!('locked' in r.body.contents))
    const done = await h.admin('DELETE', `/api/folder${q(DIR, '&trash=true')}`)
    assert.equal(done.status, 200, done.text)
    assert.ok(!existsSync(join(h.notesDir, DIR)))
  } finally { await h.close() }
})

test('an agent deleting a note takes only the images it may write: not those in a folder closed to agents', async () => {
  const [NOTE, OPEN, CLOSED, HIDDEN] = [token(), token(), token(), token()]
  const DIR = inShared(token())
  const note = `${DIR}/${NOTE}.md`
  const assets = `${DIR}/${NOTE}.assets`
  const h = await setup({
    config: (n) => `attachments:\n  mode: per-note\n${sharedSpace({ [n.admin]: 'manage', [n.member]: 'edit' })}  ${JSON.stringify(`${assets}/${CLOSED}`)}:\n    ai: false\n`,
    files: { [note]: `![](${NOTE}.assets/${OPEN}.png) ![](${NOTE}.assets/${CLOSED}/${HIDDEN}.png)\n`, [`${assets}/${OPEN}.png`]: PNG, [`${assets}/${CLOSED}/${HIDDEN}.png`]: PNG },
  })
  try {
    await h.enableApi()
    const agent = h.withKey((await h.newKey({ name: m.aKeyName(), canWrite: true })).token)
    const del = await agent('DELETE', `/api/note${q(note)}`)
    assert.equal(del.status, 200, del.text)
    assert.deepEqual(del.body.files.map((f: { path: string }) => f.path), [`${assets}/${OPEN}.png`])
    assert.ok(existsSync(join(h.notesDir, assets, CLOSED, `${HIDDEN}.png`)), 'what is closed to agents stays')
  } finally { await h.close() }
})
