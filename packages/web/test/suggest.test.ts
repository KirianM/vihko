import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NoteCatalog, completionContext, completionEnd, matchScore, rankHeadings, rankTags, type NoteEntry } from '../src/editor/suggest.ts'
import { markdownLinkNote, wikiLinkNote } from '../src/editor/createLink.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const NOTES: NoteEntry[] = [
  { path: 'Plan.md', title: 'Plan general' },
  { path: 'proyectos/blog/Plan.md', title: 'Plan' },
  { path: 'proyectos/vihko/Plan.md', title: 'Plan' },
  { path: 'proyectos/vihko/Tareas.md', title: 'Tareas' },
  { path: 'hogar/Proxy.md', title: 'Proxy', aliases: ['gw', 'Hipervisor'] },
  { path: 'hogar/enlaces.md', title: 'Enlaces' },
  { path: 'recetas/Café.md', title: 'Café' },
  { path: 'recetas/Notas de reunión (2026).md', title: 'Notas de reunión' },
  { path: 'planificación.md', title: 'Planificación trimestral' },
]
const catalog = new NoteCatalog(NOTES)

test('context: [[ asks for notes, # after a name for headings, | for the visible text', () => {
  assert.deepEqual(completionContext('see [['), { kind: 'note', query: '' })
  assert.deepEqual(completionContext('see [[Pla'), { kind: 'note', query: 'Pla' })
  assert.deepEqual(completionContext('see ![[Pla'), { kind: 'note', query: 'Pla' })
  assert.deepEqual(completionContext('[[Proxy#Re'), { kind: 'heading', target: 'Proxy', query: 'Re' })
  assert.deepEqual(completionContext('[[#'), { kind: 'heading', target: '', query: '' })
  assert.deepEqual(completionContext('[[Proxy#Red|la r'), { kind: 'display', target: 'Proxy', query: 'la r' })
  assert.equal(completionContext('[[Plan]] and more'), null, 'a closed link asks for nothing')
})

test('context: # suggests tags after a space, never a heading at the start of a line', () => {
  assert.deepEqual(completionContext('text #ho'), { kind: 'tag', query: 'ho' })
  assert.deepEqual(completionContext('text #'), { kind: 'tag', query: '' })
  assert.deepEqual(completionContext('#ho'), { kind: 'tag', query: 'ho' }, 'a tag can start a line once a letter follows')
  assert.equal(completionContext('#'), null, 'alone at the start of a line: probably a heading')
  assert.equal(completionContext('  #'), null)
  assert.equal(completionContext('## '), null)
  assert.equal(completionContext('word#tag'), null, 'a tag starts a word')
  assert.deepEqual(completionContext('(#pro'), { kind: 'tag', query: 'pro' })
})

test('matchScore: exact > prefix > word start > contained > all words > letters in order', () => {
  const s = (text: string, q: string) => matchScore(text, q)
  assert.ok(s('plan', 'plan') > s('plan general', 'plan'))
  assert.ok(s('plan general', 'plan') > s('mi plan', 'plan'))
  assert.ok(s('mi plan', 'plan') > s('explanar', 'plan'))
  assert.ok(s('explanar', 'plan') > s('notas de reunion', 'reunion notas'))
  assert.ok(s('notas de reunion', 'reunion notas') > s('proxy', 'pxy'))
  assert.equal(s('proxy', 'zz'), -1)
  assert.equal(s('proxy', 'x'), 40, 'a single letter never matches out of order')
})

test('rank: accent- and case-insensitive, by title, file name and alias; the current note is left out', () => {
  assert.equal(catalog.rank('cafe', 'x.md')[0]?.path, 'recetas/Café.md')
  assert.equal(catalog.rank('CAFÉ', 'x.md')[0]?.path, 'recetas/Café.md')
  const gw = catalog.rank('hiper', 'x.md')[0]!
  assert.deepEqual([gw.path, gw.label, gw.alias], ['hogar/Proxy.md', 'Hipervisor', 'Hipervisor'])
  assert.equal(catalog.rank('proxy', 'hogar/Proxy.md').length, 0)
  assert.equal(catalog.rank('reunion', 'x.md')[0]?.path, 'recetas/Notas de reunión (2026).md')
})

