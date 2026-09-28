// Each person's profile: timezone, daily-note preferences (D-030) and the UI's language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { LANGUAGES } from '@vihko/core'
import { CONFIG, DAILY, setup } from './_app.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('profiles: timezone and daily preferences, validated', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  const none = { timezone: null, dailySeries: null, openDailyOnStart: false, language: null }
  assert.deepEqual((await admin('GET', '/api/profile')).body, none)
  assert.deepEqual((await admin('PUT', '/api/profile', { timezone: zone })).body, { ...none, timezone: zone })
  assert.deepEqual((await admin('PUT', '/api/profile', { dailySeries: DAILY.team.id, openDailyOnStart: true, role: 'admin' })).body, { ...none, timezone: zone, dailySeries: DAILY.team.id, openDailyOnStart: true })
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
  assert.deepEqual(saved.body, { timezone: zone, dailySeries: null, openDailyOnStart: false, language }, 'only the language changes')
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
