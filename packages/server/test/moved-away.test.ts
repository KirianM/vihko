// A note asked for where it was a moment ago, before vihko moved it: `not_found`
// with `movedTo`, so an editor that missed a move follows it; only to whoever
// reads it where it went, and only for a while.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const q = (p: string) => `/api/note?path=${encodeURIComponent(p)}`

test('a note moved from vihko, and moved back: the old path says where it is, to whoever reads it there', async () => {
  const h = await setup()
  try {
    const [a, b] = [`${h.home('member')}/${m.aFolder()}`, `${h.home('member')}/${m.aFolder()}`]
    const title = `${m.aTitle()}.md`
    h.write(`${a}/${title}`, `# ${m.aHeading()}\n`)
    assert.equal((await h.member('POST', '/api/folder/move', { from: a, to: b })).status, 200)
    const gone = await h.member('GET', q(`${a}/${title}`))
    assert.deepEqual([gone.status, gone.body.error, gone.body.movedTo], [404, 'not_found', `${b}/${title}`])
    // Moved back: from where it went, back here; here, nothing to say.
    assert.equal((await h.member('POST', '/api/folder/move', { from: b, to: a })).status, 200)
    const back = await h.member('GET', q(`${b}/${title}`))
    assert.deepEqual([back.status, back.body.movedTo], [404, `${a}/${title}`])
    assert.equal((await h.member('GET', q(`${a}/${title}`))).status, 200)
    // Someone who doesn't read it: the same answer as for a note that never was, nothing more.
    const other = await h.other('GET', q(`${b}/${title}`))
    const never = await h.other('GET', q(`${h.home('member')}/${m.aFolder()}/${m.aTitle()}.md`))
    assert.deepEqual([other.status, other.body.error, other.body.movedTo], [404, 'not_found', undefined])
    assert.deepEqual(Object.keys(other.body).sort(), Object.keys(never.body).sort())
  } finally {
    h.close()
  }
})
