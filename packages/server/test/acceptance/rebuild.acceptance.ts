// M1 «done when»: deleting the index and rebuilding it yields an identical dump.
//
// The index is first lived in: notes created, edited (closed and open),
// moved, trashed and changed from outside, all through the running server.
// Then the server stops, index.db is deleted, and a new start rebuilds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Indexer, dumpIndex, openIndex } from '@thoth/server'
import { api, closeAll, connect, login, typeLine } from '../_collab.ts'
import { PASSWORD, USER, cleanup, metric, sleep, startServer, waitFor, workspace, type Server } from './_harness.ts'

function dumpOf(file: string): string {
  const db = new Database(file, { readonly: true })
  try { return dumpIndex(db) } finally { db.close() }
}

function firstDifference(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n')
  const i = x.findIndex((l, k) => l !== y[k])
  return `line ${i}:\n- ${x[i]}\n+ ${y[i]}`
}

test('deleting index.db and rebuilding it gives an identical dump', { timeout: 300_000 }, async () => {
  const ws = workspace('rebuild')
  let srv: Server | null = null
  const indexFile = join(ws.stateDir, 'index.db')
  try {
    srv = await startServer(ws.env)
    const cookie = await login(srv, { username: USER, password: PASSWORD })
    const [a, b, c, d] = ws.vault.editable as [string, string, string, string]
    const ok = (r: { status: number; body: unknown }) => assert.ok(r.status < 300, JSON.stringify(r.body))
    // A lived-in index: every kind of change, through the server and from outside.
    ok(await api(srv, cookie, 'POST', '/api/note', { path: 'nuevas/Creada desde la API.md', text: '# Creada\n\n[[Arquitectura]] #nueva\n' }))
    ok(await api(srv, cookie, 'POST', '/api/note/edit', { path: a, ops: [{ op: 'append', text: '\n## Añadido\n\n[[Plan]] y [[Nota que no existe]]\n' }] }))
    ok(await api(srv, cookie, 'POST', '/api/note/move', { from: b, to: 'movidas/' + b.split('/').pop() }))
    ok(await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(c)}`))
    const live = await connect(srv, cookie, d)
    for (let i = 0; i < 20; i++) typeLine(live, `typed in the editor ${i} [[Tareas]] #vivo`)
    await waitFor(() => readFileSync(join(ws.notesDir, d), 'utf8').includes('typed in the editor 19'), 'flush')
    live.close()
    closeAll()
    appendFileSync(join(ws.notesDir, ws.vault.editable[4]!), '\nEdited outside [[Inicio]] #fuera\n')
    writeFileSync(join(ws.notesDir, 'Escrita fuera.md'), '---\naliases: [fuera]\n---\n# Escrita fuera\n\n[[Diseño]]\n')
    rmSync(join(ws.notesDir, ws.vault.editable[5]!))
    await sleep(1500) // watcher events
    await srv.stop()

    const lived = dumpOf(indexFile)
    // Delete it and start again: the index is rebuilt from the files.
    for (const s of ['', '-wal', '-shm']) rmSync(indexFile + s, { force: true })
    srv = await startServer(ws.env)
    metric('rebuild on start (index.db deleted)', srv.listeningMs, 'ms', { indexReadyMs: Math.round(srv.indexedMs) })
    await srv.stop()
    assert.ok(existsSync(indexFile))
    const rebuilt = dumpOf(indexFile)
    const rows = rebuilt.split('\n').filter((l) => !l.startsWith('## ')).length
    metric('index dump', rows, 'rows', { bytes: rebuilt.length })
    assert.ok(lived === rebuilt, `the lived-in index differs from the rebuilt one, ${firstDifference(lived, rebuilt)}`)

    // And the same as indexing the folder in another process.
    const fresh = openIndex(join(ws.root, 'fresh.db'))
    new Indexer({ notesDir: ws.notesDir, db: fresh }).scan()
    const other = dumpIndex(fresh)
    fresh.close()
    assert.ok(other === rebuilt, `a rebuild elsewhere differs, ${firstDifference(other, rebuilt)}`)
    assert.ok(rows > 10_000, `a real index (${rows} rows)`)
  } finally {
    closeAll()
    await srv?.stop()
    cleanup(ws)
  }
})
