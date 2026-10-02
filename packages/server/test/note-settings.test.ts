// Note settings of a person and of a shared space (noteSettings.ts): edited
// through the API (one's own; a space's by its managers), read for the merge
// with vihko.yaml (series, where images go, guides for agents),
// never served, and nothing of someone else's ever applied.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** Puts someone's settings (or a space's, `space`), from what GET gives. */
async function put(h: Spaces, who: Name, change: (s: any) => void, space?: string) {
  const now = await h.as(who)('GET', `/api/settings${space ? `?space=${encodeURIComponent(space)}` : ''}`)
  assert.equal(now.status, 200, now.text)
  const settings = structuredClone(now.body.settings)
  change(settings)
  return h.as(who)('PUT', '/api/settings', { ...(space ? { space } : {}), settings, ifMatch: now.body.etag })
}
const today = () => new Date('2026-09-30T10:00:00Z')
const ymd = '2026-09-30'

test('one\'s own settings: a series and a guide of one\'s own, written into their space\'s hidden settings file', async () => {
  const h = await setup()
  try {
    const [id, folder, guide] = [m.anId(), m.aFolder(), m.aTitle()]
    const empty = (await h.member('GET', '/api/settings')).body
    assert.deepEqual([empty.space, empty.settings, empty.errors, empty.canEdit], [h.home('member'), { version: 1, daily: [], attachments: null, agents: null }, [], true])
    const r = await put(h, 'member', (s) => { s.daily.push({ id, label: null, folder, name: '{YYYY}-{MM}-{DD}', template: null }); s.agents = guide })
    assert.equal(r.status, 200, r.text)
    // On the disk: plain YAML in their space's `.vihko/`, with its version.
    const file = readFileSync(join(h.notesDir, h.home('member'), '.vihko', 'settings.yaml'), 'utf8')
    assert.match(file, /^version: 1\n/)
    assert.ok(file.includes(folder) && file.includes(guide))
    // Offered to them: their series (in their space).
    const w = (await h.member('GET', '/api/workspace')).body
    assert.deepEqual(w.daily.map((s: any) => [s.id, s.folder]), [[`me-${id}`, `${h.home('member')}/${folder}`]])
    h.clock.now = today()
    const made = await h.member('POST', '/api/daily', { series: `me-${id}` })
    assert.equal(made.status, 201, made.text)
    assert.equal(made.body.path, `${h.home('member')}/${folder}/${ymd}.md`)
    // Nothing of it for anyone else.
    const other = (await h.other('GET', '/api/workspace')).body
    assert.deepEqual(other.daily, [])
    assert.ok(!JSON.stringify(other).includes(folder))
    // The ETag is the file's: a stale one is refused, nothing written.
    const stale = await h.member('PUT', '/api/settings', { settings: empty.settings, ifMatch: empty.etag })
    assert.equal(stale.status, 412)
    // What's wrong is said, with where, and nothing is written.
    const bad = await put(h, 'member', (s) => { s.attachments = { mode: 'folder', folder: '../out' } })
    assert.deepEqual([bad.status, bad.body.error, bad.body.errors.map((e: any) => [e.code, e.at])], [400, 'invalid', [['invalid_path', 'attachments.folder']]])
    assert.equal(readFileSync(join(h.notesDir, h.home('member'), '.vihko', 'settings.yaml'), 'utf8'), file)
  } finally {
    h.close()
  }
})

test('a series of one\'s own with the pattern of vihko.yaml\'s is one series: no note twice', async () => {
  const folder = m.aFolder()
  const id = m.anId()
  const h = await setup({ config: `daily:\n  ${id}:\n    folder: ${JSON.stringify(`people/{user}/${folder}`)}\n` })
  try {
    assert.equal((await put(h, 'member', (s) => { s.daily.push({ id: m.anId(), label: m.aHeading(), folder, name: '{YYYY}-{MM}-{DD}', template: null }) })).status, 200)
    const daily = (await h.member('GET', '/api/workspace')).body.daily
    assert.deepEqual(daily.map((s: any) => s.id), [id])
  } finally {
    h.close()
  }
})

