import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newUid } from '@vihko/core'

test('ULID: format, time encoding and ordering', () => {
  // Vector from the ULID spec: ulid(1469918176385) starts with 01ARYZ6S41.
  const zeros = new Uint8Array(10)
  assert.equal(newUid(1469918176385, zeros), '01ARYZ6S41' + '0'.repeat(16))
  assert.equal(newUid(0, new Uint8Array(10).fill(255)), '0000000000' + 'Z'.repeat(16))
  const a = newUid(1000)
  const b = newUid(2000)
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(a < b, 'sortable by time')
  assert.notEqual(newUid(), newUid())
})
