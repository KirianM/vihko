// Links rewritten when a note changes space or is renamed (D-056, spec §4.4):
// a move never changes where a link leads; across spaces vihko writes the
// path from the notes root with the note's name as visible text (so that
// Obsidian and other editors show the name), keeps that text in step with
// renames, drops it when the link comes back inside the space, and in a
// table writes the bar as `\|`, which both vihko and Obsidian read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkIndex, extract } from '@vihko/core'
import { applyReplacements, planRelinks } from '@vihko/server'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A person's space, a shared one and someone else's; a note to move and one it links to, a note in each space. */
function scene() {
  const mine = `people/${m.aUsername()}`
  const theirs = `people/${m.aUsername()}`
  const shared = `spaces/${m.aSpaceFolder()}`
  const name = m.aTitle()
  const plan = m.aTitle()
  const note = `${mine}/${name}.md`
  const planPath = `${mine}/${plan}.md`
  const inMine = `${mine}/${m.aFolder()}/${m.aTitle()}.md`
  const inShared = `${shared}/${m.aTitle()}.md`
  const inTheirs = `${theirs}/${m.aTitle()}.md`
  const heading = m.aHeading()
  const notes = [note, planPath, inMine, inShared, inTheirs]
  return { mine, theirs, shared, name, plan, note, planPath, inMine, inShared, inTheirs, heading, notes }
}

/** The link index before and after `from` becomes `to`. */
function indexes(notes: string[], from: string, to: string, heading: string) {
  const before = new LinkIndex()
  const after = new LinkIndex()
  for (const p of notes) {
    before.set({ path: p, headings: [heading] })
    after.set({ path: p === from ? to : p, headings: [heading] })
  }
  return { before, after, map: (p: string) => (p === from ? to : p) }
}

/** `text` as the move leaves it in `src` (the moved note: `srcAfter` its new path). */
function relinked(text: string, src: string, srcAfter: string, ix: ReturnType<typeof indexes>): string {
  return applyReplacements(text, planRelinks(text, src, srcAfter, ix.before, ix.after, ix.map))
}

/** Where every link of `text` leads from `src`. */
function leads(index: LinkIndex, src: string, text: string): (string | null)[] {
  return extract(text).links.map((l) => {
    const r = index.resolve(src, l)
    return r.status === 'resolved' ? r.path : null
  })
}

test('a note taken to a shared space: its links by name to its old space become paths from the root, with the name shown', () => {
  const s = scene()
  const to = `${s.shared}/${s.name}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const text = `[[${s.plan}]] and [[${s.plan}#${s.heading}]], ![[${s.plan}]], [[${s.plan}|${m.aWord()}]] and [[#${s.heading}]].\n`
  const out = relinked(text, s.note, to, ix)
  const root = s.planPath.slice(0, -3)
  const custom = extract(text).links[3]!.display
  assert.equal(out, `[[${root}|${s.plan}]] and [[${root}#${s.heading}|${s.plan}]], ![[${root}]], [[${root}|${custom}]] and [[#${s.heading}]].\n`)
  assert.deepEqual(leads(ix.after, to, out), [s.planPath, s.planPath, s.planPath, s.planPath, to])
  assert.ok(!out.includes('[[/'), 'never a leading slash: Obsidian does not read it')
})

test('links to a note that changed space: from its old space and from others, the new root path; from its new space, the name again', () => {
  const s = scene()
  const to = `${s.shared}/${s.name}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const oldRoot = s.note.slice(0, -3)
  const newRoot = to.slice(0, -3)
  const custom = m.aSentence(2)
  assert.equal(relinked(`[[${s.name}]]\n`, s.inMine, s.inMine, ix), `[[${newRoot}|${s.name}]]\n`)
  assert.equal(relinked(`[[${oldRoot}|${s.name}]] [[${oldRoot}|${custom}]]\n`, s.inTheirs, s.inTheirs, ix), `[[${newRoot}|${s.name}]] [[${newRoot}|${custom}]]\n`)
  // Back inside its space: the text vihko wrote says nothing the name doesn't.
  assert.equal(relinked(`[[${oldRoot}|${s.name}]] [[${oldRoot}|${custom}]]\n`, s.inShared, s.inShared, ix), `[[${s.name}]] [[${s.name}|${custom}]]\n`)
})

test('renaming a note another space links to: the path and the name vihko wrote as its text follow it; any other text stays', () => {
  const s = scene()
  const newName = m.aTitle()
  const to = `${s.mine}/${newName}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const oldRoot = s.note.slice(0, -3)
  const custom = m.aSentence(2)
  const text = `[[${oldRoot}|${s.name}]], [[${oldRoot}#${s.heading}|${s.name}]], [[${oldRoot}|${custom}]], [[${oldRoot}]]\n`
  const out = relinked(text, s.inShared, s.inShared, ix)
  const root = to.slice(0, -3)
  assert.equal(out, `[[${root}|${newName}]], [[${root}#${s.heading}|${newName}]], [[${root}|${custom}]], [[${root}|${newName}]]\n`)
  assert.deepEqual(leads(ix.after, s.inShared, out), [to, to, to, to])
  // Inside its own space, by name as before.
  assert.equal(relinked(`[[${s.name}]]\n`, s.inMine, s.inMine, ix), `[[${newName}]]\n`)
})

test('in a table, the visible text is written after `\\|`, which vihko and Obsidian read as the bar', () => {
  const s = scene()
  const to = `${s.shared}/${s.name}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const newRoot = to.slice(0, -3)
  const oldRoot = s.note.slice(0, -3)
  const text = `| a | b |\n| --- | --- |\n| [[${s.name}]] | [[${oldRoot}\\|${s.name}]] |\n`
  const fromMine = relinked(`| a | b |\n| --- | --- |\n| [[${s.name}]] | x |\n`, s.inMine, s.inMine, ix)
  assert.equal(fromMine, `| a | b |\n| --- | --- |\n| [[${newRoot}\\|${s.name}]] | x |\n`)
  assert.deepEqual(leads(ix.after, s.inMine, fromMine), [to])
  const fromTheirs = relinked(text.replace(`[[${s.name}]]`, 'x'), s.inTheirs, s.inTheirs, ix)
  assert.equal(fromTheirs, `| a | b |\n| --- | --- |\n| x | [[${newRoot}\\|${s.name}]] |\n`)
  assert.deepEqual(extract(fromTheirs).links.map((l) => [l.target, l.display]), [[newRoot, s.name]])
})
