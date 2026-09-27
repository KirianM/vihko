// The typists of the kill -9 rounds (_crash.ts) must never break each other's
// lines: a round takes a broken line for one the server lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { countLine, startLine } from './_crash.ts'

test('a typist starting a line where another has just started one leaves both lines whole', () => {
  // Both orders of client ids: Yjs orders concurrent inserts at one place by them.
  for (const [idA, idB] of [[1, 2], [2, 1]] as const) {
    const origin = new Y.Doc()
    origin.getText('md').insert(0, '# Note\n\nline one\nline two\n')
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.clientID = idA
    b.clientID = idB
    Y.applyUpdate(a, Y.encodeStateAsUpdate(origin))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(origin))
    const fromA: Uint8Array[] = []
    a.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'sync') fromA.push(u) })
    const sync = () => {
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'sync')
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'sync')
    }

    // A starts a line before «line one»; B has only A's first update when it
    // starts its own line at that same line start.
    const at = a.getText('md').toString().indexOf('line one')
    const nextA = startLine(a.getText('md'), at, 'R0-A-27.')
    nextA()
    Y.applyUpdate(b, fromA[0]!, 'sync')
    const nextB = startLine(b.getText('md'), at, 'R0-B-27.')
    sync()
    for (let more = true; more;) {
      more = [nextA(), nextB()].some(Boolean)
      sync()
    }

    const text = a.getText('md').toString()
    assert.equal(b.getText('md').toString(), text)
    assert.equal(countLine(text, 'R0-A-27.'), 1, `A (${idA}) against B (${idB}): ${JSON.stringify(text)}`)
    assert.equal(countLine(text, 'R0-B-27.'), 1, `A (${idA}) against B (${idB}): ${JSON.stringify(text)}`)
  }
})
