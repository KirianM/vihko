// An agent that hides a note from itself (`ai: false` in what it writes):
// the write stands and says so (`now_hidden` over MCP, `nowHidden` over the
// API), never `agent_denied`, so that the agent doesn't take it for a failure
// and write again. From then on the note is hidden like any other: nothing
// of it reaches the agent, and naming it is `agent_denied`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash, readFrontmatter } from '@vihko/core'
import { setup } from './_agents.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The key's folder. */
const DIR = inShared(m.aFolder())
/** The note to hide: its name, path, heading and a word only it has (the heading too: words no other text has). */
const NAME = m.aTitle()
const NOTE = `${DIR}/${NAME}.md`
const HEADING = m.aUniqueWord()
const WORD = m.aUniqueWord()
/** A note that links to it, and one that becomes hidden by a whole new text. */
const OTHER = m.aNotePath(DIR)
const FREE = m.aNotePath(DIR)
const FILES = {
  [NOTE]: `# ${HEADING}\n\n${WORD} ${m.aSentence()}\n\n## ${m.aHeading()}\n\n- ${m.aWord()}\n`,
  [OTHER]: `# ${m.aHeading()}\n\n${m.aSentence()} [[${NAME}]] ${m.aSentence()}\n`,
  [FREE]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`,
}
/** A note whose frontmatter a revert leaves unreadable: a quoted value on two lines (the case under test). */
const FM = m.aNotePath(DIR)
const FM_TEXT = `---\na: "x\n  y"\n---\n# ${m.aHeading()}\n`

/** Whatever of the hidden note shows up in `shown`, unless the call named it itself (`asked`). */
const leaked = (shown: string, asked: string) => [NOTE, WORD, HEADING].filter((mk) => shown.includes(mk) && !asked.includes(mk))

const disk = (h: { notesDir: string }, p: string) => readFileSync(join(h.notesDir, p), 'utf8')

test('MCP: edit_note that sets ai: false succeeds with now_hidden, and from then on nothing of the note reaches the agent', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })).token)
    const { etag } = (await c.call('get_note', { path: NOTE })).data
    const hide = await c.call('edit_note', { path: NOTE, operations: [{ op: 'set_frontmatter', key: 'ai', value: false }], if_match: etag })
    assert.equal(hide.error, false, hide.raw)
    assert.equal(hide.data.now_hidden, true)
    assert.equal(hide.data.reason, 'ai_false')
    assert.match(hide.data.message, /no longer available to agents.*only a person can, from vihko's interface/)
    assert.deepEqual(Object.keys(hide.data).sort(), ['etag', 'message', 'now_hidden', 'path', 'reason'])
    // Written, and its ETag is the hash of what it wrote on the text it had read.
    const text = disk(h, NOTE)
    assert.match(text, /^---\nai: false\n/)
    assert.equal(hide.data.etag, contentHash(text))
    assert.equal(hide.texts.length, 0)

    // From now on: denied when named, absent everywhere else.
    const calls: [string, Record<string, unknown>, 'ok' | 'denied'][] = [
      ['get_note', { path: NOTE }, 'denied'],
      ['changes_since', { path: NOTE, since: etag }, 'denied'],
      ['history', { path: NOTE }, 'denied'],
      ['related', { path: NOTE }, 'denied'],
      ['edit_note', { path: NOTE, operations: [{ op: 'append', text: m.aSentence() }] }, 'denied'],
      ['edit_note', { path: NOTE, operations: [{ op: 'set_frontmatter', key: 'ai', value: true }], if_match: hide.data.etag }, 'denied'],
      ['create_note', { path: NOTE, text: m.aSentence() }, 'denied'],
      ['search', { query: WORD }, 'ok'],
      ['search', { query: `path:"${DIR}"` }, 'ok'],
      ['list_folder', { folder: DIR, recursive: true }, 'ok'],
      ['get_note', { path: OTHER }, 'ok'],
      ['related', { path: OTHER }, 'ok'],
      ['resolve_link', { from: OTHER, link: `[[${NAME}]]` }, 'ok'],
    ]
    for (const [tool, args, expect] of calls) {
      const r = await c.call(tool, args)
      const where = `${tool} ${JSON.stringify(args)} → ${r.raw.slice(0, 400)}`
      assert.deepEqual(leaked(r.raw, JSON.stringify(args)), [], where)
      if (expect === 'denied') assert.deepEqual([r.error, r.data.error, r.data.reason], [true, 'agent_denied', 'ai_false'], where)
      else assert.equal(r.error, false, where)
    }
    assert.equal(disk(h, NOTE), text, 'nothing more was written')
    const link = (await c.call('get_note', { path: OTHER })).data.links.outgoing[0]
    assert.deepEqual([link.status, link.reason, link.path], ['no_access', 'ai_false', null])
    await c.close()
  } finally { await h.close() }
})

