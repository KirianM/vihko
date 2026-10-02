// The tree, live (liveTree.ts): GET /api/events tells a person to
// read their tree again when a change concerns what they see, and only then;
// an event never says what changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Longer than the debounce (250 ms) and the time a change takes to be indexed here. */
const QUIET = 700

/** Listens to someone's events: what arrived (event name and data), and how to stop. */
async function listen(h: Spaces, who: Name) {
  const ctrl = new AbortController()
  const res = await h.app.request('/api/events', { headers: { cookie: h.cookie(who) }, signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
  const reader = res.body!.getReader()
  const events: { event: string; data: string }[] = []
  const raw: string[] = []
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += new TextDecoder().decode(value)
        raw.push(new TextDecoder().decode(value))
        let at: number
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (event) events.push({ event, data: data ?? '' })
        }
      }
    } catch { /* stopped */ }
  })()
  // Ready once the stream says so.
  for (let i = 0; i < 50 && !events.some((e) => e.event === 'ready'); i++) await sleep(20)
  const trees = () => events.filter((e) => e.event === 'tree').length
  return {
    events, raw, trees,
    /** Waits for one more `tree` than `seen`, up to a while; whether it came. */
    async next(seen: number, ms = 3000) {
      for (let t = 0; t < ms; t += 25) { if (trees() > seen) return true; await sleep(25) }
      return false
    },
    close() { ctrl.abort(); void reader.cancel().catch(() => {}) },
  }
}

test('live tree: a note made, moved or deleted where someone reads tells them; where they don\'t, nothing; the event says nothing of it', async () => {
  const h = await setup()
  const streams: { close(): void }[] = []
  try {
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName(), members: { [h.names.other]: 'read' } })).body.space.path as string
    const other = await listen(h, 'other')
    streams.push(other)
    // Something of the admin's own: nothing reaches the other.
    let seen = other.trees()
    const secret = `${h.home('admin')}/${m.aTitle()}.md`
    assert.equal((await h.admin('POST', '/api/note', { path: secret, text: `# ${m.aHeading()}\n` })).status, 201)
    await sleep(QUIET)
    assert.equal(other.trees(), seen, 'nothing they can\'t read')
    // In the space they read: told, with nothing but «read your tree again».
    const note = `${space}/${m.aTitle()}.md`
    assert.equal((await h.member('POST', '/api/note', { path: note, text: `# ${m.aHeading()}\n` })).status, 201)
    assert.ok(await other.next(seen), 'a note made where they read')
    assert.deepEqual(other.events.filter((e) => e.event === 'tree').map((e) => e.data), ['{}'])
    assert.ok(!other.raw.join('').includes(note) && !other.raw.join('').includes(secret))
    // Made a template and back (the tree marks templates): told each time; other edits, not.
    seen = other.trees()
    assert.equal((await h.member('POST', '/api/note/template', { path: note, template: true })).status, 200)
    assert.ok(await other.next(seen), 'made a template')
    seen = other.trees()
    assert.equal((await h.member('POST', '/api/note/template', { path: note, template: false })).status, 200)
    assert.ok(await other.next(seen), 'a template no more')
    seen = other.trees()
    assert.equal((await h.member('POST', '/api/note/edit', { path: note, ops: [{ op: 'append', text: m.aSentence() }] })).status, 200)
    await sleep(QUIET)
    assert.equal(other.trees(), seen, 'an edit the tree doesn\'t show')
    // Moved within it, and deleted: told each time.
    seen = other.trees()
    const moved = `${space}/${m.aFolder()}/${m.aTitle()}.md`
    assert.equal((await h.member('POST', '/api/note/move', { from: note, to: moved })).status, 200)
    assert.ok(await other.next(seen), 'a move')
    seen = other.trees()
    assert.equal((await h.member('DELETE', `/api/note?path=${encodeURIComponent(moved)}`)).status, 200)
    assert.ok(await other.next(seen), 'a deletion')
    // A folder made in the admin's own space: nothing.
    seen = other.trees()
    assert.equal((await h.admin('POST', '/api/folder', { path: `${h.home('admin')}/${m.aFolder()}` })).status, 201)
    await sleep(QUIET)
    assert.equal(other.trees(), seen)
  } finally {
    for (const s of streams) s.close()
    h.close()
  }
})

test('live tree: being added to a space or given a folder tells that person; a change of what they don\'t reach tells nobody else', async () => {
  const h = await setup()
  const streams: { close(): void }[] = []
  try {
    const [other, admin] = [await listen(h, 'other'), await listen(h, 'admin')]
    streams.push(other, admin)
    // The member shares a folder of hers with the other.
    const folder = `${h.home('member')}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, folder), { recursive: true })
    h.indexer.indexFolders([folder])
    await sleep(QUIET)
    const [o0, a0] = [other.trees(), admin.trees()]
    await h.rule(folder, { grants: { [h.names.other]: 'read' } })
    assert.ok(await other.next(o0), 'what is shared with them')
    await sleep(QUIET)
    assert.equal(admin.trees(), a0, 'the admin reaches nothing new')
    // Taken out again: told too.
    const o1 = other.trees()
    await h.rule(folder, { grants: null })
    assert.ok(await other.next(o1), 'what they no longer reach')
    // A rule of a folder only the member reaches: nobody else hears of it.
    const [o2, a2] = [other.trees(), admin.trees()]
    await h.rule(folder, { ai: false })
    await sleep(QUIET)
    assert.deepEqual([other.trees(), admin.trees()], [o2, a2])
  } finally {
    for (const s of streams) s.close()
    h.close()
  }
})

test('live tree: an agent has no event stream; nobody signed in, neither', async () => {
  const h = await setup()
  try {
    await h.enable()
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: false })
    assert.equal((await h.withKey(key.token)('GET', '/api/events')).status, 404)
    assert.equal((await h.app.request('/api/events')).status, 401)
    assert.equal(h.services.live.size, 0)
  } finally {
    h.close()
  }
})
