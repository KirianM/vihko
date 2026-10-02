// Templates: a new note from a template note, never overwriting; which
// notes are templates (`template: true`), who is offered them, and marking them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG, DAILY, setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { setup as spacesSetup } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** An instant as `YYYY-MM-DD HH:mm` in a timezone. */
function localTime(timeZone: string, at: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

test('templates: a new note from any template note, in the person\'s timezone', async () => {
  const now = new Date('2026-09-24T23:30:00Z') // the setup's clock
  const { notesDir, admin, runtime, users } = await setup({ config: CONFIG })
  const template = `${DAILY.templates}/${m.aTitle()}.md`
  writeFileSync(join(notesDir, template), '# {{title}}\n\n{{date:YYYY-MM-DD HH:mm}} {{user}}\n')
  runtime.rescan({})
  const zone = m.aTimeZone()
  await admin('PUT', '/api/profile', { timezone: zone })
  const title = m.aTitle()
  const path = inShared(`${m.aFolder()}/${title}.md`)
  const r = await admin('POST', '/api/note', { path, template })
  assert.equal(r.status, 201)
  assert.equal(readFileSync(join(notesDir, path), 'utf8'), `---\nuid: ${r.body.uid}\n---\n# ${title}\n\n${localTime(zone, now)} ${users.admin.username}\n`, zone)
  assert.equal((await admin('POST', '/api/note', { path, template })).body.error, 'exists')
  const other = m.aNotePath(inShared(''))
  assert.equal((await admin('POST', '/api/note', { path: other, template: `${DAILY.templates}/${m.aTitle()}.md` })).body.error, 'not_found')
  assert.equal((await admin('POST', '/api/note', { path: other, template: 3 })).body.error, 'invalid')
  assert.ok(!existsSync(join(notesDir, other)))
})

test('a marked template: the new note gets its frontmatter without the mark and the aliases (ai: false kept), byte for byte, and its variables filled in', async () => {
  const { admin, notesDir, runtime, users } = await setup({ config: CONFIG })
  const [type, comment, other] = [m.aUniqueWord(), m.aSentence(), m.aUniqueWord()]
  const template = `${DAILY.templates}/${m.aTitle()}.md`
  writeFileSync(join(notesDir, template), `---\n# ${comment}\ntype: "${type}"   # ${comment}\ntemplate: true\naliases: [${m.aUniqueWord()}]\nai: false\ntags: [${other}, '${type}']\nx-${other}: { a: 1 }\nauthor: "{{user}}"\n---\n# {{title}}\n`)
  runtime.rescan({})
  const title = m.aTitle()
  const path = inShared(`${m.aFolder()}/${title}.md`)
  const r = await admin('POST', '/api/note', { path, template })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  // The new note's own uid goes at the end of its frontmatter, as on any note.
  assert.equal(readFileSync(join(notesDir, path), 'utf8'), `---\n# ${comment}\ntype: "${type}"   # ${comment}\nai: false\ntags: [${other}, '${type}']\nx-${other}: { a: 1 }\nauthor: "${users.admin.username}"\nuid: ${r.body.uid}\n---\n# ${title}\n`)
  // The new note is no template: it is searched like any other.
  const found = (await admin('GET', `/api/search?q=${encodeURIComponent(`type:${type}`)}`)).body.results.map((x: { path: string }) => x.path)
  assert.deepEqual(found, [path])
})

test('templates are left out of search, tags and Home, not out of the tree (marked there) or of opening them; asked by their mark, they are found', async () => {
  const { admin, notesDir, runtime } = await setup({ config: CONFIG })
  const [word, tag] = [m.aUniqueWord(), m.aTag()]
  const template = inShared(`${m.aFolder()}/${m.aTitle()}.md`)
  const note = inShared(`${m.aTitle()}.md`)
  mkdirSync(join(notesDir, template, '..'), { recursive: true })
  writeFileSync(join(notesDir, template), `---\ntemplate: true\ntags: [${tag}]\ndate: {{date}}\n---\n# {{title}}\n\n${word}\n`)
  writeFileSync(join(notesDir, note), `---\ntags: [${tag}]\n---\n# ${m.aHeading()}\n\n${word}\n`)
  runtime.rescan({})
  const found = async (q: string) => ((await admin('GET', `/api/search?q=${encodeURIComponent(q)}`)).body.results as { path: string }[]).map((r) => r.path)
  assert.deepEqual(await found(word), [note])
  assert.deepEqual(await found(`tag:${tag}`), [note])
  // Its folder named is no longer asking for templates: only its mark is.
  assert.deepEqual(await found(`${word} path:"${template.slice(0, template.lastIndexOf('/'))}"`), [])
  assert.deepEqual(await found(`${word} template:true`), [template])
  assert.deepEqual(await found(`prop:template tag:${tag}`), [template])
  assert.deepEqual(await found(`tag:${tag} -template:true`), [note])
  // Tags count only the note.
  const tags = (await admin('GET', '/api/tags')).body.tags as { tag: string; count: number }[]
  assert.equal(tags.find((t) => t.tag === tag)?.count, 1)
  // Home doesn't list it.
  assert.ok(!JSON.stringify((await admin('GET', '/api/home')).body).includes(template))
  // The tree and opening it: as any note, marked in the tree.
  const tree = (await admin('GET', '/api/tree')).body.notes as { path: string; template?: true }[]
  assert.equal(tree.find((n) => n.path === template)?.template, true)
  assert.ok(!('template' in tree.find((n) => n.path === note)!))
  assert.equal((await admin('GET', `/api/note?path=${encodeURIComponent(template)}`)).status, 200)
})

test('the templates offered: the marked notes each person reads, in their own space and their shared spaces; nothing they can\'t read', async () => {
  const h = await spacesSetup()
  try {
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName(), members: { [h.names.other]: 'edit' } })).body.space.path as string
    const mine = `${h.home('member')}/${m.aFolder()}/${m.aTitle()}.md`
    const ours = `${space}/${m.aTitle()}.md`
    const theirs = `${h.home('other')}/${m.aTitle()}.md`
    const admins = `${h.home('admin')}/${m.aTitle()}.md`
    const unmarked = `${h.home('member')}/${m.aTitle()}.md`
    for (const p of [mine, ours, theirs, admins]) h.write(p, `---\ntemplate: true\n---\n# {{title}}\n`)
    h.write(unmarked, `---\ntemplate: false\n---\n# {{title}}\n`)
    const offered = async (who: 'admin' | 'member' | 'other') => (((await h.as(who)('GET', '/api/tree')).body.notes) as { path: string; template?: true }[]).filter((n) => n.template).map((n) => n.path).sort()
    assert.deepEqual(await offered('member'), [mine, ours].sort())
    assert.deepEqual(await offered('other'), [ours, theirs].sort())
    assert.deepEqual(await offered('admin'), [admins])
    // Someone else's template can't be used by naming it: as a note that doesn't exist.
    const r = await h.other('POST', '/api/note', { path: `${h.home('other')}/${m.aTitle()}.md`, template: mine })
    assert.equal(r.body.error, 'not_found')
  } finally {
    h.close()
  }
})

