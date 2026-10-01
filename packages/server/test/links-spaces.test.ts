// Links under the spaces model (D-056, spec §4), through the HTTP API and the
// operations agents use, over the new layout: a member's personal space
// with a folder shared with someone else, a shared space, and the other
// person's own space.
// - A link to what someone can't read is, for them and for their agents,
//   exactly a link to a note that doesn't exist (D-056.15): writing links or
//   naming paths never tells anyone what exists.
// - A name never resolves out of its space; a path from the notes root does.
// - Moving a note or a folder to another space keeps every link on its note
//   (paths from the root with the name shown, as Obsidian reads them), and
//   copies the images it would leave behind, only those whoever moves it can read.
// - A rewrite that fails: the old name as an alias only where it helps (the
//   same space); the rest is tried again after the next rescan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { DEFAULT_ATTACHMENTS_SUFFIX, readFrontmatter } from '@vihko/core'
import { Auth, Indexer, NoteError, NoteService, Notices, Profiles, RelinkRetries, Workspace, createServer, openIndex, openState, type RelinkRetry, type Runtime } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { yamlKey } from './_permissions.ts'
import { create, type Person } from './_people.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const ROLES = ['admin', 'member', 'other'] as const
type Role = typeof ROLES[number]

/**
 * The scenario's names, new for every setup: the member's space with a
 * folder shared with `other` (edit) and another one (read), a shared space of the member (edit) and
 * the admin (manage), and each one's own space.
 */
function scenario() {
  const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser(), other: m.aUser() }
  const homeName = m.aSpaceName()
  const home = `spaces/${m.aSpaceFolder(homeName)}`
  const space = { admin: `people/${people.admin.username}`, member: `people/${people.member.username}`, other: `people/${people.other.username}` }
  const trips = `${space.member}/${m.aFolder()}`
  const recipes = `${space.member}/${m.aFolder()}`
  const rules = `permissions:
  ${yamlKey(home)}:
    name: ${JSON.stringify(homeName)}
    grants: { ${yamlKey(people.member.username)}: edit, ${yamlKey(people.admin.username)}: manage }
  ${yamlKey(trips)}:
    grants: { ${yamlKey(people.other.username)}: edit }
  ${yamlKey(recipes)}:
    grants: { ${yamlKey(people.other.username)}: read }
`
  return { people, home, homeName, space, trips, recipes, rules }
}
type Scenario = ReturnType<typeof scenario>

async function setup(files: (s: Scenario) => Record<string, string | Buffer>, opts: { onGaveUp?: (e: RelinkRetry) => void } = {}) {
  const s = scenario()
  const dir = tempDir('vihko-links-spaces-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir)
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(notesDir, path)), { recursive: true })
    writeFileSync(join(notesDir, path), content)
  }
  for (const root of Object.values(s.space)) mkdirSync(join(notesDir, root), { recursive: true })
  mkdirSync(join(notesDir, s.home), { recursive: true })
  writeFileSync(join(notesDir, 'vihko.yaml'), s.rules)
  for (const [p, c] of Object.entries(files(s))) write(p, c)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  // As main.ts wires it: a move's links given up tell whoever made it.
  const notices = new Notices(state)
  const notes = new NoteService({
    notesDir, stateDir, indexer, db: index, attachments: () => workspace.config.attachments,
    retries: new RelinkRetries({ stateDir }),
    onRelinkGaveUp: (e) => { opts.onGaveUp?.(e); notices.relinkGaveUp(e.reason.by) },
  })
  const { app, services } = createServer({ auth, profiles: new Profiles(state), workspace, notes, index, indexer, notesDir, runtime, notices, permissionsModel: 'spaces' })
  const users = {} as Record<Role, Person>
  for (const r of ROLES) users[r] = await create(auth, s.people[r])
  runtime.rescan({})
  const cookies = {} as Record<Role, string>
  for (const r of ROLES) {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: users[r].username, password: users[r].password }) })
    cookies[r] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  const as = (r: Role) => async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: cookies[r], ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, body: json, text }
  }
  /** What an agent of `r` (a key that may write, in every folder) reaches. */
  const agent = (r: Role) => services.scoped(services.policy.for({ kind: 'agent', user: users[r], key: { id: m.anId(), name: m.aKeyName(), canWrite: true, folders: [] }, via: 'mcp' }))
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  /** A note's text without its frontmatter (a moved note gets its `uid`). */
  const body = (p: string) => read(p).replace(/^---\n[\s\S]*?\n---\n/, '')
  return { s, dir, notesDir, notes, indexer, runtime, workspace, as, agent, read, body, write, users, has: (p: string) => existsSync(join(notesDir, p)) }
}

