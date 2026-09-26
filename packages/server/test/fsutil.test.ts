import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from '@thoth/core'
import { commitText } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const dir = () => tempDir('thoth-fs-')

test('commitText: creates without overwriting, replaces with the correct hash and leaves no temp files', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  assert.deepEqual(await commitText(f, 'uno\n', null), { ok: true })
  assert.deepEqual(await commitText(f, 'otro\n', null), { ok: false, current: 'uno\n' }, "create doesn't overwrite")
  assert.deepEqual(await commitText(f, 'dos\n', contentHash('desfasado')), { ok: false, current: 'uno\n' })
  assert.equal(readFileSync(f, 'utf8'), 'uno\n', "a stale hash doesn't write")
  assert.deepEqual(await commitText(f, 'dos\n', contentHash('uno\n')), { ok: true })
  assert.equal(readFileSync(f, 'utf8'), 'dos\n')
  assert.deepEqual(readdirSync(d), ['n.md'], 'no temp files or .prev links')
})

test("commitText: if the file doesn't exist and one was expected, nothing is created", async () => {
  const d = dir()
  const f = join(d, 'n.md')
  assert.deepEqual(await commitText(f, 'x', contentHash('algo')), { ok: false, current: null })
  assert.deepEqual(readdirSync(d), [])
})

test('commitText: a prior external write is detected and returned', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  writeFileSync(f, 'v1\n')
  writeFileSync(f, 'v1 editada fuera\n') // someone writes after we read v1
  const r = await commitText(f, 'mi versión\n', contentHash('v1\n'))
  assert.deepEqual(r, { ok: false, current: 'v1 editada fuera\n' })
  assert.equal(readFileSync(f, 'utf8'), 'v1 editada fuera\n')
})

// In a container the server is always pid 1 and, after a crash, its counter
// starts again: the temp names of the killed process are still on disk.
test('commitText: leftovers of a killed process with the same pid do not block writes', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  writeFileSync(f, 'uno\n')
  for (let n = 0; n < 200; n++) {
    writeFileSync(join(d, `.n.md.thoth-${process.pid}-${n}`), 'left by a crash')
    writeFileSync(join(d, `.n.md.thoth-${process.pid}-${n}.prev`), 'left by a crash')
  }
  assert.deepEqual(await commitText(f, 'dos\n', contentHash('uno\n')), { ok: true })
  assert.equal(readFileSync(f, 'utf8'), 'dos\n')
})

// The write path is asynchronous (so a big rename on NFS doesn't queue every
// round trip on the event loop): two writes from the same base must still
// never both pass the hash check.
test('commitText: of two concurrent writes from the same version, only one lands', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  writeFileSync(f, 'base\n')
  for (let round = 0; round < 20; round++) {
    const base = readFileSync(f, 'utf8')
    const [a, b] = await Promise.all([commitText(f, `a${round}\n`, contentHash(base)), commitText(f, `b${round}\n`, contentHash(base))])
    assert.equal([a, b].filter((r) => r.ok).length, 1, `round ${round}: exactly one write wins`)
    const loser = a.ok ? b : a
    assert.equal(loser.ok ? null : loser.current, readFileSync(f, 'utf8'), 'the loser is told what is there')
  }
  assert.deepEqual(readdirSync(d), ['n.md'], 'no temp files left')
})
