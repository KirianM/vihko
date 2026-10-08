// Automatic retention, in process: the history keeps every version newer than
// the period and, of the older ones, each file's version at the cutoff; a
// note in the trash keeps its whole history; trash entries past their period
// go with their images, and so does the history of what they held; the
// preview counts exactly what the run removes; the admins are told with
// counts only. The history's clock is moved forward (`now`) so that what
// was written first is old.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminSettings, Git, Notices, Retention, nextAt, type TrashEntry } from '@vihko/server'
import { setup } from './_history.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const DAY = 86_400_000

const repo = (stateDir: string) => new Git({ gitDir: join(stateDir, 'history.git') })

/** A path's versions in the history, newest first: the change (A, M, D) and the content's id. */
async function versionsOf(stateDir: string, path: string): Promise<{ status: string; oid: string | null }[]> {
  const { stdout } = await repo(stateDir).run(['log', '--format=', '--raw', '--no-renames', '--no-abbrev', '-z', 'refs/heads/main', '--', path])
  const out: { status: string; oid: string | null }[] = []
  const tokens = stdout.toString('utf8').split('\0').map((t) => t.replace(/^\n+/, ''))
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (!tokens[i]!.startsWith(':')) { i--; continue }
    const [, , , newOid, status] = tokens[i]!.slice(1).split(' ') as [string, string, string, string, string]
    out.push({ status: status[0]!, oid: /^0+$/.test(newOid) ? null : newOid })
  }
  return out
}

/** The id git gives a file's current bytes. */
async function oidOnDisk(notesDir: string, path: string): Promise<string> {
  const { stdout } = await repo(notesDir).run(['hash-object', '--stdin'], { input: readFileSync(join(notesDir, path)), bare: true })
  return stdout.toString('latin1').trim()
}

/** Every object in the repository, reachable or not, with its contents. */
async function objects(stateDir: string): Promise<string> {
  return (await repo(stateDir).run(['cat-file', '--batch-all-objects', '--batch'])).stdout.toString('latin1')
}

/** The commits newer than `since` (ms): author line and message, which a run never changes. */
async function newer(stateDir: string, since: number): Promise<string[]> {
  const { stdout } = await repo(stateDir).run(['log', '--date=raw', '--format=%an <%ae> %ad%x1f%B%x1e', 'refs/heads/main'])
  return stdout.toString('utf8').split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean)
    .filter((r) => Number(/ (\d+) [+-]\d{4}\x1f/.exec(r)![1]) * 1000 >= since)
    .map((r) => r.replace(/\b[0-9a-f]{40}\b/g, '<id>'))
}

/** A clock that can jump forward: the history's versions are dated by it. */
function clock() {
  let offset = 0
  return { now: () => Date.now() + offset, jump: (ms: number) => { offset += ms } }
}

function retention(h: Awaited<ReturnType<typeof setup>>, now: () => number) {
  const settings = new AdminSettings(h.state)
  const notices = new Notices(h.state)
  const r = new Retention({ stateDir: h.stateDir, settings, trash: () => h.notes.trash(), history: h.history, notices, now })
  return { r, settings, notices }
}

const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(m.aSentence())])

