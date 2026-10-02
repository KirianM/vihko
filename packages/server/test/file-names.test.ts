// Files named Obsidian's way (fileNames.ts): `![[photo.png]]` and
// `[[invoice.pdf]]` with no folder resolve by name within the note's space,
// as note names do (relative first, then the nearest, a tie is no answer),
// never in another space; the file is served for whoever reads it, a PDF
// shown in the browser, anything else that could run downloaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFileTarget } from '@vihko/server'
import { setup } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==', 'base64')
const PDF = () => Buffer.from(`%PDF-1.4\n${m.aSentence()}\n`)

test('![[photo.png]] and [[invoice.pdf]] resolve by name within the note\'s space: the image is served, the PDF shown, the link leads to the file', async () => {
  const h = await setup()
  try {
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName(), members: { [h.names.other]: 'read' } })).body.space.path as string
    const [notes, images, docs, photo, invoice] = [m.aFolder(), m.aFolder(), m.aFolder(), m.aUniqueWord(), m.aUniqueWord()]
    const note = `${space}/${notes}/${m.aTitle()}.md`
    const pdf = PDF()
    h.write(`${space}/${images}/${photo}.png`, PNG)
    h.write(`${space}/${docs}/${invoice}.pdf`, pdf)
    h.write(note, `# ${m.aHeading()}\n\n![[${photo}.png]]\n\n[[${invoice}.pdf]]\n`)
    const file = (who: 'member' | 'other' | 'admin', name: string, from = note) => h.as(who)('GET', `/api/file?note=${encodeURIComponent(from)}&name=${encodeURIComponent(name)}`)

    const img = await file('other', `${photo}.png`)
    assert.equal(img.status, 200, img.text)
    const raw = await h.app.request(`/api/file?note=${encodeURIComponent(note)}&name=${encodeURIComponent(`${invoice}.pdf`)}`, { headers: { cookie: h.cookie('other') } })
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get('content-type'), 'application/pdf')
    assert.match(raw.headers.get('content-disposition')!, /^inline/)
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(raw.headers.get('content-security-policy'), "frame-ancestors 'none'")
    assert.ok(Buffer.from(await raw.arrayBuffer()).equals(pdf))

    // The link: to the file, for whoever reads it.
    const links = (await h.other('GET', `/api/note/links?path=${encodeURIComponent(note)}`)).body.outgoing as any[]
    const toPdf = links.find((l) => l.raw === `[[${invoice}.pdf]]`)
    assert.deepEqual([toPdf.status, toPdf.dstPath, toPdf.file], ['resolved', `${space}/${docs}/${invoice}.pdf`, true])
    // An agent is told the same: a file, not a note to read.
    await h.enable()
    const c = await h.mcp((await h.newKey('other', { name: m.aKeyName(), canWrite: false })).token)
    try {
      const got = await c.call('get_note', { path: note })
      const viaMcp = (got.data.links.outgoing as any[]).find((l) => l.link === `[[${invoice}.pdf]]`)
      assert.deepEqual([viaMcp.status, viaMcp.path, viaMcp.file], ['resolved', `${space}/${docs}/${invoice}.pdf`, true], got.raw)
    } finally {
      await c.close()
    }

    // Someone outside the space: as for a note that doesn't exist.
    assert.equal((await file('admin', `${photo}.png`)).status, 404)
    // A name that leads nowhere in the space.
    assert.equal((await file('member', `${m.aUniqueWord()}.png`)).status, 404)
  } finally {
    h.close()
  }
})

test('a file\'s name has an extension with a letter in it: a note named with a number after a dot is still a note', () => {
  // Literals: each name is the case under test.
  for (const [target, file] of [
    ['invoice.pdf', true], ['Pasted image 20240101.png', true], ['docs/archive.tar.gz', true], ['photo.PNG#x', true],
    ['v1.2', false], ['Report 2026.10', false], ['Plan.md', false], ['Plan', false], ['.hidden', false], ['Meeting w. Dr. Smith', false],
  ] as const) assert.equal(isFileTarget(target), file, target)
})

