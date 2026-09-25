import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor } from './_collab.ts'

test('moving a folder with open notes: each editor follows its note, nothing typed is lost, no alert', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, 'hogar/Proxy.md')
    const b = await connect(srv, cookie, 'hogar/Red.md')
    const moved: { from: string; to: string }[] = []
    for (const c of [a, b]) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:moved') moved.push({ from: m.from, to: m.to }) })
    typeLine(a, 'UNFLUSHED-A') // still in the debounce: the move flushes it first
    typeLine(b, 'UNFLUSHED-B')
    await waitFor(() => a.provider.unsyncedChanges === 0 && b.provider.unsyncedChanges === 0, 'sent to the server')

    const r = await api(srv, cookie, 'POST', '/api/folder/move', { from: 'hogar', to: 'infra/red de casa' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.failed, [])
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved.sort((x, y) => (x.from < y.from ? -1 : 1)), [
      { from: 'hogar/Proxy.md', to: 'infra/red de casa/Proxy.md' },
      { from: 'hogar/Red.md', to: 'infra/red de casa/Red.md' },
    ])
    assert.ok(!existsSync(join(notes, 'hogar')))
    assert.ok(readFileSync(join(notes, 'infra/red de casa/Proxy.md'), 'utf8').includes('UNFLUSHED-A\n'))
    assert.ok(readFileSync(join(notes, 'infra/red de casa/Red.md'), 'utf8').includes('UNFLUSHED-B\n'))
    a.close(); b.close()

    // It reopens at the new path and editing goes on; the old path is never recreated.
    const c = await connect(srv, cookie, 'infra/red de casa/Proxy.md')
    assert.ok(c.text().includes('UNFLUSHED-A\n'))
    typeLine(c, 'AFTER-MOVE')
    await waitFor(() => readFileSync(join(notes, 'infra/red de casa/Proxy.md'), 'utf8').includes('AFTER-MOVE'), 'flushed at the new path')
    await sleep(1500) // a watcher round and a hub check
    assert.ok(!existsSync(join(notes, 'hogar')), 'the old folder is not recreated')
    const alerts = (await api(srv, cookie, 'GET', '/api/alerts')).body.alerts as { code: string }[]
    assert.deepEqual(alerts.filter((x) => x.code === 'orphaned_note' || x.code === 'scan_aborted_mass_delete'), [], 'seen as thoth\'s own move')
    const tree = (await api(srv, cookie, 'GET', '/api/tree')).body
    assert.ok(tree.folders.includes('infra/red de casa') && !tree.folders.includes('hogar'))
  } finally { closeAll(); await srv.stop() }
})
