import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newNote, scopePathFilters } from '../src/newNote.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('a name alone: the note goes in the folder it is created from, titled with that name', () => {
  const folder = m.aFolderPath(m.anInt(0, 2))
  const title = m.aTitle()
  assert.deepEqual(newNote(title, folder), { path: folder ? `${folder}/${title}.md` : `${title}.md`, folder, title })
})

test('a «/» separates folders, from the folder it is created from; the title is the name after the last one', () => {
  const [a, b] = [m.aFolder(), m.aFolder()]
  const title = m.aTitle()
  assert.deepEqual(newNote(`${a}/${title}`, ''), { path: `${a}/${title}.md`, folder: a, title })
  const from = m.aFolderPath(m.anInt(1, 2))
  assert.deepEqual(newNote(`${a}/${b}/${title}`, from), { path: `${from}/${a}/${b}/${title}.md`, folder: `${from}/${a}/${b}`, title })
})

test('a leading «/» starts from the root of the space it is created in', () => {
  const a = m.aFolder()
  const title = m.aTitle()
  const root = `spaces/${m.aSpaceFolder()}`
  const from = `${root}/${m.aFolderPath()}`
  assert.deepEqual(newNote(`/${a}/${title}`, from, root), { path: `${root}/${a}/${title}.md`, folder: `${root}/${a}`, title })
  assert.deepEqual(newNote(` /${title}`, from, root), { path: `${root}/${title}.md`, folder: root, title })
})

// The literals are the cases: what a typed name is cleaned of.
test('each part is cleaned: spaces, control characters, «\\», leading dots, «.md»; empty parts and «..» are left out', () => {
  assert.deepEqual(newNote('  a //  b   c /../ .d/Plan.md  ', ''), { path: 'a/b c/d/Plan.md', folder: 'a/b c/d', title: 'Plan' })
  assert.deepEqual(newNote('x\\y/Na\u0007me', ''), { path: 'x-y/Name.md', folder: 'x-y', title: 'Name' })
  // NFC: a name typed decomposed is the same name.
  assert.deepEqual(newNote('Cafe\u0301', ''), { path: 'Café.md', folder: '', title: 'Café' })
})

test('a path filter typed inside a space searches in the current space; one from the notes root stays as typed', () => {
  const root = `spaces/${m.aSpaceFolder()}`
  const [a, b] = [m.aFolder().replace(/\s/g, '-'), `${m.aWord()} ${m.aWord()}`]
  const word = m.aWord()
  assert.equal(scopePathFilters(`${word} path:${a}/`, root), `${word} path:${root}/${a}/`)
  assert.equal(scopePathFilters(`-path:"${b}/" ${word}`, root), `-path:"${root}/${b}/" ${word}`)
  assert.equal(scopePathFilters(`path:/${a}`, root), `path:${root}/${a}`)
  const other = `people/${m.aUsername()}/${a}`
  assert.equal(scopePathFilters(`path:${other}`, root), `path:${other}`)
  assert.equal(scopePathFilters(`tag:${word}`, root), `tag:${word}`)
})

test('without a name there is nothing to create', () => {
  for (const typed of ['', '   ', '/', `${m.aFolder()}/`, `${m.aFolder()}/  `, '...', '\u0001']) assert.equal(newNote(typed, m.aFolderPath()), null, JSON.stringify(typed))
})
