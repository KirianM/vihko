// Link fixes against a running server: pinning an ambiguous link in a note
// open in the editor (written to the live document, D-031.2), and a
// note renamed on disk reaching the alerts through the watcher (D-031.4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { api, closeAll, connect, login, makeDirs, startServer, waitFor } from './_collab.ts'
import { inShared } from './_permissions.ts'

const NOTE = inShared('diario/2026-09-24.md')

test('pinning a link in an open note goes through the live document: someone typing right next to it keeps their text', async () => {
  const { env, notes } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    // A keystroke right after the link, not yet seen by the hub when the pin arrives.
    const typing = new Y.Doc()
    Y.applyUpdate(typing, Y.encodeStateAsUpdate(a.doc))
    const tt = typing.getText('md')
    tt.insert(tt.toString().indexOf('[[Tareas]]') + '[[Tareas]]'.length, ' (typed)')
    const r = await api(srv, cookie, 'POST', '/api/note/link/pin', { path: NOTE, raw: '[[Tareas]]', target: inShared('proyectos/blog/Tareas.md') })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.raw, '[[blog/Tareas]]')
    await waitFor(() => a.text().includes('[[blog/Tareas]]'), 'the pin reaches the editor')
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(typing, Y.encodeStateVector(a.doc)))
    await waitFor(() => a.provider.unsyncedChanges === 0, 'synced')
    assert.ok(a.text().includes('- [[blog/Tareas]] (typed) es ambiguo'), a.text())
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('- [[blog/Tareas]] (typed) es ambiguo'), 'flushed to the file')
  } finally { closeAll(); await srv.stop() }
})

test('a note renamed on disk while the server runs: the alert, and «Update links» fixes them', async () => {
  const { env, notes } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    renameSync(join(notes, inShared('hogar/Proxy.md')), join(notes, inShared('hogar/Hipervisor.md')))
    let alert: { id: string; links: number; moves: unknown } | undefined
    await waitFor(async () => {
      const r = await api(srv, cookie, 'GET', '/api/alerts')
      alert = r.body.alerts.find((x: { code: string }) => x.code === 'external_move')
      return !!alert
    }, 'the external move alert')
    assert.deepEqual(alert!.moves, [{ from: inShared('hogar/Proxy.md'), to: inShared('hogar/Hipervisor.md') }])
    assert.equal(alert!.links, 3)
    const r = await api(srv, cookie, 'POST', `/api/external-moves/${alert!.id}/relink`, { background: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(readFileSync(join(notes, inShared('hogar/enlaces.md')), 'utf8').includes('[[Hipervisor#Red]]'))
    const after = await api(srv, cookie, 'GET', '/api/alerts')
    assert.equal(after.body.alerts.filter((x: { code: string }) => x.code === 'external_move').length, 0)
  } finally { closeAll(); await srv.stop() }
})
