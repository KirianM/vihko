// One kill -9 round, shared by the process and the Docker acceptance tests.
//
// Two people type into the same note (collaborative clients), an agent edits
// that open note and a closed one over HTTP, and the server is killed at a
// random moment. Then it comes back.
//
// "Acknowledged" means:
// - typing: the hub confirmed the update (Hocuspocus SyncStatus). The hub
//   appends each update to the note's recovery log before that confirmation
//   goes out. A token counts as acknowledged once the client's count of
//   unconfirmed changes drops to 0 after the token was completed.
// - HTTP: the request answered 200.
// What was acknowledged must be in the file once the server is back, before
// any client reconnects, exactly once. Then the clients (which kept their
// documents, as an open tab does) reconnect: what they typed, acknowledged
// or not, converges once in the file and in both editors.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { api, closeAll, connect, login, type Client, type Srv } from '../_collab.ts'
import { sleep, waitFor } from './_harness.ts'

export const AGENT_MARK = 'AGENT-MARK'

interface Typist { client: Client; done: string[]; acked: Set<string>; stop: boolean; loop: Promise<void> }

/** Types lines character by character at random line starts in the body. */
function typist(client: Client, id: string): Typist {
  const t: Typist = { client, done: [], acked: new Set(), stop: false, loop: Promise.resolve() }
  client.provider.on('unsyncedChanges', ({ number }: { number: number }) => {
    if (number === 0) for (const tok of t.done) t.acked.add(tok)
  })
  t.loop = (async () => {
    const text = client.doc.getText('md')
    for (let n = 0; !t.stop; n++) {
      const token = `${id}-${n}.` // the dot: a token cut short by the kill is not another token
      const s = text.toString()
      const body = s.indexOf('\n# ') + 1
      const starts = [body]
      for (let i = s.indexOf('\n', body); i !== -1 && i < s.length - 1; i = s.indexOf('\n', i + 1)) starts.push(i + 1)
      const at = starts[Math.floor(Math.random() * starts.length)]!
      text.insert(at, '\n')
      let cursor = Y.createRelativePositionFromTypeIndex(text, at)
      for (const ch of token) {
        const abs = Y.createAbsolutePositionFromRelativePosition(cursor, client.doc)!
        text.insert(abs.index, ch)
        cursor = Y.createRelativePositionFromTypeIndex(text, abs.index + 1)
        await sleep(3 + Math.random() * 12)
      }
      t.done.push(token)
      await sleep(Math.random() * 30)
    }
  })()
  return t
}

export const countLine = (s: string, l: string) => s.split(/\r?\n/).filter((x) => x === l).length

export interface RoundResult { typed: number; acked: number; agentHot: number; agentCold: number; recoveryMs: number; failures: string[] }

export interface RoundOptions {
  round: number
  srv: Srv
  cookie: string
  notesDir: string
  /** The note being typed into; it must contain the AGENT_MARK line. */
  hot: string
  /** A note nobody has open. */
  cold: string
  /** Kills the server with SIGKILL. */
  kill: () => Promise<void>
  /** Brings it back (restart, or waits for the container's restart policy); resolves when it listens. */
  restart: () => Promise<Srv>
}

