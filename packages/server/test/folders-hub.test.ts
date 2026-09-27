import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor } from './_collab.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** Lines typed or written to find again: words no other text has. */
const MARK = {
  afterMove: m.aUniqueWord(),
  typed: m.aUniqueWord(),
  unflushedA: m.aUniqueWord(),
  unflushedB: m.aUniqueWord(),
}

test('moving a folder with open notes: each editor follows its note, nothing typed is lost, no alert', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, 'hogar/Proxy.md')
    const b = await connect(srv, cookie, 'hogar/Red.md')
    const moved: { from: string; to: string }[] = []
    for (const c of [a, b]) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:moved') moved.push({ from: m.from, to: m.to }) })
    typeLine(a, MARK.unflushedA) // still in the debounce: the move flushes it first
    typeLine(b, MARK.unflushedB)
    await waitFor(() => a.provider.unsyncedChanges === 0 && b.provider.unsyncedChanges === 0, 'sent to the server')

    // Into a new folder, a level down, with spaces in its name.
    const to = `${m.aFolder()}/${m.aTitle()} ${m.aWord()}`
    const r = await api(srv, cookie, 'POST', '/api/folder/move', { from: 'hogar', to })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.failed, [])
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved.sort((x, y) => (x.from < y.from ? -1 : 1)), [
      { from: 'hogar/Proxy.md', to: `${to}/Proxy.md` },
      { from: 'hogar/Red.md', to: `${to}/Red.md` },
    ])
    assert.ok(!existsSync(join(notes, 'hogar')))
    assert.ok(readFileSync(join(notes, `${to}/Proxy.md`), 'utf8').includes(`${MARK.unflushedA}\n`))
    assert.ok(readFileSync(join(notes, `${to}/Red.md`), 'utf8').includes(`${MARK.unflushedB}\n`))
    a.close(); b.close()

    // It reopens at the new path and editing goes on; the old path is never recreated.
    const c = await connect(srv, cookie, `${to}/Proxy.md`)
    assert.ok(c.text().includes(`${MARK.unflushedA}\n`))
    typeLine(c, MARK.afterMove)
    await waitFor(() => readFileSync(join(notes, `${to}/Proxy.md`), 'utf8').includes(MARK.afterMove), 'flushed at the new path')
    await sleep(1500) // a watcher round and a hub check
    assert.ok(!existsSync(join(notes, 'hogar')), 'the old folder is not recreated')
    const alerts = (await api(srv, cookie, 'GET', '/api/alerts')).body.alerts as { code: string }[]
    assert.deepEqual(alerts.filter((x) => x.code === 'orphaned_note' || x.code === 'scan_aborted_mass_delete'), [], 'seen as thoth\'s own move')
    const tree = (await api(srv, cookie, 'GET', '/api/tree')).body
    assert.ok(tree.folders.includes(to) && !tree.folders.includes('hogar'))
  } finally { closeAll(); await srv.stop() }
})

test('moving a folder while someone types in a note that links into it: link rewritten, typing intact', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const outside = m.aNotePath()
    const [before, after] = [m.aSentence().slice(0, -1), m.aSentence()]
    const created = await api(srv, cookie, 'POST', '/api/note', { path: outside, text: `# ${m.aHeading()}\n\n${before} [[hogar/Proxy]] ${after}\n` })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const a = await connect(srv, cookie, outside)
    let typing = true
    const typed: string[] = []
    const typer = (async () => {
      for (let i = 0; typing; i++) { const t = `${MARK.typed}-${i}-END`; typed.push(t); typeLine(a, t); await sleep(3) }
    })()
    await sleep(50)
    const r = await api(srv, cookie, 'POST', '/api/folder/move', { from: 'hogar', to: m.aFolder() })
    await sleep(50)
    typing = false
    await typer
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.failed, [])
    const file = join(notes, outside)
    await waitFor(() => a.provider.unsyncedChanges === 0 && readFileSync(file, 'utf8') === a.text(), 'converged on disk')
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('hogar/Proxy'), 'the link into the moved folder is rewritten')
    assert.match(text, new RegExp(`${before} \\[\\[[^\\]]*Proxy\\]\\] ${after.replace('.', '\\.')}`, 'u'), 'only the link target changed')
    for (const t of typed) assert.equal(text.split('\n').filter((l) => l === t).length, 1, `${t} typed once and intact`)
  } finally { closeAll(); await srv.stop() }
})