test('history retention: older versions go, each note keeps its version at the cutoff and everything newer; the preview counted it exactly', async () => {
  const t = clock()
  const KEPT = inShared(m.aNotePath(m.aFolder()))
  const CHANGED = inShared(m.aNotePath(m.aFolder()))
  const GONE = inShared(m.aNotePath(m.aFolder()))
  const PRIVATE_WORD = m.aUniqueWord()
  const h = await setup({ now: t.now, files: { [KEPT]: `# ${m.aHeading()}\n`, [CHANGED]: `# ${m.aHeading()}\n`, [GONE]: `# ${m.aHeading()}\n` } })
  try {
    // Somewhere only the member reads: nothing the admin is told names it.
    const own = `people/${h.users.member.username}/${PRIVATE_WORD}.md`
    assert.equal((await h.member('POST', '/api/note', { path: own, text: `${m.aSentence()}\n` })).status, 201)
    await h.settle()
    await h.put(KEPT, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    await h.put(CHANGED, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    await h.put(CHANGED, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    const base = (await versionsOf(h.stateDir, CHANGED))[0]!.oid
    // Deleted outside vihko: not in the trash.
    rmSync(join(h.notesDir, GONE))
    h.indexer.scan({})
    await h.settle()
    assert.equal((await versionsOf(h.stateDir, GONE))[0]!.status, 'D')

    t.jump(400 * DAY)
    const cutoff = t.now() - 365 * DAY
    await h.put(CHANGED, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    const before = await newer(h.stateDir, cutoff)
    const untouched = inShared('hogar/Proxy.md') // a note of the fixed vault nobody edits here
    assert.equal((await versionsOf(h.stateDir, untouched)).length, 1)

    const { r, settings, notices } = retention(h, t.now)
    settings.set({ historyRetentionDays: 365 })
    const preview = await r.preview({ trashRetentionDays: null, historyRetentionDays: 365 })
    const run = await r.run()
    assert.equal(run.failed, false)
    assert.deepEqual(run.trash, { entries: 0, bytes: 0 })
    assert.ok(run.history!.versions > 0)
    assert.deepEqual(run.history, preview.history, 'the preview counts what the run removes')

    // The note unchanged since: its current version, alone.
    const kept = await versionsOf(h.stateDir, KEPT)
    assert.equal(kept.length, 1)
    assert.equal(kept[0]!.oid, await oidOnDisk(h.notesDir, KEPT))
    // The note changed since: its version at the cutoff, and the newer one.
    const changed = await versionsOf(h.stateDir, CHANGED)
    assert.deepEqual(changed.map((v) => v.status), ['M', 'A'])
    assert.equal(changed[1]!.oid, base)
    assert.equal(changed[0]!.oid, await oidOnDisk(h.notesDir, CHANGED))
    // Deleted before the cutoff and not in the trash: nothing left.
    assert.deepEqual(await versionsOf(h.stateDir, GONE), [])
    assert.equal((await versionsOf(h.stateDir, untouched)).length, 1)
    // Everything newer is as it was: authors, dates, messages.
    assert.deepEqual(await newer(h.stateDir, cutoff), before)
    // Every file keeps its content at the head.
    const { stdout } = await repo(h.stateDir).run(['ls-tree', '-r', '--name-only', 'refs/heads/main'])
    for (const p of stdout.toString('utf8').split('\n').filter((x) => x.endsWith('.md'))) {
      if (existsSync(join(h.notesDir, p))) assert.equal((await versionsOf(h.stateDir, p))[0]!.oid, await oidOnDisk(h.notesDir, p), p)
    }
    // The history UI reads it as before.
    const api = await h.versions(CHANGED)
    assert.equal(api.versions.length, 2)

    // Every admin is told, with counts only.
    const told = notices.of(h.ids.admin).filter((n) => n.data.code === 'retention_ran')
    assert.equal(told.length, 1)
    assert.deepEqual(told[0]!.data, { code: 'retention_ran', trashEntries: 0, versions: run.history!.versions, failed: false })
    assert.equal(notices.of(h.ids.member).length, 0, 'members are not told')
    const status = await h.admin('GET', '/api/admin/retention')
    assert.ok(!JSON.stringify([status.body, told, preview]).includes(PRIVATE_WORD))

    // A second run the same night has nothing left to take out, and tells nobody.
    const again = await r.run()
    assert.equal(again.history!.versions, 0)
    assert.equal(notices.of(h.ids.admin).filter((n) => n.data.code === 'retention_ran').length, 1)
  } finally { await h.close() }
})

test('trash retention: entries past the period go with their images; a note in the trash keeps its whole history; an emptied one loses it, a newer note of that name keeps its own', async () => {
  const t = clock()
  const dir = inShared(m.aFolder())
  const [TRASHED, EMPTIED, IMAGE] = [`${dir}/${m.aUniqueWord()}.md`, `${dir}/${m.aUniqueWord()}.md`, `${dir}/${m.aUniqueWord()}.png`]
  const h = await setup({ now: t.now, files: { [TRASHED]: `# ${m.aHeading()}\n`, [EMPTIED]: `# ${m.aHeading()}\n\n![](${IMAGE.slice(dir.length + 1)})\n`, [IMAGE]: png() } })
  const SECRET = m.aSecret()
  const KEPT_WORD = m.aSecret()
  try {
    await h.put(TRASHED, (x) => x + `${KEPT_WORD}\n`)
    await h.put(EMPTIED, (x) => x + `${SECRET}\n`)
    await h.settle()
    const actor = { kind: 'user' as const, id: h.ids.admin }
    const trashed = await h.notes.delete(TRASHED, { actor })
    const emptied = await h.notes.delete(EMPTIED, { actor })
    assert.deepEqual(emptied.files?.map((f) => f.path), [IMAGE])
    await h.settle()
    // A new note under the emptied one's name.
    assert.equal((await h.admin('POST', '/api/note', { path: EMPTIED, text: `${m.aSentence()}\n` })).status, 201)
    await h.settle()
    await h.put(EMPTIED, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    const trashedHistory = await versionsOf(h.stateDir, TRASHED)
    assert.deepEqual(trashedHistory.map((v) => v.status), ['D', 'M', 'A'])
    assert.equal((await versionsOf(h.stateDir, IMAGE)).length, 2)

    // The emptied entry is the older one: deleted a few minutes before the other.
    const metaFile = join(h.stateDir, 'trash', emptied.id, 'meta.json')
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as TrashEntry
    writeFileSync(metaFile, JSON.stringify({ ...meta, deletedAt: new Date(Date.parse(trashed.deletedAt) - 5 * 60_000).toISOString() }))
    t.jump(400 * DAY)
    const now = () => Date.parse(trashed.deletedAt) + 400 * DAY - 2 * 60_000
    const { r, settings, notices } = retention(h, now)
    settings.set({ trashRetentionDays: 400, historyRetentionDays: 365 })
    const preview = await r.preview({ trashRetentionDays: 400, historyRetentionDays: 365 })
    assert.equal(preview.trash.entries, 1)
    assert.ok(preview.trash.bytes > 0)
    const run = await r.run()
    assert.deepEqual(run.trash, preview.trash)
    assert.deepEqual(run.history, preview.history)

    // Out of the trash, images included; the other entry stays.
    assert.ok(!existsSync(join(h.stateDir, 'trash', emptied.id)))
    assert.deepEqual(readdirSync(join(h.stateDir, 'trash')), [trashed.id])
    assert.deepEqual(h.notes.trash().map((e) => e.id), [trashed.id])
    // The note still in the trash keeps every version, however old.
    assert.deepEqual(await versionsOf(h.stateDir, TRASHED), trashedHistory)
    // The emptied note's history is gone, its image's too; the new note keeps its current version.
    assert.deepEqual(await versionsOf(h.stateDir, IMAGE), [])
    const reborn = await versionsOf(h.stateDir, EMPTIED)
    assert.equal(reborn.length, 1)
    assert.equal(reborn[0]!.oid, await oidOnDisk(h.notesDir, EMPTIED))
    const all = await objects(h.stateDir)
    assert.ok(!all.includes(SECRET), 'nothing of the emptied note is left in the repository')
    assert.ok(all.includes(KEPT_WORD))
    const told = notices.of(h.ids.admin).find((n) => n.data.code === 'retention_ran')!
    assert.deepEqual(told.data, { code: 'retention_ran', trashEntries: 1, versions: run.history!.versions, failed: false })
    // Restoring the note left in the trash still works.
    assert.equal((await h.admin('POST', `/api/trash/${trashed.id}/restore`, {})).status, 200)
  } finally { await h.close() }
})

test('an emptied note loses its history even where it is newer than the history\'s period; the rest keeps everything', async () => {
  const t = clock()
  const NOTE = inShared(m.aNotePath(m.aFolder()))
  const OTHER = inShared(m.aNotePath(m.aFolder()))
  const SECRET = m.aSecret()
  const h = await setup({ now: t.now, files: { [NOTE]: `# ${m.aHeading()}\n`, [OTHER]: `# ${m.aHeading()}\n` } })
  try {
    await h.put(NOTE, (x) => x + `${SECRET}\n`)
    await h.put(OTHER, (x) => x + `${m.aSentence()}\n`)
    await h.settle()
    const moved = inShared(m.aNotePath(m.aFolder()))
    // Followed through its move: its versions under the first name go too.
    assert.equal((await h.admin('POST', '/api/note/move', { from: NOTE, to: moved })).status, 200)
    await h.settle()
    await h.notes.delete(moved, { actor: { kind: 'user', id: h.ids.admin } })
    await h.settle()
    const others = await versionsOf(h.stateDir, OTHER)
    const { r, settings } = retention(h, () => Date.now() + 10 * DAY)
    settings.set({ trashRetentionDays: 5, historyRetentionDays: 1000 })
    const run = await r.run()
    assert.equal(run.trash.entries, 1)
    assert.deepEqual(await versionsOf(h.stateDir, moved), [])
    assert.deepEqual(await versionsOf(h.stateDir, NOTE), [])
    assert.deepEqual(await versionsOf(h.stateDir, OTHER), others)
    assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'nothing of it is left in the repository')
  } finally { await h.close() }
})

test('with the history off, retention empties the trash and leaves the history alone', async () => {
  const NOTE = inShared(m.aNotePath(m.aFolder()))
  const h = await setup({ config: 'history:\n  mode: off\n', files: { [NOTE]: `# ${m.aHeading()}\n` } })
  try {
    await h.notes.delete(NOTE, { actor: { kind: 'user', id: h.ids.admin } })
    const { r, settings } = retention(h, () => Date.now() + 10 * DAY)
    settings.set({ trashRetentionDays: 5, historyRetentionDays: 1 })
    assert.equal((await r.preview({ trashRetentionDays: 5, historyRetentionDays: 1 })).history, null)
    const run = await r.run()
    assert.equal(run.trash.entries, 1)
    assert.equal(run.history, null)
    assert.equal(run.failed, false)
    assert.deepEqual(JSON.parse(readFileSync(join(h.stateDir, 'retention.json'), 'utf8')).emptied, [])
    assert.equal((await h.admin('GET', '/api/admin/retention')).body.history, false)
  } finally { await h.close() }
})

test('with the history managed and only the trash\'s retention on, emptying the trash leaves the history alone: the emptied note keeps its versions', async () => {
  const NOTE = inShared(m.aNotePath(m.aFolder()))
  const WORD = m.aSecret()
  const h = await setup({ files: { [NOTE]: `# ${m.aHeading()}\n` } })
  try {
    await h.put(NOTE, (x) => x + `${WORD}\n`)
    await h.settle()
    await h.notes.delete(NOTE, { actor: { kind: 'user', id: h.ids.admin } })
    await h.settle()
    const versions = await versionsOf(h.stateDir, NOTE)
    assert.deepEqual(versions.map((v) => v.status), ['D', 'M', 'A'])
    const { r, settings } = retention(h, () => Date.now() + 10 * DAY)
    settings.set({ trashRetentionDays: 5, historyRetentionDays: null })
    const run = await r.run()
    assert.deepEqual([run.trash.entries, run.history, run.failed], [1, null, false])
    assert.deepEqual(h.notes.trash(), [])
    // Its versions are where they were, nothing is noted down to drop later, and a second run changes nothing.
    assert.deepEqual(await versionsOf(h.stateDir, NOTE), versions)
    assert.ok((await objects(h.stateDir)).includes(WORD))
    assert.deepEqual(JSON.parse(readFileSync(join(h.stateDir, 'retention.json'), 'utf8')).emptied, [])
    await r.run()
    assert.deepEqual(await versionsOf(h.stateDir, NOTE), versions)
  } finally { await h.close() }
})

test('a run cut short leaves nothing half done: a trash entry set aside is removed by the next run', async () => {
  const h = await setup()
  try {
    const { r, settings } = retention(h, Date.now)
    const aside = join(h.stateDir, 'trash', `.expired-${m.faker.string.ulid()}`)
    writeFileSync(join(h.stateDir, 'retention.json'), '{')
    rmSync(aside, { recursive: true, force: true })
    await import('node:fs').then((fs) => { fs.mkdirSync(join(aside, 'files'), { recursive: true }); fs.writeFileSync(join(aside, 'note.md'), m.aSentence()) })
    settings.set({ trashRetentionDays: 30 })
    const run = await r.run()
    assert.equal(run.failed, false)
    assert.ok(!existsSync(aside))
    // A state file it can't read is started afresh.
    assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'retention.json'), 'utf8')).version, 1)
  } finally { await h.close() }
})

