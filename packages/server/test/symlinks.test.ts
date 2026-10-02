// Symbolic links in the notes folder are never followed. Anyone (or anything:
// a sync tool) able to put a file in a folder could otherwise make a member
// read, index, version or write what lies behind the link: another person's
// personal space, vihko.yaml, or any file of the server outside the notes
// folder. For vihko a link isn't there, as its walks already said.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { contentHash } from '@vihko/core'
import { PNG, setup } from './_agents.ts'
import { SHARED, inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A word only the file outside the notes folder has, and one only the admin's diary has. */
const SECRET = m.aUniqueWord()
const DIARY_WORD = m.aUniqueWord()
/** The admin's diary, in their personal space: the member can't read it. */
const DIARY_TITLE = m.aTitle()
const DIARY_DIR = m.aFolder()
const diaryOf = (admin: string) => `people/${admin}/${DIARY_DIR}/${DIARY_TITLE}.md`
/** The links the member can reach, in the shared space (which they edit). */
const LINK = {
  outsideNote: inShared(`${m.aTitle()}.md`),
  diary: inShared(`${m.aTitle()}.md`),
  outsideDir: inShared(m.aFolder()),
  config: inShared(`${m.aTitle()}.png`),
  outsideImage: inShared(`${m.aTitle()}.png`),
}

async function withLinks() {
  const s = await setup({ files: (n) => ({ [diaryOf(n.admin)]: `# ${m.aHeading()}\n\n${DIARY_WORD}\n`, [inShared(`${m.aTitle()}.md`)]: `# ${m.aHeading()}\n` }) })
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.md'), `# ${m.aHeading()}\n\n${m.aSentence()} ${SECRET}.\n`)
  writeFileSync(join(outside, 'secret.png'), PNG)
  const at = (p: string) => join(s.notesDir, p)
  /** A relative link from the shared space's root to `target` (from the notes root). */
  const fromShared = (target: string) => posix.relative(SHARED, target)
  symlinkSync(join(outside, 'secret.md'), at(LINK.outsideNote))
  symlinkSync(fromShared(diaryOf(s.users.admin.username)), at(LINK.diary))
  symlinkSync(outside, at(LINK.outsideDir))
  symlinkSync(fromShared('vihko.yaml'), at(LINK.config))
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
    const r = await s.member('GET', s.url('/api/note', { path }))
    assert.equal(r.status, 404, path)
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(DIARY_WORD), path)
  }
})

test('a file reached through a symbolic link is not served', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  for (const path of [LINK.config, LINK.outsideImage, `${LINK.outsideDir}/secret.png`]) {
    const r = await s.member('GET', s.url('/api/file', { path }))
    assert.equal(r.status, 404, path)
    assert.ok(!r.text.includes('permissions'), path)
  }
})

test('what a symbolic link leads to is in no index, tree or search', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  const tree = await s.member('GET', '/api/tree')
  assert.equal(tree.status, 200)
  for (const path of s.reported) assert.ok(!tree.text.includes(path.slice(SHARED.length + 1)), path)
  for (const word of [SECRET, DIARY_WORD]) {
    const r = await s.member('GET', s.url('/api/search', { q: word }))
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

test('a person\'s settings are never read or written through a symbolic link', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  // Their own `.vihko` leads outside, where a settings file names a series.
  const label = m.aWord()
  writeFileSync(join(s.outside, 'settings.yaml'), `daily:\n  ${m.anId()}:\n    label: ${JSON.stringify(label)}\n    folder: diary\n    name: "{YYYY}-{MM}-{DD}"\n`)
  mkdirSync(join(s.notesDir, `people/${s.users.member.username}`), { recursive: true })
  symlinkSync(s.outside, join(s.notesDir, `people/${s.users.member.username}/.vihko`))
  const read = await s.member('GET', '/api/settings')
  assert.equal(read.status, 200)
  assert.ok(!JSON.stringify(read.body).includes(label), 'what is behind the link is not read')
  const written = await s.member('PUT', '/api/settings', { settings: { version: 1, daily: [], attachments: null, agents: null }, ifMatch: read.body.etag })
  assert.equal(written.status, 400, JSON.stringify(written.body))
  assert.equal(written.body.error, 'invalid_path')
  assert.deepEqual(readdirSync(s.outside).sort(), ['secret.md', 'secret.png', 'settings.yaml'])
  assert.ok(readFileSync(join(s.outside, 'settings.yaml'), 'utf8').includes(label), 'nothing written there')
})

test('nothing is written through a symbolic link', async (t) => {
  const s = await withLinks()
  t.after(() => s.close())
  const note = `${LINK.outsideDir}/${m.aTitle()}.md`
  const created = await s.member('POST', '/api/note', { path: note, text: `${m.aSentence()}\n` })
  assert.equal(created.status, 404)
  const folder = await s.member('POST', '/api/folder', { path: `${LINK.outsideDir}/${m.aFolder()}` })
  assert.equal(folder.status, 404)
  // Even knowing what is behind it.
  const behind = readFileSync(join(s.outside, 'secret.md'), 'utf8')
  const replaced = await s.member('PUT', s.url('/api/note', { path: LINK.outsideNote }), { text: `${m.aSentence()}\n` }, { 'if-match': `"${contentHash(behind)}"` })
  assert.equal(replaced.status, 404)
  assert.deepEqual(readdirSync(s.outside).sort(), ['secret.md', 'secret.png'])
  assert.equal(readFileSync(join(s.outside, 'secret.md'), 'utf8'), behind)
  assert.ok(lstatSync(join(s.notesDir, LINK.outsideNote)).isSymbolicLink())
})
