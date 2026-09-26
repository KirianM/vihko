import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hiddenFromAgents } from '@thoth/server'
import { setup } from './_agents.ts'

test('ai: false hides a note from agents, and so does any doubt: no, off, "false", 0, a frontmatter that can\'t be read', () => {
  const fm = (data: Record<string, unknown>, error: string | null = null) => ({ data, error })
  for (const v of [false, 'false', 'no', 'Off', ' FALSE ', 0, '0']) assert.equal(hiddenFromAgents(fm({ ai: v })), true, JSON.stringify(v))
  for (const v of [true, 'yes', undefined, null, 1, 'agents']) assert.equal(hiddenFromAgents(fm({ ai: v })), false, JSON.stringify(v))
  assert.equal(hiddenFromAgents(fm({}, 'bad yaml')), true)
  assert.equal(hiddenFromAgents(fm({ privado: false }), 'privado'), true, 'the key is configurable')
  assert.equal(hiddenFromAgents(fm({ ai: false }), 'privado'), false)
})

test('a key\'s folders match paths as the disk holds them (NFD), and a note hidden since it was indexed is hidden by its text', async () => {
  const nfd = 'Café'
  const h = await setup({ files: { [`${nfd}/receta.md`]: '# Receta\n', 'otra/nota.md': '# Nota\n' } })
  try {
    await h.enableApi()
    const { token } = await h.newKey({ name: 'x', canWrite: true, folders: ['Café'] })
    const key = h.withKey(token)
    const tree = (await key('GET', '/api/tree')).body
    assert.deepEqual(tree.notes.map((n: { path: string }) => n.path), [`${nfd}/receta.md`])
    assert.deepEqual(tree.folders, [nfd])
    assert.equal((await key('GET', h.url('/api/note', { path: `${nfd}/receta.md` }))).status, 200)

    // Written outside thoth a moment ago, not indexed yet: its text decides.
    // It names the note: told it exists and isn't for agents, and nothing else.
    writeFileSync(join(h.notesDir, nfd, 'receta.md'), '---\nai: false\n---\n# Receta\n')
    const read = await key('GET', h.url('/api/note', { path: `${nfd}/receta.md` }))
    assert.deepEqual([read.status, read.body.error, read.body.reason], [403, 'agent_denied', 'ai_false'])
    const edit = await key('POST', '/api/note/edit', { path: `${nfd}/receta.md`, ops: [{ op: 'append', text: 'x' }] })
    assert.deepEqual([edit.status, edit.body.error], [403, 'agent_denied'])
    const create = await key('POST', '/api/note', { path: `${nfd}/receta.md`, text: 'x' })
    assert.deepEqual([create.status, create.body.error], [403, 'agent_denied'])
    assert.equal(create.body.etag ?? null, null, 'no ETag of a note it can\'t see')
    assert.equal(create.headers.get('etag'), null)
  } finally { await h.close() }
})
