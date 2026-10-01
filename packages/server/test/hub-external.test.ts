// Changes another program saves to an open note, on a real server:
// they're merged into the live document, which is only a cache of the file.
// A program that undoes its own change (a revert) gets its revert, in the
// editors and on disk; a program that saves a buffer it loaded before vihko
// wrote what was typed (a stale buffer) doesn't erase that typing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Client, type Srv } from './_collab.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/**
 * Longer than the hub's flush debounce (1 s) and its check of open files
 * (1 s): whatever the hub was going to write after a change has been
 * written by then.
 */
const FLUSH_WINDOW = 2500

/** A note of the test's own in the vault copy: a uid, a heading and paragraphs of generated text. */
function aNote(notes: string) {
  const path = m.aNotePath(inShared(m.aFolder()))
  const file = join(notes, path)
  const text = `---\nuid: ${m.faker.string.ulid()}\n---\n# ${m.aHeading()}\n\n${m.aParagraph()}\n\n${m.aParagraph()}\n`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return { path, file, text }
}

/** `text` with a line of its own added before its last paragraph. */
const withLine = (text: string, line: string) => {
  const at = text.lastIndexOf('\n\n') + 2
  return text.slice(0, at) + line + '\n\n' + text.slice(at)
}

/** `text` with `word` added after the first word of its last paragraph. */
const withWord = (text: string, word: string) => {
  const at = text.indexOf(' ', text.lastIndexOf('\n\n') + 2)
  return text.slice(0, at) + ' ' + word + text.slice(at)
}

const disk = (file: string) => readFileSync(file, 'utf8')

/** Waits until no note is open in the hub any more (its recovery logs are gone once each one is unloaded, flushed first). */
const allUnloaded = (srv: Srv) => waitFor(() => readdirSync(join(srv.env.VIHKO_STATE_DIR!, 'collab')).every((f) => !f.endsWith('.ylog')), 'the notes are closed')

/** Saves `text` as another program would, and waits until the open editor has it. */
async function saveOutside(c: Client, file: string, text: string, what: string) {
  writeFileSync(file, text)
  await waitFor(() => c.text() === text, `the editor gets ${what}`)
}

test('another program that undoes its own change: the revert reaches the editor, stays on disk and is never written over', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    // Each case: the texts the program saves one after another, starting from the note's own (A).
    const cases: { name: string; saves: (a: string) => string[] }[] = [
      { name: 'lines A→B→C→B', saves: (a) => { const b = withLine(a, m.aSentence()); return [b, withLine(b, m.aSentence()), b] } },
      { name: 'a line, then back to the original A→B→A', saves: (a) => [withLine(a, m.aSentence()), a] },
      { name: 'words A→B→C→B', saves: (a) => { const b = withWord(a, m.aUniqueWord()); return [b, withWord(b, m.aUniqueWord()), b] } },
      { name: 'a word, then back to the original A→B→A', saves: (a) => [withWord(a, m.aUniqueWord()), a] },
    ]
    for (const { name, saves } of cases) {
      const note = aNote(notes)
      const c = await connect(srv, cookie, note.path)
      const texts = saves(note.text)
      for (const [i, text] of texts.entries()) await saveOutside(c, note.file, text, `${name}: save ${i + 1}`)
      const last = texts.at(-1)!
      await sleep(FLUSH_WINDOW)
      assert.equal(c.text(), last, `${name}: the editor keeps the revert`)
      assert.equal(disk(note.file), last, `${name}: the file keeps the revert`)
      // Closing flushes whatever the hub holds: nothing but the revert.
      c.close()
      await allUnloaded(srv)
      assert.equal(disk(note.file), last, `${name}: closing the note doesn't write the undone text back`)
    }
  } finally { closeAll(); await srv.stop() }
})

test("a program saving the buffer it loaded before vihko wrote what was typed, unchanged: the typing survives and goes back to the file", async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const note = aNote(notes)
    const c = await connect(srv, cookie, note.path)
    const typed = m.aUniqueWord()
    typeLine(c, typed) // the program loaded the file before this was flushed…
    await waitFor(() => disk(note.file).includes(`${typed}\n`), 'flush')
    writeFileSync(note.file, note.text) // …and saves its buffer as it was
    await waitFor(() => disk(note.file).includes(`${typed}\n`), 'vihko writes what was typed back', FLUSH_WINDOW * 2)
    assert.ok(c.text().includes(`${typed}\n`), 'the editor keeps what was typed')
    await sleep(FLUSH_WINDOW)
    assert.equal(disk(note.file), c.text())
  } finally { closeAll(); await srv.stop() }
})

test('a program with a stale buffer that then undoes its own change: the typing survives and the revert wins', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const note = aNote(notes)
    const c = await connect(srv, cookie, note.path)
    const typed = m.aUniqueWord()
    typeLine(c, typed) // the program loaded the file before this was flushed, and never reloads it
    await waitFor(() => disk(note.file).includes(`${typed}\n`), 'flush')
    const [first, second] = [m.aUniqueWord(), m.aUniqueWord()]
    const b = withLine(note.text, first)
    const bc = withLine(b, second)
    writeFileSync(note.file, b) // its buffer: the note as it loaded it, and a line
    await waitFor(() => c.text().includes(first), 'the first save reaches the editor')
    await waitFor(() => disk(note.file).includes(`${typed}\n`) && disk(note.file).includes(first), 'vihko writes both')
    writeFileSync(note.file, bc) // another line
    await waitFor(() => c.text().includes(second), 'the second save reaches the editor')
    await waitFor(() => disk(note.file).includes(`${typed}\n`) && disk(note.file).includes(second), 'vihko writes all three')
    writeFileSync(note.file, b) // and it removes its second line
    await waitFor(() => !c.text().includes(second), 'the revert reaches the editor')
    await sleep(FLUSH_WINDOW)
    for (const t of [c.text(), disk(note.file)]) {
      assert.ok(t.includes(`${typed}\n`), 'what was typed survives')
      assert.ok(t.includes(first), "the program's first line stays")
      assert.ok(!t.includes(second), 'the line it removed stays removed')
    }
    assert.equal(disk(note.file), c.text())
    c.close()
    await allUnloaded(srv)
    assert.ok(!disk(note.file).includes(second), "closing the note doesn't write the removed line back")
  } finally { closeAll(); await srv.stop() }
})