test('the settings: off by default; turning one on or shortening it is confirmed at the moment, after a preview of counts; members reach none of it', async () => {
  const PRIVATE_WORD = m.aUniqueWord()
  const h = await setup()
  try {
    const password = h.users.admin.password
    const own = `people/${h.users.member.username}/${PRIVATE_WORD}.md`
    assert.equal((await h.member('POST', '/api/note', { path: own, text: `${m.aSentence()}\n` })).status, 201)
    await h.notes.delete(own, { actor: { kind: 'user', id: h.ids.member } })
    await h.settle()
    const settings = await h.admin('GET', '/api/admin/settings')
    assert.equal(settings.body.trashRetentionDays, null)
    assert.equal(settings.body.historyRetentionDays, null)
    const status = await h.admin('GET', '/api/admin/retention')
    assert.deepEqual(status.body, { lastRun: null, nextRun: null, history: true })

    // The preview: counts and bytes of everything, the member's trash included, and no path.
    const preview = await h.admin('POST', '/api/admin/retention/preview', { trashRetentionDays: 1, historyRetentionDays: 30 })
    assert.equal(preview.status, 200)
    assert.deepEqual(Object.keys(preview.body).sort(), ['history', 'trash'])
    assert.deepEqual(preview.body.trash, { entries: 0, bytes: 0 }, 'deleted just now: not past a day')
    assert.deepEqual(Object.keys(preview.body.history).sort(), ['bytes', 'versions'])
    assert.ok(!JSON.stringify(preview.body).includes(PRIVATE_WORD))
    for (const bad of [0, 1.5, 'x', 36501, -3]) {
      assert.equal((await h.admin('POST', '/api/admin/retention/preview', { trashRetentionDays: bad })).status, 400, String(bad))
      assert.equal((await h.admin('PUT', '/api/admin/settings', { historyRetentionDays: bad, confirm: password })).status, 400, String(bad))
    }

    // On, or shorter: confirmed at the moment.
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 30 })).body.error, 'confirmation_required')
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 30, confirm: m.aPassword() })).status, 403)
    assert.equal((await h.admin('GET', '/api/admin/settings')).body.trashRetentionDays, null, 'nothing changed')
    const on = await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 30, historyRetentionDays: 365, confirm: password })
    assert.equal(on.status, 200)
    assert.equal(on.body.trashRetentionDays, 30)
    assert.equal(on.body.historyRetentionDays, 365)
    assert.equal((await h.admin('PUT', '/api/admin/settings', { historyRetentionDays: 200 })).body.error, 'confirmation_required')
    // Longer, or off: it removes less, at once.
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 60 })).status, 200)
    assert.equal((await h.admin('PUT', '/api/admin/settings', { historyRetentionDays: null })).body.historyRetentionDays, null)
    assert.equal((await h.admin('PUT', '/api/admin/settings', { historyRetentionDays: 200 })).body.error, 'confirmation_required', 'on again: confirmed again')

    // Members reach none of it.
    assert.equal((await h.member('GET', '/api/admin/retention')).status, 403)
    assert.equal((await h.member('POST', '/api/admin/retention/preview', {})).status, 403)
    assert.equal((await h.member('PUT', '/api/admin/settings', { trashRetentionDays: null })).status, 403)
  } finally { await h.close() }
})

