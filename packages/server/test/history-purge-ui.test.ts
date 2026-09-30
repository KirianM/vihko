// Purging from the UI while vihko runs (D-038.9), in process: whoever manages
// the folder, a note or one of its versions and nothing else; the admin, any
// path by its name; the history paused and resumed, writes made meanwhile
// kept; the admin's notice, without the content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Git } from '@vihko/server'
import { posix } from 'node:path'
import { ADMIN, FILES, MEMBER, OTHER, PATH, RULES, WORD, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The member's recipe, in a folder the member manages, the admin comments on and the other reads. */
const RECIPE = PATH.cake
const DIARY = PATH.diary
const SHARED = RULES + `  ${yamlKey(posix.dirname(RECIPE))}:\n    grants: { ${yamlKey(MEMBER.username)}: manage, ${yamlKey(ADMIN.username)}: comment, ${yamlKey(OTHER.username)}: read }\n`

type As = ReturnType<Awaited<ReturnType<typeof setup>>['as']>

async function put(as: As, path: string, edit: (t: string) => string) {
  const cur = await as('GET', `/api/note?path=${encodeURIComponent(path)}`)
  const r = await as('PUT', `/api/note?path=${encodeURIComponent(path)}`, { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

/** Every object in the managed repository, reachable or not, with its contents. */
async function objects(stateDir: string): Promise<string> {
  return (await new Git({ gitDir: join(stateDir, 'history.git') }).run(['cat-file', '--batch-all-objects', '--batch'])).stdout.toString('latin1')
}

test('whoever manages a folder purges a version of a note in it from the UI: gone from the repository, nothing else touched; the admin gets a notice without the content', async () => {
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const SECRET = m.aSecret()
    const instead = m.aSentence()
    await put(h.member, DIARY, (t) => t + `${SECRET}\n`)
    await h.settle()
    await put(h.member, DIARY, (t) => t.replace(`${SECRET}\n`, `${instead}\n`))
    await h.settle()
    await put(h.member, PATH.list, (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    const versionsOf = async (path: string, as: As = h.member) => (await as('GET', `/api/history/versions?path=${encodeURIComponent(path)}`)).body.versions as { id: string }[]
    const [, secret] = await versionsOf(DIARY)
    const list = (await versionsOf(PATH.list)).length
    assert.ok((await objects(h.stateDir)).includes(SECRET))

    // Not hers to purge: someone else's, or a note she edits without managing it.
    assert.equal((await h.member('POST', '/api/history/purge', { path: PATH.adminPlan, dryRun: true })).status, 404)
    assert.equal((await h.member('POST', '/api/history/purge', { path: PATH.list, dryRun: true })).status, 403)
    assert.equal((await h.other('POST', '/api/history/purge', { path: RECIPE, dryRun: true })).status, 403)
    assert.equal((await h.admin('POST', '/api/history/purge', { path: 'vihko.yaml', dryRun: true })).status, 200, 'the admin, any path by name')
    assert.equal((await h.member('POST', '/api/history/purge', { path: 'vihko.yaml', dryRun: true })).status, 400, 'a note, not vihko.yaml')

    // The confirmation: what goes, without the content.
    const dry = await h.member('POST', '/api/history/purge', { path: DIARY, version: secret!.id, dryRun: true })
    assert.equal(dry.status, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.dryRun, true)
    assert.ok(dry.body.versions.length >= 1)
    assert.ok(!JSON.stringify(dry.body).includes(SECRET))
    assert.ok((await objects(h.stateDir)).includes(SECRET), 'a dry run changes nothing')

    // «Recent changes» seen before (its authors are remembered up to the history's head then).
    assert.equal((await h.admin('GET', '/api/history/changes')).status, 200)
    const run = await h.member('POST', '/api/history/purge', { path: DIARY, version: secret!.id })
    assert.equal(run.status, 200, JSON.stringify(run.body))
    // …still answers after the purge rewrote the history under it, that head included.
    const after = await h.admin('GET', '/api/history/changes')
    assert.equal(after.status, 200, JSON.stringify(after.body))
    assert.ok(after.body.authors.some((a: { name?: string }) => a.name === MEMBER.username), JSON.stringify(after.body.authors))
    assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'nothing of it left in the repository')
    assert.equal((await versionsOf(PATH.list)).length, list, 'the other notes keep their versions')
    assert.ok(readFileSync(join(h.notesDir, DIARY), 'utf8').includes(instead), 'the note itself is untouched')

    // The history goes on: a write after the purge is a version.
    await put(h.member, PATH.list, (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    assert.equal((await versionsOf(PATH.list)).length, list + 1)

    // The admin is told who and what, never the content; nobody else. Where the
    // admin can't read (the member's diary), not even the path (D-056.24).
    const alerts = async (as: As) => ((await as('GET', '/api/alerts')).body.alerts as { code: string; id: string; path: string | null; version: string | null; by: string }[]).filter((a) => a.code === 'history_purged')
    const notices = await alerts(h.admin)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.path, null)
    assert.ok(!JSON.stringify(notices).includes(DIARY))
    assert.match(notices[0]!.version ?? '', /^[0-9a-f]{40}$/)
    assert.ok(notices[0]!.version!.startsWith(secret!.id.slice(0, 7)))
    assert.equal(notices[0]!.by, MEMBER.username)
    assert.ok(!JSON.stringify(notices).includes(SECRET))
    assert.deepEqual(await alerts(h.member), [])
    assert.deepEqual(await alerts(h.other), [])
    assert.equal((await h.member('DELETE', `/api/history/purges/${notices[0]!.id}`)).status, 403)
    assert.equal((await h.admin('DELETE', `/api/history/purges/${notices[0]!.id}`)).status, 200)
    assert.deepEqual(await alerts(h.admin), [])

    // Where the admin reads (the recipe, shared with them to comment), the path is named.
    await put(h.member, RECIPE, (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    assert.equal((await h.member('POST', '/api/history/purge', { path: RECIPE })).status, 200)
    assert.deepEqual((await alerts(h.admin)).map((a) => [a.path, a.by]), [[RECIPE, MEMBER.username]])
  } finally { await h.close() }
})

test('a manager purges a note\'s whole history (that file alone); the admin purges a folder he can\'t read by its name; notes written meanwhile keep their versions', async () => {
  const OLD = m.aNotePath(home(OTHER.username))
  // What the other writes, where the admin purging their folder can't read it: never in the answer, nor left in the repository.
  const [more, older] = [m.aSecret(), m.aSecret()]
  const h = await setup({ files: { ...FILES, [OLD]: `# ${m.aHeading()}\n` }, config: SHARED })
  try {
    await put(h.member, DIARY, (t) => t + `${m.aSentence()}\n`)
    await put(h.other, PATH.otherNotes, (t) => t + `${more}\n`)
    await put(h.other, OLD, (t) => t + `${older}\n`)
    await h.settle()
    const versionsOf = async (path: string, as: As) => (await as('GET', `/api/history/versions?path=${encodeURIComponent(path)}`)).body.versions as unknown[]

    // The member: that note alone, never what's next to it.
    const r = await h.member('POST', '/api/history/purge', { path: DIARY })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.onDisk, 1, 'still in the folder: it enters again with its next version')
    assert.deepEqual(await versionsOf(DIARY, h.member), [])
    await h.history.recorder.sweep('periodic')
    await h.settle()
    assert.deepEqual(await versionsOf(DIARY, h.member), [], 'what the folder holds is known, not a change made outside')
    await put(h.member, DIARY, (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    assert.equal((await versionsOf(DIARY, h.member)).length, 1)
    // A manager purges files, not folders.
    assert.notEqual((await h.member('POST', '/api/history/purge', { path: PATH.diaryDir })).status, 200)

    // The admin, the other's folder by its name: he can't read it, and the answer says nothing of it but how much.
    const preview = await h.admin('POST', '/api/history/purge', { path: home(OTHER.username), dryRun: true })
    assert.equal(preview.body.confirmRequired, true, 'what he can\'t read is confirmed at the moment (D-040 3.6)')
    assert.equal((await h.admin('POST', '/api/history/purge', { path: home(OTHER.username) })).body.error, 'confirmation_required')
    const writing = put(h.member, PATH.list, (t) => t + `${m.aSentence()}\n`)
    const k = await h.admin('POST', '/api/history/purge', { path: home(OTHER.username), confirm: ADMIN.password })
    await writing
    assert.equal(k.status, 200, JSON.stringify(k.body))
    for (const mark of [WORD.other, more, older, posix.basename(PATH.otherNotes), posix.basename(OLD)]) assert.ok(!JSON.stringify(k.body).includes(mark), mark)
    assert.deepEqual(await versionsOf(PATH.otherNotes, h.other), [])
    assert.deepEqual(await versionsOf(OLD, h.other), [])
    assert.ok(!(await objects(h.stateDir)).includes(older))
    await h.settle()
    const list = (await versionsOf(PATH.list, h.member)) as { authors: { name: string }[] }[]
    assert.equal(list[0]!.authors[0]!.name, MEMBER.username, 'the write made during the purge has its version')
    // Both where the admin can't read: who, never where (D-056.24).
    const alerts = ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string; path: string | null; by: string }[]).filter((a) => a.code === 'history_purged')
    assert.deepEqual(alerts.map((a) => [a.path, a.by]), [[null, MEMBER.username], [null, ADMIN.username]])
  } finally { await h.close() }
})

test('the notices of purges outlive a restart, and a broken file of them is no notice', async () => {
  const { PurgeNotices } = await import('../src/history/notices.ts')
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const n = new PurgeNotices(h.stateDir)
    n.add({ path: 'a.md', version: null, by: 'u1', at: '2026-09-27T10:00:00.000Z' })
    assert.deepEqual(new PurgeNotices(h.stateDir).all().map((x) => x.path), ['a.md'])
    writeFileSync(join(h.stateDir, 'history', 'purges.json'), '{ no')
    assert.deepEqual(new PurgeNotices(h.stateDir).all(), [])
  } finally { await h.close() }
})