test('by name: next to the note first, then the nearest; a tie is no answer; never another space', async () => {
  const h = await setup()
  try {
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName() })).body.space.path as string
    const elsewhere = h.home('member')
    const [deep, a, b, name] = [m.aFolder(), m.aFolder(), m.aFolder(), `${m.aUniqueWord()}.pdf`]
    const note = `${space}/${deep}/${m.aTitle()}.md`
    h.write(note, `[[${name}]]\n`)
    const file = (from = note, n = name) => h.member('GET', `/api/file?note=${encodeURIComponent(from)}&name=${encodeURIComponent(n)}`)
    const served = async () => {
      const r = await h.app.request(`/api/file?note=${encodeURIComponent(note)}&name=${encodeURIComponent(name)}`, { headers: { cookie: h.cookie('member') } })
      return r.status === 200 ? Buffer.from(await r.arrayBuffer()).toString() : r.status
    }
    // Only in another space (the member's own): not found from this one.
    h.write(`${elsewhere}/${name}`, PDF())
    assert.equal((await file()).status, 404)
    // Two at the same distance: a tie, no answer.
    const [one, two] = [PDF(), PDF()]
    h.write(`${space}/${a}/${name}`, one)
    h.write(`${space}/${b}/${name}`, two)
    assert.equal(await served(), 404)
    // One nearer (in the note's own folder's subtree): it wins.
    const near = PDF()
    h.write(`${space}/${deep}/${m.aFolder()}/${name}`, near)
    assert.equal(await served(), near.toString())
    // Next to the note: first, whatever else there is.
    const next = PDF()
    h.write(`${space}/${deep}/${name}`, next)
    assert.equal(await served(), next.toString())
    // A path suffix narrows it, as for notes.
    assert.equal((await file(note, `${a}/${name}`)).status, 200)
  } finally {
    h.close()
  }
})

test('an agent gets a file a note it reads names, but never one in a folder closed to agents, nor through a note hidden from it', async () => {
  const h = await setup()
  try {
    await h.enable()
    const home = h.home('member')
    const [open, closed, name, shut] = [m.aFolder(), m.aFolder(), `${m.aUniqueWord()}.pdf`, `${m.aUniqueWord()}.pdf`]
    const note = `${home}/${m.aTitle()}.md`
    const hidden = `${home}/${m.aTitle()}.md`
    h.write(`${home}/${open}/${name}`, PDF())
    h.write(`${home}/${closed}/${shut}`, PDF())
    h.write(note, `[[${name}]] [[${shut}]]\n`)
    h.write(hidden, `---\nai: false\n---\n[[${name}]]\n`)
    await h.rule(`${home}/${closed}`, { ai: false })
    const agent = h.withKey((await h.newKey('member', { name: m.aKeyName(), canWrite: false })).token)
    const get = (from: string, n: string) => agent('GET', `/api/file?note=${encodeURIComponent(from)}&name=${encodeURIComponent(n)}`)
    assert.equal((await get(note, name)).status, 200)
    assert.equal((await get(note, shut)).status, 404, 'in a folder closed to agents')
    assert.notEqual((await get(hidden, name)).status, 200, 'through a note hidden from it')
    const links = (await agent('GET', `/api/note/links?path=${encodeURIComponent(note)}`)).body.outgoing as any[]
    assert.deepEqual(links.map((l) => [l.status, l.file ?? null]), [['resolved', true], ['no_access', null]])
  } finally {
    h.close()
  }
})

test('files opened alone: images and PDFs are shown; an SVG, a page or anything else is downloaded', async () => {
  const h = await setup()
  try {
    const dir = h.home('member')
    const get = (p: string) => h.app.request(`/api/file?path=${encodeURIComponent(p)}`, { headers: { cookie: h.cookie('member') } })
    // Literal names: the file types are the case under test.
    const cases: [string, string | Buffer, RegExp][] = [
      [`${dir}/${m.aUniqueWord()}.png`, PNG, /^inline/],
      [`${dir}/${m.aUniqueWord()}.pdf`, PDF(), /^inline/],
      [`${dir}/${m.aUniqueWord()}.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /^attachment/],
      [`${dir}/${m.aUniqueWord()}.html`, '<script>alert(1)</script>', /^attachment/],
    ]
    for (const [p, bytes, disposition] of cases) {
      h.write(p, bytes)
      const r = await get(p)
      assert.equal(r.status, 200, p)
      assert.match(r.headers.get('content-disposition')!, disposition, p)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
      if (!p.endsWith('.pdf')) assert.match(r.headers.get('content-security-policy')!, /sandbox/, p)
    }
  } finally {
    h.close()
  }
})
