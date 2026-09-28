import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentHash } from '@vihko/core'

test('contentHash matches sha256 and carries an algorithm prefix', () => {
  // Reference value: printf 'hola\n' | sha256sum
  assert.equal(contentHash('hola\n'), 'sha256:133ee989293f92736301280c6f14c89d521200c17dcdcecca30cd20705332d44')
  assert.match(contentHash(''), /^sha256:[0-9a-f]{64}$/)
})

test('contentHash distinguishes bytes, not just visible text', () => {
  assert.notEqual(contentHash('a\n'), contentHash('a\r\n'))
  assert.notEqual(contentHash('é'), contentHash('é')) // NFC vs NFD
})
