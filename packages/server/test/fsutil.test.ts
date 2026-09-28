import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from '@vihko/core'
import { commitText } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const dir = () => tempDir('vihko-fs-')
/** A note's name, and a version of its text (never the same twice). */
const aName = () => `${m.aTitle()}.md`
const text = () => `${m.aSentence()}\n`

test('commitText: creates without overwriting, replaces with the correct hash and leaves no temp files', async () => {
  const d = dir()
  const name = aName()
  const f = join(d, name)
  const [one, other, two] = [text(), text(), text()]
  assert.deepEqual(await commitText(f, one, null), { ok: true })
  assert.deepEqual(await commitText(f, other, null), { ok: false, current: one }, "create doesn't overwrite")
  assert.deepEqual(await commitText(f, two, contentHash(text())), { ok: false, current: one })
  assert.equal(readFileSync(f, 'utf8'), one, "a stale hash doesn't write")
  assert.deepEqual(await commitText(f, two, contentHash(one)), { ok: true })
  assert.equal(readFileSync(f, 'utf8'), two)
  assert.deepEqual(readdirSync(d), [name], 'no temp files or .prev links')
})

test("commitText: if the file doesn't exist and one was expected, nothing is created", async () => {
  const d = dir()
  const f = join(d, aName())
  assert.deepEqual(await commitText(f, text(), contentHash(text())), { ok: false, current: null })
  assert.deepEqual(readdirSync(d), [])
})

test('commitText: a prior external write is detected and returned', async () => {
  const d = dir()
  const f = join(d, aName())
  const [v1, outside] = [text(), text()]
  writeFileSync(f, v1)
  writeFileSync(f, outside) // someone writes after we read v1
  const r = await commitText(f, text(), contentHash(v1))
  assert.deepEqual(r, { ok: false, current: outside })
  assert.equal(readFileSync(f, 'utf8'), outside)
})

// In a container the server is always pid 1 and, after a crash, its counter
// starts again: the temp names of the killed process are still on disk.
test('commitText: leftovers of a killed process with the same pid do not block writes', async () => {
  const d = dir()
  const name = aName()
  const f = join(d, name)
  const [one, two] = [text(), text()]
  writeFileSync(f, one)
  // The temp names' format (the case under test): `.<name>.vihko-<pid>-<n>`.
  for (let n = 0; n < 200; n++) {
    writeFileSync(join(d, `.${name}.vihko-${process.pid}-${n}`), 'left by a crash')
    writeFileSync(join(d, `.${name}.vihko-${process.pid}-${n}.prev`), 'left by a crash')
  }
  assert.deepEqual(await commitText(f, two, contentHash(one)), { ok: true })
  assert.equal(readFileSync(f, 'utf8'), two)
})

// The write path is asynchronous (so a big rename on NFS doesn't queue every
// round trip on the event loop): two writes from the same base must still
// never both pass the hash check.
test('commitText: of two concurrent writes from the same version, only one lands', async () => {
  const d = dir()
  const name = aName()
  const f = join(d, name)
  writeFileSync(f, text())
  for (let round = 0; round < 20; round++) {
    const base = readFileSync(f, 'utf8')
    const [a, b] = await Promise.all([commitText(f, `a${round}\n`, contentHash(base)), commitText(f, `b${round}\n`, contentHash(base))])
    assert.equal([a, b].filter((r) => r.ok).length, 1, `round ${round}: exactly one write wins`)
    const loser = a.ok ? b : a
    assert.equal(loser.ok ? null : loser.current, readFileSync(f, 'utf8'), 'the loser is told what is there')
  }
  assert.deepEqual(readdirSync(d), [name], 'no temp files left')
})
