import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentHash } from '@thoth/core'

test('contentHash coincide con sha256 y lleva prefijo de algoritmo', () => {
  // Valor de referencia: printf 'hola\n' | sha256sum
  assert.equal(contentHash('hola\n'), 'sha256:133ee989293f92736301280c6f14c89d521200c17dcdcecca30cd20705332d44')
  assert.match(contentHash(''), /^sha256:[0-9a-f]{64}$/)
})

test('contentHash distingue bytes, no solo texto visible', () => {
  assert.notEqual(contentHash('a\n'), contentHash('a\r\n'))
  assert.notEqual(contentHash('é'), contentHash('é')) // NFC frente a NFD
})
