import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseAuthorKey } from '../src/actor.ts'
import { countWords, wordDiff } from '../src/history/diff.ts'
import { blobOid, quotePath } from '../src/history/git.ts'
import { formatMessage, movedFrom, parseMessage } from '../src/history/trailers.ts'

test('word diff: whole words, spaces and marks; counts leave spaces out', () => {
  const d = wordDiff('El gato come pescado.', 'El perro come carne!')
  assert.deepEqual(d.ops, [[0, 'El '], [-1, 'gato'], [1, 'perro'], [0, ' come '], [-1, 'pescado.'], [1, 'carne!']])
  assert.deepEqual([d.added, d.removed], [3, 3])
  // Accents and combining marks stay inside their word.
  const nfd = 'café'
  const a = wordDiff(`un ${nfd} solo`, `un ${nfd} doble`)
  assert.deepEqual(a.ops, [[0, `un ${nfd} `], [-1, 'solo'], [1, 'doble']])
  assert.deepEqual(wordDiff('igual', 'igual'), { ops: [[0, 'igual']], added: 0, removed: 0 })
  assert.deepEqual(wordDiff('', 'nuevo texto'), { ops: [[1, 'nuevo texto']], added: 2, removed: 0 })
  assert.equal(countWords('uno, dos  tres\n'), 4)
  // Applying the ops rebuilds both sides.
  const x = 'línea uno\nlínea dos\n- [ ] tarea\n'
  const y = 'línea uno\nlínea DOS\n- [x] tarea hecha\n'
  const ops = wordDiff(x, y).ops
  assert.equal(ops.filter(([o]) => o !== 1).map(([, s]) => s).join(''), x)
  assert.equal(ops.filter(([o]) => o !== -1).map(([, s]) => s).join(''), y)
})

test('word diff: long texts with little in common take bounded time; a small change in a long text is still by words', () => {
  const rebuilds = (a: string, b: string, ops: [number, string][]) => {
    assert.equal(ops.filter(([o]) => o !== 1).map(([, s]) => s).join(''), a)
    assert.equal(ops.filter(([o]) => o !== -1).map(([, s]) => s).join(''), b)
  }
  const cases: [string, string][] = [
    // One long line each, every word different.
    [Array.from({ length: 40_000 }, (_, i) => `a${i}`).join(' ') + ' fin', Array.from({ length: 40_000 }, (_, i) => `b${i}`).join(' ') + ' fin'],
    // Thousands of lines, all different.
    [Array.from({ length: 6000 }, (_, i) => `a${i} x\n`).join(''), Array.from({ length: 6000 }, (_, i) => `b${i} y\n`).join('')],
  ]
  for (const [a, b] of cases) {
    const t0 = performance.now()
    const d = wordDiff(a, b)
    const ms = performance.now() - t0
    assert.ok(ms < 3000, `${Math.round(ms)} ms`)
    rebuilds(a, b, d.ops)
  }
  const big = Array.from({ length: 20_000 }, (_, i) => `línea ${i} de la nota\n`).join('')
  const changed = big.replace('línea 10000 de', 'línea diez mil de')
  const t0 = performance.now()
  const d = wordDiff(big, changed)
  assert.ok(performance.now() - t0 < 1000)
  assert.deepEqual(d.ops.filter(([o]) => o !== 0), [[-1, '10000'], [1, 'diez mil']])
  rebuilds(big, changed, d.ops)
})

test('blob ids are git\'s', () => {
  // Checked independently, with git itself.
  const git = (input: Uint8Array | string) => spawnSync('git', ['hash-object', '--stdin'], { input }).stdout.toString().trim()
  assert.equal(blobOid('hola\n'), git('hola\n'))
  assert.equal(blobOid('café ☕\n'), git('café ☕\n'))
  assert.equal(blobOid(new Uint8Array([0, 1, 2, 255])), git(new Uint8Array([0, 1, 2, 255])))
})

test('trailers: written and read back; moves by file and by folder', () => {
  const msg = formatMessage('Move a to b', {
    authors: ['user 01ABC', 'agent key-1 01DEF'],
    reason: { code: 'note_moved', from: 'a.md', to: 'dir with space/b.md', by: 'user 01ABC' },
    foundAtStartup: true,
    moves: [{ from: 'a.md', to: 'dir with space/b.md' }, { from: 'old', to: 'new/dir' }],
    restoredFrom: 'abc123',
  })
  const p = parseMessage(msg)
  assert.equal(p.subject, 'Move a to b')
  assert.deepEqual(p.parsedAuthors, [{ kind: 'user', id: '01ABC' }, { kind: 'agent', id: 'key-1', onBehalfOf: '01DEF' }])
  assert.deepEqual(p.reason, { code: 'note_moved', from: 'a.md', to: 'dir with space/b.md', by: 'user 01ABC' })
  assert.equal(p.foundAtStartup, true)
  assert.equal(p.restoredFrom, 'abc123')
  assert.equal(movedFrom('dir with space/b.md', p.moves), 'a.md')
  assert.equal(movedFrom('new/dir/x/y.png', p.moves), 'old/x/y.png')
  assert.equal(movedFrom('new/directory.md', p.moves), null)
  assert.equal(parseAuthorKey('user'), null)
  assert.equal(parseAuthorKey('system extra'), null)
  assert.deepEqual(parseAuthorKey('external'), { kind: 'external' })
})

test('trailers: an agent\'s via goes in its own Thoth-Via, and the Thoth-Actor keeps the form older versions read', () => {
  const msg = formatMessage('Edit plan', {
    authors: ['agent K1 U1 mcp', 'user U1', 'agent K2 U1', 'agent K1 U1 api'],
    reason: null, foundAtStartup: false, moves: [], restoredFrom: null,
  })
  const lines = msg.split('\n').filter((l) => l.startsWith('Thoth-'))
  assert.deepEqual(lines, [
    'Thoth-Actor: agent K1 U1', 'Thoth-Via: K1 mcp', 'Thoth-Actor: user U1', 'Thoth-Actor: agent K2 U1', 'Thoth-Actor: agent K1 U1', 'Thoth-Via: K1 api',
  ])
  const p = parseMessage(msg)
  assert.deepEqual(p.authors, ['agent K1 U1 mcp', 'user U1', 'agent K2 U1', 'agent K1 U1 api'])
  assert.deepEqual(p.parsedAuthors, [
    { kind: 'agent', id: 'K1', onBehalfOf: 'U1', via: 'mcp' }, { kind: 'user', id: 'U1' },
    { kind: 'agent', id: 'K2', onBehalfOf: 'U1' }, { kind: 'agent', id: 'K1', onBehalfOf: 'U1', via: 'api' },
  ])
  // A via for no agent, or an unknown one, is ignored.
  const odd = parseMessage('x\n\nThoth-Via: K9 api\nThoth-Actor: agent K1 U1\nThoth-Via: K1 telnet\n')
  assert.deepEqual(odd.parsedAuthors, [{ kind: 'agent', id: 'K1', onBehalfOf: 'U1' }])
  assert.deepEqual(parseAuthorKey('agent K1 U1 oauth'), { kind: 'agent', id: 'K1', onBehalfOf: 'U1', via: 'oauth' })
  assert.equal(parseAuthorKey('agent K1 U1 telnet'), null)
})

test('fast-import paths are quoted', () => {
  assert.equal(quotePath('a b/c.md'), '"a b/c.md"')
  assert.equal(quotePath('say "hi"\\.md'), '"say \\"hi\\"\\\\.md"')
  assert.equal(quotePath('Café.md'), '"Café.md"')
})
