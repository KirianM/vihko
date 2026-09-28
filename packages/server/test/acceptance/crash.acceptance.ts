// M1 «done when»: a `kill -9` loses no edits. Several rounds of _crash.ts
// against the server process (one green pass in concurrency proves nothing),
// and then the index must still equal a rebuild from the files, and the
// history (M2) must be available with every note's newest version as its file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api, closeAll, login } from '../_collab.ts'
import { Indexer, dumpIndex, openIndex } from '@vihko/server'
import { PASSWORD, ROUNDS, USER, cleanup, metric, startServer, workspace, type Server } from './_harness.ts'
import { AGENT_MARK, historyAfterKills, killRound } from './_crash.ts'

test(`kill -9 while two people type and an agent edits: ${ROUNDS} rounds`, { timeout: ROUNDS * 90_000 + 60_000 }, async () => {
  const ws = workspace('crash')
  const [hot, cold] = ws.vault.editable as [string, string]
  // Versions that close after 1 s without changes: more commits for a kill to land in, and the history checked without waiting.
  const env = { ...ws.env, VIHKO_HISTORY_QUIET_SECONDS: '1' }
  let srv: Server = await startServer(env)
  const failures: string[] = []
  try {
    const cookie = await login(srv, { username: USER, password: PASSWORD })
    const mark = await api(srv, cookie, 'POST', '/api/note/edit', { path: hot, ops: [{ op: 'append', text: `${AGENT_MARK}\n` }] })
    assert.equal(mark.status, 200, JSON.stringify(mark.body))
    const totals = { typed: 0, acked: 0, agentHot: 0, agentCold: 0, recoveryMs: [] as number[] }
    for (let round = 0; round < ROUNDS; round++) {
      const r = await killRound({
        round, srv, cookie, notesDir: ws.notesDir, hot, cold,
        kill: () => srv.stop('SIGKILL'),
        restart: async () => (srv = await startServer(env)),
      })
      failures.push(...r.failures)
      totals.typed += r.typed
      totals.acked += r.acked
      totals.agentHot += r.agentHot
      totals.agentCold += r.agentCold
      totals.recoveryMs.push(Math.round(r.recoveryMs))
    }
    metric('kill -9 rounds', ROUNDS, 'rounds', totals)
    failures.push(...await historyAfterKills(srv, cookie, ws.notesDir, [hot, cold]))

    // The index after the kills: the same as rebuilding it from the files.
    await srv.stop()
    const live = openIndex(join(ws.stateDir, 'index.db'))
    const liveDump = dumpIndex(live)
    live.close()
    const fresh = openIndex(join(ws.root, 'fresh-index.db'))
    new Indexer({ notesDir: ws.notesDir, db: fresh }).scan()
    const freshDump = dumpIndex(fresh)
    fresh.close()
    if (liveDump !== freshDump) failures.push('the index after the kills differs from a rebuild from the files')
    assert.deepEqual(failures, [])
  } finally {
    closeAll()
    await srv.stop()
    cleanup(ws)
  }
})