test('MCP: create_note with ai: false in its text creates it and says it is hidden now', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })).token)
    const text = `---\nai: false\n---\n# ${m.aHeading()}\n\n${WORD} ${m.aSentence()}\n`
    const secret = m.aNotePath(DIR)
    const r = await c.call('create_note', { path: secret, text })
    assert.equal(r.error, false, r.raw)
    assert.deepEqual([r.data.created, r.data.now_hidden, r.data.reason, r.data.path], [true, true, 'ai_false', secret])
    // Its own text, with the uid vihko gave it (which it is told): the ETag tells it nothing new.
    assert.equal(r.data.etag, contentHash(disk(h, secret)))
    assert.match(disk(h, secret), new RegExp(`uid: ${r.data.uid}`))
    const again = await c.call('get_note', { path: secret })
    assert.deepEqual([again.data.error, again.data.reason], ['agent_denied', 'ai_false'])
    assert.deepEqual((await c.call('search', { query: WORD })).data.results.map((x: any) => x.path), [NOTE])
    await c.close()
  } finally { await h.close() }
})

test('MCP: a revert that leaves the frontmatter unreadable hides the note: now_hidden, with its ETag only if the agent gave one', async () => {
  // A version made the quoted value plain on two lines; a person changed the second one since.
  const h = await setup({ files: { [FM]: FM_TEXT } })
  try {
    await h.enableMcp()
    await h.settle()
    const put = async (edit: (t: string) => string) => {
      const cur = await h.admin('GET', h.url('/api/note', { path: FM }))
      assert.equal((await h.admin('PUT', h.url('/api/note', { path: FM }), { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })).status, 200)
      await h.settle()
    }
    await put((t) => t.replace('a: "x\n  y"', 'a: x\nb: y'))
    await put((t) => t.replace('b: y', 'b: z'))
    const c = await h.mcp((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })).token)
    const versions = (await c.call('history', { path: FM })).data.versions as { version: string }[]
    const current = (await c.call('get_note', { path: FM })).data.etag
    const dry = await c.call('revert_change', { path: FM, version: versions[1]!.version, dry_run: true })
    assert.deepEqual([dry.data.counts.reverted, dry.data.counts.skipped, dry.data.now_hidden], [2, 1, undefined], dry.raw)
    const r = await c.call('revert_change', { path: FM, version: versions[1]!.version, if_match: current })
    assert.equal(r.error, false, r.raw)
    // The precondition: the note's frontmatter can't be read now.
    const text = disk(h, FM)
    assert.match(text, /a: "x\n  z\n/)
    assert.ok(readFrontmatter(text).error, text)
    assert.deepEqual([r.data.changed, r.data.now_hidden, r.data.reason, r.data.etag], [true, true, 'ai_false', contentHash(text)])
    assert.equal((await c.call('get_note', { path: FM })).data.error, 'agent_denied')
    await c.close()
  } finally { await h.close() }
})

