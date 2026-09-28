// Through the API: a note deleted with its images is one version and one
// trash entry; an agent's deletion takes only the images it may write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const token = () => m.aUniqueWord()
const q = (path: string, extra = '') => `?path=${encodeURIComponent(path)}${extra}`

test('a note and the images only it uses are deleted in one version, and restored together', async () => {
  const [DIR, NOTE, OWN, SHARED, OTHER] = [token(), token(), token(), token(), token()]
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

test('an agent deleting a note takes only the images it may write: not those in a folder closed to agents', async () => {
  const [DIR, NOTE, OPEN, CLOSED, HIDDEN] = [token(), token(), token(), token(), token()]
  const note = `${DIR}/${NOTE}.md`
  const assets = `${DIR}/${NOTE}.assets`
  const h = await setup({
    config: (n) => `attachments:\n  mode: per-note\npermissions:\n  "":\n    grants: { ${JSON.stringify(n.admin)}: manage, ${JSON.stringify(n.member)}: edit }\n  ${JSON.stringify(`${assets}/${CLOSED}`)}:\n    ai: false\n`,
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
