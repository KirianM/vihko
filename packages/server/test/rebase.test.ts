// A write planned on a text the note had a moment ago, applied to the text it
// has now (rebase.ts): where nothing changed since, the same change; where
// something did, in what it replaces or right next to it, refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySplices, planEdits, rebase, replacementsOf, type Splice } from '@vihko/server'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A note of a few lines, each with a word only it has. */
function note(lines: number) {
  const words = Array.from({ length: lines }, () => m.aUniqueWord())
  return { words, text: `# ${m.aTitle()}\n\n${words.map((w) => `${m.aSentence()} ${w} ${m.aSentence()}`).join('\n')}\n` }
}

/** `text` with `insert` typed right after `word`. */
const typedAfter = (text: string, word: string, insert: string) => text.replace(word, word + insert)

test('a substitution planned on an older text goes in where nobody typed since', () => {
  const { words, text: base } = note(5)
  const [, target, , typedAt] = words as [string, string, string, string]
  const replacement = m.aUniqueWord()
  // Someone typed on another line, before and after the substitution's.
  const typed = ` ${m.aWord()}`
  const current = typedAfter(typedAfter(base, words[0]!, typed), typedAt, typed)
  const splices = rebase(base, planEdits(base, [{ op: 'find_replace', find: target, replace: replacement }]), current)
  assert.ok(splices, 'applied')
  assert.equal(applySplices(current, splices), current.replace(target, replacement))
})

test('refused when someone typed inside what it replaces, or right against it', () => {
  const { words, text: base } = note(3)
  const target = words[1]!
  const planned = planEdits(base, [{ op: 'find_replace', find: target, replace: m.aUniqueWord() }])
  const inside = base.replace(target, target.slice(0, 2) + m.aWord() + target.slice(2))
  assert.equal(rebase(base, planned, inside), null, 'typed inside')
  assert.equal(rebase(base, planned, typedAfter(base, target, m.aWord())), null, 'typed right after it')
  assert.equal(rebase(base, planned, base.replace(target, m.aWord() + target)), null, 'typed right before it')
  assert.equal(rebase(base, planned, base.replace(` ${target} `, ` ${target}`)), null, 'a character next to it deleted')
})

test('the same text now: the change as planned', () => {
  const { words, text: base } = note(3)
  const planned = planEdits(base, [{ op: 'set_frontmatter', key: m.aWord(), value: m.aWord() }, { op: 'find_replace', find: words[2]!, replace: m.aUniqueWord() }])
  const splices = rebase(base, planned, base)
  assert.ok(splices)
  assert.equal(applySplices(base, splices), applySplices(base, planned))
})

test('a whole new text is one change, from its first difference to its last', () => {
  const { words, text: base } = note(6)
  const next = base.replace(words[2]!, m.aUniqueWord()).replace(words[3]!, m.aUniqueWord())
  const typed = ` ${m.aWord()}`
  // Outside that span: merged.
  const elsewhere = typedAfter(base, words[5]!, typed)
  const splices = rebase(base, next, elsewhere)
  assert.ok(splices)
  assert.equal(applySplices(elsewhere, splices), typedAfter(next, words[5]!, typed))
  // Between the two replaced words (the start of the second one's line), inside the span: refused, though neither word was touched.
  const lineStart = base.lastIndexOf('\n', base.indexOf(words[3]!)) + 1
  assert.equal(rebase(base, next, `${base.slice(0, lineStart)}${m.aWord()} ${base.slice(lineStart)}`), null)
})

test('the splices of any edit, as replacements of the text they started from, make the same text', () => {
  for (let round = 0; round < 200; round++) {
    const base = m.aParagraph()
    let cur = base
    const splices: Splice[] = []
    for (let k = m.faker.number.int({ min: 1, max: 6 }); k > 0; k--) {
      const at = m.faker.number.int({ min: 0, max: cur.length })
      const remove = m.faker.number.int({ min: 0, max: Math.min(8, cur.length - at) })
      const insert = m.faker.datatype.boolean() ? m.aWord() : ''
      splices.push({ at, remove, insert })
      cur = applySplices(cur, [{ at, remove, insert }])
    }
    const reps = replacementsOf(base, splices)
    let out = base
    for (const r of [...reps].reverse()) out = out.slice(0, r.from) + r.insert + out.slice(r.to)
    assert.equal(out, cur, `round ${round}: ${JSON.stringify({ base, splices })}`)
    for (let i = 1; i < reps.length; i++) assert.ok(reps[i - 1]!.to <= reps[i]!.from, 'in order, none overlapping')
  }
})