const q = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`
const noMd = (p: string) => p.slice(0, -3)
const byRaw = (list: { raw: string }[]): Record<string, any> => Object.fromEntries(list.map((l) => [l.raw, l]))

test('probing: a link to a note someone cannot read is, for them and their agent, exactly one to a note that does not exist', async () => {
  const secret = m.aTitle()
  const absent = m.aTitle()
  const probe = m.aTitle()
  const h = await setup((s) => ({
    [`${s.space.member}/${secret}.md`]: `# ${secret}\n${m.aParagraph()}\n`,
    [`${s.space.other}/${probe}.md`]: `[[${s.space.member}/${secret}]] and [[${s.space.member}/${absent}]]\n`,
  }))
  const { s } = h
  const probePath = `${s.space.other}/${probe}.md`
  const hidden = `[[${s.space.member}/${secret}]]`
  const none = `[[${s.space.member}/${absent}]]`
  // The person: both broken, alike but for what they wrote.
  const r = await h.as('other')('GET', q('/api/note/links', { path: probePath }))
  assert.equal(r.status, 200, r.text)
  const out = byRaw(r.body.outgoing)
  const shape = (l: any) => ({ ...l, raw: undefined, target: undefined, posFrom: undefined })
  assert.deepEqual(shape(out[hidden]), shape(out[none]))
  assert.equal(out[hidden].status, 'missing')
  assert.deepEqual(r.body.titles, {})
  // The owner sees it resolved: the link means the same for everyone, only what each may see differs.
  const own = (await h.as('member')('GET', q('/api/note/links', { path: `${s.space.member}/${secret}.md` }))).body.backlinks.map((b: any) => b.path)
  assert.deepEqual(own, [], 'a note one cannot read is never a backlink')
  // Reading it, or one that isn't there: the same answer.
  const a = await h.as('other')('GET', q('/api/note', { path: `${s.space.member}/${secret}.md` }))
  const b = await h.as('other')('GET', q('/api/note', { path: `${s.space.member}/${absent}.md` }))
  assert.deepEqual([a.status, a.body.error], [404, 'not_found'])
  assert.equal(b.text.replace(absent, secret), a.text)
  // Their agent: `missing` from resolve_link, `not_found` naming it, the same for both.
  const ag = h.agent('other')
  const ra = ag.resolveLink(probePath, hidden)
  const rb = ag.resolveLink(probePath, none)
  assert.deepEqual({ ...ra, target: null }, { ...rb, target: null })
  assert.deepEqual([ra.status, ra.path, ra.reason], ['missing', null, null])
  const outAgent = byRaw(ag.links(probePath).outgoing)
  assert.deepEqual(shape(outAgent[hidden]), shape(outAgent[none]))
  for (const p of [`${s.space.member}/${secret}.md`, `${s.space.member}/${absent}.md`]) {
    assert.throws(() => ag.read(p), (err: any) => err.code === 'not_found', p)
  }
})

test('a folder shared from someone’s space: a name there that leads to what the reader cannot see is broken for them; backlinks only from what they read', async () => {
  const secret = m.aTitle()
  const trip = m.aTitle()
  const linker = m.aTitle()
  const [dup, absent, hiddenDir] = [m.aTitle(), m.aTitle(), m.aFolder()]
  const h = await setup((s) => ({
    [`${s.space.member}/${secret}.md`]: `# ${secret}\n[[${trip}]]\n`,
    [`${s.trips}/${trip}.md`]: `# ${trip}\n`,
    [`${s.trips}/${linker}.md`]: `[[${secret}]] [[${trip}]] [[${dup}]] [[${absent}]]\n`,
    // The same name in the other folder they were given and in one of the member's they weren't: ambiguous, for the member.
    [`${s.recipes}/${dup}.md`]: `# ${dup}\n`,
    [`${s.space.member}/${hiddenDir}/${dup}.md`]: `# ${dup}\n`,
  }))
  const { s } = h
  const linkerPath = `${s.trips}/${linker}.md`
  const tripPath = `${s.trips}/${trip}.md`
  const forOther = byRaw((await h.as('other')('GET', q('/api/note/links', { path: linkerPath }))).body.outgoing)
  const forMember = byRaw((await h.as('member')('GET', q('/api/note/links', { path: linkerPath }))).body.outgoing)
  assert.deepEqual([forOther[`[[${secret}]]`].status, forOther[`[[${secret}]]`].dstPath], ['missing', null])
  assert.deepEqual([forMember[`[[${secret}]]`].status, forMember[`[[${secret}]]`].dstPath], ['resolved', `${s.space.member}/${secret}.md`])
  assert.deepEqual([forOther[`[[${trip}]]`].status, forOther[`[[${trip}]]`].dstPath], ['resolved', tripPath])
  // Ambiguous among notes of which they can't read one: broken for them, as one to nothing; and it can't be pinned.
  assert.equal(forMember[`[[${dup}]]`].status, 'ambiguous')
  const shape = (l: any) => ({ ...l, raw: undefined, target: undefined, posFrom: undefined })
  assert.deepEqual(shape(forOther[`[[${dup}]]`]), shape(forOther[`[[${absent}]]`]))
  const pin = (raw: string) => h.as('other')('POST', '/api/note/link/pin', { path: linkerPath, raw, target: `${s.recipes}/${dup}.md` })
  const [ambiguous, broken] = [await pin(`[[${dup}]]`), await pin(`[[${absent}]]`)]
  assert.deepEqual([ambiguous.status, ambiguous.body.error], [broken.status, broken.body.error])
  assert.equal(ambiguous.text.replace(dup, absent), broken.text)
  assert.equal(h.read(linkerPath), `[[${secret}]] [[${trip}]] [[${dup}]] [[${absent}]]\n`)
  const backlinks = async (r: Role) => (await h.as(r)('GET', q('/api/note/links', { path: tripPath }))).body.backlinks.map((b: any) => b.path).sort()
  assert.deepEqual(await backlinks('other'), [linkerPath])
  assert.deepEqual(await backlinks('member'), [linkerPath, `${s.space.member}/${secret}.md`].sort())
})

test('names stay in their space; a path from the notes root reaches another space for whoever can read it', async () => {
  const list = m.aTitle()
  const mine = m.aTitle()
  const h = await setup((s) => ({
    [`${s.home}/${list}.md`]: `# ${list}\n`,
    [`${s.space.member}/${mine}.md`]: `[[${list}]] [[${s.home}/${list}|${list}]]\n`,
    [`${s.space.other}/${mine}.md`]: `[[${s.home}/${list}|${list}]]\n`,
  }))
  const { s } = h
  const member = byRaw((await h.as('member')('GET', q('/api/note/links', { path: `${s.space.member}/${mine}.md` }))).body.outgoing)
  assert.equal(member[`[[${list}]]`].status, 'missing', 'a name never reaches another space')
  assert.deepEqual([member[`[[${s.home}/${list}|${list}]]`].status, member[`[[${s.home}/${list}|${list}]]`].dstPath], ['resolved', `${s.home}/${list}.md`])
  // Someone out of the space: broken, as if it didn't exist.
  const other = byRaw((await h.as('other')('GET', q('/api/note/links', { path: `${s.space.other}/${mine}.md` }))).body.outgoing)
  assert.equal(other[`[[${s.home}/${list}|${list}]]`].status, 'missing')
  // Backlinks of the list, across spaces: only from notes each one reads.
  const back = (await h.as('admin')('GET', q('/api/note/links', { path: `${s.home}/${list}.md` }))).body.backlinks.map((b: any) => b.path)
  assert.deepEqual(back, [], 'the admin reads neither the member’s nor the other’s notes')
  const backMember = (await h.as('member')('GET', q('/api/note/links', { path: `${s.home}/${list}.md` }))).body.backlinks.map((b: any) => b.path)
  assert.deepEqual(backMember, [`${s.space.member}/${mine}.md`])
})

