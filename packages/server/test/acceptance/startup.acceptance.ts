// M1 «done when»: over an existing folder of 1,000 notes you can search and
// open notes. Cold start (first indexing), warm start, memory, search latency
// and correctness, and opening a note (HTTP and live document).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Indexer, openIndex } from '@vihko/server'
import { api, closeAll, connect, login } from '../_collab.ts'
import { inShared } from '../_permissions.ts'
import { NOTES, PASSWORD, USER, cleanup, memory, metric, percentile, startServer, timed, workspace, type Server } from './_harness.ts'

// Budgets for a usable system on modest hardware, not tuned to pass.
const BUDGET = {
  coldStartMs: 30_000,
  warmStartMs: 10_000,
  searchP95Ms: 100,
  openP95Ms: 200,
  liveOpenP95Ms: 500,
  peakRssMiB: 400,
}

const QUERIES = ['proyecto', 'arquitectura', 'café', 'cafe', 'pinguino', 'reunión semanal', 'flujo de datos', 'kubernetes proxy',
  'pla', 'sistema distribuido', 'crème brûlée', 'tortilla', 'nfs sqlite', 'zzzz-nothing', 'el', 'José', 'hipervisor', 'decisión']

test(`startup, search and opening notes over ${NOTES} generated notes`, { timeout: 300_000 }, async () => {
  const ws = workspace('startup')
  let srv: Server | null = null
  try {
    // 1. Cold start: nothing indexed yet.
    srv = await startServer(ws.env)
    const cold = { indexed: srv.indexedMs, listening: srv.listeningMs, ...memory(srv.pid) }
    metric('cold start (index built from scratch)', cold.listening, 'ms', { indexReadyMs: Math.round(cold.indexed), rssMiB: Math.round(cold.rss), peakMiB: Math.round(cold.peak) })
    const cookie = await login(srv, { username: USER, password: PASSWORD })

    // Everything on disk is in the index.
    const tree = (await api(srv, cookie, 'GET', '/api/tree')).body.notes as { path: string }[]
    const fresh = openIndex(join(ws.root, 'expected.db'))
    new Indexer({ notesDir: ws.notesDir, db: fresh }).scan()
    const expected = (fresh.prepare('select path from notes order by path').all() as { path: string }[]).map((r) => r.path)
    fresh.close()
    assert.deepEqual(tree.map((n) => n.path), expected)
    assert.ok(tree.length >= NOTES, `${tree.length} notes indexed`)

    // 2. Search: correctness first.
    const search = async (q: string) => (await api(srv!, cookie, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).body.results as { path: string }[]
    for (const m of ws.vault.markers) {
      const r = await search(m.word)
      assert.equal(r[0]?.path, m.path, `"${m.word}" finds ${m.path} first`)
    }
    const paths = async (q: string) => (await search(q)).map((r) => r.path.normalize('NFC'))
    assert.ok((await paths('cafe')).includes(inShared('recetas/Café.md')), 'without accents: cafe → Café')
    assert.ok((await paths('pinguino')).length > 0, 'without diaeresis: pinguino → pingüino')
    assert.ok((await paths('hipervisor')).includes(inShared('edge/hogar/Proxy.md')), 'aliases are searchable')
    assert.ok((await paths('arquitectura')).includes(ws.vault.hub), 'by title')
    assert.deepEqual(await search('zzzz-nothing'), [])

    // Latency: every query several times, sequentially.
    const lat: number[] = []
    for (let rep = 0; rep < 15; rep++) for (const q of QUERIES) lat.push((await timed(() => search(q)))[1])
    for (const m of ws.vault.markers) lat.push((await timed(() => search(m.word)))[1])
    const s = { p50: percentile(lat, 50), p95: percentile(lat, 95), max: Math.max(...lat), n: lat.length }
    metric('search latency p50', s.p50, 'ms', { p95: Math.round(s.p95 * 10) / 10, max: Math.round(s.max), queries: s.n })

    // 3. Opening a note: its text and its links/backlinks, as the UI does.
    const sample = ws.vault.notes.filter((_, i) => i % 17 === 0)
    const open: number[] = []
    for (const path of sample) {
      const [, ms] = await timed(async () => {
        const n = await api(srv!, cookie, 'GET', `/api/note?path=${encodeURIComponent(path)}`)
        assert.equal(n.status, 200, path)
        const l = await api(srv!, cookie, 'GET', `/api/note/links?path=${encodeURIComponent(path)}`)
        assert.equal(l.status, 200, path)
      })
      open.push(ms)
    }
    const hubLinks = await timed(() => api(srv!, cookie, 'GET', `/api/note/links?path=${encodeURIComponent(ws.vault.hub)}`))
    metric('open a note (text + links) p50', percentile(open, 50), 'ms', { p95: Math.round(percentile(open, 95) * 10) / 10, notes: open.length, hubWithBacklinksMs: Math.round(hubLinks[1]), hubBacklinks: hubLinks[0].body.backlinks.length })

    // Live document: from connecting to the first sync.
    const live: number[] = []
    for (const path of sample.slice(0, 25)) {
      const [c, ms] = await timed(() => connect(srv!, cookie, path))
      live.push(ms)
      c.close()
    }
    closeAll()
    metric('open a note in the editor (live sync) p50', percentile(live, 50), 'ms', { p95: Math.round(percentile(live, 95) * 10) / 10, notes: live.length })
    const loaded = memory(srv.pid)
    metric('memory after the load', loaded.rss, 'MiB', { peakMiB: Math.round(loaded.peak) })

    // 4. Warm start: the index is already there.
    await srv.stop()
    srv = await startServer(ws.env)
    metric('warm start (index up to date)', srv.listeningMs, 'ms', { rssMiB: Math.round(memory(srv.pid).rss) })

    assert.ok(cold.listening < BUDGET.coldStartMs, `cold start ${Math.round(cold.listening)} ms`)
    assert.ok(srv.listeningMs < BUDGET.warmStartMs, `warm start ${Math.round(srv.listeningMs)} ms`)
    assert.ok(s.p95 < BUDGET.searchP95Ms, `search p95 ${s.p95} ms`)
    assert.ok(percentile(open, 95) < BUDGET.openP95Ms, `open p95 ${percentile(open, 95)} ms`)
    assert.ok(percentile(live, 95) < BUDGET.liveOpenP95Ms, `live open p95 ${percentile(live, 95)} ms`)
    assert.ok(Math.max(cold.peak, loaded.peak) < BUDGET.peakRssMiB, `peak memory ${Math.round(Math.max(cold.peak, loaded.peak))} MiB`)
  } finally {
    closeAll()
    await srv?.stop()
    cleanup(ws)
  }
})
