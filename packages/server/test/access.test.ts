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

test('a note says whether it is hidden from agents, and why: the UI shows it', async () => {
  const h = await setup({ files: {
    'a/oculta.md': '---\nai: "no"\n---\n# Oculta\n',
    'a/rota.md': '---\nai: [false\n---\n# Rota\n',
    'a/visible.md': '---\nai: true\n---\n# Visible\n',
    'a/sin.md': '# Sin frontmatter\n',
  } })
  try {
    const hiding = async (path: string) => (await h.noa('GET', h.url('/api/note', { path }))).body.hiddenFromAgents
    assert.equal(await hiding('a/oculta.md'), 'ai')
    assert.equal(await hiding('a/rota.md'), 'frontmatter')
    assert.equal(await hiding('a/visible.md'), null)
    assert.equal(await hiding('a/sin.md'), null)
    // Its text decides, not the index: written a moment ago, it says so at once.
    writeFileSync(join(h.notesDir, 'a', 'sin.md'), '---\nai: false\n---\n# Sin frontmatter\n')
    assert.equal(await hiding('a/sin.md'), 'ai')
    // A key only reads notes it may see: for them, always null.
    await h.enableApi()
    const { token } = await h.newKey({ name: 'x' })
    const r = await h.withKey(token)('GET', h.url('/api/note', { path: 'a/visible.md' }))
    assert.equal(r.status, 200)
    assert.equal(r.body.hiddenFromAgents, null)
  } finally { await h.close() }
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