test('moving a note to a shared space: its names become paths from the root, links to it follow it from every space, and the report names nothing hidden', async () => {
  const note = m.aTitle()
  const plan = m.aTitle()
  const diary = m.aTitle()
  const adminNote = m.aTitle()
  const h = await setup((s) => ({
    [`${s.space.member}/${note}.md`]: `# ${note}\n[[${plan}]] ![[${plan}]]\n`,
    [`${s.space.member}/${plan}.md`]: `# ${plan}\n`,
    [`${s.space.member}/${m.aFolder()}/${diary}.md`]: `[[${note}]]\n`,
    [`${s.space.admin}/${adminNote}.md`]: `[[${s.space.member}/${note}|${note}]]\n`,
  }))
  const { s } = h
  const from = `${s.space.member}/${note}.md`
  const to = `${s.home}/${note}.md`
  const diaryPath = (await h.as('member')('GET', '/api/tree')).body.notes.map((n: any) => n.path).find((p: string) => p.endsWith(`/${diary}.md`))
  const preview = await h.as('member')('POST', '/api/note/move', { from, to, dryRun: true })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.body.hidden, true, 'links in notes the member cannot see are rewritten too: said, never which')
  assert.ok(!preview.text.includes(s.space.admin), 'nothing of the admin’s space in the member’s report')
  // What the move writes as paths from the root, where the member sees it: the diary's link to it, its own two to the plan.
  assert.deepEqual(preview.body.crossSpaceLinks, { path: noMd(to), incoming: 1, outgoing: 2 })
  const moved = await h.as('member')('POST', '/api/note/move', { from, to })
  assert.equal(moved.status, 200, moved.text)
  const planRoot = `${s.space.member}/${plan}`
  assert.equal(h.body(to), `# ${note}\n[[${planRoot}|${plan}]] ![[${planRoot}]]\n`)
  assert.equal(h.body(diaryPath), `[[${noMd(to)}|${note}]]\n`)
  assert.equal(h.body(`${s.space.admin}/${adminNote}.md`), `[[${noMd(to)}|${note}]]\n`)
  for (const p of [to, diaryPath, `${s.space.admin}/${adminNote}.md`]) assert.ok(!h.read(p).includes('[[/'), `no leading slash in ${p}`)
  // Everything still leads where it led.
  const outgoing = (await h.as('member')('GET', q('/api/note/links', { path: to }))).body.outgoing
  assert.deepEqual(outgoing.map((l: any) => l.dstPath), [`${planRoot}.md`, `${planRoot}.md`])
  const back = (await h.as('admin')('GET', q('/api/note/links', { path: to }))).body.backlinks.map((b: any) => b.path)
  assert.deepEqual(back, [`${s.space.admin}/${adminNote}.md`])
})

test('the images a note would leave behind in the space it leaves are copied, only those whoever moves it can read', async () => {
  const note = m.aTitle()
  const sibling = m.aTitle()
  const [shared, own, far, hidden] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()].map((n) => `${n}.png`)
  const [privateDir, sub] = [m.aUniqueWord(), m.aUniqueWord()]
  const h = await setup((s) => ({
    // In the folder shared with `other`: an image the note shares with a sibling, one only it uses, one elsewhere in the
    // folder, and one of the member's that `other` can't read.
    [`${s.trips}/${note}.md`]: `![](${shared}) ![](${own}) ![](${sub}/${far}) ![](../${privateDir}/${hidden})\n`,
    [`${s.trips}/${sibling}.md`]: `![](${shared})\n`,
    [`${s.trips}/${shared}`]: PNG,
    [`${s.trips}/${own}`]: PNG,
    [`${s.trips}/${sub}/${far}`]: PNG,
    [`${s.space.member}/${privateDir}/${hidden}`]: PNG,
  }))
  const { s } = h
  const from = `${s.trips}/${note}.md`
  const to = `${s.space.other}/${note}.md`
  const preview = await h.as('other')('POST', '/api/note/move', { from, to, dryRun: true })
  assert.equal(preview.status, 200, preview.text)
  assert.deepEqual(preview.body.images.moved, [{ from: `${s.trips}/${own}`, to: `${s.space.other}/${own}` }])
  assert.deepEqual(preview.body.images.copied, [
    { from: `${s.trips}/${shared}`, to: `${s.space.other}/${shared}` },
    { from: `${s.trips}/${sub}/${far}`, to: `${s.space.other}/${far}` },
  ])
  assert.deepEqual(preview.body.images.stayed, [], 'what they cannot read is not named')
  const r = await h.as('other')('POST', '/api/note/move', { from, to })
  assert.equal(r.status, 200, r.text)
  assert.equal(h.body(to), `![](${shared}) ![](${own}) ![](${far}) ![](../${s.people.member.username}/${privateDir}/${hidden})\n`)
  assert.ok(h.has(`${s.trips}/${shared}`) && h.has(`${s.trips}/${sub}/${far}`), 'the originals stay')
  assert.ok(!h.has(`${s.trips}/${own}`), 'the one only it used goes with it')
  assert.ok(!h.has(`${s.space.other}/${hidden}`), 'never a copy of what they cannot read')
  assert.equal(h.body(`${s.trips}/${sibling}.md`), `![](${shared})\n`)
})

