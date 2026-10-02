// Searching by frontmatter fields (`type:decision`, `prop:key=value`,
// `has:key`): what the index keeps of each kind of value, how a query
// matches it, and that only notes the principal reads ever count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frontmatterFields } from '@vihko/server'
import { setup } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('fields: simple values as written, each item of a list; maps left out; a key with no value kept, without one', () => {
  const [text, item] = [m.aSentence(), m.aWord()]
  // Literals: each value's kind is the case under test.
  const fields = frontmatterFields({ type: text, rating: 5.5, done: false, due: '2026-10-01', at: '2026-10-01T10:00:00Z', people: [item, 3, { a: 1 }], meta: { a: 1 }, rows: [{ a: 1 }], empty: null, none: [] })
  assert.deepEqual(fields.map((f) => [f.key, f.value, f.num, f.kind]), [
    ['type', text, null, 'string'],
    ['rating', '5.5', 5.5, 'number'],
    ['done', 'false', null, 'boolean'],
    ['due', '2026-10-01', null, 'date'],
    ['at', '2026-10-01T10:00:00Z', null, 'date'],
    ['people', item, null, 'string'],
    ['people', '3', 3, 'number'],
    ['empty', null, null, 'null'],
    ['none', null, null, 'null'],
  ])
})

test('search by frontmatter fields: key and value in any case, any item of a list, numbers however written, has:, -, quotes, with text and tags', async () => {
  const h = await setup()
  try {
    const home = h.home('member')
    const [decision, idea, status, person, other, word, tag, key] = [m.aUniqueWord(), m.aUniqueWord(), m.aSentence(3), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aTag(), m.aUniqueWord()]
    const one = `${home}/${m.aTitle()}.md`
    const two = `${home}/${m.aTitle()}.md`
    const three = `${home}/${m.aTitle()}.md`
    h.write(one, `---\ntype: ${decision}\nstatus: "${status}"\nrating: 5\ndone: false\ndue: 2026-10-01\npeople: [${person}, ${other}]\nmeta: { ${key}: 1 }\nempty:\n---\n# ${m.aHeading()}\n\n${word}\n`)
    h.write(two, `---\nType: ${idea.toUpperCase()}\nrating: 5.0\ntags: [${tag}]\n---\n# ${m.aHeading()}\n\n${word}\n`)
    h.write(three, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    const q = async (s: string) => ((await h.member('GET', `/api/search?q=${encodeURIComponent(s)}`)).body.results as { path: string }[]).map((r) => r.path).sort()
    const sorted = (...p: string[]) => p.sort()
    assert.deepEqual(await q(`type:${decision}`), [one])
    assert.deepEqual(await q(`TYPE:${decision.toUpperCase()}`), [one])
    assert.deepEqual(await q(`type:${idea}`), [two], 'a key written in another case')
    assert.deepEqual(await q(`prop:type=${idea}`), [two])
    assert.deepEqual(await q(`status:"${status.toUpperCase()}"`), [one])
    assert.deepEqual(await q('rating:5'), sorted(one, two))
    assert.deepEqual(await q('rating:5.00'), sorted(one, two))
    assert.deepEqual(await q('done:FALSE'), [one])
    assert.deepEqual(await q('due:2026-10-01'), [one])
    assert.deepEqual(await q(`people:${other}`), [one], 'any item of a list')
    assert.deepEqual(await q(`has:empty`), [one], 'a key with no value is there')
    assert.deepEqual(await q(`has:meta`), [], 'a map is no field')
    assert.deepEqual(await q(`has:${key}`), [], 'nor are the keys inside it')
    assert.deepEqual(await q(`has:type -type:${idea}`), [one])
    assert.deepEqual(await q(`-has:type`), [three])
    assert.deepEqual(await q(`${word} type:${decision}`), [one], 'with text')
    assert.deepEqual(await q(`${word} type:${m.aWord()}`), [])
    assert.deepEqual(await q(`tag:${tag} rating:5`), [two], 'with a tag')
    assert.deepEqual(await q(`type:${decision.slice(0, -1)}`), [], 'a value is never matched by a prefix of it')
    // A change to the frontmatter is searched at once.
    h.write(three, `---\ntype: ${decision}\n---\n# ${m.aHeading()}\n`)
    assert.deepEqual(await q(`type:${decision}`), sorted(one, three))
  } finally {
    h.close()
  }
})

test('search by frontmatter fields counts only what the principal reads: another person\'s notes, and for an agent, what is hidden from it', async () => {
  const h = await setup()
  try {
    await h.enable()
    const [key, value, theirsOnly] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
    const mine = `${h.home('member')}/${m.aTitle()}.md`
    const hidden = `${h.home('member')}/${m.aTitle()}.md`
    const theirs = `${h.home('other')}/${m.aTitle()}.md`
    h.write(mine, `---\n${key}: ${value}\n---\n# ${m.aHeading()}\n`)
    h.write(hidden, `---\n${key}: ${value}\nai: false\n---\n# ${m.aHeading()}\n`)
    h.write(theirs, `---\n${key}: ${value}\n${theirsOnly}: ${value}\ntemplate: true\n---\n# ${m.aHeading()}\n`)
    const q = async (s: string) => ((await h.member('GET', `/api/search?q=${encodeURIComponent(s)}`)).body.results as { path: string }[]).map((r) => r.path).sort()
    assert.deepEqual(await q(`${key}:${value}`), [hidden, mine].sort())
    assert.deepEqual(await q(`has:${theirsOnly}`), [])
    assert.deepEqual(await q(`prop:${theirsOnly}=${value}`), [])
    assert.deepEqual(await q('template:true'), [], 'nobody else\'s templates either')
    assert.deepEqual(await q(`-has:${theirsOnly}`), [hidden, mine].sort())
    assert.deepEqual((await h.other('GET', `/api/search?q=${encodeURIComponent(`${key}:${value}`)}`)).body.results.map((r: { path: string }) => r.path), [], 'their template stays out of their search')
    // An agent of the member's: not what is hidden from agents.
    const key2 = await h.newKey('member', { name: m.aKeyName(), canWrite: false })
    const agent = await h.withKey(key2.token)('GET', `/api/search?q=${encodeURIComponent(`${key}:${value}`)}`)
    assert.deepEqual(agent.body.results.map((r: { path: string }) => r.path), [mine])
    const c = await h.mcp(key2.token)
    try {
      const r = await c.call('search', { query: `has:${key}` })
      assert.deepEqual(r.data.results.map((x: { path: string }) => x.path), [mine])
    } finally { await c.close() }
  } finally {
    h.close()
  }
})
