// Purging from the UI while thoth runs (D-038.9), in process: whoever manages
// the folder, a note or one of its versions and nothing else; the admin, any
// path by its name; the history paused and resumed, writes made meanwhile
// kept; the admin's notice, without the content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Git } from '@thoth/server'
import { FILES, RULES, setup } from './_m4.ts'

const TARTA = 'personas/laura/recetas/tarta.md'
const DIARY = 'personas/laura/diario/2026-09-27.md'
const SHARED = RULES + '  personas/laura/recetas:\n    grants: { laura: manage, noa: comment, marta: read }\n'

type As = ReturnType<Awaited<ReturnType<typeof setup>>['as']>

async function put(as: As, path: string, edit: (t: string) => string) {
  const cur = await as('GET', `/api/note?path=${encodeURIComponent(path)}`)
  const r = await as('PUT', `/api/note?path=${encodeURIComponent(path)}`, { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

/** Every object in the managed repository, reachable or not, with its contents. */
async function objects(stateDir: string): Promise<string> {
  return (await new Git({ gitDir: join(stateDir, 'history.git') }).run(['cat-file', '--batch-all-objects', '--batch'])).stdout.toString('latin1')
}

test('whoever manages a folder purges a version of a note in it from the UI: gone from the repository, nothing else touched; the admin gets a notice without the content', async () => {
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const SECRET = 'CLAVE-SECRETA-5d2b'
    await put(h.laura, DIARY, (t) => t + `${SECRET}\n`)
    await h.settle()
    await put(h.laura, DIARY, (t) => t.replace(`${SECRET}\n`, 'Sin secreto.\n'))
    await h.settle()
    await put(h.laura, 'familia/compra.md', (t) => t + 'Pan.\n')
    await h.settle()
    const versionsOf = async (path: string, as: As = h.laura) => (await as('GET', `/api/history/versions?path=${encodeURIComponent(path)}`)).body.versions as { id: string }[]
    const [, secret] = await versionsOf(DIARY)
    const compra = (await versionsOf('familia/compra.md')).length
    assert.ok((await objects(h.stateDir)).includes(SECRET))

    // Not hers to purge: someone else's, or a note she edits without managing it.
    assert.equal((await h.laura('POST', '/api/history/purge', { path: 'personas/noa/plan.md', dryRun: true })).status, 404)
    assert.equal((await h.laura('POST', '/api/history/purge', { path: 'familia/compra.md', dryRun: true })).status, 403)
    assert.equal((await h.marta('POST', '/api/history/purge', { path: TARTA, dryRun: true })).status, 403)
    assert.equal((await h.noa('POST', '/api/history/purge', { path: 'thoth.yaml', dryRun: true })).status, 200, 'the admin, any path by name')
    assert.equal((await h.laura('POST', '/api/history/purge', { path: 'thoth.yaml', dryRun: true })).status, 400, 'a note, not thoth.yaml')

    // The confirmation: what goes, without the content.
    const dry = await h.laura('POST', '/api/history/purge', { path: DIARY, version: secret!.id, dryRun: true })
    assert.equal(dry.status, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.dryRun, true)
    assert.ok(dry.body.versions.length >= 1)
    assert.ok(!JSON.stringify(dry.body).includes(SECRET))
    assert.ok((await objects(h.stateDir)).includes(SECRET), 'a dry run changes nothing')

    const run = await h.laura('POST', '/api/history/purge', { path: DIARY, version: secret!.id })
    assert.equal(run.status, 200, JSON.stringify(run.body))
    assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'nothing of it left in the repository')
    assert.equal((await versionsOf('familia/compra.md')).length, compra, 'the other notes keep their versions')
    assert.ok(readFileSync(join(h.notesDir, DIARY), 'utf8').includes('Sin secreto.'), 'the note itself is untouched')

    // The history goes on: a write after the purge is a version.
    await put(h.laura, 'familia/compra.md', (t) => t + 'Huevos.\n')
    await h.settle()
    assert.equal((await versionsOf('familia/compra.md')).length, compra + 1)

    // The admin is told who and what, never the content; nobody else.
    const alerts = async (as: As) => ((await as('GET', '/api/alerts')).body.alerts as { code: string; id: string; path: string; version: string | null; by: string }[]).filter((a) => a.code === 'history_purged')
    const notices = await alerts(h.noa)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.path, DIARY)
    assert.match(notices[0]!.version ?? '', /^[0-9a-f]{40}$/)
    assert.ok(notices[0]!.version!.startsWith(secret!.id.slice(0, 7)))
    assert.equal(notices[0]!.by, 'laura')
    assert.ok(!JSON.stringify(notices).includes(SECRET))
    assert.deepEqual(await alerts(h.laura), [])
    assert.deepEqual(await alerts(h.marta), [])
    assert.equal((await h.laura('DELETE', `/api/history/purges/${notices[0]!.id}`)).status, 403)
    assert.equal((await h.noa('DELETE', `/api/history/purges/${notices[0]!.id}`)).status, 200)
    assert.deepEqual(await alerts(h.noa), [])
  } finally { await h.close() }
})

