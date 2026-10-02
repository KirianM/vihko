// «Home» (home.ts): each person's recent notes, what others changed
// in what they read, what was shared with them lately; from the history, the
// index and their notices; never anything they can't read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inShared } from './_permissions.ts'
import { setup as historySetup } from './_history.ts'
import { setup as spacesSetup } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('home, with the history: one\'s own changes are recent, the other\'s are changed by them, with their name', async () => {
  const h = await historySetup()
  try {
    const [mine, theirs] = [inShared('Plan.md'), inShared('tags.md')]
    await h.put(mine, (t) => `${t}\n${m.aSentence()}\n`, 'admin')
    await h.put(theirs, (t) => `${t}\n${m.aSentence()}\n`, 'member')
    await h.settle()
    const admin = (await h.admin('GET', '/api/home')).body
    assert.deepEqual(admin.recent.map((n: any) => n.path), [mine])
    assert.ok(admin.recent[0].title.length > 0)
    assert.ok(!Number.isNaN(Date.parse(admin.recent[0].at)))
    assert.deepEqual(admin.changed.map((n: any) => [n.path, n.by]), [[theirs, { kind: 'user', name: h.users.member.username }]])
    const member = (await h.member('GET', '/api/home')).body
    assert.deepEqual(member.recent.map((n: any) => n.path), [theirs])
    assert.deepEqual(member.changed.map((n: any) => [n.path, n.by?.name]), [[mine, h.users.admin.username]])
    assert.deepEqual(member.shared, [])
  } finally {
    await h.close()
  }
})

test('home, without a history: one\'s own space by when it changed; what others share, without a name; what was shared lately; nothing one can\'t read', async () => {
  const h = await spacesSetup()
  try {
    await h.enable()
    // The member: a note of her own, a folder shared with the other (to read), and one she keeps to herself.
    const shared = `${h.home('member')}/${m.aFolder()}`
    const [inside, own, secret] = [`${shared}/${m.aTitle()}.md`, `${h.home('member')}/${m.aTitle()}.md`, `${h.home('member')}/${m.aTitle()}.md`]
    for (const p of [inside, own, secret]) h.write(p, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    await h.rule(shared, { grants: { [h.names.other]: 'read' } })
    // A space the admin made and nobody else is in.
    const space = (await h.admin('POST', '/api/spaces', { name: m.aSpaceName() })).body.space.path as string
    const hidden = `${space}/${m.aTitle()}.md`
    h.write(hidden, `# ${m.aHeading()}\n`)

    const member = (await h.member('GET', '/api/home')).body
    assert.deepEqual(new Set(member.recent.map((n: any) => n.path)), new Set([inside, own, secret]))
    assert.deepEqual(member.changed, [], 'her own space is hers: nothing there is «others\'»')
    const other = (await h.other('GET', '/api/home')).body
    assert.deepEqual(other.recent, [])
    assert.deepEqual(other.changed.map((n: any) => [n.path, n.by]), [[inside, null]])
    // Who shared it (the rule is set by the admin here, as through the UI), and when.
    assert.deepEqual(other.shared.map((s: any) => [s.kind, s.path, s.owner, s.by]), [['folder', shared, h.names.member, h.names.admin]])
    const text = JSON.stringify(other)
    for (const p of [own, secret, hidden, space]) assert.ok(!text.includes(p), p)
    const admin = JSON.stringify((await h.admin('GET', '/api/home')).body)
    for (const p of [inside, own, secret]) assert.ok(!admin.includes(p), `the admin doesn't read ${p}`)
    // Once the other can't see the folder, it leaves their Home.
    await h.rule(shared, { grants: null })
    const after = (await h.other('GET', '/api/home')).body
    assert.deepEqual([after.changed, after.shared], [[], []])
    // An agent has no Home.
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: false })
    assert.equal((await h.withKey(key.token)('GET', '/api/home')).status, 404)
  } finally {
    h.close()
  }
})

test('home: what others changed lately is looked for among what one reads, however much else changed since', async () => {
  const h = await spacesSetup()
  try {
    // The member shares a note with the other, then the admin writes many notes of their own after it.
    const shared = `${h.home('member')}/${m.aFolder()}`
    const inside = `${shared}/${m.aTitle()}.md`
    h.write(inside, `# ${m.aHeading()}\n`)
    await h.rule(shared, { grants: { [h.names.other]: 'read' } })
    const old = new Date(Date.now() - 86_400_000)
    utimesSync(join(h.notesDir, inside), old, old)
    h.indexer.indexPaths([inside])
    const folder = `${h.home('admin')}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, folder), { recursive: true })
    const many = Array.from({ length: 450 }, (_, i) => `${folder}/${i}-${m.aUniqueWord()}.md`)
    for (const p of many) writeFileSync(join(h.notesDir, p), `# ${m.aHeading()}\n`)
    h.indexer.indexPaths(many)
    const other = (await h.other('GET', '/api/home')).body
    assert.deepEqual(other.changed.map((n: any) => n.path), [inside])
  } finally {
    h.close()
  }
})