/** A round; the server is up again when it resolves. Failures are collected, not thrown. */
export async function killRound(o: RoundOptions): Promise<RoundResult & { srv: Srv }> {
  const failures: string[] = []
  const hotFile = join(o.notesDir, o.hot)
  const coldFile = join(o.notesDir, o.cold)
  const a = typist(await connect(o.srv, o.cookie, o.hot), `R${o.round}-A`)
  const b = typist(await connect(o.srv, o.cookie, o.hot), `R${o.round}-B`)
  const agentHot: { token: string; acked: boolean }[] = []
  const agentCold: { token: string; acked: boolean }[] = []
  let agentStop = false
  const agentLoop = (list: typeof agentHot, path: string, op: (tok: string) => object) => (async () => {
    for (let k = 0; !agentStop; k++) {
      const token = `R${o.round}-AGENT-${path === o.hot ? 'H' : 'C'}${k}`
      const entry = { token, acked: false }
      list.push(entry)
      try {
        const r = await api(o.srv, o.cookie, 'POST', '/api/note/edit', { path, ops: [op(token)] })
        if (r.status === 200) entry.acked = true
        else if (!agentStop) failures.push(`round ${o.round}: agent edit ${token} → ${r.status} ${JSON.stringify(r.body)}`)
      } catch { /* the server died mid-request: not acknowledged */ }
      await sleep(50 + Math.random() * 150)
    }
  })()
  const agents = [
    agentLoop(agentHot, o.hot, (t) => ({ op: 'find_replace', find: `${AGENT_MARK}\n`, replace: `${AGENT_MARK}\n${t}\n` })),
    agentLoop(agentCold, o.cold, (t) => ({ op: 'append', text: `${t}\n` })),
  ]
  let srv = o.srv
  try {
    // Kill at a random moment, mid-activity.
    await sleep(1500 + Math.random() * 2500)
    await o.kill()
    agentStop = true
    await Promise.all(agents)
    await sleep(300) // people keep typing while the server is down (their tab is still open)
    const ackedTyped = [...a.acked, ...b.acked]
    const ackedHot = agentHot.filter((e) => e.acked).map((e) => e.token)
    const ackedCold = agentCold.filter((e) => e.acked).map((e) => e.token)
    if (ackedTyped.length < 20 || ackedHot.length < 3 || ackedCold.length < 3) {
      failures.push(`round ${o.round}: too little load to prove anything (typed ${ackedTyped.length}, agent ${ackedHot.length}/${ackedCold.length})`)
    }

    // 1. Back up: what was acknowledged is on disk before anyone reconnects.
    const t0 = performance.now()
    srv = await o.restart()
    const recoveryMs = performance.now() - t0
    const disk = readFileSync(hotFile, 'utf8')
    const coldDisk = readFileSync(coldFile, 'utf8')
    const lostTyped = ackedTyped.filter((tok) => countLine(disk, tok) !== 1)
    const lostHot = ackedHot.filter((tok) => countLine(disk, tok) !== 1)
    const lostCold = ackedCold.filter((tok) => countLine(coldDisk, tok) !== 1)
    if (lostTyped.length || lostHot.length || lostCold.length) {
      failures.push(`round ${o.round}: acknowledged but missing or duplicated after the restart: typed ${JSON.stringify(lostTyped)}, agent on the open note ${JSON.stringify(lostHot)}, agent on the closed note ${JSON.stringify(lostCold)}`)
    }
    if (countLine(disk, AGENT_MARK) !== 1) failures.push(`round ${o.round}: the agent's anchor appears ${countLine(disk, AGENT_MARK)} times after the restart`)

    // 2. The open tabs reconnect: everything they typed converges once.
    await login(srv) // the session survived (state.db)
    await sleep(500)
    a.stop = b.stop = true
    await Promise.all([a.loop, b.loop])
    const typed = [...a.done, ...b.done]
    try {
      await waitFor(() => a.client.provider.isSynced && b.client.provider.isSynced && a.client.text() === b.client.text()
        && readFileSync(hotFile, 'utf8') === a.client.text(), 'reconnection and flush', 20_000)
    } catch (err) {
      failures.push(`round ${o.round}: ${(err as Error).message}`)
    }
    const final = readFileSync(hotFile, 'utf8')
    const wrong = typed.filter((tok) => countLine(final, tok) !== 1)
    if (wrong.length) {
      failures.push(`round ${o.round}: after reconnecting, ${wrong.length} of ${typed.length} typed lines are missing or duplicated, e.g. ${JSON.stringify(wrong.slice(0, 5).map((t) => [t, countLine(final, t)]))}`)
    }
    if (countLine(final, AGENT_MARK) !== 1) failures.push(`round ${o.round}: the agent's anchor appears ${countLine(final, AGENT_MARK)} times after reconnecting`)
    return { srv, typed: typed.length, acked: ackedTyped.length, agentHot: ackedHot.length, agentCold: ackedCold.length, recoveryMs, failures }
  } finally {
    a.stop = b.stop = agentStop = true
    await Promise.all([a.loop, b.loop, ...agents])
    a.client.close()
    b.client.close()
    closeAll()
  }
}
