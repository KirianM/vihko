// Symbolic links in the notes folder are never followed. Anyone (or anything:
// a sync tool) able to put a file in a folder could otherwise make a member
// read, index, version or write what lies behind the link: another person's
// private folder, vihko.yaml, or any file of the server outside the notes
// folder. For vihko a link isn't there, as its walks already said.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from '@vihko/core'
import { DIR, FILES, PATH, PNG, WORD, setup } from './_m4.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A word only the file outside the notes folder has. */
const SECRET = m.aUniqueWord()
/** The links a member of the group can reach, in the shared folder. */
const LINK = {
  outsideNote: `${DIR.shared}/${m.aTitle()}.md`,
  diary: `${DIR.shared}/${m.aTitle()}.md`,
  outsideDir: `${DIR.shared}/${m.aFolder()}`,
  config: `${DIR.shared}/${m.aTitle()}.png`,
  outsideImage: `${DIR.shared}/${m.aTitle()}.png`,
}

async function withLinks() {
  const s = await setup({ files: FILES })
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.md'), `# ${m.aHeading()}\n\n${m.aSentence()} ${SECRET}.\n`)
  writeFileSync(join(outside, 'secret.png'), PNG)
  const at = (p: string) => join(s.notesDir, p)
  symlinkSync(join(outside, 'secret.md'), at(LINK.outsideNote))
  symlinkSync(`../${PATH.diary}`, at(LINK.diary))
  symlinkSync(outside, at(LINK.outsideDir))
  symlinkSync('../vihko.yaml', at(LINK.config))
  symlinkSync(join(outside, 'secret.png'), at(LINK.outsideImage))
  // What a file watcher would report: every link, and what's behind the linked folder.
  const reported = [...Object.values(LINK), `${LINK.outsideDir}/secret.md`, `${LINK.outsideDir}/secret.png`]
  s.indexer.indexPaths(reported, { detectMoves: true })
  s.indexer.indexFolders([LINK.outsideDir])
  await s.history.recorder.observePaths(reported)
  return { ...s, outside, reported }
}

test('a note reached through a symbolic link does not exist, however it is asked for', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  for (const path of [LINK.outsideNote, LINK.diary, `${LINK.outsideDir}/secret.md`]) {
    const r = await s.other('GET', s.url('/api/note', { path }))
    assert.equal(r.status, 404, path)
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(WORD.diary), path)
  }
})

test('a file reached through a symbolic link is not served', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  for (const path of [LINK.config, LINK.outsideImage, `${LINK.outsideDir}/secret.png`]) {
    const r = await s.other('GET', s.url('/api/file', { path }))
    assert.equal(r.status, 404, path)
    assert.ok(!r.text.includes('permissions'), path)
  }
})

test('what a symbolic link leads to is in no index, tree or search', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  const tree = await s.other('GET', '/api/tree')
  assert.equal(tree.status, 200)
  for (const path of s.reported) assert.ok(!tree.text.includes(path.slice(DIR.shared.length + 1)), path)
  for (const word of [SECRET, WORD.diary]) {
    const r = await s.other('GET', s.url('/api/search', { q: word }))
    assert.deepEqual(r.body.results, [], word)
  }
})

test('nothing behind a symbolic link enters the history', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  await s.settle()
  const { changes } = await s.history.reader().changes({ limit: 200, canRead: () => true })
  const paths = changes.flatMap((c) => c.files.map((f) => f.path))
  for (const path of s.reported) assert.ok(!paths.includes(path), path)
})

test('nothing is written through a symbolic link', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  const note = `${LINK.outsideDir}/${m.aTitle()}.md`
  const created = await s.other('POST', '/api/note', { path: note, text: `${m.aSentence()}\n` })
  assert.equal(created.status, 404)
  const folder = await s.other('POST', '/api/folder', { path: `${LINK.outsideDir}/${m.aFolder()}` })
  assert.equal(folder.status, 404)
  // Even knowing what is behind it.
  const behind = readFileSync(join(s.outside, 'secret.md'), 'utf8')
  const replaced = await s.other('PUT', s.url('/api/note', { path: LINK.outsideNote }), { text: `${m.aSentence()}\n` }, { 'if-match': `"${contentHash(behind)}"` })
  assert.equal(replaced.status, 404)
  assert.deepEqual(readdirSync(s.outside).sort(), ['secret.md', 'secret.png'])
  assert.equal(readFileSync(join(s.outside, 'secret.md'), 'utf8'), behind)
  assert.ok(lstatSync(join(s.notesDir, LINK.outsideNote)).isSymbolicLink())
})