test('«Today\'s note» with no choice: one\'s own series first, then a space\'s, then the installation\'s; the one it opens stays', async () => {
  const installation = m.anId()
  const h = await setup({ config: `daily:\n  ${installation}:\n    folder: ${JSON.stringify(`people/{user}/${m.aFolder()}`)}\n` })
  try {
    h.clock.now = today()
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName(), members: { [h.names.other]: 'edit' } })).body.space.path as string
    // The member opens today's note while the installation's is the only series: that one becomes their choice.
    const first = await h.member('POST', '/api/daily', {})
    assert.equal(first.body.series, installation, first.text)
    assert.equal((await h.member('GET', '/api/profile')).body.dailySeries, installation)
    // The space gets a series: listed before the installation's, but the member's choice stays.
    const spaceSeries = m.anId()
    assert.equal((await put(h, 'member', (s) => { s.daily.push({ id: spaceSeries, label: null, folder: m.aFolder(), name: '{YYYY}-{MM}-{DD}', template: null }) }, space)).status, 200)
    const listed = (await h.member('GET', '/api/workspace')).body.daily.map((s: any) => s.id) as string[]
    assert.equal(listed.length, 2)
    assert.ok(listed[0]!.endsWith(`-${spaceSeries}`) && listed[0]!.startsWith('sp-'), listed.join())
    assert.equal(listed[1], installation)
    assert.equal((await h.member('GET', '/api/daily')).body.series, installation)
    assert.equal((await h.member('POST', '/api/daily', {})).body.series, installation)
    // Someone who never chose: the space's before the installation's, and their own before both.
    assert.equal((await h.other('GET', '/api/daily')).body.series, listed[0])
    const own = m.anId()
    assert.equal((await put(h, 'other', (s) => { s.daily.push({ id: own, label: null, folder: m.aFolder(), name: '{YYYY}-{MM}-{DD}', template: null }) })).status, 200)
    assert.equal((await h.other('GET', '/api/daily')).body.series, `me-${own}`)
    assert.equal((await h.other('GET', '/api/profile')).body.dailySeries, null, 'looking chooses nothing')
    assert.equal((await h.other('POST', '/api/daily', {})).body.series, `me-${own}`)
    assert.equal((await h.other('GET', '/api/profile')).body.dailySeries, `me-${own}`)
    // Asking for a series by its id opens it without changing the choice.
    assert.equal((await h.other('POST', '/api/daily', { series: installation })).body.series, installation)
    assert.equal((await h.other('GET', '/api/profile')).body.dailySeries, `me-${own}`)
  } finally {
    h.close()
  }
})

test('a shared space\'s settings: its managers change them, its members read them and get their series, images folder and guide; nobody else', async () => {
  const h = await setup()
  try {
    await h.enable()
    const name = m.aSpaceName()
    const space = (await h.member('POST', '/api/spaces', { name, members: { [h.names.other]: 'edit' } })).body.space.path as string
    const [id, log, images, guide] = [m.anId(), m.aFolder(), m.aFolder(), m.aTitle()]
    const guideText = m.aSentence()
    h.write(`${space}/${guide}.md`, `# ${guide}\n\n${guideText}\n`)
    const r = await put(h, 'member', (s) => {
      s.daily.push({ id, label: null, folder: log, name: '{YYYY}-{MM}-{DD}', template: null })
      s.attachments = { mode: 'folder', folder: images }
      s.agents = guide
    }, space)
    assert.equal(r.status, 200, r.text)
    // A member reads them, and can't change them; someone outside the space doesn't learn they exist.
    const read = await h.other('GET', `/api/settings?space=${encodeURIComponent(space)}`)
    assert.deepEqual([read.status, read.body.canEdit, read.body.settings.attachments], [200, false, { mode: 'folder', folder: images }])
    assert.equal((await put(h, 'other', (s) => { s.attachments = null }, space)).status, 403)
    const outside = await h.admin('GET', `/api/settings?space=${encodeURIComponent(space)}`)
    const nowhere = await h.admin('GET', `/api/settings?space=${encodeURIComponent(`spaces/${m.aSpaceName()}`)}`)
    assert.deepEqual([outside.status, outside.body], [nowhere.status, nowhere.body])
    assert.equal(outside.status, 404)
    assert.equal((await h.admin('PUT', '/api/settings', { space, settings: read.body.settings, ifMatch: read.body.etag })).status, 404)
    // Its members get its series; the admin, nothing of it.
    const w = (await h.other('GET', '/api/workspace')).body
    assert.ok(w.daily.some((s: any) => s.folder === `${space}/${log}`), JSON.stringify(w.daily))
    const admin = (await h.admin('GET', '/api/workspace')).body
    assert.ok(!JSON.stringify(admin).includes(space))
    // New images of its notes go to its folder of images.
    const note = `${space}/${m.aTitle()}.md`
    h.write(note, `# ${m.aHeading()}\n`)
    const img = await h.app.request(`/api/attachments?note=${encodeURIComponent(note)}`, { method: 'POST', headers: { cookie: h.cookie('other'), 'content-type': 'image/png' }, body: PNG })
    assert.equal(img.status, 201, await img.clone().text())
    assert.ok(((await img.json()) as { path: string }).path.startsWith(`${space}/${images}/`))
    // Its guide for agents: for a key that reaches the space, after the installation's; not for one that doesn't.
    const theirs = await h.mcp((await h.newKey('other', { name: m.aKeyName(), canWrite: false })).token)
    const elsewhere = await h.mcp((await h.newKey('admin', { name: m.aKeyName(), canWrite: false })).token)
    try {
      assert.ok(theirs.instructions().includes(guideText), theirs.instructions())
      assert.ok(!elsewhere.instructions().includes(guideText))
    } finally {
      await theirs.close()
      await elsewhere.close()
    }
  } finally {
    h.close()
  }
})

