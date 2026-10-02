// Keys vihko retired from its settings files, migrated at start
// (retiredKeys.ts): `templates` in a person's or a space's settings, or in
// vihko.yaml, marks the notes of those folders as templates, goes from the
// file (the rest of it as it was), and whom the file belongs to is told. A
// folder that's gone is said; a second start does nothing. Settings alerts
// name their own file and reach only whom the file belongs to; the form
// removes a key vihko doesn't know when asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatter } from '@vihko/core'
import { Notices, migrateRetiredKeys } from '@vihko/server'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** Runs the start's migration over the harness's vihko, as main.ts does. */
const migrate = (h: Spaces) => migrateRetiredKeys({
  notesDir: h.notesDir, index: h.index, state: h.state, notes: h.notes, file: h.services.permissionsFile,
  notices: new Notices(h.state), managersOf: (root) => h.services.policy.permissions.managersOf(root),
})
const marked = (h: Spaces, path: string) => readFrontmatter(readFileSync(join(h.notesDir, path), 'utf8')).data.template === true
const migratedAlerts = (h: Spaces, who: Name) => h.as(who)('GET', '/api/alerts').then((r) => (r.body.alerts as any[]).filter((a) => a.code === 'settings_migrated'))

test('templates in a person\'s settings: the notes of those folders marked, the key gone with the rest of the file as it was, the person told (and nobody else); twice changes nothing', async () => {
  const h = await setup()
  try {
    const home = h.home('member')
    const [folder, sub, gone, comment, label] = [m.aFolder(), m.aFolder(), m.aFolder(), m.aSentence(), m.aHeading()]
    const notes = [`${home}/${folder}/${m.aTitle()}.md`, `${home}/${folder}/${sub}/${m.aTitle()}.md`]
    const already = `${home}/${folder}/${m.aTitle()}.md`
    const outside = `${home}/${m.aTitle()}.md`
    for (const p of [...notes, outside]) h.write(p, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
    h.write(already, `---\ntemplate: true\n---\n# ${m.aHeading()}\n`)
    const series = m.anId()
    // Literal layout: the comments and the order around the key are the case under test.
    const before = `# ${comment}\nversion: 1\ntemplates:   # ${comment}\n  - ${folder}\n  - ${gone}\ndaily:\n  ${series}:\n    label: ${JSON.stringify(label)}   # ${comment}\n    folder: ${m.aFolder()}\n`
    const file = join(h.notesDir, home, '.vihko', 'settings.yaml')
    h.write(`${home}/.vihko/settings.yaml`, before)
    const text = (p: string) => readFileSync(join(h.notesDir, p), 'utf8')
    const untouched = text(outside)

    const r = await migrate(h)
    assert.deepEqual(r.migrated.map((x) => [x.file, x.key, x.report]), [[`${home}/.vihko/settings.yaml`, 'templates', { marked: 2, missing: [gone] }]])
    for (const p of [...notes, already]) assert.ok(marked(h, p), p)
    assert.equal(text(outside), untouched, 'only the folders it named')
    // The key goes; every other byte stays.
    const after = readFileSync(file, 'utf8')
    assert.equal(after, before.replace(/templates:.*\n {2}- .*\n {2}- .*\n/, ''))
    // The person is told, with the file and the folder that's gone; nobody else.
    assert.deepEqual((await migratedAlerts(h, 'member')).map((a) => [a.key, a.file, a.marked, a.missing]), [['templates', `${home}/.vihko/settings.yaml`, 2, [gone]]])
    for (const who of ['admin', 'other'] as Name[]) assert.deepEqual(await migratedAlerts(h, who), [], who)
    // No unknown key left to warn about.
    assert.equal((await h.member('GET', '/api/settings')).body.errors.length, 0)

    // A second start: nothing to do, nothing said again.
    const again = await migrate(h)
    assert.deepEqual([again.migrated, again.failed], [[], []])
    assert.equal(readFileSync(file, 'utf8'), after)
    assert.equal((await migratedAlerts(h, 'member')).length, 1)
  } finally {
    h.close()
  }
})

test('templates in a shared space\'s settings: its managers are told, its other members aren\'t', async () => {
  const h = await setup()
  try {
    const space = (await h.member('POST', '/api/spaces', { name: m.aSpaceName(), members: { [h.names.other]: 'edit' } })).body.space.path as string
    const folder = m.aFolder()
    const note = `${space}/${folder}/${m.aTitle()}.md`
    h.write(note, `# ${m.aHeading()}\n`)
    h.write(`${space}/.vihko/settings.yaml`, `templates: ${folder}\n`)
    await migrate(h)
    assert.ok(marked(h, note))
    assert.equal(readFileSync(join(h.notesDir, space, '.vihko', 'settings.yaml'), 'utf8'), '')
    assert.deepEqual((await migratedAlerts(h, 'member')).map((a) => [a.file, a.marked, a.missing]), [[`${space}/.vihko/settings.yaml`, 1, []]])
    assert.deepEqual(await migratedAlerts(h, 'other'), [])
    assert.deepEqual(await migratedAlerts(h, 'admin'), [])
  } finally {
    h.close()
  }
})

test('templates in vihko.yaml: {user} is each person\'s folder, the admins are told, and the rest of vihko.yaml stays', async () => {
  const folder = m.aFolder()
  const comment = m.aSentence()
  const series = m.anId()
  const rest = `daily:\n  ${series}:   # ${comment}\n    folder: ${JSON.stringify(`people/{user}/${m.aFolder()}`)}\n`
  const h = await setup({ config: `# ${comment}\ntemplates: ${JSON.stringify(`people/{user}/${folder}`)}\n${rest}` })
  try {
    const yaml = join(h.notesDir, 'vihko.yaml')
    const notes = (['member', 'other'] as Name[]).map((who) => `${h.home(who)}/${folder}/${m.aTitle()}.md`)
    for (const p of notes) h.write(p, `# ${m.aHeading()}\n`)
    const r = await migrate(h)
    assert.deepEqual(r.migrated.map((x) => [x.file, x.report.marked]), [['vihko.yaml', 2]])
    for (const p of notes) assert.ok(marked(h, p), p)
    assert.equal(readFileSync(yaml, 'utf8'), `# ${comment}\n${rest}`)
    assert.deepEqual((await migratedAlerts(h, 'admin')).map((a) => [a.file, a.marked]), [['vihko.yaml', 2]])
    for (const who of ['member', 'other'] as Name[]) assert.deepEqual(await migratedAlerts(h, who), [], who)
  } finally {
    h.close()
  }
})

test('a settings alert names its own file, reaches only whom it belongs to; the form removes an unknown key when asked, never a known one', async () => {
  const h = await setup()
  try {
    const home = h.home('member')
    const [unknown, series] = [m.aUniqueWord(), m.anId()]
    h.write(`${home}/.vihko/settings.yaml`, `version: 1\n${unknown}: ${m.aWord()}\ndaily:\n  ${series}:\n    folder: ${m.aFolder()}\n`)
    const invalid = (who: Name) => h.as(who)('GET', '/api/alerts').then((r) => (r.body.alerts as any[]).filter((a) => a.code === 'settings_invalid'))
    assert.deepEqual((await invalid('member')).map((a) => [a.file, a.space, a.errors.map((e: any) => [e.code, e.at, e.line])]), [[`${home}/.vihko/settings.yaml`, null, [['unknown_key', unknown, 2]]]])
    for (const who of ['admin', 'other'] as Name[]) assert.deepEqual(await invalid(who), [], who)

    const now = (await h.member('GET', '/api/settings')).body
    const saved = await h.member('PUT', '/api/settings', { settings: now.settings, ifMatch: now.etag, remove: [unknown, 'daily'] })
    assert.equal(saved.status, 200, saved.text)
    const file = readFileSync(join(h.notesDir, home, '.vihko', 'settings.yaml'), 'utf8')
    assert.ok(!file.includes(unknown), file)
    assert.ok(file.includes(series), 'a key vihko knows is never removed this way')
    assert.deepEqual(await invalid('member'), [])
    const bad = await h.member('PUT', '/api/settings', { settings: saved.body.settings, ifMatch: saved.body.etag, remove: 'x' })
    assert.equal(bad.status, 400)
  } finally {
    h.close()
  }
})
