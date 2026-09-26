// An agent writing to an open note, as its editors see it (m3 §6): its
// presence in the document's awareness, under the Yjs client id its text is
// made by, published before the text and gone a few seconds after it stops.
// On a real server, with a key over the HTTP API (the MCP server writes
// through the same core).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as Y from 'yjs'
import { api, closeAll, connect, login, makeDirs, startServer, waitFor } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'

/** The Yjs client ids of the text items holding `needle`. */
function clientsOf(doc: Y.Doc, needle: string): Set<number> {
  const out = new Set<number>()
  let item = (doc.getText('md') as unknown as { _start: { id: { client: number }; content: { str?: string }; deleted: boolean; right: unknown } | null })._start
  while (item) {
    const s = item.content.str
    // Consecutive text by one client is one item.
    if (!item.deleted && s && (needle.includes(s) || s.includes(needle))) out.add(item.id.client)
    item = item.right as typeof item
  }
  return out
}

test('an agent writing to an open note shows up in its awareness, and its text carries that client id', async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    assert.equal((await api(srv, cookie, 'PUT', '/api/admin/integrations', { api: true })).status, 200)
    const created = await api(srv, cookie, 'POST', '/api/keys', { name: 'Claude Code', canWrite: true })
    assert.equal(created.status, 201)
    const key = { authorization: `Bearer ${created.body.token}` }
    const editor = await connect(srv, cookie, NOTE)
    /** What the editor received, in order. */
    let events = 0
    const seen: { client: number; state: unknown; at: number }[] = []
    const awareness = editor.provider.awareness!
    awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }) => {
      for (const c of [...added, ...updated]) seen.push({ client: c, state: awareness.getStates().get(c), at: ++events })
    })
    let textAt = 0
    editor.doc.getText('md').observe(() => { if (!textAt && editor.text().includes('AGENT-ONE')) textAt = ++events })

    const edit = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'AGENT-ONE\n' }] }, key)
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    await waitFor(() => editor.text().includes('AGENT-ONE'), 'the write reaches the editor')
    const agent = seen.find((s) => (s.state as { agent?: unknown } | undefined)?.agent)
    assert.ok(agent, 'the agent is announced')
    assert.deepEqual(agent.state, { agent: { name: 'Claude Code', onBehalfOf: 'noa', via: 'api' } })
    assert.ok(agent.at < textAt, 'announced before its text arrives')
    assert.deepEqual([...clientsOf(editor.doc, 'AGENT-ONE\n')], [agent.client], 'its text is made by the client it announced')
    assert.notEqual(agent.client, editor.doc.clientID)

    // A second write while it's still there: the same presence, the same client.
    const again = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'AGENT-TWO\n' }] }, key)
    assert.equal(again.status, 200)
    await waitFor(() => editor.text().includes('AGENT-TWO'), 'the second write')
    assert.deepEqual([...clientsOf(editor.doc, 'AGENT-TWO\n')], [agent.client])
    assert.ok(awareness.getStates().has(agent.client))

    // A person's write through the API announces nobody.
    const before = seen.length
    assert.equal((await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: 'PERSON\n' }] })).status, 200)
    await waitFor(() => editor.text().includes('PERSON'), 'the person\'s write')
    assert.ok(seen.slice(before).every((s) => !(s.state as { agent?: unknown } | undefined)?.agent))

    // A few seconds after its last write, it's gone.
    await waitFor(() => !awareness.getStates().has(agent.client), 'the presence ends', 10_000)
    // The text stays, and the document is the same everywhere.
    assert.ok(editor.text().includes('AGENT-ONE\nAGENT-TWO\nPERSON\n'))

    // Deleting the open note: its editors are told by the key's name, not its id.
    const trashed: unknown[] = []
    editor.provider.on('stateless', ({ payload }: { payload: string }) => trashed.push(JSON.parse(payload)))
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(NOTE)}`, undefined, key)
    assert.equal(del.status, 200, JSON.stringify(del.body))
    await waitFor(() => trashed.some((m) => (m as { type: string }).type === 'thoth:trashed'), 'the editor is told')
    assert.equal((trashed.find((m) => (m as { type: string }).type === 'thoth:trashed') as { by: string }).by, 'Claude Code')
  } finally { closeAll(); await srv.stop() }
})
