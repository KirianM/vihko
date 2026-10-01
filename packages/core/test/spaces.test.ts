import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PEOPLE, SETTINGS_FOLDER, SPACES, SPACE_ID, SPACE_NAME_MAX, displayPath, isReserved, isSpaceRoot, isValidUsername, nameKey, newSpaceFolder, newSpaceId,
  parseSpaceFolder, parseSpacePath, personalRoot, placement, readablePart, settingsFolder, sharedRoot, spaceNameProblem, spaceOf, spaceRootOf,
} from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('spaces: the fixed folders', () => {
  assert.equal(PEOPLE, 'people')
  assert.equal(SPACES, 'spaces')
  assert.equal(SETTINGS_FOLDER, '.vihko')
})

test('spaces: a path in a personal space', () => {
  const owner = m.aUsername()
  const inner = m.aNotePath(m.aFolderPath(2))
  const path = `${personalRoot(owner)}/${inner}`
  assert.deepEqual(parseSpacePath(path), { space: { kind: 'personal', root: `people/${owner}`, owner }, inner })
  assert.equal(spaceRootOf(path), `people/${owner}`)
  // The root itself is in the space, as its root.
  assert.deepEqual(parseSpacePath(`people/${owner}`), { space: { kind: 'personal', root: `people/${owner}`, owner }, inner: '' })
  assert.ok(isSpaceRoot(`people/${owner}`))
  assert.ok(!isSpaceRoot(path))
})

test('spaces: a path in a shared space', () => {
  const folder = m.aSpaceFolder()
  const { readable, id } = parseSpaceFolder(folder)!
  const inner = m.aNotePath(m.aFolder())
  assert.deepEqual(parseSpacePath(`${sharedRoot(folder)}/${inner}`), { space: { kind: 'shared', root: `spaces/${folder}`, folder, id, readable }, inner })
  assert.ok(isSpaceRoot(`spaces/${folder}`))
  assert.equal(spaceOf(`spaces/${folder}`)?.kind, 'shared')
})

test('spaces: what is in no space', () => {
  const user = m.aUsername()
  for (const path of ['', 'people', 'spaces', 'vihko.yaml', `${m.aFolder()}/${m.aNotePath()}`, m.aNotePath(), 'people/', 'spaces/']) {
    assert.equal(parseSpacePath(path), null, path)
    assert.equal(placement(path), 'outside', path)
  }
  // Names are the disk's: the fixed folders only in lowercase.
  assert.equal(spaceOf(`People/${user}/${m.aNotePath()}`), null)
  assert.equal(spaceOf(`SPACES/${m.aSpaceFolder()}`), null)
  // Under people/, only what can be a username (literals: the names are the case).
  for (const name of ['..', '.x', 'x', 'a b', '__proto__', 'Constructor']) assert.equal(spaceOf(`people/${name}/n.md`), null, name)
  // Under spaces/, only a folder with an id after the last hyphen. (A readable
  // part may end in six letters after a hyphen: `_` keeps this one from it.)
  const readable = `${readablePart(m.aSpaceName())}_`
  for (const name of [readable, `${readable}-`, `-${newSpaceId()}`, `${readable}-${newSpaceId().toUpperCase()}x`, `${readable}-abc12`, `${readable}-abc1234`, `.${readable}-${newSpaceId()}`]) {
    assert.equal(spaceOf(`spaces/${name}/n.md`), null, name)
  }
  assert.equal(placement(`people/${user}`), 'inside')
  assert.equal(placement(`people/${user}/${m.aFolder()}`), 'inside')
})

test('spaces: paths in NFD are read in NFC', () => {
  // Literal: the accent is the case (a disk that gives names decomposed).
  const owner = 'José'
  const path = `people/${owner}/Canción.md`.normalize('NFD')
  const s = parseSpacePath(path)!
  assert.equal(s.space.root, 'people/José'.normalize('NFC'))
  assert.equal(s.inner, 'Canción.md'.normalize('NFC'))
})

test('spaces: usernames, as folders', () => {
  assert.ok(isValidUsername(m.aUsername()))
  // Literals: each is the case under test.
  for (const bad of ['..', '...', '.ana', 'a', 'a/b', 'a b', '__proto__', 'toString', 'Prototype', 'José'.normalize('NFD')]) assert.ok(!isValidUsername(bad), bad)
  for (const good of ['ana.', 'a.na', 'José', '_x', 'x-']) assert.ok(isValidUsername(good), good)
  // Uniqueness under full case folding, as links.
  assert.equal(nameKey('Straße'), nameKey('STRASSE'))
})

test('spaces: a shared space name', () => {
  assert.equal(spaceNameProblem(m.aSpaceName()), null)
  assert.equal(spaceNameProblem(''), 'empty')
  assert.equal(spaceNameProblem(` ${m.aSpaceName()}`), 'spaces_around')
  assert.equal(spaceNameProblem(`${m.aSpaceName()}\n`), 'control_characters')
  assert.equal(spaceNameProblem('x'.repeat(SPACE_NAME_MAX)), null)
  assert.equal(spaceNameProblem('x'.repeat(SPACE_NAME_MAX + 1)), 'too_long')
  // Characters, not UTF-16 units.
  assert.equal(spaceNameProblem('😀'.repeat(SPACE_NAME_MAX)), null)
})

