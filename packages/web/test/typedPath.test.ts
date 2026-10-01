import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignFolder, guessTyped, resolveTyped, typedSegments, type RootNames } from '../src/typedPath.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A person's own space and a shared space they belong to, named as the UI names them. */
function place() {
  const me = m.aUsername()
  const spaceName = m.aSpaceName()
  const folder = m.aSpaceFolder(spaceName)
  const mine = `people/${me}`
  const shared = `spaces/${folder}`
  const roots: RootNames[] = [
    { root: mine, names: ['My notes', 'Mis notas', `~${me}`] },
    { root: shared, names: [spaceName, folder] },
  ]
  return { me, spaceName, folder, mine, shared, roots }
}

/** Every letter's case flipped: what a person types who doesn't remember the capitals. */
const flip = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')

test('segments: split at «/», with or without spaces around it; empty ones dropped', () => {
  const [a, b] = [m.aFolder(), m.aTitle()]
  assert.deepEqual(typedSegments(` ${a} / ${b} `), [a, b])
  assert.deepEqual(typedSegments(`/${a}//${b}/`), [a, b])
  assert.deepEqual(typedSegments(''), [])
})

test('a note typed as it is shown, in any case, with or without .md, finds the note: its space by name, in any language', () => {
  const p = place()
  const folder = m.aFolder()
  const title = m.aTitle()
  const note = `${p.mine}/${folder}/${title}.md`
  const there = `${p.shared}/${m.aTitle()}.md`
  const known = [note, there, `${p.mine}/${folder}`]
  for (const typed of [`My notes / ${folder} / ${title}`, `mis notas/${flip(folder)}/${flip(title)}.md`, `~${p.me}/${folder}/${title}`, `${note.toUpperCase()}`]) {
    assert.deepEqual(resolveTyped(typed, known, p.roots), { status: 'one', path: note }, typed)
  }
  const name = there.slice(p.shared.length + 1, -3)
  assert.deepEqual(resolveTyped(`${flip(p.spaceName)} / ${name}`, known, p.roots), { status: 'one', path: there })
  assert.deepEqual(resolveTyped(`${p.folder}/${name}`, known, p.roots), { status: 'one', path: there }, 'by the folder the address shows')
  assert.deepEqual(resolveTyped(`My notes/${flip(folder)}`, known, p.roots), { status: 'one', path: `${p.mine}/${folder}` }, 'a folder too')
})

test('several that differ only in case: all of them, to choose; nothing else and nothing the person can\'t see', () => {
  const p = place()
  const title = m.aTitle().toLowerCase()
  const lower = `${p.mine}/${title}.md`
  const upper = `${p.mine}/${title.toUpperCase()}.md`
  assert.notEqual(lower, upper)
  assert.deepEqual(resolveTyped(`My notes/${title}`, [lower, upper, `${p.shared}/${title}.md`], p.roots), { status: 'several', paths: [upper, lower].sort() })
  // What isn't among what they see (`known`) never answers, however it is typed.
  assert.deepEqual(resolveTyped(`My notes/${title}`, [`${p.shared}/${title}.md`], p.roots), { status: 'none' })
  assert.deepEqual(resolveTyped(`${m.aWord()}/${title}`, [lower], p.roots), { status: 'none' }, 'no space by that name')
})

test('a guess for what nothing matches: the space read from its name, the rest as typed; none when no space or several are named', () => {
  const p = place()
  const title = m.aTitle()
  assert.equal(guessTyped(`My notes / ${title}`, p.roots, { note: true }), `${p.mine}/${title}.md`)
  assert.equal(guessTyped(`${p.spaceName}/${title}.md`, p.roots, { note: true }), `${p.shared}/${title}.md`)
  assert.equal(guessTyped(`${p.spaceName}`, p.roots), p.shared)
  assert.equal(guessTyped(`${m.aWord()}x/${title}`, p.roots), null)
  const twin: RootNames[] = [...p.roots, { root: `spaces/${m.aSpaceFolder(p.spaceName)}`, names: [p.spaceName] }]
  assert.equal(guessTyped(`${p.spaceName}/${title}`, twin), null, 'two spaces with that name: no guess')
  assert.equal(guessTyped(`My notes/../${title}`, p.roots), null)
})

test('a folder typed inside a place takes the spelling of the folders there; the rest is new; several in case are offered whole', () => {
  const a = m.aFolder().toLowerCase()
  const b = m.aFolder()
  const fresh = m.aFolder()
  const known = [a.toUpperCase(), `${a.toUpperCase()}/${b}`]
  assert.deepEqual(alignFolder(`${a}/${flip(b)}`, known), { inner: `${a.toUpperCase()}/${b}` })
  assert.deepEqual(alignFolder(` ${a} / ${fresh} `, known), { inner: `${a.toUpperCase()}/${fresh}` })
  assert.deepEqual(alignFolder(fresh, known), { inner: fresh })
  assert.deepEqual(alignFolder('', known), { inner: '' })
  assert.deepEqual(alignFolder(`${a}/${fresh}`, [...known, a]), { several: [`${a.toUpperCase()}/${fresh}`, `${a}/${fresh}`].sort() })
})
