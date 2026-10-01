// Who may purge a note's history, as the UI tells it (levels.ts): `manage`
// effective on the note's folder, given there or inherited from above, as the
// server's `canManage` judges it; a folder the UI hasn't listed (made since)
// takes the nearest one above.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { managesFolder, noteFolder } from '../src/levels.ts'
import type { Level } from '../src/api.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('manage given on the folder, or on one above it, counts; a lower level anywhere does not', () => {
  const root = `people/${m.aUsername()}`
  const [a, b, c] = [m.aFolder(), m.aFolder(), m.aFolder()]
  const levels = new Map<string, Level>([[root, 'manage'], [`${root}/${a}`, 'manage'], [`spaces/${m.aSpaceFolder()}`, 'edit']])
  const levelOf = (f: string) => levels.get(f)
  // Inherited: listed below with its own (effective) level, or not listed at all (a folder made since).
  assert.ok(managesFolder(levelOf, `${root}/${a}/${b}`))
  assert.ok(managesFolder(levelOf, `${root}/${b}/${c}`))
  assert.ok(managesFolder(levelOf, noteFolder(`${root}/${m.aTitle()}.md`)))
  // Only editing: never.
  const space = [...levels.keys()][2]!
  assert.ok(!managesFolder(levelOf, space))
  assert.ok(!managesFolder(levelOf, `${space}/${a}`))
  // A folder shared with them to manage, inside someone else's space: below it yes, beside it no.
  const theirs = `people/${m.aUsername()}`
  levels.set(theirs, 'read')
  levels.set(`${theirs}/${a}`, 'manage')
  assert.ok(managesFolder(levelOf, `${theirs}/${a}/${b}`))
  assert.ok(!managesFolder(levelOf, `${theirs}/${b}`))
  assert.ok(!managesFolder(levelOf, theirs))
})
