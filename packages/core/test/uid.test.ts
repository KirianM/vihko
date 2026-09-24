import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newUid } from '@thoth/core'

test('ULID: formato, codificación del tiempo y orden', () => {
  // Vector de la especificación ULID: ulid(1469918176385) empieza por 01ARYZ6S41.
  const zeros = new Uint8Array(10)
  assert.equal(newUid(1469918176385, zeros), '01ARYZ6S41' + '0'.repeat(16))
  assert.equal(newUid(0, new Uint8Array(10).fill(255)), '0000000000' + 'Z'.repeat(16))
  const a = newUid(1000)
  const b = newUid(2000)
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(a < b, 'ordenables por tiempo')
  assert.notEqual(newUid(), newUid())
})
