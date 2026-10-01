import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readablePart } from '@vihko/core/spaces'
import { renamedPath } from '../src/legacyAddress.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const entry = (path: string) => ({ path, name: path.slice('spaces/'.length), level: 'edit' as const, managers: [], aiClosed: false })

test('an address of a space of rc.1 or rc.2 leads to the space it was renamed to, among those the person reaches (D-056.33)', () => {
  const name = m.aSpaceName()
  const root = `spaces/${name}`
  const old = `spaces/${m.aLegacySpaceFolder(name)}`
  const inner = m.aNotePath(m.aFolder())
  const other = `spaces/${m.aSpaceName()}`
  const info = { spaces: [entry(root), entry(other)], shared: [] }
  assert.equal(renamedPath(`${old}/${inner}`, info), `${root}/${inner}`)
  assert.equal(renamedPath(old, info), root)
  // A folder shared from a space they aren't in counts too.
  assert.equal(renamedPath(`${old}/${inner}`, { spaces: [], shared: [{ path: `${root}/${m.aFolder()}`, level: 'read', space: { path: root, name }, pinned: false }] }), `${root}/${inner}`)
  // Not among their spaces: nothing is guessed.
  assert.equal(renamedPath(`${old}/${inner}`, { spaces: [entry(other)], shared: [] }), null)
  // A space they reach as it is, a path that isn't such a folder, a personal space: as it is.
  const legacyKept = `spaces/${m.aLegacySpaceFolder()}`
  assert.equal(renamedPath(`${legacyKept}/${inner}`, { spaces: [entry(legacyKept)], shared: [] }), null)
  assert.equal(renamedPath(`${root}/${inner}`, info), null)
  assert.equal(renamedPath(`people/${m.aUsername()}/${inner}`, info), null)
  // Two of their spaces with that readable part: no guess.
  const twin = `spaces/${name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase()}`
  assert.equal(readablePart(twin.slice('spaces/'.length)), readablePart(name))
  assert.equal(renamedPath(`${old}/${inner}`, { spaces: [entry(root), entry(twin)], shared: [] }), null)
})
