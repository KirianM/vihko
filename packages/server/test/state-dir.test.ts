// The state folder holds state.db, the history of every note, the trash and
// the recovery logs: other users of the host can't get into it, whether vihko
// creates it or finds it made by someone else (`mkdir state`, usually 0755).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareStateDir } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const modeOf = (path: string) => statSync(path).mode & 0o777

test('state folder: created closed to other users', () => {
  const dir = join(tempDir('vihko-state-dir-'), m.aFolder(), m.aFolder())
  const said: string[] = []
  prepareStateDir(dir, (msg) => said.push(msg))
  assert.ok(statSync(dir).isDirectory())
  assert.equal(modeOf(dir), 0o700)
  assert.equal(said.length, 0, said.join('\n'))
})

test('state folder: one made open by someone else is closed, and what is in it stays as it was', () => {
  const dir = join(tempDir('vihko-state-dir-'), m.aFolder())
  mkdirSync(dir)
  chmodSync(dir, 0o775)
  const file = join(dir, `${m.aWord()}.db`)
  const content = m.aSentence()
  writeFileSync(file, content)
  chmodSync(file, 0o644)
  const said: string[] = []
  prepareStateDir(dir, (msg) => said.push(msg))
  assert.equal(modeOf(dir), 0o700)
  assert.equal(modeOf(file), 0o644, 'the files keep their mode: the folder is what closes them')
  assert.equal(readFileSync(file, 'utf8'), content)
  assert.equal(said.length, 0, said.join('\n'))
  prepareStateDir(dir, (msg) => said.push(msg))
  assert.equal(modeOf(dir), 0o700, 'already closed: left alone')
  assert.equal(said.length, 0, said.join('\n'))
})
