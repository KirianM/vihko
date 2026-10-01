// The first page of the managed history's changes, asked again and again
// (Home and «Recent changes» on every change to the tree, from every page
// that shows them): the commits looked at are kept for the history's head,
// so a head that hasn't moved reads no log, and one that has reads only what
// came since. What it answers is what a reader that keeps nothing answers,
// after new commits and after a purge rewrote the history.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManagedReader, type Git } from '@vihko/server'
import { setup } from './_history.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
// Notes of the fixed vault the setup copies (testdata/vault).
const NOTE = inShared('hogar/Proxy.md')
const OTHER = inShared('hogar/Red.md')

/** The history's git, counting the `git log` it runs. */
function counting(git: Git) {
  const seen = { logs: 0 }
  const counted = new Proxy(git, {
    get(target, key) {
      if (key === 'run') return (args: string[], o?: unknown) => { if (args[0] === 'log') seen.logs++; return (target.run as (a: string[], o?: unknown) => unknown)(args, o) }
      return Reflect.get(target, key)
    },
  })
  return { git: counted, seen }
}

test('the first page of changes reads only the commits since the last time, and answers as a reader that keeps nothing', async () => {
  const h = await setup()
  try {
    for (const p of [NOTE, OTHER, NOTE]) {
      await h.put(p, (t) => `${t}\n${m.aSentence()}\n`)
      await h.settle()
    }
    const { git, seen } = counting(h.history.recorder.git)
    const reader = new ManagedReader(git)
    const page = { limit: 50, canRead: () => true }
    const fresh = () => new ManagedReader(h.history.recorder.git).changes(page)

    const first = await reader.changes(page)
    assert.ok(first.changes.length >= 3)
    assert.deepEqual(first, await fresh())
    const afterFirst = seen.logs
    assert.ok(afterFirst >= 1)

    // The head hasn't moved: no log at all.
    assert.deepEqual(await reader.changes(page), first)
    assert.equal(seen.logs, afterFirst)

    // A new commit: one log, from the new head back to the last one seen.
    await h.put(OTHER, (t) => `${t}\n${m.aSentence()}\n`)
    await h.settle()
    const second = await reader.changes(page)
    assert.equal(seen.logs, afterFirst + 1)
    assert.equal(second.changes.length, first.changes.length + 1)
    assert.deepEqual(second, await fresh())

    // A purge writes the history again: nothing of what it took out comes back from what was kept.
    await h.history.purge({ path: NOTE, exact: true, by: h.ids.admin })
    const purged = await reader.changes(page)
    assert.deepEqual(purged, await fresh())
    assert.ok(!JSON.stringify(purged).includes(NOTE))
    assert.ok(JSON.stringify(purged).includes(OTHER))
  } finally {
    await h.close()
  }
})