test('rank: exact names first, then notes in the same folder, then shorter titles', () => {
  const plans = catalog.rank('plan', 'proyectos/vihko/Tareas.md').map((m) => m.path)
  assert.equal(plans[0], 'proyectos/vihko/Plan.md', 'same folder wins a tie')
  assert.deepEqual(plans.slice(1, 3), ['proyectos/blog/Plan.md', 'Plan.md'])
  assert.equal(plans.at(-1), 'planificación.md')
  assert.ok(catalog.rank('', 'x.md').length > 0, 'an empty query lists notes')
  assert.equal(catalog.rank('', 'x.md', 3).length, 3)
})

test('rank: a query with a slash also matches the path', () => {
  assert.equal(catalog.rank('blog/pl', 'x.md')[0]?.path, 'proyectos/blog/Plan.md')
})

test('rank: fast enough with thousands of notes', () => {
  const many: NoteEntry[] = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i % 50}/Nota número ${i}.md`, title: `Nota número ${i}`, aliases: [`n${i}`] }))
  const big = new NoteCatalog(many)
  const start = performance.now()
  for (const q of ['n', 'no', 'num', 'número 42', 'zz']) big.rank(q, 'f1/x.md')
  assert.ok(performance.now() - start < 500, `ranking took ${performance.now() - start} ms`)
})

test('linkTarget: the shortest link that resolves from the current note', () => {
  assert.equal(catalog.linkTarget('hogar/enlaces.md', 'recetas/Café.md'), 'Café')
  assert.equal(catalog.linkTarget('hogar/enlaces.md', 'proyectos/blog/Plan.md'), 'blog/Plan')
  assert.equal(catalog.linkTarget('hogar/enlaces.md', 'Plan.md'), 'Plan')
  assert.equal(catalog.linkTarget('proyectos/blog/x.md', 'Plan.md'), '/Plan')
  assert.equal(catalog.resolve('hogar/enlaces.md', 'gw'), 'hogar/Proxy.md')
  assert.equal(catalog.resolve('hogar/enlaces.md', 'vihko/plan'), 'proyectos/vihko/Plan.md')
  assert.equal(catalog.resolve('recetas/x.md', 'Nope'), null)
  assert.deepEqual(catalog.displays('hogar/Proxy.md'), ['Proxy', 'gw', 'Hipervisor'])
})

test('with aliases off (vihko.yaml), aliases are still suggested but only resolve as visible text', () => {
  const off = new NoteCatalog(NOTES, { aliases: false })
  const gw = off.rank('hiper', 'x.md')[0]!
  assert.deepEqual([gw.path, gw.alias], ['hogar/Proxy.md', 'Hipervisor'], 'still suggested, inserted as [[Proxy|Hipervisor]]')
  assert.equal(off.linkTarget('hogar/enlaces.md', 'hogar/Proxy.md'), 'Proxy')
  assert.equal(off.resolve('hogar/enlaces.md', 'gw'), null, '[[gw#… has no headings to offer')
  assert.equal(off.resolve('hogar/enlaces.md', 'proxy'), 'hogar/Proxy.md')
})

test('headings and tags: filtered and ordered', () => {
  const hs = [{ level: 1, text: 'Proxy' }, { level: 2, text: 'Red' }, { level: 2, text: 'Almacenamiento' }, { level: 3, text: 'Red de gestión' }]
  assert.deepEqual(rankHeadings(hs, ''), hs)
  assert.deepEqual(rankHeadings(hs, 'red').map((h) => h.text), ['Red', 'Red de gestión'])
  assert.deepEqual(rankHeadings(hs, 'gestion').map((h) => h.text), ['Red de gestión'])
  const tags = [{ tag: 'hogar', count: 3 }, { tag: 'hogar/red', count: 1 }, { tag: 'proyectos', count: 5 }]
  assert.deepEqual(rankTags(tags, '').map((t) => t.tag), ['proyectos', 'hogar', 'hogar/red'])
  assert.deepEqual(rankTags(tags, 'hog').map((t) => t.tag), ['hogar', 'hogar/red'])
  assert.deepEqual(rankTags(tags, 'red').map((t) => t.tag), ['hogar/red'])
  assert.deepEqual(rankTags(tags, 'Hogar'), [], 'a complete tag suggests nothing: ↵ is a new line')
  assert.deepEqual(rankTags(tags, 'hogar/').map((t) => t.tag), ['hogar/red'])
})

test('completionEnd: the rest of an old value up to ]] | or # is replaced; otherwise the link is closed', () => {
  const note = /^[^[\]|#\n]*/
  assert.deepEqual(completionEnd(']]', note), { extend: 0, closed: true })
  assert.deepEqual(completionEnd('an]] more', note), { extend: 2, closed: true })
  assert.deepEqual(completionEnd('#Red]]', note), { extend: 0, closed: true })
  assert.deepEqual(completionEnd(' and text', note), { extend: 0, closed: false })
  assert.deepEqual(completionEnd('', note), { extend: 0, closed: false })
})

test('a broken wikilink creates its note where the link will find it', () => {
  assert.deepEqual(wikiLinkNote('proyectos/vihko/notas.md', '[[Nota que no existe]]'),
    { path: 'proyectos/vihko/Nota que no existe.md', title: 'Nota que no existe', raw: '[[Nota que no existe]]' })
  assert.equal(wikiLinkNote('raiz.md', '[[Nueva#Sección|texto]]')?.path, 'Nueva.md')
  assert.equal(wikiLinkNote('a/b.md', '[[sub/Nueva]]')?.path, 'a/sub/Nueva.md')
  assert.equal(wikiLinkNote('a/b.md', '[[/otra/Nueva]]')?.path, 'otra/Nueva.md')
  assert.equal(wikiLinkNote('a/b.md', '[[ Con espacios ]]')?.path, 'a/Con espacios.md')
  assert.equal(wikiLinkNote('a/b.md', '[[.oculta]]'), null, 'no hidden files')
  assert.equal(wikiLinkNote('a/b.md', '[[../fuera]]'), null)
  assert.equal(wikiLinkNote('a/b.md', '[[#Sección]]'), null)
})

test('a broken link creates its note only in the note’s own space; into another space, nothing to create', () => {
  const owner = `people/${m.aUsername()}`
  const source = `${owner}/${m.aFolder()}/${m.aTitle()}.md`
  const space = `spaces/${m.aSpaceFolder()}`
  const [folder, title] = [m.aFolder(), m.aTitle()]
  // Into a shared space or someone else's: such a link never resolves, so creating there would leave it broken.
  assert.equal(wikiLinkNote(source, `[[${space}/${folder}/${title}|${title}]]`), null)
  assert.equal(wikiLinkNote(source, `[[people/${m.aUsername()}/${title}]]`), null)
  assert.equal(markdownLinkNote(source, `[x](../../${space}/${title}.md)`, `../../${space}/${encodeURI(title)}.md`), null)
  // By its path from the root inside its own space: there, never under the current folder.
  const raw = `[[${owner}/${folder}/${title}|${title}]]`
  assert.deepEqual(wikiLinkNote(source, raw), { path: `${owner}/${folder}/${title}.md`, title, raw })
  // `[[people]]` alone is a note's name, next to the source.
  assert.equal(wikiLinkNote(source, '[[people]]')?.path, `${source.slice(0, source.lastIndexOf('/'))}/people.md`)
})

test('a leading `/` is the root of the note’s space: suggesting, resolving and creating from it', () => {
  for (const root of [`people/${m.aUsername()}`, `spaces/${m.aSpaceFolder()}`]) {
    const [folder, title, missing] = [m.aFolder(), m.aTitle(), m.aTitle()]
    const source = `${root}/${m.aFolder()}/${m.aTitle()}.md`
    const target = `${root}/${folder}/${title}.md`
    const cat = new NoteCatalog([{ path: source, title: m.aTitle() }, { path: target, title }, { path: `${folder}/${title}.md`, title }])
    // Typed from the root of the space, the note there comes first, as its link would resolve.
    assert.equal(cat.rank(`/${folder}/${title.slice(0, 2)}`, source)[0]?.path, target)
    assert.equal(cat.resolve(source, `/${folder}/${title}`), target, 'and its headings are offered from there')
    assert.equal(wikiLinkNote(source, `[[/${folder}/${missing}]]`)?.path, `${root}/${folder}/${missing}.md`)
    assert.equal(markdownLinkNote(source, '[x](/y.md)', `/${encodeURI(folder)}/${encodeURI(missing)}.md`)?.path, `${root}/${folder}/${missing}.md`)
  }
})

test('a broken Markdown link creates the .md it points to, relative to the note', () => {
  assert.equal(markdownLinkNote('a/b.md', '[x](nueva.md)', 'nueva.md')?.path, 'a/nueva.md')
  assert.equal(markdownLinkNote('a/b.md', '[x](../Otra%20nota.md)', '../Otra%20nota.md')?.path, 'Otra nota.md')
  assert.equal(markdownLinkNote('a/b.md', '[x](foto.png)', 'foto.png'), null)
  assert.equal(markdownLinkNote('a/b.md', '[x](https://ejemplo.org/a.md)', 'https://ejemplo.org/a.md'), null)
  assert.equal(markdownLinkNote('a/b.md', '[x](../../fuera.md)', '../../fuera.md'), null)
})

test('suggestions fold case like links and tags: «Straße» and «STRASSE»', () => {
  const c = new NoteCatalog([{ path: 'Straße.md', title: 'Straße' }])
  assert.equal(c.rank('STRASSE', 'x.md')[0]?.path, 'Straße.md')
  assert.equal(c.resolve('x.md', 'strasse'), 'Straße.md')
  assert.deepEqual(rankTags([{ tag: 'strasse', count: 1 }], 'Straß').map((t) => t.tag), ['strasse'])
})

test('suggestions are only of the note’s own space; in a folder seen in part, the path from the root with the name shown', () => {
  const mine = `people/${m.aUsername()}`
  const theirs = `people/${m.aUsername()}`
  const home = `spaces/${m.aSpaceFolder()}`
  const [shared, other] = [`${theirs}/${m.aFolder()}`, `${theirs}/${m.aFolder()}`]
  const [a, b, c, list, own] = [m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle()]
  const notes: NoteEntry[] = [
    { path: `${mine}/${own}.md`, title: own },
    { path: `${home}/${list}.md`, title: list },
    { path: `${shared}/${a}.md`, title: a },
    { path: `${shared}/${m.aFolder()}/${b}.md`, title: b },
    { path: `${other}/${c}.md`, title: c },
  ]
  // What someone sees of another person's space: two folders they were given, the rest of it only as the way there.
  const cat = new NoteCatalog(notes, { pathOnly: ['people', theirs, 'spaces'] })
  // Typing any of their names from one's own space offers none of another space.
  for (const t of [list, a, b, c]) assert.deepEqual(cat.rank(t, `${mine}/${own}.md`).map((x) => x.path), [], t)
  assert.deepEqual(cat.rank(a, notes[3]!.path).map((x) => x.path), [`${shared}/${a}.md`])
  // Within a folder shared whole, the name; between folders of someone's space seen only in part, the path with the name shown.
  assert.deepEqual(cat.linkForm(`${shared}/${a}.md`, notes[3]!.path), { target: b, display: null })
  assert.deepEqual(cat.linkForm(`${shared}/${a}.md`, `${other}/${c}.md`), { target: `${other}/${c}`, display: c })
})
