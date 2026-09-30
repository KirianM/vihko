// Moves in the background: the request answers once the note (or folder) is
// in place, the rewrites go on with their progress, and the report arrives at
// the end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

// The vault's notes move (its links are the fixture); where they go is the mother's.
const m = mother(import.meta.url)
// The vault's notes, in the shared space where the setup puts them.
const [PROXY, RED, FIREWALL, ENLACES, DIARY] = ['hogar/Proxy.md', 'hogar/Red.md', 'hogar/Firewall.md', 'hogar/enlaces.md', 'diario/2026-09-24.md'].map(inShared) as [string, string, string, string, string]

async function until(get: () => Promise<{ body: any }>, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const r = await get()
    if (r.body?.state !== 'running') return r
    if (Date.now() > end) throw new Error('the job did not finish')
    await new Promise((res) => setTimeout(res, 20))
  }
}

test('a background rename answers with a job once the note is in place, and the job ends with the report', async () => {
  const { admin, member, notesDir } = await setup({ moveWaitMs: 0 })
  const title = m.aTitle()
  const to = inShared(`hogar/${title}.md`)
  const res = await admin('POST', '/api/note/move', { from: PROXY, to, background: true })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  const job = res.body.job
  assert.deepEqual([job.kind, job.from, job.to, job.state], ['note', PROXY, to, 'running'])
  assert.ok(job.total >= 1, 'it knows how many notes it will rewrite')
  assert.ok(existsSync(join(notesDir, to)) && !existsSync(join(notesDir, PROXY)), 'the note is already in place')

  assert.equal((await member('GET', `/api/move-jobs/${job.id}`)).status, 404, 'only whoever started it sees it')
  const end = await until(() => admin('GET', `/api/move-jobs/${job.id}`))
  assert.equal(end.body.state, 'done')
  assert.equal(end.body.done, end.body.total)
  assert.deepEqual(end.body.report.failed, [])
  assert.ok(end.body.report.relinked.some((r: { path: string }) => r.path === ENLACES))
  assert.ok(readFileSync(join(notesDir, ENLACES), 'utf8').includes(`[[${title}#Red]]`))
})

test('a quick background move answers with the report itself; an impossible one, with its error', async () => {
  const { admin } = await setup({ moveWaitMs: 5_000 })
  const to = m.aNotePath(inShared('hogar'))
  const res = await admin('POST', '/api/note/move', { from: PROXY, to, background: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.to, to)
  assert.ok(res.body.relinked.length > 0)
  const taken = await admin('POST', '/api/note/move', { from: RED, to: FIREWALL, background: true })
  assert.equal(taken.status, 409)
  assert.equal(taken.body.error, 'exists')
  assert.equal((await admin('GET', `/api/move-jobs/${m.faker.string.ulid()}`)).status, 404)
})

// To `blog`, the name of the partial path a vault note links with: the case under test (the link shifts).
test('a background folder move follows the same path', async () => {
  const { admin, notesDir } = await setup({ moveWaitMs: 0 })
  const res = await admin('POST', '/api/folder/move', { from: inShared('proyectos/blog'), to: inShared('blog'), background: true })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  assert.equal(res.body.job.kind, 'folder')
  const end = await until(() => admin('GET', `/api/move-jobs/${res.body.job.id}`))
  assert.equal(end.body.state, 'done')
  assert.deepEqual(end.body.report.failed, [])
  assert.ok(readFileSync(join(notesDir, DIARY), 'utf8').includes('- [[blog/Plan]] ruta parcial'))
  assert.deepEqual(end.body.report.shifted.map((g: { path: string }) => g.path), [DIARY])
})