test('a manager purges a note\'s whole history (that file alone); the admin purges a folder he can\'t read by its name; notes written meanwhile keep their versions', async () => {
  const h = await setup({ files: { ...FILES, 'personas/marta/notas-viejas.md': '# Viejas\n' }, config: SHARED })
  try {
    await put(h.laura, DIARY, (t) => t + 'Uno.\n')
    await put(h.marta, 'personas/marta/notas.md', (t) => t + 'Más Jade.\n')
    await put(h.marta, 'personas/marta/notas-viejas.md', (t) => t + 'Viejo Jade.\n')
    await h.settle()
    const versionsOf = async (path: string, as: As) => (await as('GET', `/api/history/versions?path=${encodeURIComponent(path)}`)).body.versions as unknown[]

    // Laura: that note alone, never what's next to it.
    const r = await h.laura('POST', '/api/history/purge', { path: DIARY })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.onDisk, 1, 'still in the folder: it enters again with its next version')
    assert.deepEqual(await versionsOf(DIARY, h.laura), [])
    await h.history.recorder.sweep('periodic')
    await h.settle()
    assert.deepEqual(await versionsOf(DIARY, h.laura), [], 'what the folder holds is known, not a change made outside')
    await put(h.laura, DIARY, (t) => t + 'Dos.\n')
    await h.settle()
    assert.equal((await versionsOf(DIARY, h.laura)).length, 1)
    // A manager purges files, not folders.
    assert.notEqual((await h.laura('POST', '/api/history/purge', { path: 'personas/laura/diario' })).status, 200)

    // The admin, Marta's folder by its name: he can't read it, and the answer says nothing of it but how much.
    const writing = put(h.laura, 'familia/compra.md', (t) => t + 'Mientras.\n')
    const k = await h.noa('POST', '/api/history/purge', { path: 'personas/marta' })
    await writing
    assert.equal(k.status, 200, JSON.stringify(k.body))
    for (const mark of ['Jade', 'notas.md', 'notas-viejas']) assert.ok(!JSON.stringify(k.body).includes(mark), mark)
    assert.deepEqual(await versionsOf('personas/marta/notas.md', h.marta), [])
    assert.deepEqual(await versionsOf('personas/marta/notas-viejas.md', h.marta), [])
    assert.ok(!(await objects(h.stateDir)).includes('Viejo Jade'))
    await h.settle()
    const compra = (await versionsOf('familia/compra.md', h.laura)) as { authors: { name: string }[] }[]
    assert.equal(compra[0]!.authors[0]!.name, 'laura', 'the write made during the purge has its version')
    const alerts = ((await h.noa('GET', '/api/alerts')).body.alerts as { code: string; path: string; by: string }[]).filter((a) => a.code === 'history_purged')
    assert.deepEqual(alerts.map((a) => [a.path, a.by]), [[DIARY, 'laura'], ['personas/marta', 'noa']])
  } finally { await h.close() }
})

test('the notices of purges outlive a restart, and a broken file of them is no notice', async () => {
  const { PurgeNotices } = await import('../src/history/notices.ts')
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const n = new PurgeNotices(h.stateDir)
    n.add({ path: 'a.md', version: null, by: 'u1', at: '2026-09-27T10:00:00.000Z' })
    assert.deepEqual(new PurgeNotices(h.stateDir).all().map((x) => x.path), ['a.md'])
    writeFileSync(join(h.stateDir, 'history', 'purges.json'), '{ no')
    assert.deepEqual(new PurgeNotices(h.stateDir).all(), [])
  } finally { await h.close() }
})
