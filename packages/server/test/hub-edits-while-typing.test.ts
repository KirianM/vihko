// An agent writing to a note someone is typing in, on a real server with a
// key over the HTTP API (the MCP server writes through the same core).
// - A substitution planned on what it read lands in the text as it is now,
//   unless someone changed what it replaces (or right next to it) since.
// - What it appends while someone types at the end of the note goes after
//   their word, never into it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as Y from 'yjs'
import { newUid } from '@vihko/core'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, waitFor, type Client } from './_collab.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/**
 * A server with the API on and an agent's key, and a note with a uid (no
 * write of vihko's adds one under the agent's feet) and a few lines, each
 * with a word only it has.
 */
async function setup() {
  const { notes, env, admin } = makeDirs()
  const note = m.aNotePath(inShared(m.aFolder()))
  const words = Array.from({ length: 4 }, () => m.aUniqueWord())
  const heading = m.aHeading()
  mkdirSync(dirname(join(notes, note)), { recursive: true })
  writeFileSync(join(notes, note), `---\nuid: ${newUid()}\n---\n# ${heading}\n\n${words.map((w) => `${m.aSentence()} ${w} ${m.aSentence()}`).join('\n\n')}\n`)
  const srv = await startServer(env)
  const cookie = await login(srv)
  assert.equal((await api(srv, cookie, 'PUT', '/api/admin/integrations', { api: true })).status, 200)
  const created = await api(srv, cookie, 'POST', '/api/keys', { name: m.aKeyName(), canWrite: true, confirm: admin.password })
  assert.equal(created.status, 201)
  const key = { authorization: `Bearer ${created.body.token}` }
  const at = `/api/note?path=${encodeURIComponent(note)}`
  const agent = {
    read: async () => (await api(srv, cookie, 'GET', at, undefined, key)).body as { text: string; etag: string },
    edit: (ops: unknown[], ifMatch?: string) => api(srv, cookie, 'POST', '/api/note/edit', { path: note, ops, ...(ifMatch ? { ifMatch } : {}) }, key),
  }
  return { srv, cookie, note, words, heading, agent, file: join(notes, note) }
}

/** Types `text` in the editor at `at`, and waits until the hub has it. */
async function typeAt(c: Client, at: number, text: string) {
  c.doc.getText('md').insert(at, text)
  await waitFor(() => c.provider.unsyncedChanges === 0, 'sent')
}

test('substitutions planned on a text someone has typed in since: applied where nothing changed, refused where something did', async () => {
  const { srv, cookie, note, words, heading, agent, file } = await setup()
  try {
    const editor = await connect(srv, cookie, note)
    const end = (word: string) => editor.text().indexOf(word) + word.length
    for (const op of ['find_replace', 'set_frontmatter', 'replace_section'] as const) {
      const read = await agent.read()
      // Someone types on another line, after the agent read.
      const typed = ` ${m.aWord()}`
      await typeAt(editor, end(words[3]!), typed)
      words[3] += typed
      const word = m.aUniqueWord()
      const ops = op === 'find_replace' ? [{ op, find: words[1]!, replace: word }]
        : op === 'set_frontmatter' ? [{ op, key: m.anId(), value: word }]
        : [{ op, heading, text: `${m.aSentence()} ${word}\n` }]
      const r = await agent.edit(ops, read.etag)
      if (op === 'replace_section') {
        // The section holds the line typed in: something changed in what it replaces.
        assert.equal(r.status, 412, JSON.stringify(r.body))
        assert.ok(!editor.text().includes(word))
        continue
      }
      assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.body)}`)
      await waitFor(() => editor.text().includes(word), `${op}: reaches the editor`)
      assert.ok(editor.text().includes(words[3]!), `${op}: what was typed stays`)
      if (op === 'find_replace') {
        assert.ok(!editor.text().includes(words[1]!), 'replaced')
        words[1] = word
      }
      assert.equal(r.body.etag, (await agent.read()).etag, `${op}: the ETag it answers is the note's now`)
    }
    // Someone types inside what it replaces, or right next to it: refused, and nothing changes.
    for (const where of ['inside', 'next to it'] as const) {
      const read = await agent.read()
      const target = words[2]!
      const typed = m.aWord()
      await typeAt(editor, where === 'inside' ? editor.text().indexOf(target) + 2 : end(target), typed)
      words[2] = where === 'inside' ? target.slice(0, 2) + typed + target.slice(2) : target + typed
      const before = editor.text()
      const r = await agent.edit([{ op: 'find_replace', find: target, replace: m.aUniqueWord() }], read.etag)
      assert.equal(r.status, 412, `${where}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'precondition_failed')
      await sleep(300)
      assert.equal(editor.text(), before, `${where}: nothing changed`)
    }
    // An ETag the note never had: refused as before.
    const r = await agent.edit([{ op: 'find_replace', find: words[0]!, replace: m.aUniqueWord() }], `sha256:${'0'.repeat(64)}`)
    assert.equal(r.status, 412)
    await waitFor(() => readFileSync(file, 'utf8') === editor.text(), 'flushed')
  } finally { closeAll(); await srv.stop() }
})

test('what an agent appends while someone types at the end of the note goes after their word, whatever their client id', async () => {
  const { srv, cookie, note, agent } = await setup()
  try {
    const editor = await connect(srv, cookie, note)
    const t = editor.doc.getText('md')
    // Concurrent insertions at the same place are ordered by client id: the lowest and the highest a browser draws, in practice.
    for (const clientID of [1, 2 ** 32 - 2 ** 16 - 1]) {
      // The person's line, without its newline yet, at the very end: they're typing it.
      const start = m.aUniqueWord()
      await typeAt(editor, t.length, start)
      // A keystroke the hub hasn't seen when the agent's text arrives: typed on a copy, by a client with that id.
      const rest = m.aUniqueWord()
      const typing = new Y.Doc()
      typing.clientID = clientID
      Y.applyUpdate(typing, Y.encodeStateAsUpdate(editor.doc))
      typing.getText('md').insert(typing.getText('md').length, rest)
      const appended = m.aUniqueWord()
      const r = await agent.edit([{ op: 'append', text: `${appended}\n` }])
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await waitFor(() => editor.text().includes(appended), 'the append reaches the editor')
      Y.applyUpdate(editor.doc, Y.encodeStateAsUpdate(typing, Y.encodeStateVector(editor.doc)))
      await waitFor(() => editor.provider.unsyncedChanges === 0, 'synced')
      const lines = editor.text().split('\n')
      assert.ok(lines.includes(`${start}${rest}`), `client id ${clientID}: the word stays whole in:\n${editor.text()}`)
      assert.equal(lines[lines.indexOf(`${start}${rest}`) + 1], appended, `client id ${clientID}: the agent's text right after it`)
    }
  } finally { closeAll(); await srv.stop() }
})
