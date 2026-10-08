import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from '../src/bytes.ts'

// The values are the cases under test: the plural's edges and each unit's.
test('sizes in words: bytes by the plural rules, then KB, MB and GB with one decimal, in each language', () => {
  for (const [bytes, en, es] of [
    [0, '0 bytes', '0 bytes'],
    [1, '1 byte', '1 byte'],
    [51, '51 bytes', '51 bytes'],
    [1023, '1,023 bytes', '1023 bytes'],
    [1024, '1 KB', '1 KB'],
    [1229, '1.2 KB', '1,2 KB'],
    [3.4 * 1024 * 1024, '3.4 MB', '3,4 MB'],
    [5 * 1024 ** 3, '5 GB', '5 GB'],
  ] as const) {
    assert.equal(formatBytes(bytes, 'en'), en, `en ${bytes}`)
    assert.equal(formatBytes(bytes, 'es'), es, `es ${bytes}`)
  }
})
