import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NoteCatalog, completionContext, completionEnd, matchScore, rankHeadings, rankTags, type NoteEntry } from '../src/editor/suggest.ts'
import { markdownLinkNote, wikiLinkNote } from '../src/editor/createLink.ts'

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
