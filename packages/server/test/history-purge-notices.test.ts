// Purging and the people who wrote (M4.1, D-040 3.6): whoever else wrote in
// what goes is told, without the content (people, never agents, and never
// the one who purged); the path only while they can still read it. The admin
// purging what they can't read confirms at the moment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILES, RULES, setup } from './_m4.ts'

const TARTA = 'personas/laura/recetas/tarta.md'
const CONFIG = RULES + '  personas/laura/recetas:\n    grants: { laura: manage, "@familia": edit }\n'

type H = Awaited<ReturnType<typeof setup>>
type As = ReturnType<H['as']>
interface Notice { code: string; id: string; path: string | null; version: boolean; by: string; at: string; actions: string[] }

async function put(as: As, path: string, add: string) {
  const cur = await as('GET', `/api/note?path=${encodeURIComponent(path)}`)
  const r = await as('PUT', `/api/note?path=${encodeURIComponent(path)}`, { text: cur.body.text + add }, { 'if-match': `"${cur.body.etag}"` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

const notices = async (as: As) => ((await as('GET', '/api/alerts')).body.alerts as Notice[]).filter((a) => a.code === 'history_purged_authored')

test('a purge tells whoever else wrote in it, people and not agents, without the content; the path only while they can read it', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enable()
    const agent = await h.newKey('marta', { name: 'Script de Marta', canWrite: true })
    await put(h.laura, TARTA, 'Harina.\n')
    await h.settle()
    await put(h.marta, TARTA, 'Azúcar secreto.\n')
    await h.settle()
    await put(h.withKey(agent.token), TARTA, 'Del script.\n')
    await h.settle()
    const versions = (await h.laura('GET', `/api/history/versions?path=${encodeURIComponent(TARTA)}`)).body.versions as { id: string; authors: { kind: string; name: string }[] }[]
    const martas = versions.find((v) => v.authors.some((a) => a.kind === 'user' && a.name === 'marta'))!

    // Laura manages the folder: one of Marta's versions goes. Marta is told, by name and path.
    const one = await h.laura('POST', '/api/history/purge', { path: TARTA, version: martas.id })
    assert.equal(one.status, 200, JSON.stringify(one.body))
    const [n] = await notices(h.marta)
    assert.deepEqual({ ...n, id: undefined, at: undefined }, { code: 'history_purged_authored', id: undefined, at: undefined, path: TARTA, version: true, by: 'laura', actions: ['dismiss'] })
    assert.ok(!JSON.stringify(n).includes('Azúcar'), 'never the content')
    assert.deepEqual(await notices(h.laura), [], 'not whoever purged')
    assert.deepEqual(await notices(h.noa), [], 'nor anyone who didn\'t write in it')

    // The whole note, after Marta wrote again: told again. The agent that wrote on her behalf is not a person.
    await put(h.marta, TARTA, 'Otra vez.\n')
    await h.settle()
    assert.equal((await h.laura('POST', '/api/history/purge', { path: TARTA })).status, 200)
    const both = await notices(h.marta)
    assert.deepEqual(both.map((x) => [x.path, x.version]), [[TARTA, true], [TARTA, false]])

    // Out of the group, she can't read it any more: the notices say it neutrally.
    h.groupList.familia = ['laura']
    const neutral = await notices(h.marta)
    assert.deepEqual(neutral.map((x) => [x.path, x.version, x.by]), [[null, true, 'laura'], [null, false, 'laura']])
    const shown = JSON.stringify((await h.marta('GET', '/api/alerts')).body)
    for (const mark of ['recetas', 'tarta', 'personas/laura']) assert.ok(!shown.includes(mark), mark)

    // Each dismisses their own, and only their own.
    assert.equal((await h.laura('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 404)
    assert.equal((await h.marta('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 200)
    assert.equal((await h.marta('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 404)
    assert.equal((await notices(h.marta)).length, 1)
  } finally { await h.close() }
})

test('the admin purging what they can\'t read confirms at the moment; what they can read, not', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await put(h.marta, 'personas/marta/notas.md', 'Más Jade.\n')
    await put(h.marta, 'familia/compra.md', 'Pan.\n')
    await h.settle()

    // Marta's own note: Noa can't read it.
    const versionsOf = async () => (await h.marta('GET', '/api/history/versions?path=personas%2Fmarta%2Fnotas.md')).body.versions.length as number
    const before = await versionsOf()
    assert.ok(before > 0)
    const dry = await h.noa('POST', '/api/history/purge', { path: 'personas/marta/notas.md', dryRun: true })
    assert.deepEqual([dry.status, dry.body.confirmRequired], [200, true])
    const missing = await h.noa('POST', '/api/history/purge', { path: 'personas/marta/notas.md' })
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.noa('POST', '/api/history/purge', { path: 'personas/marta/notas.md', confirm: 'wrong' })).body.error, 'wrong_password')
    assert.equal(await versionsOf(), before, 'nothing purged yet')
    assert.equal((await h.noa('POST', '/api/history/purge', { path: 'personas/marta/notas.md', confirm: 'a-long-password' })).status, 200)
    const [told] = await notices(h.marta)
    assert.deepEqual([told!.path, told!.version, told!.by], ['personas/marta/notas.md', false, 'noa'], 'Marta can read it: its path')

    // A folder with something he can't read under it confirms too; a note he reads, not.
    assert.equal((await h.noa('POST', '/api/history/purge', { path: 'personas', dryRun: true })).body.confirmRequired, true)
    const shared = await h.noa('POST', '/api/history/purge', { path: 'familia/compra.md', dryRun: true })
    assert.equal(shared.body.confirmRequired, false)
    assert.equal((await h.noa('POST', '/api/history/purge', { path: 'familia/compra.md' })).status, 200)
    assert.equal((await notices(h.marta)).length, 2)
    // Whoever manages a note purges it with no confirmation: it's theirs to read.
    const laura = await h.laura('POST', '/api/history/purge', { path: TARTA, dryRun: true })
    assert.equal(laura.body.confirmRequired, false)
  } finally { await h.close() }
})