test('spaces: the readable part of a new space', () => {
  // Literals: the transformation is the case.
  assert.equal(readablePart('Casa'), 'casa')
  assert.equal(readablePart('Lista de la Compra!'), 'lista-de-la-compra')
  assert.equal(readablePart('Ñandú   & Pingüino'), 'nandu-pinguino')
  assert.equal(readablePart('--Año 2026--'), 'ano-2026')
  assert.equal(readablePart('家族'), '家族')
  assert.equal(readablePart('!!!'), 'space')
  assert.equal(readablePart('.hidden'), 'hidden')
  assert.equal([...readablePart('palabra '.repeat(20))].length <= 40, true)
  assert.ok(!readablePart('palabra '.repeat(20)).endsWith('-'))
  // Always a valid folder of a space, whatever the name.
  for (let i = 0; i < 50; i++) {
    const folder = newSpaceFolder(m.aSpaceName() + m.pick(['', '?', ' / ', '..', ':']), () => false)
    assert.ok(parseSpaceFolder(folder), folder)
    assert.ok(isSpaceRoot(`spaces/${folder}`), folder)
  }
})

test('spaces: ids', () => {
  for (let i = 0; i < 100; i++) assert.match(newSpaceId(), SPACE_ID)
  assert.equal(newSpaceId(new Uint8Array([0, 1, 25, 26, 35, 36])), 'abz09a')
  // A new folder never takes an id already in use.
  const used = new Set<string>()
  const ids = ['aaaaaa', 'aaaaaa', 'bbbbbb']
  const name = m.aSpaceName()
  used.add('aaaaaa')
  assert.equal(newSpaceFolder(name, (id) => used.has(id), () => ids.shift()!), `${readablePart(name)}-bbbbbb`)
  assert.throws(() => newSpaceFolder(name, () => false, () => 'NOTANID'))
  assert.throws(() => newSpaceFolder(name, () => true))
})

test('spaces: a folder name as readable part and id', () => {
  // Literals: the hyphens are the case.
  assert.deepEqual(parseSpaceFolder('casa-7k2q9x'), { readable: 'casa', id: '7k2q9x' })
  assert.deepEqual(parseSpaceFolder('lista-de-la-compra-000000'), { readable: 'lista-de-la-compra', id: '000000' })
  assert.deepEqual(parseSpaceFolder('Casa Grande-abcdef'), { readable: 'Casa Grande', id: 'abcdef' })
  for (const bad of ['casa', 'casa-', '-7k2q9x', 'casa-7K2Q9X', 'casa-7k2q9', ' casa-7k2q9x', '.casa-7k2q9x']) assert.equal(parseSpaceFolder(bad), null, bad)
})

test('spaces: the reserved settings folder, at the root of every space (D-056.16, .28)', () => {
  const owner = m.aUsername()
  const space = `spaces/${m.aSpaceFolder()}`
  assert.equal(settingsFolder(owner), `people/${owner}/.vihko`)
  assert.ok(isReserved(settingsFolder(owner)))
  assert.ok(isReserved(`${settingsFolder(owner)}/${m.aNotePath()}`))
  assert.ok(isReserved(`${space}/.vihko`))
  assert.ok(isReserved(`${space}/.vihko/${m.aNotePath()}`))
  // In any case: a case-insensitive disk makes them one folder.
  assert.ok(isReserved(`${space}/.VIHKO`))
  assert.ok(!isReserved(`people/${owner}/${m.aNotePath()}`))
  assert.ok(!isReserved(`people/${owner}/.vihkox`))
  // Only at a space's root: deeper, it is a hidden folder like any other.
  assert.ok(!isReserved(`${space}/${m.aFolder()}/.vihko`))
  assert.ok(!isReserved('.vihko'))
})

test('spaces: how each person sees a path', () => {
  const me = m.aUsername()
  const other = m.aUsername()
  const folder = m.aFolder()
  const title = m.aTitle()
  assert.deepEqual(displayPath(`people/${me}/${folder}/${title}.md`, me), { space: { kind: 'mine', root: `people/${me}` }, folders: [folder], name: title })
  assert.deepEqual(displayPath(`people/${other}/${folder}/${title}.md`, me), { space: { kind: 'person', root: `people/${other}`, owner: other }, folders: [folder], name: title })
  const name = m.aSpaceName()
  const sf = m.aSpaceFolder(name)
  const { id, readable } = parseSpaceFolder(sf)!
  const root = `spaces/${sf}`
  assert.deepEqual(displayPath(`${root}/${title}.md`, me, (r) => (r === root ? name : null)), { space: { kind: 'shared', root, id, name }, folders: [], name: title })
  // Without a name, the readable part.
  assert.equal((displayPath(`${root}/${title}.md`, me)!.space as { name: string }).name, readable)
  // A root, and a file that isn't a note.
  assert.deepEqual(displayPath(root, me, () => name), { space: { kind: 'shared', root, id, name }, folders: [], name: '' })
  assert.equal(displayPath(`people/${me}/${folder}/${title}.png`, me)!.name, `${title}.png`)
  assert.equal(displayPath(m.aNotePath(), me), null)
})
