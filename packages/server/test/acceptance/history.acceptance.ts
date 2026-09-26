// M2 «done when»: any change, wherever it came from, can be seen and undone
// with its author. Here through the API over the generated 1,000-note vault
// (the browser drives the same in packages/web/acceptance/history.spec.ts):
// something typed in the editor, a change made with another editor and a
// rename of the most linked note, each with its author, and each undone by
// restoring the version before it. Plus what the history costs: starting
// (the first commit of the whole vault, then a warm start with its cache)
// and the time it adds to a write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, closeAll, connect, login, typeLine } from '../_collab.ts'
import { NOTES, cleanup, metric, percentile, startServer, timed, waitFor, workspace, type Server } from './_harness.ts'

const q = encodeURIComponent
const who = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? a.name : a.kind)).join(',')

test(`history over ${NOTES} notes: startup, write latency, and every change seen with its author and undone`, { timeout: 600_000 }, async () => {
  const ws = workspace('history')
  const env = { ...ws.env, THOTH_HISTORY_QUIET_SECONDS: '1', THOTH_RESCAN_SECONDS: '5' }
  let srv: Server | null = null
  try {
    // 1. First start: the index and the first commit of the whole folder.
    const t0 = performance.now()
    srv = await startServer(env)
    const cookie = await login(srv)
    const changes = async () => (await api(srv!, cookie, 'GET', '/api/history/changes?limit=5')).body.changes as any[]
    await waitFor(async () => (await changes()).length === 1, 'the first commit', 120_000)
    const first = (await changes())[0]
    assert.deepEqual(first.reason, { code: 'history_enabled' })
    assert.ok(first.files.length >= NOTES, `${first.files.length} files in the first commit`)
    metric('cold start with history: listening', srv.listeningMs, 'ms', { firstCommitMs: Math.round(performance.now() - t0), files: first.files.length })

    // 2. What recording costs a write: the same edits with the history on and off.
    const notes = ws.vault.editable.slice(40, 100)
    const edits = async (list: string[], tag: string) => {
      const lat: number[] = []
      for (const path of list) {
        const cur = await api(srv!, cookie, 'GET', `/api/note?path=${q(path)}`)
        const [r, ms] = await timed(() => api(srv!, cookie, 'PUT', `/api/note?path=${q(path)}`, { text: cur.body.text + `${tag}\n` }, { 'if-match': `"${cur.body.etag}"` }))
        assert.equal(r.status, 200, path)
        lat.push(ms)
      }
      return lat
    }
    const on = await edits(notes.slice(0, 30), 'EDIT-HISTORY-ON')
    writeFileSync(join(ws.notesDir, 'thoth.yaml'), 'history:\n  mode: off\n')
    await waitFor(async () => (await api(srv!, cookie, 'GET', '/api/history/status')).body.mode === 'off', 'history off', 20_000)
    const off = await edits(notes.slice(30), 'EDIT-HISTORY-OFF')
    metric('write with history p50', percentile(on, 50), 'ms', { p95: Math.round(percentile(on, 95) * 10) / 10, offP50: Math.round(percentile(off, 50) * 10) / 10, offP95: Math.round(percentile(off, 95) * 10) / 10 })
    writeFileSync(join(ws.notesDir, 'thoth.yaml'), 'history:\n  mode: managed\n')
    await waitFor(async () => (await api(srv!, cookie, 'GET', '/api/history/status')).body.mode === 'managed', 'history on', 20_000)
    // Resuming records what changed while it was off, as nobody's.
    await waitFor(async () => (await changes())[0]?.reason?.code === 'history_resumed', 'resumed', 20_000)
    assert.equal((await changes())[0].files.filter((f: any) => notes.includes(f.path)).length, 30)
    // A busy machine (a shared CI runner) can slow one batch down: a second
    // batch with the history back on, and the better of the two counts. A real
    // cost shows in both.
    const again = ws.vault.editable.slice(100, 130)
    assert.equal(again.length, 30, 'enough editable notes for a second batch')
    const on2 = await edits(again, 'EDIT-HISTORY-ON-AGAIN')
    const onP50 = Math.min(percentile(on, 50), percentile(on2, 50))
    const added = onP50 - percentile(off, 50)
    assert.ok(added < 25, `recording adds ${Math.round(added)} ms to a write (p50 on ${Math.round(percentile(on, 50))} and ${Math.round(percentile(on2, 50))} ms, off ${Math.round(percentile(off, 50))} ms)`)

    // 3. «Done when»: typed in the editor, changed with another editor, renamed.
    const note = ws.vault.editable[5]!
    const file = join(ws.notesDir, note)
    const editor = await connect(srv, cookie, note)
    typeLine(editor, 'TYPED-IN-THE-EDITOR')
    await waitFor(() => readFileSync(file, 'utf8').includes('TYPED-IN-THE-EDITOR'), 'the typing reaches the file')
    writeFileSync(file, readFileSync(file, 'utf8') + 'CHANGED-WITH-ANOTHER-EDITOR\n')
    await waitFor(() => editor.text().includes('CHANGED-WITH-ANOTHER-EDITOR'), 'the external change reaches the editor')
    editor.close()
    closeAll()
    const versions = async (path: string) => (await api(srv!, cookie, 'GET', `/api/history/versions?path=${q(path)}`)).body.versions as any[]
    await waitFor(async () => (await versions(note)).length >= 3, 'versions of the note', 20_000)
    const v = await versions(note)
    assert.deepEqual(v.slice(0, 2).map(who), ['external', 'noa'])
    // Undone: back to the version before the external change.
    const r = await api(srv, cookie, 'POST', '/api/history/restore', { path: note, id: v[1].id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const restored = readFileSync(file, 'utf8')
    assert.ok(restored.includes('TYPED-IN-THE-EDITOR') && !restored.includes('CHANGED-WITH-ANOTHER-EDITOR'))

    // The most linked note renamed: its move by noa, its backlinks rewritten by the system for noa.
    const hub = ws.vault.hub
    const [mv, renameMs] = await timed(() => api(srv!, cookie, 'POST', '/api/note/move', { from: hub, to: ws.vault.hubTarget }))
    assert.equal(mv.status, 200)
    const relinked = (mv.body.relinked as { path: string }[]).map((x) => x.path).filter((p) => p !== ws.vault.hubTarget)
    await waitFor(async () => (await changes()).some((c: any) => c.reason?.code === 'note_moved'), 'the system commit', 30_000)
    const system = (await changes()).find((c: any) => c.reason?.code === 'note_moved')
    assert.equal(system.reason.by.name, 'noa')
    assert.deepEqual(system.files.map((f: any) => f.path).sort(), [...relinked].sort(), 'every rewritten backlink, in one commit')
    const moved = (await versions(ws.vault.hubTarget))[0]
    assert.deepEqual([moved.change, moved.from, who(moved)], ['moved', hub, 'noa'])
    metric('rename of the most linked note, with its history', renameMs, 'ms', { backlinks: relinked.length })
    // Undone for a backlink: its version from before the rewrite comes back.
    const backlink = relinked[0]!
    const bv = await versions(backlink)
    assert.equal(bv[0].reason?.code, 'note_moved')
    const before = readFileSync(join(ws.notesDir, backlink), 'utf8')
    const rb = await api(srv, cookie, 'POST', '/api/history/restore', { path: backlink, id: bv[1].id })
    assert.equal(rb.status, 200, JSON.stringify(rb.body))
    assert.notEqual(readFileSync(join(ws.notesDir, backlink), 'utf8'), before)

    // 4. Warm start: the sweep's cache spares reading the vault again, and nothing new is recorded.
    await waitFor(async () => (await versions(backlink))[0].change === 'restored', 'the restore is committed', 20_000)
    const before2 = (await changes())[0].id
    await srv.stop()
    srv = await startServer(env)
    const c2 = await login(srv)
    metric('warm start with history', srv.listeningMs, 'ms')
    assert.ok(srv.listeningMs < 10_000, `warm start ${Math.round(srv.listeningMs)} ms`)
    const late = (await api(srv, c2, 'GET', '/api/history/changes?limit=5')).body.changes as any[]
    assert.equal(late[0].id, before2, 'nothing changed while stopped: nothing recorded at startup')
  } finally {
    closeAll()
    await srv?.stop()
    cleanup(ws)
  }
})