test('a folder taken to another space: links kept, and the images its notes use from the space it leaves copied next to them', async () => {
  const project = m.aFolder()
  const note = m.aTitle()
  const outside = m.aTitle()
  const img = `${m.aUniqueWord()}.png`
  const assets = m.aUniqueWord()
  const h = await setup((s) => ({
    [`${s.space.member}/${project}/${note}.md`]: `![](../${assets}/${img}) [[${outside}]]\n`,
    [`${s.space.member}/${assets}/${img}`]: PNG,
    [`${s.space.member}/${outside}.md`]: `[[${note}]]\n`,
  }))
  const { s } = h
  const from = `${s.space.member}/${project}`
  const to = `${s.home}/${project}`
  const preview = await h.as('member')('POST', '/api/folder/move', { from, to, dryRun: true })
  assert.equal(preview.status, 200, preview.text)
  assert.deepEqual(preview.body.images.copied, [{ from: `${s.space.member}/${assets}/${img}`, to: `${to}/${img}` }])
  assert.deepEqual(preview.body.crossSpaceLinks, { path: to, incoming: 1, outgoing: 1 })
  const r = await h.as('member')('POST', '/api/folder/move', { from, to })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.body.images, { copied: [{ from: `${s.space.member}/${assets}/${img}`, to: `${to}/${img}` }], failed: [] })
  assert.equal(h.body(`${to}/${note}.md`), `![](${img}) [[${s.space.member}/${outside}|${outside}]]\n`)
  assert.equal(h.body(`${s.space.member}/${outside}.md`), `[[${to}/${note}|${note}]]\n`)
  assert.ok(h.has(`${s.space.member}/${assets}/${img}`) && h.has(`${to}/${img}`))
})

test('D-056.21: the images copied to another space go where the attachments settings put a new image there: its space\'s folder, or the note\'s own folder of images', async () => {
  /** Where a note's first image reference leads, from the notes root. */
  const imageOf = (h: Awaited<ReturnType<typeof setup>>, note: string) => {
    const ref = /!\[[^\]]*\]\(<?([^)>]+)>?\)/.exec(h.body(note))![1]!
    return posix.join(posix.dirname(note), decodeURI(ref))
  }
  for (const mode of ['folder', 'per-note'] as const) {
    const attachments = m.aFolder()
    const [note, sibling, inside] = [m.aTitle(), m.aTitle(), m.aTitle()]
    const project = m.aFolder()
    const img = `${m.aUniqueWord()}.png`
    const h = await setup((s) => ({
      'vihko.yaml': s.rules + (mode === 'folder' ? `attachments:\n  mode: folder\n  folder: ${JSON.stringify(attachments)}\n` : 'attachments:\n  mode: per-note\n'),
      // An image two notes use (it stays), one of them in a folder that goes too.
      [`${s.space.member}/${note}.md`]: `![](${img})\n`,
      [`${s.space.member}/${sibling}.md`]: `![](${img})\n`,
      [`${s.space.member}/${project}/${inside}.md`]: `![](../${img})\n`,
      [`${s.space.member}/${img}`]: PNG,
    }))
    const { s } = h
    const where = (to: string) => (mode === 'folder' ? `${s.home}/${attachments}` : `${to.slice(0, -3)}${DEFAULT_ATTACHMENTS_SUFFIX}`)
    // A note.
    const to = `${s.home}/${note}.md`
    const preview = await h.as('member')('POST', '/api/note/move', { from: `${s.space.member}/${note}.md`, to, dryRun: true })
    assert.deepEqual(preview.body.images.copied, [{ from: `${s.space.member}/${img}`, to: `${where(to)}/${img}` }], mode)
    const r = await h.as('member')('POST', '/api/note/move', { from: `${s.space.member}/${note}.md`, to })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.images.copied, [{ from: `${s.space.member}/${img}`, to: `${where(to)}/${img}` }], mode)
    assert.ok(h.has(`${where(to)}/${img}`) && h.has(`${s.space.member}/${img}`), mode)
    assert.equal(imageOf(h, to), `${where(to)}/${img}`, `${mode}: the note links the copy`)
    // A folder.
    const folderTo = `${s.home}/${project}`
    const moved = await h.as('member')('POST', '/api/folder/move', { from: `${s.space.member}/${project}`, to: folderTo })
    assert.equal(moved.status, 200, moved.text)
    const insideTo = `${folderTo}/${inside}.md`
    const copy = moved.body.images.copied[0]?.to
    // In the space's folder, where a copy of that image already is: a name of its own.
    assert.ok(typeof copy === 'string' && copy.startsWith(`${where(insideTo)}/`) && h.has(copy), `${mode}: ${JSON.stringify(moved.body.images)}`)
    assert.equal(imageOf(h, insideTo), copy, `${mode}: the note in the folder links its copy`)
  }
})

