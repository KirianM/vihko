import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hiddenFromAgents } from '@thoth/server'
import { setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('ai: false hides a note from agents, and so does any doubt: no, off, "false", 0, a frontmatter that can\'t be read', () => {
  const fm = (data: Record<string, unknown>, error: string | null = null) => ({ data, error })
  for (const v of [false, 'false', 'no', 'Off', ' FALSE ', 0, '0']) assert.equal(hiddenFromAgents(fm({ ai: v })), true, JSON.stringify(v))
  for (const v of [true, 'yes', undefined, null, 1, 'agents']) assert.equal(hiddenFromAgents(fm({ ai: v })), false, JSON.stringify(v))
  assert.equal(hiddenFromAgents(fm({}, 'bad yaml')), true)
  assert.equal(hiddenFromAgents(fm({ privado: false }), 'privado'), true, 'the key is configurable')
  assert.equal(hiddenFromAgents(fm({ ai: false }), 'privado'), false)
})

test('a note says whether it is hidden from agents, and why: the UI shows it', async () => {
  const dir = m.aFolder()
  const [hidden, broken, visible, plain] = [m.aNotePath(dir), m.aNotePath(dir), m.aNotePath(dir), m.aNotePath(dir)]
  const body = `# ${m.aHeading()}\n\n${m.aParagraph()}\n`
  const h = await setup({ files: {
    [hidden]: `---\nai: "no"\n---\n${body}`,
    [broken]: `---\nai: [false\n---\n${body}`,
    [visible]: `---\nai: true\n---\n${body}`,
    [plain]: body,
  } })
  try {
    const hiding = async (path: string) => (await h.admin('GET', h.url('/api/note', { path }))).body.hiddenFromAgents
    assert.equal(await hiding(hidden), 'ai')
    assert.equal(await hiding(broken), 'frontmatter')
    assert.equal(await hiding(visible), null)
    assert.equal(await hiding(plain), null)
    // Its text decides, not the index: written a moment ago, it says so at once.
    writeFileSync(join(h.notesDir, plain), `---\nai: false\n---\n${body}`)
    assert.equal(await hiding(plain), 'ai')
    // A key only reads notes it may see: for them, always null.
    await h.enableApi()
    const { token } = await h.newKey({ name: m.aKeyName() })
    const r = await h.withKey(token)('GET', h.url('/api/note', { path: visible }))
    assert.equal(r.status, 200)
    assert.equal(r.body.hiddenFromAgents, null)
  } finally { await h.close() }
})

test('a key\'s folders match paths as the disk holds them (NFD), and a note hidden since it was indexed is hidden by its text', async () => {
  // The folder's name decomposed on disk, composed in the key: the case under test.
  const nfd = 'Café'
  const name = `${m.aTitle()}.md`
  const note = `${nfd}/${name}`
  const heading = `# ${m.aHeading()}\n`
  const h = await setup({ files: { [note]: heading, [m.aNotePath(m.aFolder())]: `# ${m.aHeading()}\n` } })
  try {
    await h.enableApi()
    const { token } = await h.newKey({ name: m.aKeyName(), canWrite: true, folders: ['Café'] })
    const key = h.withKey(token)
    const tree = (await key('GET', '/api/tree')).body
    assert.deepEqual(tree.notes.map((n: { path: string }) => n.path), [note])
    assert.deepEqual(tree.folders, [nfd])
    assert.equal((await key('GET', h.url('/api/note', { path: note }))).status, 200)

    // Written outside thoth a moment ago, not indexed yet: its text decides.
    // It names the note: told it exists and isn't for agents, and nothing else.
    writeFileSync(join(h.notesDir, nfd, name), `---\nai: false\n---\n${heading}`)
    const read = await key('GET', h.url('/api/note', { path: note }))
    assert.deepEqual([read.status, read.body.error, read.body.reason], [403, 'agent_denied', 'ai_false'])
    const edit = await key('POST', '/api/note/edit', { path: note, ops: [{ op: 'append', text: m.aSentence() }] })
    assert.deepEqual([edit.status, edit.body.error], [403, 'agent_denied'])
    const create = await key('POST', '/api/note', { path: note, text: m.aParagraph() })
    assert.deepEqual([create.status, create.body.error], [403, 'agent_denied'])
    assert.equal(create.body.etag ?? null, null, 'no ETag of a note it can\'t see')
    assert.equal(create.headers.get('etag'), null)
  } finally { await h.close() }
})
