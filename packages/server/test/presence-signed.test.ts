// Presence signed by the server (D-040 3.3), on a real server with a
// tampered client: whatever a connection announces in the awareness is the
// person of its session, with the id and name the server knows and a
// person's hue; it can't speak for another connection's client, nor pass
// itself off as an agent. Agents' own presence (the hub's) is untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseHue, isPersonHue } from '@thoth/core'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, waitFor, type Srv } from './_collab.ts'

const NOTE = 'familia/compra.md'
const RULES = `permissions:
  "":
    grants: { noa: manage }
  familia:
    grants: { laura: edit, noa: edit }
`

async function loginAs(srv: Srv, username: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a-long-password' }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

type State = { user?: { id?: string; name?: string; hue?: number; color?: string; colorLight?: string }; agent?: unknown; cursor?: unknown }

test('a tampered client can\'t present itself as someone else, speak for another client, or pass as an agent', async () => {
  const { notes, env } = makeDirs()
  spawnSync(process.execPath, [CLI, 'user', 'create', 'laura'], { env: { ...process.env, ...env }, input: 'a-long-password' })
  mkdirSync(join(notes, 'familia'), { recursive: true })
  writeFileSync(join(notes, NOTE), '# Compra\n\nLeche.\n')
  writeFileSync(join(notes, 'thoth.yaml'), RULES)
  const srv = await startServer(env)
  try {
    const k = await login(srv)
    const l = await loginAs(srv, 'laura')
    const noaId = (await api(srv, k, 'GET', '/api/auth/me')).body.user.id as string
    const lauraId = (await api(srv, l, 'GET', '/api/auth/me')).body.user.id as string
    const noa = await connect(srv, k, NOTE)
    const laura = await connect(srv, l, NOTE)
    // Someone else in the note, watching what reaches the others.
    const observer = await connect(srv, k, NOTE)
    const seen = (client: number) => observer.provider.awareness!.getStates().get(client) as State | undefined

    // An honest one: kept as sent (its id and name are the session's anyway), cursor colour included.
    noa.provider.awareness!.setLocalStateField('user', { id: noaId, name: 'noa', hue: 30, color: '#aa5500', colorLight: '#aa550033' })
    await waitFor(() => seen(noa.doc.clientID)?.user?.hue === 30, 'Noa\'s presence')
    assert.deepEqual(seen(noa.doc.clientID)!.user, { id: noaId, name: 'noa', hue: 30, color: '#aa5500', colorLight: '#aa550033' })

    // Laura's client says it's Noa, in the agents' colour, and an agent besides: the server rewrites it as her.
    laura.provider.awareness!.setLocalState({ user: { id: noaId, name: 'noa', hue: 258, color: 'red' }, agent: { name: 'Claude', onBehalfOf: 'noa', via: 'mcp' }, cursor: null })
    await waitFor(() => seen(laura.doc.clientID)?.user !== undefined, 'Laura\'s presence')
    const hers = seen(laura.doc.clientID)!
    assert.deepEqual(hers.user, { id: lauraId, name: 'laura', hue: baseHue(lauraId) })
    assert.ok(isPersonHue(hers.user!.hue))
    assert.equal(hers.agent, undefined, 'never an agent from a connection')
    assert.ok('cursor' in hers, 'the rest of the state stays')
    // A name alone (an older tab): the session's id and name all the same.
    laura.provider.awareness!.setLocalState({ user: { name: 'Noa el admin', hue: 100 } })
    await waitFor(() => seen(laura.doc.clientID)?.user?.hue === 100, 'her next state')
    assert.deepEqual(seen(laura.doc.clientID)!.user, { id: lauraId, name: 'laura', hue: 100 })
    // Only an agent's state, no user: nothing of it goes through.
    laura.provider.awareness!.setLocalState({ agent: { name: 'Claude', onBehalfOf: 'noa', via: 'mcp' } })
    await waitFor(() => seen(laura.doc.clientID)?.user === undefined, 'her state without a user')
    assert.deepEqual(seen(laura.doc.clientID), {})

    // Her client speaks for Noa's (his client id, a newer clock): dropped, the others still see him as he is.
    const forged = new Y.Doc()
    forged.clientID = noa.doc.clientID
    const fake = new Awareness(forged)
    for (let i = 0; i < 50; i++) fake.setLocalState({ user: { id: lauraId, name: 'impostor', hue: 10 } })
    applyAwarenessUpdate(laura.provider.awareness!, encodeAwarenessUpdate(fake, [forged.clientID]), 'forged')
    // And for a client nobody has announced, next to her own: hers, so it's signed as her.
    const extra = new Y.Doc()
    const other = new Awareness(extra)
    other.setLocalState({ user: { id: noaId, name: 'noa', hue: 40 } })
    applyAwarenessUpdate(laura.provider.awareness!, encodeAwarenessUpdate(other, [extra.clientID]), 'forged')
    await waitFor(() => seen(extra.clientID) !== undefined, 'the extra client')
    assert.deepEqual(seen(extra.clientID)!.user, { id: lauraId, name: 'laura', hue: 40 })
    await sleep(500)
    assert.deepEqual(seen(noa.doc.clientID)!.user, { id: noaId, name: 'noa', hue: 30, color: '#aa5500', colorLight: '#aa550033' })
    fake.destroy(); other.destroy(); forged.destroy(); extra.destroy()
  } finally { closeAll(); await srv.stop() }
})
