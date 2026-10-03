// Markdown links to notes rewritten after a move: the destination is encoded
// as image links are (`markdownDest`), so a name with brackets, parentheses,
// `#`, `?`, `%` or spaces still parses back to the note; the `<…>` form, the
// anchor and the title stay as written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkIndex, extract, markdownDest } from '@vihko/core'
import { applyReplacements, planRelinks, rewriteLink } from '@vihko/server'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** File names a Markdown destination must encode: they are the case under test. */
const TRICKY = ['a (1).md', 'x#y.md', 'ñ [b].md', 'q?.md', '100% <c>.md', 'd\\e.md', 'at 10.12 AM.md', 'a b　c.md']

/** Where a link written in `src` leads, by `index`. */
function leads(index: LinkIndex, src: string, text: string): string | null {
  const link = extract(text).links[0]
  assert.ok(link, `no link in ${text}`)
  const r = index.resolve(src, link)
  return r.status === 'resolved' ? r.path : null
}

for (const name of TRICKY) {
  test(`a note named «${name}»: its rewritten Markdown link still leads to it`, () => {
    const [from, to, where] = [m.aFolder(), m.aFolder(), m.aFolder()]
    const src = m.aNotePath(where)
    const heading = m.aHeading()
    const before = new LinkIndex()
    const after = new LinkIndex()
    for (const i of [before, after]) i.set({ path: src })
    before.set({ path: `${from}/${name}`, headings: [heading] })
    after.set({ path: `${to}/${name}`, headings: [heading] })
    const label = m.aWord()
    // In `<…>`, where the anchor may have spaces; the name encoded, as it must be to be read back.
    const text = `${m.aSentence()} [${label}](<../${markdownDest(from)}/${markdownDest(name)}#${heading}> "${m.aWord()}") ${m.aSentence()}\n`
    assert.equal(leads(before, src, text), `${from}/${name}`, 'the fixture link leads to the note before the move')
    const reps = planRelinks(text, src, src, before, after, (p) => (p === `${from}/${name}` ? `${to}/${name}` : p))
    assert.equal(reps.length, 1)
    const next = applyReplacements(text, reps)
    assert.equal(leads(after, src, next), `${to}/${name}`, next)
    const link = extract(next).links[0]!
    assert.equal(link.anchor, heading)
    assert.ok(next.slice(link.destFrom, link.destTo).startsWith('<'), `the <…> form stays: ${next}`)
    assert.match(link.raw, /" *\)$/, 'the title stays')
  })

  test(`a note named «${name}»: a bare Markdown link is rewritten encoded, and parses back`, () => {
    const [to, where] = [m.aFolder(), m.aFolder()]
    const src = m.aNotePath(where)
    const index = new LinkIndex()
    index.set({ path: src })
    index.set({ path: `${to}/${name}` })
    const label = m.aWord()
    const raw = rewriteLink(extract(`[${label}](${m.aWord()}.md)`).links[0]!, src, `${to}/${name}`, index)
    assert.ok(raw)
    assert.ok(raw.startsWith(`[${label}](`))
    assert.doesNotMatch(raw.slice(label.length + 3, -1), /[\s()[\]#?<>\\]/, `nothing that ends or splits the destination: ${raw}`)
    assert.equal(leads(index, src, raw), `${to}/${name}`, raw)
  })
}

test('a rewritten Markdown link keeps its anchor as written and its accents readable', () => {
  const [to, where] = [m.aFolder(), m.aFolder()]
  const src = m.aNotePath(where)
  const name = `${m.aTitle()} ñ.md`
  const index = new LinkIndex()
  index.set({ path: src })
  index.set({ path: `${to}/${name}` })
  const anchor = encodeURIComponent(m.aHeading())
  const raw = rewriteLink(extract(`[${m.aWord()}](${m.aWord()}.md#${anchor})`).links[0]!, src, `${to}/${name}`, index)!
  assert.ok(raw.endsWith(`#${anchor})`), raw)
  assert.ok(raw.includes('ñ'), raw)
})