test('HTTP with a key: an edit, a creation or a whole text that hides the note succeed with nowHidden, and the note is hidden from then on', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableApi()
    const key = h.withKey((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })).token)
    const read = await key('GET', h.url('/api/note', { path: NOTE }))
    const edit = await key('POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'set_frontmatter', key: 'ai', value: 'no' }], ifMatch: read.body.etag })
    assert.equal(edit.status, 200, edit.text)
    const text = disk(h, NOTE)
    assert.deepEqual(edit.body, { etag: contentHash(text), nowHidden: true, reason: 'ai_false', message: edit.body.message })
    assert.match(edit.body.message, /only a person can/)
    assert.equal(edit.headers.get('etag'), `"${contentHash(text)}"`)
    // Hidden from then on: named, denied; listed, absent.
    const denied = await key('GET', h.url('/api/note', { path: NOTE }))
    assert.deepEqual([denied.status, denied.body.error, denied.body.reason], [403, 'agent_denied', 'ai_false'])
    for (const path of [h.url('/api/search', { q: WORD }), '/api/tree', h.url('/api/note/links', { path: OTHER }), h.url('/api/note', { path: OTHER })]) {
      const r = await key('GET', path)
      assert.equal(r.status, 200, `${path}: ${r.text}`)
      assert.deepEqual(leaked(r.text, decodeURIComponent(path.replace(/\+/g, ' '))), [], path)
    }

    const fresh = m.aNotePath(DIR)
    const made = await key('POST', '/api/note', { path: fresh, text: `---\nai: false\n---\n# ${m.aHeading()}\n` })
    assert.equal(made.status, 201, made.text)
    assert.deepEqual([made.body.path, made.body.nowHidden, made.body.reason, made.body.etag], [fresh, true, 'ai_false', contentHash(disk(h, fresh))])

    const libre = await key('GET', h.url('/api/note', { path: FREE }))
    const put = await key('PUT', h.url('/api/note', { path: FREE }), { text: `---\nai: off\n---\n# ${m.aHeading()}\n` }, { 'if-match': `"${libre.body.etag}"` })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual([put.body.nowHidden, put.body.reason, put.body.etag], [true, 'ai_false', contentHash(disk(h, FREE))])
    assert.equal((await key('GET', h.url('/api/note', { path: FREE }))).status, 403)

    // A person writing the same gets no such answer: they still see the note.
    const mine = await h.admin('GET', h.url('/api/note', { path: OTHER }))
    const person = await h.admin('POST', '/api/note/edit', { path: OTHER, ops: [{ op: 'set_frontmatter', key: 'ai', value: false }], ifMatch: mine.body.etag })
    assert.deepEqual(Object.keys(person.body), ['etag'])
  } finally { await h.close() }
})

test('HTTP with a key: a revert that hides the note answers nowHidden, without its ETag when the agent gave none', async () => {
  const h = await setup({ files: { [FM]: FM_TEXT } })
  try {
    await h.enableApi()
    await h.settle()
    const put = async (edit: (t: string) => string) => {
      const cur = await h.admin('GET', h.url('/api/note', { path: FM }))
      assert.equal((await h.admin('PUT', h.url('/api/note', { path: FM }), { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })).status, 200)
      await h.settle()
    }
    await put((t) => t.replace('a: "x\n  y"', 'a: x\nb: y'))
    await put((t) => t.replace('b: y', 'b: z'))
    const key = h.withKey((await h.newKey({ name: m.aKeyName(), canWrite: true })).token)
    const versions = (await key('GET', h.url('/api/history/versions', { path: FM }))).body.versions as { id: string }[]
    const r = await key('POST', '/api/history/revert', { path: FM, id: versions[1]!.id })
    assert.equal(r.status, 200, r.text)
    assert.ok(readFrontmatter(disk(h, FM)).error)
    assert.deepEqual([r.body.changed, r.body.nowHidden, r.body.reason, 'etag' in r.body, r.headers.get('etag')], [true, true, 'ai_false', false, null])
  } finally { await h.close() }
})