const RUN = fileURLToPath(new URL('./_retentionRun.ts', import.meta.url))

/** A run in a process of its own, killed at `crashAt` if given. */
function runApart(dir: string, now: number, crashAt?: string) {
  const env = { ...process.env, ...(crashAt ? { VIHKO_TEST_CRASH_AT: crashAt } : {}) }
  const r = spawnSync(process.execPath, ['--no-experimental-webstorage', RUN, dir, String(now)], { env, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, signal: r.signal, out: r.stdout + r.stderr }
}

const head = async (stateDir: string) => (await repo(stateDir).run(['rev-parse', 'refs/heads/main'])).stdout.toString('latin1').trim()
const stateOf = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, 'retention.json'), 'utf8')) as { emptied: unknown[]; compactPending: boolean }

for (const crashAt of ['purge-importing', 'purge-moved']) {
  test(`a run killed at ${crashAt} is finished by the next one: the emptied note's history goes, and nothing of it is left in the repository`, async () => {
    const NOTE = inShared(m.aNotePath(m.aFolder()))
    const OTHER = inShared(m.aNotePath(m.aFolder()))
    const SECRET = m.aSecret()
    const h = await setup({ files: { [NOTE]: `# ${m.aHeading()}\n`, [OTHER]: `# ${m.aHeading()}\n` } })
    let others: Awaited<ReturnType<typeof versionsOf>>
    let before: string
    try {
      await h.put(NOTE, (x) => x + `${SECRET}\n`)
      await h.put(OTHER, (x) => x + `${m.aSentence()}\n`)
      await h.settle()
      await h.notes.delete(NOTE, { actor: { kind: 'user', id: h.ids.admin } })
      await h.settle()
      new AdminSettings(h.state).set({ trashRetentionDays: 5, historyRetentionDays: 1000 })
      others = await versionsOf(h.stateDir, OTHER)
      before = await head(h.stateDir)
    } finally { await h.close() }
    const now = Date.now() + 10 * DAY

    const cut = runApart(h.dir, now, crashAt)
    assert.equal(cut.signal, 'SIGKILL', cut.out)
    // The trash entry went first, and the note waits to lose its history.
    assert.equal(readdirSync(join(h.stateDir, 'trash')).length, 0)
    if (crashAt === 'purge-importing') {
      assert.equal(await head(h.stateDir), before, 'the history is as it was')
      assert.equal(stateOf(h.stateDir).emptied.length, 1)
    } else {
      assert.notEqual(await head(h.stateDir), before, 'the history moved')
      assert.deepEqual(stateOf(h.stateDir), { ...stateOf(h.stateDir), emptied: [], compactPending: true })
      assert.deepEqual(await versionsOf(h.stateDir, NOTE), [])
    }
    assert.ok((await objects(h.stateDir)).includes(SECRET), 'not compacted yet')

    const done = runApart(h.dir, now)
    assert.equal(done.status, 0, done.out)
    assert.deepEqual(await versionsOf(h.stateDir, NOTE), [])
    assert.deepEqual(await versionsOf(h.stateDir, OTHER), others)
    assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'nothing of it is left in the repository')
    assert.deepEqual({ ...stateOf(h.stateDir), lastRun: null }, { version: 1, emptied: [], compactPending: false, lastRun: null })
  })
}

