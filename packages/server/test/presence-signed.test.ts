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
import { baseHue, isPersonHue } from '@vihko/core'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, waitFor } from './_collab.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const SHARED = m.aFolder()
const NOTE = m.aNotePath(SHARED)
/** The name of the agent a tampered client claims to be. */
const AGENT = m.aKeyName()
const rules = (admin: string, member: string) => `permissions:
  "":
    grants: { ${yamlKey(admin)}: manage }
  ${yamlKey(SHARED)}:
    grants: { ${yamlKey(member)}: edit, ${yamlKey(admin)}: edit }
`

type State = { user?: { id?: string; name?: string; hue?: number; color?: string; colorLight?: string }; agent?: unknown; cursor?: unknown }

test('a tampered client can\'t present itself as someone else, speak for another client, or pass as an agent', async () => {
  const { notes, env, admin } = makeDirs()
  const member = m.aUser()
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  mkdirSync(join(notes, SHARED), { recursive: true })
  writeFileSync(join(notes, NOTE), `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  writeFileSync(join(notes, 'vihko.yaml'), rules(admin.username, member.username))
  // Names a tampered client claims: someone else's display name, and nobody's.
  const [pretended, impostor] = [m.aDisplayName(), m.aDisplayName()]
  const srv = await startServer(env)
  try {
    const k = await login(srv)
    const l = await login(srv, member)
    const adminId = (await api(srv, k, 'GET', '/api/auth/me')).body.user.id as string
    const memberId = (await api(srv, l, 'GET', '/api/auth/me')).body.user.id as string
    const adminEditor = await connect(srv, k, NOTE)
    const memberEditor = await connect(srv, l, NOTE)
    // Someone else in the note, watching what reaches the others.
    const observer = await connect(srv, k, NOTE)
    const seen = (client: number) => observer.provider.awareness!.getStates().get(client) as State | undefined
    // People's hues (outside the agents' band), all different, and none the member's own (what the server puts when it rewrites a state).
    const hues: number[] = []
    while (hues.length < 4) {
      const h = m.anInt(0, 359)
      if (isPersonHue(h) && h !== baseHue(memberId) && !hues.includes(h)) hues.push(h)
    }
    const [honest, older, forgedHue, extraHue] = hues as [number, number, number, number]
    const colour = m.faker.color.rgb()
    const honestUser = { id: adminId, name: admin.username, hue: honest, color: colour, colorLight: `${colour}33` }

    // An honest one: kept as sent (its id and name are the session's anyway), cursor colour included.
    adminEditor.provider.awareness!.setLocalStateField('user', honestUser)
    await waitFor(() => seen(adminEditor.doc.clientID)?.user?.hue === honest, 'the admin\'s presence')
    assert.deepEqual(seen(adminEditor.doc.clientID)!.user, honestUser)

    // The member's client says it's the admin, in the agents' colour, and an agent besides: the server rewrites it as the member.
    memberEditor.provider.awareness!.setLocalState({ user: { id: adminId, name: admin.username, hue: 258, color: 'red' }, agent: { name: AGENT, onBehalfOf: admin.username, via: 'mcp' }, cursor: null })
    await waitFor(() => seen(memberEditor.doc.clientID)?.user !== undefined, 'the member\'s presence')
    const theirs = seen(memberEditor.doc.clientID)!
    assert.deepEqual(theirs.user, { id: memberId, name: member.username, hue: baseHue(memberId) })
    assert.ok(isPersonHue(theirs.user!.hue))
    assert.equal(theirs.agent, undefined, 'never an agent from a connection')
    assert.ok('cursor' in theirs, 'the rest of the state stays')
    // A name alone (an older tab): the session's id and name all the same.
    memberEditor.provider.awareness!.setLocalState({ user: { name: pretended, hue: older } })
    await waitFor(() => seen(memberEditor.doc.clientID)?.user?.hue === older, 'the member\'s next state')
    assert.deepEqual(seen(memberEditor.doc.clientID)!.user, { id: memberId, name: member.username, hue: older })
    // Only an agent's state, no user: nothing of it goes through.
    memberEditor.provider.awareness!.setLocalState({ agent: { name: AGENT, onBehalfOf: admin.username, via: 'mcp' } })
    await waitFor(() => seen(memberEditor.doc.clientID)?.user === undefined, 'the member\'s state without a user')
    assert.deepEqual(seen(memberEditor.doc.clientID), {})

    // The member's client speaks for the admin's (its client id, a newer clock): dropped, the others still see the admin as they are.
    const forged = new Y.Doc()
    forged.clientID = adminEditor.doc.clientID
    const fake = new Awareness(forged)
    for (let i = 0; i < 50; i++) fake.setLocalState({ user: { id: memberId, name: impostor, hue: forgedHue } })
    applyAwarenessUpdate(memberEditor.provider.awareness!, encodeAwarenessUpdate(fake, [forged.clientID]), 'forged')
    // And for a client nobody has announced, next to its own: the member's, so it's signed as the member.
    const extra = new Y.Doc()
    const other = new Awareness(extra)
    other.setLocalState({ user: { id: adminId, name: admin.username, hue: extraHue } })
    applyAwarenessUpdate(memberEditor.provider.awareness!, encodeAwarenessUpdate(other, [extra.clientID]), 'forged')
    await waitFor(() => seen(extra.clientID) !== undefined, 'the extra client')
    assert.deepEqual(seen(extra.clientID)!.user, { id: memberId, name: member.username, hue: extraHue })
    await sleep(500)
    assert.deepEqual(seen(adminEditor.doc.clientID)!.user, honestUser)
    fake.destroy(); other.destroy(); forged.destroy(); extra.destroy()
  } finally { closeAll(); await srv.stop() }
})
