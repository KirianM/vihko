import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PEOPLE, PERSONAL_ADDRESS, SETTINGS_FOLDER, SPACES, SPACE_NAME_MAX, addressOf, displayPath, isReserved, isSpaceFolderName, isSpaceRoot, isValidUsername,
  legacySpaceFolder, nameKey, parseSpacePath, pathOfAddress, personalRoot, placement, readablePart, settingsFolder, sharedRoot, spaceNameProblem, spaceOf, spaceRootOf,
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

test('spaces: a path in a shared space, whose folder is its name', () => {
  const name = m.aSpaceName()
  const inner = m.aNotePath(m.aFolder())
  assert.deepEqual(parseSpacePath(`${sharedRoot(name)}/${inner}`), { space: { kind: 'shared', root: `spaces/${name}`, folder: name, name }, inner })
  assert.ok(isSpaceRoot(`spaces/${name}`))
  assert.equal(spaceOf(`spaces/${name}`)?.kind, 'shared')
  // A folder of 0.1.0-rc.1 or rc.2 is a space too, by that name, until vihko renames it.
  const legacy = m.aLegacySpaceFolder()
  assert.deepEqual(spaceOf(`spaces/${legacy}`), { kind: 'shared', root: `spaces/${legacy}`, folder: legacy, name: legacy })
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
  // Under spaces/, only a name a space's folder can have (literals: each is the case).
  const word = m.aWord()
  for (const name of [`.${word}`, `~${word}`, `${word}.`, `${word}~`, `${word}.md`, `${word}.MD`, 'people', 'Spaces', '..']) {
    assert.equal(spaceOf(`spaces/${name}/n.md`), null, name)
    assert.ok(!isSpaceFolderName(name), name)
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
  const shared = spaceOf('spaces/Música'.normalize('NFD'))!
  assert.equal(shared.kind === 'shared' && shared.name, 'Música'.normalize('NFC'))
})

test('spaces: usernames, as folders', () => {
  assert.ok(isValidUsername(m.aUsername()))
  // Literals: each is the case under test.
  for (const bad of ['..', '...', '.ana', 'a', 'a/b', 'a b', '__proto__', 'toString', 'Prototype', 'José'.normalize('NFD')]) assert.ok(!isValidUsername(bad), bad)
  for (const good of ['ana.', 'a.na', 'José', '_x', 'x-']) assert.ok(isValidUsername(good), good)
  // Uniqueness under full case folding, as links.
  assert.equal(nameKey('Straße'), nameKey('STRASSE'))
  assert.equal(nameKey('Música'.normalize('NFD')), nameKey('MÚSICA'))
})

test('spaces: a shared space name, which is its folder', () => {
  assert.equal(spaceNameProblem(m.aSpaceName()), null)
  assert.equal(spaceNameProblem(''), 'empty')
  assert.equal(spaceNameProblem(` ${m.aSpaceName()}`), 'spaces_around')
  assert.equal(spaceNameProblem(`${m.aSpaceName()}\n`), 'control_characters')
  assert.equal(spaceNameProblem('x'.repeat(SPACE_NAME_MAX)), null)
  assert.equal(spaceNameProblem('x'.repeat(SPACE_NAME_MAX + 1)), 'too_long')
  // Characters, not UTF-16 units.
  assert.equal(spaceNameProblem('😀'.repeat(SPACE_NAME_MAX)), null)
  // What no folder's name can hold, and names the notes folder can't give a space (literals: each is the case).
  const name = m.aSpaceName()
  for (const bad of [`${name}/${m.aWord()}`, `${name}\\${m.aWord()}`]) assert.equal(spaceNameProblem(bad), 'invalid_characters', bad)
  for (const bad of [`.${name}`, `~${name}`, `${name}.`, `${name}~`, `${name}.md`, 'people', 'SPACES']) assert.equal(spaceNameProblem(bad), 'invalid_name', bad)
  // What a space's name may have that a username can't.
  for (const good of [`${name} & ${m.aWord()}`, `${name}: ${m.aWord()}?`, `${name} (${m.aWord()})`, '家族', `${name}.md.bak`, `${name}-7k2q9x`]) assert.equal(spaceNameProblem(good), null, good)
})

test('spaces: the folders of 0.1.0-rc.1 and rc.2', () => {
  // Literals: the hyphens and the transformation are the case.
  assert.deepEqual(legacySpaceFolder('casa-7k2q9x'), { readable: 'casa', id: '7k2q9x' })
  assert.deepEqual(legacySpaceFolder('lista-de-la-compra-000000'), { readable: 'lista-de-la-compra', id: '000000' })
  for (const bad of ['casa', 'casa-', '-7k2q9x', 'casa-7K2Q9X', 'casa-7k2q9', ' casa-7k2q9x', '.casa-7k2q9x']) assert.equal(legacySpaceFolder(bad), null, bad)
  assert.equal(readablePart('Lista de la Compra!'), 'lista-de-la-compra')
  assert.equal(readablePart('Ñandú   & Pingüino'), 'nandu-pinguino')
  assert.equal(readablePart('!!!'), 'space')
  const legacy = m.aLegacySpaceFolder()
  assert.ok(legacySpaceFolder(legacy), legacy)
})

test('spaces: the reserved settings folder, at the root of every space', () => {
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
  const root = `spaces/${name}`
  assert.deepEqual(displayPath(`${root}/${title}.md`, me), { space: { kind: 'shared', root, name }, folders: [], name: title })
  // A root, and a file that isn't a note.
  assert.deepEqual(displayPath(root, me), { space: { kind: 'shared', root, name }, folders: [], name: '' })
  assert.equal(displayPath(`people/${me}/${folder}/${title}.png`, me)!.name, `${title}.png`)
  assert.equal(displayPath(m.aNotePath(), me), null)
})

test('spaces: a note’s address in the browser never shows the product’s folders, and reads back', () => {
  const owner = m.aUsername()
  const name = m.aSpaceName()
  const inner = m.aNotePath(m.aFolderPath(2))
  const mine = `${personalRoot(owner)}/${inner}`
  const shared = `${sharedRoot(name)}/${inner}`
  assert.equal(addressOf(mine), `${PERSONAL_ADDRESS}${owner}/${inner}`)
  assert.equal(addressOf(shared), `${name}/${inner}`)
  for (const path of [mine, shared]) {
    const address = addressOf(path)!
    assert.ok(!address.startsWith(`${PEOPLE}/`) && !address.startsWith(`${SPACES}/`), address)
    assert.deepEqual(pathOfAddress(address), { path, legacy: false })
    // The old form of the address, the real path, is still read, and said to be old.
    assert.deepEqual(pathOfAddress(path), { path, legacy: true })
  }
  assert.equal(addressOf(personalRoot(owner)), `${PERSONAL_ADDRESS}${owner}`)
  assert.equal(addressOf(sharedRoot(name)), name)
  // In no space, no address; and what names no space reads as nothing.
  assert.equal(addressOf(inner), null)
  for (const address of ['', `${PEOPLE}/`, `${SPACES}/.${m.aWord()}/${inner}`, `${PERSONAL_ADDRESS}/${inner}`, `${PERSONAL_ADDRESS}..`, `.${m.aWord()}/${inner}`]) {
    assert.equal(pathOfAddress(address), null, address)
  }
})
