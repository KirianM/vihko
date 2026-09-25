import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash } from '@thoth/core'
import { commitText } from '@thoth/server'

const dir = () => mkdtempSync(join(tmpdir(), 'thoth-fs-'))

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