test('the run is weekly: on the day and hour asked, the next week once it has passed', () => {
  // 1 October 2026 is a Thursday; Sunday is 4 October.
  const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min).getTime()
  assert.equal(new Date(at(1, 12)).getDay(), 4)
  assert.equal(nextAt(at(1, 12), 3, 0), at(4, 3))
  assert.equal(nextAt(at(4, 2, 59), 3, 0), at(4, 3))
  assert.equal(nextAt(at(4, 3), 3, 0), at(11, 3))
  assert.equal(nextAt(at(4, 23, 30), 3, 0), at(11, 3))
  assert.equal(nextAt(at(1, 12), 3, 4), at(8, 3), 'Thursday at noon: the next Thursday')
  assert.equal(nextAt(at(1, 2), 3, 4), at(1, 3))
})

test('«Run now»: confirmed at the moment, with the settings in force; it removes what the preview counted and a second one finds nothing', async () => {
  const NOTE = inShared(m.aNotePath(m.aFolder()))
  const h = await setup({ files: { [NOTE]: `# ${m.aHeading()}\n` } })
  try {
    await h.notes.delete(NOTE, { actor: { kind: 'user', id: h.ids.admin } })
    const metaDir = join(h.stateDir, 'trash')
    const [id] = readdirSync(metaDir)
    const metaFile = join(metaDir, id!, 'meta.json')
    // Deleted two days ago, as far as the trash is concerned.
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as TrashEntry
    writeFileSync(metaFile, JSON.stringify({ ...meta, deletedAt: new Date(Date.now() - 2 * DAY).toISOString() }))
    const password = h.users.admin.password
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: 1, confirm: password })).status, 200)
    const preview = await h.admin('POST', '/api/admin/retention/preview', {})
    assert.equal(preview.body.trash.entries, 1)

    assert.equal((await h.admin('POST', '/api/admin/retention/run', {})).body.error, 'confirmation_required')
    assert.equal((await h.admin('POST', '/api/admin/retention/run', { confirm: m.aPassword() })).status, 403)
    assert.equal(h.notes.trash().length, 1, 'nothing ran')
    assert.equal((await h.member('POST', '/api/admin/retention/run', { confirm: h.users.member.password })).status, 403)

    const run = await h.admin('POST', '/api/admin/retention/run', { confirm: password })
    assert.equal(run.status, 200)
    assert.deepEqual(run.body.trash, preview.body.trash)
    assert.equal(run.body.failed, false)
    assert.equal(h.notes.trash().length, 0)
    const status = await h.admin('GET', '/api/admin/retention')
    assert.deepEqual(status.body.lastRun.trash, preview.body.trash)
    const again = await h.admin('POST', '/api/admin/retention/run', { confirm: password })
    assert.deepEqual(again.body.trash, { entries: 0, bytes: 0 })
  } finally { await h.close() }
})
