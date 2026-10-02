// A note's history after its shared space is renamed, or a folder holding it
// renamed within its space: each version is judged where the note is now,
// so whoever may see its history there sees what came before the rename.
// Before, each was judged at the path it had then, which no rule names
// any more after a space's rename: its whole past was hidden from everyone.
// A note that came from another space still keeps that part to itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIR, FILES as BASE, MEMBER, OTHER, RULES, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

type Version = { id: string; path: string; change: string; from?: string }

test('renaming a shared space or a folder within its space keeps the history before it for whoever reads it now', async () => {
  const shared = `${home(MEMBER.username)}/${m.aFolder()}`
  const config = RULES + `  ${yamlKey(shared)}:\n    grants: { ${yamlKey(OTHER.username)}: edit }\n`
  const h = await setup({ files: { ...BASE, [`${shared}/`]: '' }, config })
  try {
    const versions = async (who: 'member' | 'other', path: string) => {
      const r = await h[who]('GET', h.url('/api/history/versions', { path }))
      assert.equal(r.status, 200, r.text)
      return r.body.versions as Version[]
    }
    /** A note written, then changed: two versions. */
    const write = async (path: string) => {
      assert.equal((await h.member('POST', '/api/note', { path, text: `# ${m.aHeading()}\n` })).status, 201)
      await h.settle()
      const cur = (await h.member('GET', h.url('/api/note', { path }))).body
      assert.equal((await h.member('PUT', h.url('/api/note', { path }), { text: `${cur.text}${m.aSentence()}\n` }, { 'if-match': `"${cur.etag}"` })).status, 200)
      await h.settle()
    }

    // A shared space renamed.
    const note = m.aNotePath(DIR.shared)
    await write(note)
    const old = await versions('other', note)
    assert.equal(old.length, 2)
    const name = m.aSpaceName()
    const renamed = await h.admin('POST', '/api/spaces/rename', { path: DIR.shared, name })
    assert.equal(renamed.status, 200, renamed.text)
    await h.settle()
    const now = `${renamed.body.space.path}${note.slice(DIR.shared.length)}`
    const after = await versions('other', now)
    assert.deepEqual(after.slice(1).map((v) => v.id), old.map((v) => v.id), 'the versions from before the rename')
    assert.deepEqual([after[0]!.change, after[0]!.from], ['moved', note], 'and where it came from: the same space')
    // Their texts, a diff and a restore, as for any version of it.
    const first = old.at(-1)!.id
    assert.equal((await h.other('GET', h.url('/api/history/version', { path: now, id: first }))).status, 200)
    assert.equal((await h.other('GET', h.url('/api/history/diff', { path: now, id: first }))).status, 200)
    assert.equal((await h.other('POST', '/api/history/restore', { path: now, id: first })).status, 200)
    await h.settle()
    // «Recent changes» lists them too.
    const changes = (await h.other('GET', '/api/history/changes')).body.changes as { id: string }[]
    for (const v of old) assert.ok(changes.some((c) => c.id === v.id), `${v.id} in recent changes`)
    // Nobody else gains it: the third person reads nothing there.
    assert.equal((await h.member('GET', h.url('/api/history/versions', { path: now }))).status, 200)

    // A folder renamed within a personal space, shared with the other: they keep what came before.
    const mine = m.aNotePath(shared)
    await write(mine)
    assert.equal((await versions('other', mine)).length, 2)
    const to = `${home(MEMBER.username)}/${m.aFolder()}`
    assert.equal((await h.member('POST', '/api/folder/move', { from: shared, to })).status, 200)
    await h.settle()
    assert.equal((await versions('other', `${to}${mine.slice(shared.length)}`)).length, 3)

    // A note moved from the member's own space into the shared one: its past there stays theirs.
    const own = m.aNotePath(home(MEMBER.username))
    await write(own)
    const moved = m.aNotePath(renamed.body.space.path)
    assert.equal((await h.member('POST', '/api/note/move', { from: own, to: moved })).status, 200)
    await h.settle()
    const seen = await versions('other', moved)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.from, undefined)
    assert.equal((await versions('member', moved)).length, 3)
  } finally { await h.close() }
})