test('making a note a template and back touches only the mark, through the normal write; marking a folder previews, then marks each note', async () => {
  const h = await spacesSetup()
  try {
    await h.enable()
    const folder = `${h.home('member')}/${m.aFolder()}`
    const [type, comment] = [m.aUniqueWord(), m.aSentence()]
    const plain = `${folder}/${m.aTitle()}.md`
    const nested = `${folder}/${m.aFolder()}/${m.aTitle()}.md`
    const marked = `${folder}/${m.aTitle()}.md`
    const broken = `${folder}/${m.aTitle()}.md`
    const outside = `${h.home('member')}/${m.aTitle()}.md`
    const texts: Record<string, string> = {
      [plain]: `---\n# ${comment}\ntype: ${type}   # ${comment}\n---\n# {{title}}\n`,
      [nested]: `# {{title}}\n\n${m.aSentence()}\n`,
      [marked]: `---\ntemplate: true\n---\n# {{title}}\n`,
      [broken]: `---\ntype: [${type}\n---\n# {{title}}\n`,
      [outside]: `# ${m.aHeading()}\n`,
    }
    for (const [p, t] of Object.entries(texts)) h.write(p, t)
    // Any write gives a note without a uid its uid (at the end of its frontmatter): left out here.
    const read = (p: string) => readFileSync(join(h.notesDir, p), 'utf8').replace(/^uid: \S+\n/m, '').replace(/^---\n---\n/, '')
    // One note, and back.
    const on = await h.member('POST', '/api/note/template', { path: outside, template: true })
    assert.equal(on.status, 200, on.text)
    assert.equal(read(outside), `---\ntemplate: true\n---\n${texts[outside]}`)
    assert.equal((await h.member('POST', '/api/note/template', { path: outside, template: false })).status, 200)
    assert.equal(read(outside), texts[outside])
    // The folder: first what it would do, writing nothing.
    const preview = await h.member('POST', '/api/folder/templates', { path: folder, dryRun: true })
    assert.deepEqual([preview.status, preview.body], [200, { marked: 2, already: 1, skipped: 1 }], preview.text)
    assert.deepEqual(Object.keys(texts).map(read), Object.values(texts))
    const done = await h.member('POST', '/api/folder/templates', { path: folder })
    assert.deepEqual(done.body, { marked: 2, already: 1, skipped: 1 })
    assert.equal(read(plain), `---\n# ${comment}\ntype: ${type}   # ${comment}\ntemplate: true\n---\n# {{title}}\n`)
    assert.equal(read(nested), `---\ntemplate: true\n---\n${texts[nested]}`)
    assert.equal(read(marked), texts[marked])
    assert.equal(read(broken), texts[broken])
    assert.equal(read(outside), texts[outside], 'nothing out of the folder')
    // The tree marks them.
    const tree = ((await h.member('GET', '/api/tree')).body.notes as { path: string; template?: true }[]).filter((n) => n.template).map((n) => n.path).sort()
    assert.deepEqual(tree, [plain, nested, marked].sort())
    // Someone who can't write there: nothing (a folder they don't see doesn't exist for them).
    const theirs = await h.other('POST', '/api/folder/templates', { path: folder, dryRun: true })
    assert.equal(theirs.status, 404)
    assert.equal((await h.other('POST', '/api/note/template', { path: plain, template: false })).status, 404)
    // Not for a key: it writes the mark as any frontmatter key.
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    assert.equal((await h.withKey(key.token)('POST', '/api/folder/templates', { path: folder })).status, 404)
    assert.equal((await h.member('POST', '/api/note/template', { path: plain, template: 'yes' })).status, 400)
    assert.equal((await h.member('POST', '/api/folder/templates', { path: plain })).status, 400)
  } finally {
    h.close()
  }
})
