// Each person's profile: timezone, daily-note preferences and the UI's language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { LANGUAGES } from '@vihko/core'
import { CONFIG, DAILY, setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('profiles: timezone and daily preferences, validated', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  const none = { timezone: null, dailySeries: null, onOpen: 'home', onOpenNote: null, openDailyOnStart: false, language: null }
  assert.deepEqual((await admin('GET', '/api/profile')).body, none)
  assert.deepEqual((await admin('PUT', '/api/profile', { timezone: zone })).body, { ...none, timezone: zone })
  assert.deepEqual((await admin('PUT', '/api/profile', { dailySeries: DAILY.team.id, openDailyOnStart: true, role: 'admin' })).body, { ...none, timezone: zone, dailySeries: DAILY.team.id, onOpen: 'daily', openDailyOnStart: true })
  // Not a timezone, an offset instead of one, a path for a series id, a string for a boolean.
  for (const bad of [{ timezone: 'Mars/Base' }, { timezone: '+02:00' }, { dailySeries: '../x' }, { openDailyOnStart: 'yes' }]) {
    assert.deepEqual([(await admin('PUT', '/api/profile', bad)).status, (await admin('PUT', '/api/profile', bad)).body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.deepEqual((await member('GET', '/api/profile')).body.timezone, null, 'each person has their own')
})

test('profiles: the language of the UI, one of its translations or automatic (null)', async () => {
  const { admin, member, dir } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  await admin('PUT', '/api/profile', { timezone: zone })
  const language = m.pick(LANGUAGES)
  const other = LANGUAGES.find((l) => l !== language)!
  const saved = await admin('PUT', '/api/profile', { language })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, { timezone: zone, dailySeries: null, onOpen: 'home', onOpenNote: null, openDailyOnStart: false, language }, 'only the language changes')
  assert.equal((await admin('GET', '/api/profile')).body.language, language)
  assert.equal((await member('GET', '/api/profile')).body.language, null, 'each person has their own; nobody chose = automatic')
  // Changing something else keeps it.
  assert.equal((await admin('PUT', '/api/profile', { openDailyOnStart: true })).body.language, language)
  assert.equal((await admin('PUT', '/api/profile', { language: other })).body.language, other)
  // A language the UI isn't translated into, a region, another type: refused, and nothing changes.
  for (const bad of [{ language: 'fr' }, { language: `${language}-${m.pick(['ES', 'US', 'GB'])}` }, { language: language.toUpperCase() }, { language: 1 }, { language: '' }]) {
    const r = await admin('PUT', '/api/profile', bad)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.equal((await admin('GET', '/api/profile')).body.language, other)
  // Back to automatic.
  assert.equal((await admin('PUT', '/api/profile', { language: null })).body.language, null)
  assert.equal((await admin('GET', '/api/profile')).body.language, null)
  // What the column holds is read through the same list: a value this version doesn't know (a
  // hand edit, a language only a later version has) is automatic, not an error.
  await admin('PUT', '/api/profile', { language })
  const db = new Database(join(dir, 'state.db'))
  try { db.prepare('update profiles set language = ?').run('xx') } finally { db.close() }
  assert.equal((await admin('GET', '/api/profile')).body.language, null)
})

test('profiles: «On opening»: home by default, the last note, today\'s, or a note the person reads', async () => {
  const { admin, member, users, dir } = await setup({ config: CONFIG })
  assert.equal((await admin('GET', '/api/profile')).body.onOpen, 'home')
  for (const onOpen of ['last', 'daily', 'home'] as const) {
    const r = await admin('PUT', '/api/profile', { onOpen })
    assert.deepEqual([r.status, r.body.onOpen, r.body.onOpenNote, r.body.openDailyOnStart], [200, onOpen, null, onOpen === 'daily'])
  }
  // A note: one they read, by its path; it stays while they choose it.
  const note = inShared('Plan.md')
  const chosen = await admin('PUT', '/api/profile', { onOpen: 'note', onOpenNote: note })
  assert.deepEqual([chosen.body.onOpen, chosen.body.onOpenNote], ['note', note])
  assert.equal((await admin('PUT', '/api/profile', { timezone: m.aTimeZone() })).body.onOpenNote, note)
  // Another choice forgets it.
  assert.equal((await admin('PUT', '/api/profile', { onOpen: 'last' })).body.onOpenNote, null)
  // What isn't valid: no note, not a note's path, an unknown choice.
  for (const bad of [{ onOpen: 'note' }, { onOpen: 'note', onOpenNote: '../x.md' }, { onOpen: 'note', onOpenNote: m.aFolder() }, { onOpen: 'tree' }, { onOpen: 1 }]) {
    const r = await admin('PUT', '/api/profile', bad)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  // A note in someone else's own space: as missing.
  const theirs = `people/${users.member.username}/${m.aTitle()}.md`
  assert.equal((await admin('PUT', '/api/profile', { onOpen: 'note', onOpenNote: theirs })).status, 404)
  // One they could read once and can't now isn't shown: Home instead.
  const db = new Database(join(dir, 'state.db'))
  try { db.prepare("update profiles set on_open = 'note', on_open_note = ? where user_id = ?").run(theirs, users.admin.id) } finally { db.close() }
  const masked = (await admin('GET', '/api/profile')).body
  assert.deepEqual([masked.onOpen, masked.onOpenNote], ['home', null])
  // The switch it replaces still works: true is «daily», false turns «daily» back into home.
  assert.equal((await member('PUT', '/api/profile', { openDailyOnStart: true })).body.onOpen, 'daily')
  assert.equal((await member('PUT', '/api/profile', { openDailyOnStart: false })).body.onOpen, 'home')
})
