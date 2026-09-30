// Link resolution with spaces (D-056, spec §4.2): a name resolves only in
// its note's space; a path from the notes root (`people/…`, `spaces/…`),
// a relative Markdown link or `[[/path]]` reach any space; what vihko
// writes to reach a note (shortestTarget, wikiLink) never starts with `/`
// and carries the note's name as visible text when it crosses spaces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkIndex, isRootTarget, linkSpace, shortestTarget, wikiLink, type Resolution } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const wiki = (target: string, anchor: string | null = null) => ({ kind: 'wiki' as const, target, anchor })
const at = (r: Resolution) => (r.status === 'resolved' ? r.path : r.status)

/** Two people's spaces and a shared one, the same name in each, and a note of that name nowhere else. */
function layout() {
  const owner = m.aUsername()
  const other = m.aUsername()
  const shared = `spaces/${m.aSpaceFolder()}`
  const mine = `people/${owner}`
  const theirs = `people/${other}`
  const name = m.aTitle()
  const folder = m.aFolder()
  const notes = {
    mineName: `${mine}/${folder}/${name}.md`,
    sharedName: `${shared}/${name}.md`,
    theirsNote: `${theirs}/${m.aTitle()}.md`,
    mineSource: `${mine}/${m.aTitle()}.md`,
    sharedSource: `${shared}/${m.aFolder()}/${m.aTitle()}.md`,
  }
  const index = new LinkIndex()
  for (const p of Object.values(notes)) index.set({ path: p, headings: [] })
  return { owner, other, shared, mine, theirs, name, folder, notes, index }
}

test('a name resolves only among the notes of its own space', () => {
  const l = layout()
  assert.equal(at(l.index.resolve(l.notes.mineSource, wiki(l.name))), l.notes.mineName)
  assert.equal(at(l.index.resolve(l.notes.sharedSource, wiki(l.name))), l.notes.sharedName)
  // In a third space nothing of that name: broken, though two other spaces have one (nobody probes names).
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki(l.name))), 'missing')
  // Path suffixes too: `folder/name` only in the space that has it.
  assert.equal(at(l.index.resolve(l.notes.mineSource, wiki(`${l.folder}/${l.name}`))), l.notes.mineName)
  assert.equal(at(l.index.resolve(l.notes.sharedSource, wiki(`${l.folder}/${l.name}`))), 'missing')
})

test('a path from the notes root reaches any space, exactly and in any case; so do [[/path]] and relative Markdown', () => {
  const l = layout()
  const root = l.notes.sharedName.slice(0, -3)
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki(root))), l.notes.sharedName)
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki(root.toUpperCase()))), l.notes.sharedName)
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki('/' + root))), l.notes.sharedName)
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki(l.notes.mineName.slice(0, -3)))), l.notes.mineName)
  // Exact: the root path of a folder the note isn't in reaches nothing (no suffix heuristics from the root).
  assert.equal(at(l.index.resolve(l.notes.theirsNote, wiki(`${l.mine}/${l.name}`))), 'missing')
  assert.equal(at(l.index.resolve(l.notes.mineSource, wiki(`${l.mine}/${l.name}`))), 'missing')
  // A relative Markdown link crosses spaces as it is written.
  assert.equal(at(l.index.resolve(`${l.mine}/${l.folder}/x.md`, { kind: 'markdown', target: `../../../${l.notes.sharedName}`, anchor: null })), l.notes.sharedName)
})

test('`people` or `spaces` alone is a name, and only a first segment makes a root path', () => {
  assert.ok(isRootTarget('spaces/x-abc123/n'))
  assert.ok(isRootTarget('People/ana/n'))
  assert.ok(isRootTarget('/people/ana/n'))
  assert.ok(!isRootTarget('spaces'))
  assert.ok(!isRootTarget('people'))
  assert.ok(!isRootTarget('notes/people/n'))
  const owner = m.aUsername()
  const index = new LinkIndex()
  const named = `people/${owner}/spaces.md`
  const source = `people/${owner}/${m.aTitle()}.md`
  index.set({ path: named })
  index.set({ path: source })
  assert.equal(at(index.resolve(source, wiki('spaces'))), named)
})

test('ambiguity and aliases stay within the space', () => {
  const owner = m.aUsername()
  const shared = `spaces/${m.aSpaceFolder()}`
  const name = m.aTitle()
  const alias = m.aTitle()
  const index = new LinkIndex()
  const a = `${shared}/${m.aFolder()}/${name}.md`
  const b = `${shared}/${m.aFolder()}/${name}.md`
  const mineAliased = `people/${owner}/${m.aTitle()}.md`
  const source = `${shared}/${m.aTitle()}.md`
  const mineSource = `people/${owner}/${m.aTitle()}.md`
  index.set({ path: a })
  index.set({ path: b })
  index.set({ path: `people/${owner}/${name}.md` })
  index.set({ path: mineAliased, aliases: [alias] })
  index.set({ path: source })
  index.set({ path: mineSource })
  assert.deepEqual(index.resolve(source, wiki(name)), { status: 'ambiguous', candidates: [a, b].sort() })
  assert.equal(at(index.resolve(mineSource, wiki(name))), `people/${owner}/${name}.md`)
  assert.equal(at(index.resolve(mineSource, wiki(alias))), mineAliased)
  assert.equal(at(index.resolve(source, wiki(alias))), 'missing')
})

