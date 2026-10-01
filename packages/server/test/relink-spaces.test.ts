// Links when a note changes space or is renamed: a
// link never leads to another space, so a move rewrites nothing across
// spaces. The moved note's links stay as written and resolve in its new
// space (or are broken there); links left behind that led to it are broken;
// both are reported as shifts (`breaks`) for the preview to list. Inside a
// space a rename keeps every link on its note, as ever, and in a table the
// bar stays `\|`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkIndex, extract } from '@vihko/core'
import { applyReplacements, planLinks, planRelinks } from '@vihko/server'
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

/** The codes of the links a move leaves as they are but whose destination changes, and where each led. */
function shifts(text: string, src: string, srcAfter: string, ix: ReturnType<typeof indexes>) {
  return planLinks(text, src, srcAfter, ix.before, ix.after, ix.map).shifts.map((s) => [s.code, s.before.status === 'resolved' ? s.before.path : null])
}

test('a note taken to a shared space: nothing in it is rewritten; its links to the space it left are broken there, and said', () => {
  const s = scene()
  const to = `${s.shared}/${s.name}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const md = `[${m.aWord()}](${encodeURI(s.plan)}.md)`
  const text = `[[${s.plan}]] and [[${s.plan}#${s.heading}]], ![[${s.plan}]], [[${s.plan}|${m.aWord()}]], ${md} and [[#${s.heading}]].\n`
  assert.equal(relinked(text, s.note, to, ix), text)
  // Each was leading to the plan, in the space it left: now broken (the heading of the note itself still works).
  assert.deepEqual(leads(ix.after, to, text), [null, null, null, null, null, to])
  assert.deepEqual(shifts(text, s.note, to, ix), Array.from({ length: 5 }, () => ['breaks', s.planPath]))
})

test('links to a note that changed space: never rewritten, from its old space or any other; broken where they were, resolved by name where it went', () => {
  const s = scene()
  const to = `${s.shared}/${s.name}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const oldRoot = s.note.slice(0, -3)
  const byName = `[[${s.name}]] [[${s.name}|${m.aSentence(2)}]]\n`
  // In its old space: left as written, and broken.
  assert.equal(relinked(byName, s.inMine, s.inMine, ix), byName)
  assert.deepEqual(shifts(byName, s.inMine, s.inMine, ix), [['breaks', s.note], ['breaks', s.note]])
  // From a third space it never led anywhere (a link never leaves its space), and still doesn't.
  const fromRoot = `[[${oldRoot}]] [[${to.slice(0, -3)}]]\n`
  assert.equal(relinked(fromRoot, s.inTheirs, s.inTheirs, ix), fromRoot)
  assert.deepEqual(leads(ix.after, s.inTheirs, fromRoot), [null, null])
  assert.deepEqual(shifts(fromRoot, s.inTheirs, s.inTheirs, ix), [])
  // In the space it went to, a name that was broken now leads to it.
  assert.deepEqual(leads(ix.after, s.inShared, byName), [to, to])
  assert.deepEqual(shifts(byName, s.inShared, s.inShared, ix), [['resolves', null], ['resolves', null]])
})

test('renaming a note: links in its space follow it, by name or path; a link from another space stays as it is, broken as before', () => {
  const s = scene()
  const newName = m.aTitle()
  const to = `${s.mine}/${newName}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const oldRoot = s.note.slice(0, -3)
  const custom = m.aSentence(2)
  const text = `[[${s.name}]], [[${s.name}#${s.heading}|${custom}]], [[${oldRoot}]]\n`
  const out = relinked(text, s.inMine, s.inMine, ix)
  assert.equal(out, `[[${newName}]], [[${newName}#${s.heading}|${custom}]], [[${newName}]]\n`)
  assert.deepEqual(leads(ix.after, s.inMine, out), [to, to, to])
  const elsewhere = `[[${oldRoot}|${s.name}]]\n`
  assert.equal(relinked(elsewhere, s.inShared, s.inShared, ix), elsewhere)
})

test('in a table, a link rewritten inside its space keeps its visible text after `\\|`, which vihko and Obsidian read as the bar', () => {
  const s = scene()
  const newName = m.aTitle()
  const to = `${s.mine}/${m.aFolder()}/${newName}.md`
  const ix = indexes(s.notes, s.note, to, s.heading)
  const custom = m.aWord()
  const out = relinked(`| a | b |\n| --- | --- |\n| [[${s.name}\\|${custom}]] | x |\n`, s.inMine, s.inMine, ix)
  assert.equal(out, `| a | b |\n| --- | --- |\n| [[${newName}\\|${custom}]] | x |\n`)
  assert.deepEqual(extract(out).links.map((l) => [l.target, l.display]), [[newName, custom]])
  assert.deepEqual(leads(ix.after, s.inMine, out), [to])
})