test('a failed rewrite: the alias only where it helps (the same space); links from other spaces are retried after the next rescan', { skip: process.getuid?.() === 0 }, async () => {
  const [note, renamed, other, otherRenamed] = [m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle()]
  const [locked, lockedLater] = [m.aFolder(), m.aFolder()]
  const [inside, outside, later] = [m.aTitle(), m.aTitle(), m.aTitle()]
  const gaveUp: RelinkRetry[] = []
  const h = await setup((s) => ({
    [`${s.space.member}/${note}.md`]: `# ${note}\n`,
    [`${s.space.member}/${locked}/${inside}.md`]: `[[${note}]]\n`,
    [`${s.home}/${locked}/${outside}.md`]: `[[${s.space.member}/${note}|${note}]]\n`,
    [`${s.space.member}/${other}.md`]: `# ${other}\n`,
    [`${s.home}/${lockedLater}/${later}.md`]: `[[${s.space.member}/${other}|${other}]]\n`,
  }), { onGaveUp: (e) => gaveUp.push(e) })
  const { s } = h
  const actor = { kind: 'user' as const, id: h.users.member.id }
  const lock = (dirs: string[], mode: number) => { for (const d of dirs) chmodSync(join(h.notesDir, d), mode) }
  const lockedDirs = [`${s.space.member}/${locked}`, `${s.home}/${locked}`]
  lock(lockedDirs, 0o555)
  try {
    const r = await h.notes.move(`${s.space.member}/${note}.md`, `${s.space.member}/${renamed}.md`, { actor })
    assert.deepEqual(r.failed.map((f) => f.path).sort(), [`${s.space.member}/${locked}/${inside}.md`, `${s.home}/${locked}/${outside}.md`].sort())
    assert.equal(r.aliasAdded, note, 'the link by name in its own space still resolves through the alias')
    assert.deepEqual(readFrontmatter(h.read(`${s.space.member}/${renamed}.md`)).data.aliases, [note])
    // Still locked when retried: given up, and said (only what no alias stands in for).
    await h.notes.retryRelinks()
    assert.deepEqual(gaveUp.map((e) => e.sources), [[`${s.home}/${locked}/${outside}.md`]])
  } finally {
    lock(lockedDirs, 0o755)
  }
  // Locked only at the move: the next rescan's retry fixes it.
  lock([`${s.home}/${lockedLater}`], 0o555)
  try {
    const r = await h.notes.move(`${s.space.member}/${other}.md`, `${s.space.member}/${otherRenamed}.md`, { actor })
    assert.deepEqual(r.failed.map((f) => f.path), [`${s.home}/${lockedLater}/${later}.md`])
    assert.equal(r.aliasAdded, null, 'an alias would not reach a link from another space')
  } finally {
    lock([`${s.home}/${lockedLater}`], 0o755)
  }
  h.runtime.rescan({})
  await h.notes.retryRelinks()
  assert.equal(h.body(`${s.home}/${lockedLater}/${later}.md`), `[[${s.space.member}/${otherRenamed}|${otherRenamed}]]\n`)
  assert.equal(gaveUp.length, 1, 'nothing more given up')
  await h.notes.retryRelinks()
  assert.equal(gaveUp.length, 1, 'each failure is retried once')
  // Whoever moved it is told, with nothing of the notes: no path, name or count.
  const alerts = (await h.as('member')('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'links_not_updated')
  assert.equal(alerts.length, 1)
  assert.deepEqual(Object.keys(alerts[0]).sort(), ['actions', 'at', 'code', 'id'])
  assert.deepEqual((await h.as('other')('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code === 'links_not_updated'), [])
})

/**
 * The residual leak of D-056.20, as D-056.28 leaves it: `member` shares a
 * folder (the trip) with `other`; a note of the member's outside it (the
 * budget) is what a link by name in the trip leads to. A rename or a move by
 * `other` that would have to rewrite that link (in a note they read, so
 * naming the budget to them) is refused exactly as a taken name, for them
 * and their agent; the preview doesn't check, and names nothing hidden.
 */
async function residual() {
  const [finance, budget, plan, draft, notesName, taken, takenMine] = [m.aFolder(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle()]
  const h = await setup((s) => ({
    [`${s.space.member}/${finance}/${budget}.md`]: `# ${budget}\n`,
    [`${s.trips}/${plan}.md`]: `[[${budget}]]\n`,
    [`${s.trips}/${draft}.md`]: `# ${draft}\n`,
    [`${s.trips}/${notesName}.md`]: `${m.aSentence()} [[${budget}]]\n`,
    [`${s.trips}/${taken}.md`]: `# ${taken}\n`,
    [`${s.space.other}/${takenMine}.md`]: `# ${takenMine}\n`,
  }))
  const { s } = h
  const p = {
    budget: `${s.space.member}/${finance}/${budget}.md`, plan: `${s.trips}/${plan}.md`, draft: `${s.trips}/${draft}.md`,
    notes: `${s.trips}/${notesName}.md`, taken: `${s.trips}/${taken}.md`, takenMine: `${s.space.other}/${takenMine}.md`,
    renameTo: `${s.trips}/${budget}.md`, moveTo: `${s.space.other}/${notesName}.md`,
  }
  return { h, s, p, budget, finance }
}

test('D-056.20/.28: a rename or move that would rewrite, in a note the actor reads, a link to a note they can’t read answers as a taken name; the preview doesn’t check and names nothing hidden', async () => {
  const { h, p, budget, finance } = await residual()
  const before = [p.plan, p.draft, p.notes].map((x) => h.read(x))
  const move = (from: string, to: string, dryRun: boolean) => h.as('other')('POST', '/api/note/move', { from, to, dryRun })
  // What a real taken name answers, with the path echoed as the request's.
  const same = (a: { status: number; text: string }, b: { status: number; text: string }, aTo: string, bTo: string) => {
    assert.equal(a.status, 409, a.text)
    assert.equal(JSON.parse(a.text).error, 'exists')
    assert.deepEqual([a.status, a.text.replaceAll(aTo, bTo)], [b.status, b.text])
  }
  // Rename: `draft` would take the name the plan's link finds in the budget.
  same(await move(p.draft, p.renameTo, false), await move(p.draft, p.taken, false), p.renameTo, p.taken)
  // Move: `notes` links the budget by name; out of the member's space the link would have to name it.
  same(await move(p.notes, p.moveTo, false), await move(p.notes, p.takenMine, false), p.moveTo, p.takenMine)
  // The preview answers with its plan, the rewrite that would name the budget left out.
  for (const [from, to] of [[p.draft, p.renameTo], [p.notes, p.moveTo]] as const) {
    const preview = await move(from, to, true)
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.body.dryRun, true)
    assert.ok(!preview.text.includes(`${finance}/${budget}`), preview.text)
  }
  assert.deepEqual([p.plan, p.draft, p.notes].map((x) => h.read(x)), before, 'nothing written')
  assert.ok(!h.has(p.renameTo) && !h.has(p.moveTo))
  // The member reads the budget: the same rename goes through, and the plan's link keeps its note.
  const own = await h.as('member')('POST', '/api/note/move', { from: p.draft, to: p.renameTo })
  assert.equal(own.status, 200, own.text)
  assert.equal(h.body(p.plan), `[[${finance}/${budget}]]\n`)
})

test('D-056.20: an agent gets the same answer as for a taken name', async () => {
  const { h, p } = await residual()
  const agent = h.agent('other')
  const refusal = async (from: string, to: string, dryRun: boolean) => {
    try {
      await agent.move(from, to, { dryRun })
    } catch (err) {
      assert.ok(err instanceof NoteError)
      return { code: err.code, message: err.message, etag: err.etag }
    }
    assert.fail(`${from} → ${to} went through`)
  }
  const hidden = await refusal(p.draft, p.renameTo, false)
  const real = await refusal(p.draft, p.taken, false)
  assert.equal(hidden.code, 'exists')
  assert.deepEqual({ ...hidden, message: hidden.message.replace(p.renameTo, p.taken) }, real)
  const moved = await refusal(p.notes, p.moveTo, false)
  const movedReal = await refusal(p.notes, p.takenMine, false)
  assert.deepEqual({ ...moved, message: moved.message.replace(p.moveTo, p.takenMine) }, movedReal)
  // Its preview doesn't check either.
  const preview = await agent.move(p.draft, p.renameTo, { dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.ok(!JSON.stringify(preview).includes(p.budget))
  assert.ok(!h.has(p.renameTo) && !h.has(p.moveTo))
})

/**
 * D-056.28: the link at stake is in a note of the member's that `other`
 * can't read (the memo), so no rewrite of it would show them anything:
 * what `other` does goes through, and the system keeps the memo's link on
 * the member's note, without telling them.
 */
async function unseen() {
  const [finance, privy, budget, memo, draft, alias, aliased, aliasMemo] = [m.aFolder(), m.aFolder(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle(), m.aTitle()]
  const h = await setup((s) => ({
    [`${s.space.member}/${finance}/${budget}.md`]: `# ${budget}\n`,
    [`${s.space.member}/${finance}/${aliased}.md`]: `---\naliases: [${JSON.stringify(alias)}]\n---\n# ${aliased}\n`,
    [`${s.space.member}/${privy}/${memo}.md`]: `${m.aSentence()} [[${budget}]]\n`,
    [`${s.space.member}/${privy}/${aliasMemo}.md`]: `[[${alias}]]\n`,
    [`${s.trips}/${draft}.md`]: `# ${draft}\n`,
  }))
  const { s } = h
  const p = {
    budget: `${s.space.member}/${finance}/${budget}.md`, aliased: `${s.space.member}/${finance}/${aliased}.md`,
    memo: `${s.space.member}/${privy}/${memo}.md`, aliasMemo: `${s.space.member}/${privy}/${aliasMemo}.md`,
    draft: `${s.trips}/${draft}.md`, takesName: `${s.trips}/${budget}.md`,
  }
  /** Where the links in `path` lead, as the member reads them. */
  const leads = async (path: string) => (await h.as('member')('GET', q('/api/note/links', { path }))).body.outgoing.map((l: any) => [l.status, l.dstPath])
  return { h, s, p, finance, budget, alias, leads }
}

test('D-056.28: a rename whose link at stake is in a note the actor can’t read goes through, and the system keeps that link on its note', async () => {
  const { h, p, finance, budget, leads } = await unseen()
  const memoBefore = h.read(p.memo)
  // The preview is a plan like any other: nothing hidden in it.
  const preview = await h.as('other')('POST', '/api/note/move', { from: p.draft, to: p.takesName, dryRun: true })
  assert.equal(preview.status, 200, preview.text)
  assert.ok(!preview.text.includes(p.memo) && !preview.text.includes(`${finance}/${budget}`), preview.text)
  const r = await h.as('other')('POST', '/api/note/move', { from: p.draft, to: p.takesName })
  assert.equal(r.status, 200, r.text)
  assert.ok(!r.text.includes(p.memo) && !r.text.includes(`${finance}/${budget}`), r.text)
  assert.ok(h.has(p.takesName))
  // The memo's link was rewritten by the system and still leads to the budget.
  assert.notEqual(h.read(p.memo), memoBefore)
  assert.ok(h.read(p.memo).includes(`[[${finance}/${budget}]]`), h.read(p.memo))
  assert.deepEqual(await leads(p.memo), [['resolved', p.budget]])
})

test('D-056.28: creating a note, by any route, whose name would take a link in a note its person can’t read: created, and the link kept on its note', async () => {
  const { h, p, finance, budget, leads } = await unseen()
  const plain = await h.as('other')('POST', '/api/note', { path: p.takesName, text: '' })
  assert.equal(plain.status, 201, plain.text)
  // The answer is a creation's like any other: it tells nothing of the rewrite.
  const elsewhere = await h.as('other')('POST', '/api/note', { path: `${posix.dirname(p.takesName)}/${m.aTitle()}.md`, text: '' })
  assert.deepEqual(Object.keys(plain.body).sort(), Object.keys(elsewhere.body).sort())
  assert.ok(!plain.text.includes(`${finance}/${budget}`), plain.text)
  assert.ok(h.read(p.memo).includes(`[[${finance}/${budget}]]`), h.read(p.memo))
  assert.deepEqual(await leads(p.memo), [['resolved', p.budget]])
  // An agent's create_note (the scoped create the MCP tool calls), the same.
  const again = `${posix.dirname(p.takesName)}/${m.aFolder()}/${budget}.md`
  await h.agent('other').create(again, { text: '' })
  assert.ok(h.has(again))
  assert.deepEqual(await leads(p.memo), [['resolved', p.budget]])
})

test('D-056.28: an alias added by an edit is a name taken like a new note’s: refused where the actor reads the link, kept by the system where they don’t', async () => {
  const { h, p, alias, leads } = await unseen()
  const etag = async (path: string) => (await h.as('other')('GET', q('/api/note', { path }))).body.etag
  const withAlias = `---\naliases: [${JSON.stringify(alias)}]\n---\n${m.aSentence()}\n`
  // The alias memo, which `other` can't read, leads by alias to a note of the member's: the alias would make it ambiguous, so the system keeps it.
  const put = await h.as('other')('PUT', q('/api/note', { path: p.draft }), { text: withAlias }, { 'if-match': await etag(p.draft) })
  assert.equal(put.status, 200, put.text)
  assert.deepEqual(await leads(p.aliasMemo), [['resolved', p.aliased]])
  // The same link, now also in a note of the trip `other` reads: an alias added there is refused as a taken name, and nothing is written.
  const plan = `${posix.dirname(p.draft)}/${m.aTitle()}.md`
  const mine = `${posix.dirname(p.draft)}/${m.aTitle()}.md`
  h.write(plan, `[[${alias}]]\n`)
  h.write(mine, `# ${m.aTitle()}\n`)
  h.runtime.rescan({})
  const before = h.read(mine)
  const refused = await h.as('other')('PUT', q('/api/note', { path: mine }), { text: withAlias }, { 'if-match': await etag(mine) })
  assert.deepEqual([refused.status, refused.body?.error], [409, 'exists'], refused.text)
  assert.equal(h.read(mine), before)
  // By operation (the edit agents use), the same.
  const op = await h.as('other')('POST', '/api/note/edit', { path: mine, ifMatch: await etag(mine), ops: [{ op: 'set_frontmatter', key: 'aliases', value: [alias] }] })
  assert.deepEqual([op.status, op.body?.error], [409, 'exists'], op.text)
  assert.equal(h.read(mine), before)
})

test('creating from a broken link into another space, by its path from the root: there if the person may create there, otherwise a taken name’s answer whether or not anything is there', async () => {
  const { h, s, p } = await residual()
  const source = `${s.space.other}/${m.aTitle()}.md`
  h.write(source, `# ${m.aTitle()}\n`)
  h.runtime.rescan({})
  const create = (path: string) => h.as('other')('POST', '/api/note', { path, text: '', fromLink: source })
  // Into the shared trip (they edit it), and into the member's space, where they can't create: by name of what is hidden and of nothing.
  assert.equal((await create(`${s.trips}/${m.aTitle()}.md`)).status, 201)
  const hidden = await create(p.budget)
  const nothing = await create(`${s.space.member}/${m.aFolder()}/${m.aTitle()}.md`)
  const real = await create(p.taken)
  assert.deepEqual([hidden.status, hidden.body.error], [409, 'exists'], hidden.text)
  assert.equal(hidden.text.replaceAll(p.budget, p.taken), real.text)
  assert.deepEqual([nothing.status, nothing.body.error], [409, 'exists'], nothing.text)
  // Read-only there (the recipes): the same answer.
  assert.deepEqual((await create(`${s.recipes}/${m.aTitle()}.md`)).body.error, 'exists')
})

test('D-056.21: never creating from a link in a note of someone else’s personal space; from one’s own, as ever', async () => {
  const { h, s, p, budget } = await residual()
  const absent = m.aTitle()
  h.write(p.draft, `[[${absent}]]\n`)
  h.runtime.rescan({})
  const create = (r: 'member' | 'other', path: string, fromLink: string) => h.as(r)('POST', '/api/note', { path, text: '', fromLink })
  // A link that leads to the hidden budget and one that leads nowhere: the same refusal.
  const hidden = await create('other', p.renameTo, p.plan)
  const none = await create('other', `${s.trips}/${absent}.md`, p.draft)
  assert.deepEqual([hidden.status, hidden.body.error], [403, 'forbidden'])
  assert.equal(none.text, hidden.text)
  assert.ok(!h.has(p.renameTo) && !h.has(`${s.trips}/${absent}.md`))
  // From a note one can't read at all: as if it didn't exist.
  const unseen = await create('other', `${s.space.other}/${m.aTitle()}.md`, p.budget)
  assert.deepEqual([unseen.status, unseen.body.error], [404, 'not_found'])
  // The owner creates from a link in their own space; anyone from their own.
  assert.equal((await create('member', `${s.trips}/${absent}.md`, p.draft)).status, 201)
  const mine = `${s.space.other}/${m.aTitle()}.md`
  h.write(mine, `[[${budget}]]\n`)
  h.runtime.rescan({})
  assert.equal((await create('other', `${s.space.other}/${budget}.md`, mine)).status, 201)
})

test('D-056.20: creating a note whose name would take a link to what its person can’t read answers as a taken name, by every route', async () => {
  const { h, s, p } = await residual()
  const series = m.anId()
  writeFileSync(join(h.notesDir, 'vihko.yaml'), `${s.rules}daily:\n  ${series}:\n    folder: ${JSON.stringify(s.trips)}\n`)
  h.workspace.reload()
  h.runtime.rescan({})
  const other = h.as('other')
  const plan = h.read(p.plan)
  /** A refusal and a real clash: the same status and text, but for the path each asked for. */
  const same = (a: { status: number; text: string }, b: { status: number; text: string }, aPath: string, bPath: string, status: number, code: string) => {
    assert.deepEqual([a.status, JSON.parse(a.text).error], [status, code], a.text)
    assert.deepEqual([a.status, a.text.replaceAll(aPath, bPath)], [b.status, b.text])
  }
  // POST /api/note, with a text and from a template.
  same(await other('POST', '/api/note', { path: p.renameTo, text: '' }), await other('POST', '/api/note', { path: p.taken, text: '' }), p.renameTo, p.taken, 409, 'exists')
  same(await other('POST', '/api/note', { path: p.renameTo, template: p.draft }), await other('POST', '/api/note', { path: p.taken, template: p.draft }), p.renameTo, p.taken, 409, 'exists')
  // PUT with If-None-Match: *.
  const putNew = (path: string) => other('PUT', q('/api/note', { path }), { text: '' }, { 'if-none-match': '*' })
  same(await putNew(p.renameTo), await putNew(p.taken), p.renameTo, p.taken, 412, 'precondition_failed')
  // An agent's create_note (the scoped create the MCP tool calls).
  const agent = h.agent('other')
  const refusal = async (path: string) => {
    try {
      await agent.create(path, { text: '' })
    } catch (err) {
      assert.ok(err instanceof NoteError)
      return { code: err.code, message: err.message.replace(path, '<path>'), etag: err.etag }
    }
    assert.fail(`${path} was created`)
  }
  const [hidden, real] = [await refusal(p.renameTo), await refusal(p.taken)]
  assert.equal(hidden.code, 'exists')
  assert.deepEqual(hidden, real)
  // The daily note of a series in the shared folder, on a day a hidden note of the member's is named after.
  const today = (await other('GET', q('/api/daily', { series }))).body.path as string
  const day = today.slice(today.lastIndexOf('/') + 1, -3)
  h.write(`${s.space.member}/${m.aFolder()}/${day}.md`, `# ${day}\n`)
  h.write(`${s.trips}/${m.aTitle()}.md`, `[[${day}]]\n`)
  h.runtime.rescan({})
  same(await other('POST', '/api/daily', { series }), await other('POST', '/api/note', { path: p.taken, text: '' }), today, p.taken, 409, 'exists')
  // Nothing was written, and the member's links keep their notes.
  for (const x of [p.renameTo, today]) assert.ok(!h.has(x), x)
  assert.equal(h.read(p.plan), plan)
  // The member reads what those links lead to: the same creations go through.
  assert.equal((await h.as('member')('POST', '/api/note', { path: p.renameTo, text: '' })).status, 201)
  assert.equal((await h.as('member')('POST', '/api/daily', { series })).status, 201)
})

test('D-056.20: restoring from the trash where the note would take a link to what its person can’t read answers as a taken name', async () => {
  const { h, p } = await residual()
  // The member had a note with the budget's name in the trip, which the plan's link found; they delete it.
  assert.equal((await h.as('member')('POST', '/api/note', { path: p.renameTo, text: '' })).status, 201)
  assert.equal((await h.as('member')('DELETE', q('/api/note', { path: p.renameTo }))).status, 200)
  const entry = (await h.as('other')('GET', '/api/trash')).body.entries.find((e: any) => e.path === p.renameTo)
  assert.ok(entry, 'whoever edits the trip sees what was deleted there')
  const restore = (to?: string) => h.as('other')('POST', `/api/trash/${entry.id}/restore`, to === undefined ? {} : { to })
  const [hidden, real] = [await restore(), await restore(p.taken)]
  assert.deepEqual([hidden.status, hidden.body.error], [409, 'exists'], hidden.text)
  assert.equal(hidden.text.replaceAll(p.renameTo, p.taken), real.text)
  assert.ok(!h.has(p.renameTo))
  // Under a name that takes nothing it comes back; the member, who reads the budget, restores it anywhere.
  const elsewhere = p.renameTo.replace(/[^/]+\.md$/, `${m.aTitle()}.md`)
  assert.equal((await restore(elsewhere)).status, 200)
})

test('D-056.20: an alias written in any note never captures a link: names beat aliases, and a shared alias is ambiguous', async () => {
  const [alias, draft] = [m.aTitle(), m.aTitle()]
  const { h, s, p, budget } = await residual()
  // The member's budget takes an alias the plan links by; nothing else has it.
  h.write(p.budget, `---\naliases: [${JSON.stringify(alias)}]\n---\n# ${budget}\n`)
  h.write(p.plan, `[[${budget}]] [[${alias}]]\n`)
  const mine = `${s.trips}/${draft}.md`
  h.write(mine, `# ${draft}\n`)
  h.runtime.rescan({})
  const byMember = async () => byRaw((await h.as('member')('GET', q('/api/note/links', { path: p.plan }))).body.outgoing)
  assert.equal((await byMember())[`[[${alias}]]`].dstPath, p.budget)
  // The other person writes the budget's name as an alias of their note: a name beats an alias, so nothing changes and nothing is refused.
  const etag = async () => (await h.as('other')('GET', q('/api/note', { path: mine }))).body.etag
  const put = await h.as('other')('PUT', q('/api/note', { path: mine }), { text: `---\naliases: [${JSON.stringify(budget)}]\n---\n# ${draft}\n` }, { 'if-match': await etag() })
  assert.equal(put.status, 200, put.text)
  assert.deepEqual([(await byMember())[`[[${budget}]]`].status, (await byMember())[`[[${budget}]]`].dstPath], ['resolved', p.budget], 'a name beats an alias')
  // The budget's alias too: the plan's link by alias would change, and the plan is a note they read (D-056.28): a taken name.
  const refused = await h.as('other')('PUT', q('/api/note', { path: mine }), { text: `---\naliases: [${JSON.stringify(budget)}, ${JSON.stringify(alias)}]\n---\n# ${draft}\n` }, { 'if-match': await etag() })
  assert.deepEqual([refused.status, refused.body?.error], [409, 'exists'], refused.text)
  // The member, who reads the budget, writes it: the link by alias isn't taken but ambiguous between the two, which its owner sees and can fix.
  const memberEtag = (await h.as('member')('GET', q('/api/note', { path: mine }))).body.etag
  const own = await h.as('member')('PUT', q('/api/note', { path: mine }), { text: `---\naliases: [${JSON.stringify(budget)}, ${JSON.stringify(alias)}]\n---\n# ${draft}\n` }, { 'if-match': memberEtag })
  assert.equal(own.status, 200, own.text)
  const after = await byMember()
  assert.deepEqual([after[`[[${budget}]]`].status, after[`[[${budget}]]`].dstPath], ['resolved', p.budget], 'a name beats an alias')
  assert.deepEqual([after[`[[${alias}]]`].status, after[`[[${alias}]]`].candidates], ['ambiguous', [p.budget, mine].sort()])
  // For the other person, a link among notes of which one is hidden is broken, as before.
  const theirs = byRaw((await h.as('other')('GET', q('/api/note/links', { path: p.plan }))).body.outgoing)
  assert.deepEqual([theirs[`[[${alias}]]`].status, theirs[`[[${alias}]]`].dstPath, theirs[`[[${alias}]]`].candidates], ['missing', null, null])
})