test('notes in no space (the layout before spaces) resolve among themselves, as they always did', () => {
  const index = new LinkIndex()
  const name = m.aTitle()
  const loose = `${m.aFolder()}/${name}.md`
  const source = `${m.aFolder()}/${m.aTitle()}.md`
  const person = `people/${m.aUsername()}/${m.aTitle()}.md`
  index.set({ path: loose })
  index.set({ path: source })
  index.set({ path: person })
  assert.equal(linkSpace(loose), '')
  assert.equal(at(index.resolve(source, wiki(name))), loose)
  assert.equal(at(index.resolve(person, wiki(name))), 'missing')
})

test('what vihko writes: the name inside a space, the path from the root (never with /) and the name as visible text across spaces', () => {
  const l = layout()
  assert.deepEqual(wikiLink(l.index, l.notes.mineSource, l.notes.mineName), { target: l.name, display: null })
  const toShared = wikiLink(l.index, l.notes.mineSource, l.notes.sharedName)
  assert.deepEqual(toShared, { target: l.notes.sharedName.slice(0, -3), display: l.name })
  assert.ok(!toShared.target.startsWith('/'))
  assert.equal(shortestTarget(l.index, l.notes.sharedSource, l.notes.theirsNote), l.notes.theirsNote.slice(0, -3))
  // Someone who sees only part of the source's space (not the folder the two notes share): the path from the root,
  // which means the same for everyone; within a folder they see whole, the name.
  const whole = (folder: string) => folder.startsWith(`${l.mine}/${l.folder}`)
  assert.deepEqual(wikiLink(l.index, l.notes.mineSource, l.notes.mineName, { whole }), { target: l.notes.mineName.slice(0, -3), display: l.name })
  const sibling = `${l.mine}/${l.folder}/${m.aTitle()}.md`
  l.index.set({ path: sibling })
  assert.deepEqual(wikiLink(l.index, sibling, l.notes.mineName, { whole }), { target: l.name, display: null })
  // A folder named like the product's at the root of a space: its notes are reached by name or suffix, not by `spaces/…`.
  const owner = m.aUsername()
  const index = new LinkIndex()
  const inner = `people/${owner}/spaces/${m.aTitle()}.md`
  const other = `people/${owner}/${m.aFolder()}/${inner.split('/').pop()}`
  const source = `people/${owner}/${m.aTitle()}.md`
  for (const p of [inner, other, source]) index.set({ path: p })
  const t = shortestTarget(index, source, inner)
  assert.equal(at(index.resolve(source, wiki(t))), inner)
  assert.ok(!t.startsWith('spaces/') && !t.startsWith('/'), t)
})

test('property: from any note, what vihko writes reaches the note, never starts with /, and names only within the space', () => {
  const people = Array.from({ length: m.anInt(1, 3) }, () => `people/${m.aUsername()}`)
  const spaces = Array.from({ length: m.anInt(1, 3) }, () => `spaces/${m.aSpaceFolder()}`)
  const roots = [...people, ...spaces]
  const names = Array.from({ length: m.anInt(2, 4) }, () => m.aTitle())
  const folders = Array.from({ length: m.anInt(1, 3) }, () => m.aFolder())
  const index = new LinkIndex()
  const paths = new Set<string>()
  for (let i = 0; i < m.anInt(8, 20); i++) {
    const depth = m.anInt(0, 2)
    const dir = [m.pick(roots), ...Array.from({ length: depth }, () => m.pick(folders))].join('/')
    paths.add(`${dir}/${m.pick(names)}.md`)
  }
  for (const p of paths) index.set({ path: p, aliases: m.chance(0.3) ? [m.pick(names)] : [] })
  for (const source of paths) {
    for (const path of paths) {
      for (const whole of [undefined, () => false]) {
        const { target, display } = wikiLink(index, source, path, { whole })
        assert.ok(!target.startsWith('/'), `${source} → ${path}: ${target}`)
        assert.equal(at(index.resolve(source, wiki(target))), path, `${source} → ${path}: ${target}`)
        if (!isRootTarget(target)) assert.equal(linkSpace(source), linkSpace(path), `a name across spaces: ${source} → ${target}`)
        assert.equal(display !== null, isRootTarget(target))
      }
    }
  }
})

test('property: a reader who sees only some folders writes, from their partial index, links that lead where they meant for everyone', () => {
  const owner = `people/${m.aUsername()}`
  const folders = Array.from({ length: m.anInt(2, 4) }, () => m.aFolder())
  const names = Array.from({ length: m.anInt(2, 4) }, () => m.aTitle())
  const all = new Set<string>()
  for (let i = 0; i < m.anInt(10, 24); i++) {
    const dir = [owner, ...Array.from({ length: m.anInt(0, 3) }, () => m.pick(folders))].join('/')
    all.add(`${dir}/${m.pick(names)}.md`)
  }
  const full = new LinkIndex()
  for (const p of all) full.set({ path: p })
  // The folders shared with them: some of the ones that exist, and everything under each.
  const dirs = [...new Set([...all].map((p) => p.slice(0, p.lastIndexOf('/'))))].filter((d) => d !== owner)
  const shared = dirs.filter(() => m.chance(0.5))
  const whole = (folder: string) => shared.some((f) => folder === f || folder.startsWith(f + '/'))
  const seen = [...all].filter((p) => whole(p.slice(0, p.lastIndexOf('/'))))
  const partial = new LinkIndex()
  for (const p of seen) partial.set({ path: p })
  for (const source of seen) {
    for (const path of seen) {
      const { target } = wikiLink(partial, source, path, { whole })
      assert.equal(at(full.resolve(source, wiki(target))), path, `${source} → ${path}: ${target} (shared: ${shared.join(', ')})`)
    }
  }
})
