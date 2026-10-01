// Purging and the people who wrote: whoever else wrote in
// what goes is told, without the content (people, never agents, and never
// the one who purged); the path only while they can still read it. The admin
// purging what they can't read confirms at the moment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { ADMIN, DIR, FILES, GROUP, MEMBER, NAME, OTHER, PATH, RULES, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The member's recipe, in a folder the member manages and the group edits. */
const RECIPE = PATH.cake
const RECIPES = posix.dirname(RECIPE)
const CONFIG = RULES + `  ${yamlKey(RECIPES)}:\n    grants: { ${yamlKey(MEMBER.username)}: manage, ${yamlKey(`@${GROUP}`)}: edit }\n`

type H = Awaited<ReturnType<typeof setup>>
type As = ReturnType<H['as']>
interface Notice { code: string; id: string; path: string | null; version: boolean; by: string; at: string; actions: string[] }

async function put(as: As, path: string, add: string) {
  const cur = await as('GET', `/api/note?path=${encodeURIComponent(path)}`)
  const r = await as('PUT', `/api/note?path=${encodeURIComponent(path)}`, { text: cur.body.text + add }, { 'if-match': `"${cur.body.etag}"` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

const notices = async (as: As) => ((await as('GET', '/api/alerts')).body.alerts as Notice[]).filter((a) => a.code === 'history_purged_authored')

test('a purge tells whoever else wrote in it, people and not agents, without the content; the path only while they can read it', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enable()
    const agent = await h.newKey('other', { name: `Script de ${OTHER.username}`, canWrite: true })
    await put(h.member, RECIPE, `${m.aSentence()}\n`)
    await h.settle()
    const secret = m.aUniqueWord()
    await put(h.other, RECIPE, `${m.aSentence()} ${secret}.\n`)
    await h.settle()
    await put(h.withKey(agent.token), RECIPE, `${m.aSentence()}\n`)
    await h.settle()
    const versions = (await h.member('GET', `/api/history/versions?path=${encodeURIComponent(RECIPE)}`)).body.versions as { id: string; authors: { kind: string; name: string }[] }[]
    const others = versions.find((v) => v.authors.some((a) => a.kind === 'user' && a.name === OTHER.username))!

    // The member manages the folder: one of the other's versions goes. The other is told, by name and path.
    const one = await h.member('POST', '/api/history/purge', { path: RECIPE, version: others.id })
    assert.equal(one.status, 200, JSON.stringify(one.body))
    const [n] = await notices(h.other)
    assert.deepEqual({ ...n, id: undefined, at: undefined }, { code: 'history_purged_authored', id: undefined, at: undefined, path: RECIPE, version: true, by: MEMBER.username, actions: ['dismiss'] })
    assert.ok(!JSON.stringify(n).includes(secret), 'never the content')
    assert.deepEqual(await notices(h.member), [], 'not whoever purged')
    assert.deepEqual(await notices(h.admin), [], 'nor anyone who didn\'t write in it')

    // The whole note, after the other wrote again: told again. The agent that wrote on their behalf is not a person.
    await put(h.other, RECIPE, `${m.aSentence()}\n`)
    await h.settle()
    assert.equal((await h.member('POST', '/api/history/purge', { path: RECIPE })).status, 200)
    const both = await notices(h.other)
    assert.deepEqual(both.map((x) => [x.path, x.version]), [[RECIPE, true], [RECIPE, false]])

    // Out of the group, she can't read it any more: the notices say it neutrally.
    h.groupList[GROUP] = ['member']
    const neutral = await notices(h.other)
    assert.deepEqual(neutral.map((x) => [x.path, x.version, x.by]), [[null, true, MEMBER.username], [null, false, MEMBER.username]])
    const shown = JSON.stringify((await h.other('GET', '/api/alerts')).body)
    for (const mark of [RECIPES, `${NAME.cake}.md`, `${home(MEMBER.username)}/`]) assert.ok(!shown.includes(mark), mark)

    // Each dismisses their own, and only their own.
    assert.equal((await h.member('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 404)
    assert.equal((await h.other('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 200)
    assert.equal((await h.other('DELETE', `/api/account/notices/${neutral[0]!.id}`)).status, 404)
    assert.equal((await notices(h.other)).length, 1)
  } finally { await h.close() }
})

test('the admin purging what they can\'t read confirms at the moment; what they can read, not', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await put(h.other, PATH.otherNotes, `${m.aSentence()}\n`)
    await put(h.other, PATH.list, `${m.aSentence()}\n`)
    await h.settle()

    // The other's own note: the admin can't read it.
    const versionsOf = async () => (await h.other('GET', `/api/history/versions?path=${encodeURIComponent(PATH.otherNotes)}`)).body.versions.length as number
    const before = await versionsOf()
    assert.ok(before > 0)
    const dry = await h.admin('POST', '/api/history/purge', { path: PATH.otherNotes, dryRun: true })
    assert.deepEqual([dry.status, dry.body.confirmRequired], [200, true])
    const missing = await h.admin('POST', '/api/history/purge', { path: PATH.otherNotes })
    assert.deepEqual([missing.status, missing.body.error, missing.body.with], [400, 'confirmation_required', 'password'])
    assert.equal((await h.admin('POST', '/api/history/purge', { path: PATH.otherNotes, confirm: m.aPassword() })).body.error, 'wrong_password')
    assert.equal(await versionsOf(), before, 'nothing purged yet')
    assert.equal((await h.admin('POST', '/api/history/purge', { path: PATH.otherNotes, confirm: ADMIN.password })).status, 200)
    const [told] = await notices(h.other)
    assert.deepEqual([told!.path, told!.version, told!.by], [PATH.otherNotes, false, ADMIN.username], 'the other can read it: its path')

    // A folder with something he can't read under it confirms too; a note he reads, not.
    assert.equal((await h.admin('POST', '/api/history/purge', { path: DIR.people, dryRun: true })).body.confirmRequired, true)
    const shared = await h.admin('POST', '/api/history/purge', { path: PATH.list, dryRun: true })
    assert.equal(shared.body.confirmRequired, false)
    assert.equal((await h.admin('POST', '/api/history/purge', { path: PATH.list })).status, 200)
    assert.equal((await notices(h.other)).length, 2)
    // Whoever manages a note purges it with no confirmation: it's theirs to read.
    const own = await h.member('POST', '/api/history/purge', { path: RECIPE, dryRun: true })
    assert.equal(own.body.confirmRequired, false)
  } finally { await h.close() }
})