test('a guide for agents that names no note: said when saved and read, and an alert to whom the settings belong, until the note exists', async () => {
  const h = await setup()
  try {
    const guides = (who: Name) => h.as(who)('GET', '/api/alerts').then((r) => (r.body.alerts as any[]).filter((a) => a.code === 'settings_guide_missing'))
    // One's own: the person is told; nobody else.
    const mine = m.aTitle()
    const saved = await put(h, 'member', (s) => { s.agents = mine })
    assert.deepEqual([saved.status, saved.body.guideMissing], [200, true], saved.text)
    assert.equal((await h.member('GET', '/api/settings')).body.guideMissing, true)
    assert.deepEqual(await guides('member'), [{ code: 'settings_guide_missing', space: null, note: `${h.home('member')}/${mine}.md`, actions: [] }])
    for (const who of ['admin', 'other'] as Name[]) assert.deepEqual(await guides(who), [], who)
    h.write(`${h.home('member')}/${mine}.md`, `# ${mine}\n\n${m.aSentence()}\n`)
    assert.equal((await h.member('GET', '/api/settings')).body.guideMissing, false)
    assert.deepEqual(await guides('member'), [])
    // A shared space's: its managers are told, not its other members.
    const name = m.aSpaceName()
    const space = (await h.member('POST', '/api/spaces', { name, members: { [h.names.other]: 'edit' } })).body.space.path as string
    const theirs = m.aTitle()
    assert.equal((await put(h, 'member', (s) => { s.agents = theirs }, space)).body.guideMissing, true)
    assert.deepEqual(await guides('member'), [{ code: 'settings_guide_missing', space: { path: space, name }, note: `${space}/${theirs}.md`, actions: [] }])
    assert.deepEqual(await guides('other'), [])
    // No guide: nothing to say.
    assert.equal((await put(h, 'member', (s) => { s.agents = null }, space)).body.guideMissing, false)
    assert.deepEqual(await guides('member'), [])
  } finally {
    h.close()
  }
})

test('settings files are never served, and a hand edit with something wrong tells whom they belong to, not the admin', async () => {
  const h = await setup()
  try {
    await h.enable()
    assert.equal((await put(h, 'member', (s) => { s.agents = m.aTitle() })).status, 200)
    const file = `${h.home('member')}/.vihko/settings.yaml`
    for (const who of ['member', 'other', 'admin'] as Name[]) {
      for (const route of [`/api/file?path=${encodeURIComponent(file)}`, `/api/note?path=${encodeURIComponent(file)}`]) {
        const r = await h.as(who)('GET', route)
        assert.ok(r.status === 404 || r.status === 400, `${who} ${route}: ${r.status}`)
        assert.ok(!r.text.includes('version: 1'))
      }
    }
    const key = await h.mcp((await h.newKey('member', { name: m.aKeyName(), canWrite: false })).token)
    try {
      const r = await key.call('get_note', { path: file })
      assert.equal(r.error, true)
      assert.ok(!r.raw.includes('version: 1'))
    } finally { await key.close() }
    // A hand edit with a path out of the space: the person is told, with where; the admin isn't.
    writeFileSync(join(h.notesDir, file), 'version: 1\nattachments:\n  folder: ../../out\n')
    const mine = ((await h.member('GET', '/api/alerts')).body.alerts as any[]).filter((a) => a.code === 'settings_invalid')
    assert.deepEqual(mine.map((a) => [a.space, a.errors.map((e: any) => [e.code, e.at, e.line])]), [[null, [['invalid_path', 'attachments.folder', 3]]]])
    for (const who of ['admin', 'other'] as Name[]) {
      assert.deepEqual(((await h.as(who)('GET', '/api/alerts')).body.alerts as any[]).filter((a) => a.code === 'settings_invalid'), [], who)
    }
  } finally {
    h.close()
  }
})
