import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyWidens, type KeyScope } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
// Folders of a key (any names do): two apart, one inside the first, and one it never had.
const [A, B, OTHER] = [m.aFolder(), m.aFolder(), m.aFolder()]
const INSIDE = `${A}/${m.aFolder()}`
const day = (n: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 86_400_000).toISOString()

test('keyWidens: writing, more folders, every folder, a later expiry or none widen a key', () => {
  const some: KeyScope = { canWrite: false, folders: [A, B], expiresAt: day(30) }
  assert.equal(keyWidens(some, { canWrite: true }), true, 'read-only to read-write')
  assert.equal(keyWidens(some, { folders: [A, B, OTHER] }), true, 'one more folder')
  assert.equal(keyWidens(some, { folders: [OTHER] }), true, 'another folder, even with fewer')
  assert.equal(keyWidens(some, { folders: [] }), true, 'every folder')
  assert.equal(keyWidens({ ...some, folders: [INSIDE] }, { folders: [A] }), true, 'the folder around the one it had')
  assert.equal(keyWidens(some, { expiresAt: day(31) }), true, 'a later expiry')
  assert.equal(keyWidens(some, { expiresAt: null }), true, 'none')
})

test('keyWidens: renaming, narrowing, or setting what it already has doesn\'t', () => {
  const wide: KeyScope = { canWrite: true, folders: [], expiresAt: null }
  assert.equal(keyWidens(wide, {}), false, 'nothing changes (a rename)')
  assert.equal(keyWidens(wide, { canWrite: true, folders: [], expiresAt: null }), false, 'the same')
  assert.equal(keyWidens(wide, { canWrite: false, folders: [A], expiresAt: day(7) }), false, 'every part narrower')
  const some: KeyScope = { canWrite: false, folders: [A, B], expiresAt: day(30) }
  assert.equal(keyWidens(some, { canWrite: false }), false)
  assert.equal(keyWidens(some, { folders: [B] }), false, 'fewer folders')
  assert.equal(keyWidens(some, { folders: [INSIDE] }), false, 'a folder inside one it had')
  assert.equal(keyWidens(some, { expiresAt: day(29) }), false, 'an earlier expiry')
  assert.equal(keyWidens(some, { expiresAt: day(30) }), false, 'the same expiry')
})
